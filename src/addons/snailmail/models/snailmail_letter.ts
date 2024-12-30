import { decode } from "utf8";
import { Fields, api } from "../../../core";
import { AccessError, UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { b64encode, isInstance, len, parseInt } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { update } from "../../../core/tools/misc";
import { safeEval } from "../../../core/tools/save_eval";
import { f } from "../../../core/tools/utils";
import { iapJsonrpc } from "../../iap/tools/iap_tools";

const inch = 72.0;
const cm = inch / 2.54;
const mm = cm * 0.1;
const pica = 12.0;

const DEFAULT_ENDPOINT = 'https://iap-snailmail.theverp.com';
const PRINT_ENDPOINT = '/iap/snailmail/1/print';
const DEFAULT_TIMEOUT = 30;

const ERROR_CODES = [
    'MISSING_REQUIRED_FIELDS',
    'CREDIT_ERROR',
    'TRIAL_ERROR',
    'NO_PRICE_AVAILABLE',
    'FORMAT_ERROR',
    'UNKNOWN_ERROR',
];

@MetaModel.define()
class SnailmailLetter extends Model {
    static _module = module;
    static _name = 'snailmail.letter';
    static _description = 'Snailmail Letter';

    static userId = Fields.Many2one('res.users', {string: 'Sent by'});
    static model = Fields.Char('Model', {required: true});
    static resId = Fields.Integer('Document ID', {required: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Recipient', required: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, readonly: true,
        default: async (self) => (await self.env.company()).id});
    static reportTemplate = Fields.Many2one('ir.actions.report', {string: 'Optional report to print and attach'});

    static attachmentId = Fields.Many2one('ir.attachment', {string: 'Attachment', ondelete: 'CASCADE'});
    static attachmentDatas = Fields.Binary('Document', {related: 'attachmentId.datas'});
    static attachmentFname = Fields.Char('Attachment Filename', {related: 'attachmentId.label'});
    static color = Fields.Boolean({string: 'Color', default: async (self) => (await self.env.company()).snailmailColor});
    static cover = Fields.Boolean({string: 'Cover Page', default: async (self) => (await self.env.company()).snailmailCover});
    static duplex = Fields.Boolean({string: 'Both side', default: async (self) => (await self.env.company()).snailmailDuplex});
    static state = Fields.Selection([
        ['pending', 'In Queue'],
        ['sent', 'Sent'],
        ['error', 'Error'],
        ['canceled', 'Canceled']
        ], {string: 'Status', readonly: true, copy: false, default: 'pending', required: true,
        help: ["When a letter is created, the status is 'Pending'.\n",
             "If the letter is correctly sent, the status goes in 'Sent',\n",
             "If not, it will got in state 'Error' and the error message will be displayed in the field 'Error Message'."].join()});
    static errorCode = Fields.Selection(ERROR_CODES.map(errCode => [errCode, errCode]), {string: "Error"});
    static infoMsg = Fields.Char('Information');
    static displayName = Fields.Char('Display Name', {compute: "_computeDisplayName"});

    static reference = Fields.Char({string: 'Related Record', compute: '_computeReference', readonly: true, store: false});

    static messageId = Fields.Many2one('mail.message', {string: "Snailmail Status Message"});
    static notificationIds = Fields.One2many('mail.notification', 'letterId', { string: "Notifications"});

    static street = Fields.Char('Street');
    static street2 = Fields.Char('Street2');
    static zip = Fields.Char('Zip');
    static city = Fields.Char('City');
    static stateId = Fields.Many2one("res.country.state", {string: 'State'});
    static countryId = Fields.Many2one('res.country', {string: 'Country'});

    @api.depends('reference', 'partnerId')
    async _computeDisplayName() {
        for (const letter of this) {
          const [attachmentId, partnerId] = await letter('attachmentId', 'partnerId');
            if (attachmentId.ok) {
                await letter.set('displayName', f("%s - %s", await attachmentId.label, await partnerId.label));
            }
            else {
              await letter.set('displayName', await partnerId.label);
            }
        }
    }

    @api.depends('model', 'resId')
    async _computeReference() {
        for (const res of this) {
          await res.set('reference', f("%s,%s", await res.model, await res.resId));
        }
    }

    @api.modelCreateMulti()
    async create(valsList) {
        for (const vals of valsList) {
            const msgId = await this.env.items(vals['model']).browse(vals['resId']).messagePost({
                body: await this._t("Letter sent by post with Snailmail"),
                messageType: 'snailmail',
            });

            const partnerId = this.env.items('res.partner').browse(vals['partnerId']);
            update(vals, {
                'messageId': msgId.id,
                'street': await partnerId.street,
                'street2': await partnerId.street2,
                'zip': await partnerId.zip,
                'city': await partnerId.city,
                'stateId': (await partnerId.stateId).id,
                'countryId': (await partnerId.countryId).id,
            })
        }
        const letters = await _super(SnailmailLetter, this).create(valsList);

        const notificationVals = [];
        for (const letter of letters) {
            notificationVals.push({
                'mailMessageId': (await letter.messageId).id,
                'resPartnerId': (await letter.partnerId).id,
                'notificationType': 'snail',
                'letterId': letter.id,
                'isRead': true,  // discard Inbox notification
                'notificationStatus': 'ready',
            });
        }

        await (await this.env.items('mail.notification').sudo()).create(notificationVals);

        await (await letters.attachmentId).check('read');
        return letters;
    }

    async write(vals) {
        const res = await _super(SnailmailLetter, this).write(vals);
        if ('attachmentId' in vals) {
            await (await this['attachmentId']).check('read');
        }
        return res;
    }

    /**
     * This method will check if we have any existent attachement matching the model
        and resIds and create them if not found.
     * @returns 
     */
    async _fetchAttachment() {
        this.ensureOne();
        const obj = this.env.items(await this['model']).browse(await this['resId']);
        if (! (await this['attachmentId']).ok) {
            let report = await this['reportTemplate'];
            let reportName;
            if (! bool(report)) {
                reportName = this.env.context['reportName'];
                report = await this.env.items('ir.actions.report')._getReportFromName(reportName);
                if (!bool(report)) {
                    return false;
                }
                else {
                    await this.write({'reportTemplate': report.id});
                }
                //// report = self.env.ref('account.accountInvoices')
            }
            if (await report.printReportName) {
                reportName = safeEval(await report.printReportName, {'object': obj});
            }
            else if (await report.attachment) {
                reportName = safeEval(await report.attachment, {'object': obj});
            }
            else {
                reportName = 'Document';
            }
            const filename = f("%s.%s", reportName, "pdf");
            const paperformat = await report.getPaperformat();
            if ((await paperformat.format === 'custom' && await paperformat.pageWidth != 210 && await paperformat.pageHeight != 297) || await paperformat.format !== 'A4') {
                throw new UserError(await this._t("Please use an A4 Paper format."));
            }
            let [pdfBin, unusedFiletype] = await (await report.withContext({snailmailLayout: ! await this['cover'], lang: 'en_US'}))._renderQwebPdf(await this['resId']);
            pdfBin = await this._overwriteMargins(pdfBin);
            if (await this['cover']) {
                pdfBin = await this._appendCoverPage(pdfBin);
            }
            const attachment = await this.env.items('ir.attachment').create({
                'label': filename,
                'datas': b64encode(pdfBin),
                'resModel': 'snailmail.letter',
                'resId': this.id,
                'type': 'binary',  // override default_type from context, possibly meant for another model!
            })
            await this.write({'attachmentId': attachment.id});
        }

        return this['attachmentId'];
    }

    /**
     * Count the number of pages of the given pdf file.
            :param bin_pdf : binary content of the pdf file
     * @param binPdf 
     * @returns 
     */
    async _countPagesPdf(binPdf: string) {
        let pages = 0;
        for (const match of binPdf.matchAll(/Count\s+(\d+)/g)) {
            pages = parseInt(match[1]);
        }
        return pages;
    }

    /**
     * Create a dictionnary object to send to snailmail server.

        :return: Dict in the form:
        {
            account_token: string,    //IAP Account token of the user
            documents: [{
                pages: int,
                pdf_bin: pdf file
                resId: int (client-side resId),
                resModel: char (client-side resModel),
                address: {
                    name: char,
                    street: char,
                    street2: char (OPTIONAL),
                    zip: int,
                    city: char,
                    state: char (state code (OPTIONAL)),
                    country_code: char (country code)
                }
                return_address: {
                    name: char,
                    street: char,
                    street2: char (OPTIONAL),
                    zip: int,
                    city: char,at
                    state: char (state code (OPTIONAL)),
                    country_code: char (country code)
                }
            }],
            options: {
                color: boolean (true if color, false if black-white),
                duplex: boolean (true if duplex, false otherwise),
                currency_name: char
            }
        }
     * @param route 
     */
    async _snailmailCreate(route) {
        const accountToken = await (await this.env.items('iap.account').get('snailmail')).accountToken;
        const dbuuid = await (await this.env.items('ir.config.parameter').sudo()).getParam('database.uuid');
        const documents = [];

        const batch = len(this) > 1;
        for (const letter of this) {
            const [partnerId] = await letter.partnerId;
            const recipientName = await partnerId.label || (await partnerId.parentId).ok && await (await partnerId.parentId).label;
            if (! recipientName) {
                await letter.write({
                    'infoMsg': await this._t('Invalid recipient name.'),
                    'state': 'error',
                    'errorCode': 'MISSING_REQUIRED_FIELDS'
                  });
                continue;
            }
            const [companyId] = await letter.companyId;
            const companyPartnerId = await companyId.partnerId;
            const document = {
                // generic informations to send
                'letterId': letter.id,
                'resModel': await letter.model,
                'resId': await letter.resId,
                'contactAddress': (await (await partnerId.withContext({snailmailLayout: true, showAddress: true})).nameGet())[0][1],
                'address': {
                    'label': recipientName,
                    'street': await partnerId.street,
                    'street2': await partnerId.street2,
                    'zip': await partnerId.zip,
                    'state': (await partnerId.stateId).ok ? await (await partnerId.stateId).code : false,
                    'city': await partnerId.city,
                    'countryCode': await (await partnerId.countryId).code
                },
                'returnAddress': {
                    'label': await companyPartnerId.label,
                    'street': await companyPartnerId.street,
                    'street2': await companyPartnerId.street2,
                    'zip': await companyPartnerId.zip,
                    'state': (await companyPartnerId.stateId).ok ? (await companyPartnerId.stateId).code : false,
                    'city': await companyPartnerId.city,
                    'countryCode': await (await companyPartnerId.countryId).code,
                }
            }
            // Specific to each case:
            // If we are estimating the price: 1 object = 1 page
            // If we are printing -> attach the pdf
            if (route === 'estimate') {
                update(document, {pages: 1});
            }
            else {
                // adding the web logo from the company for future possible customization
                update(document, {
                    'companyLogo': await companyId.logoWeb && decode(await companyId.logoWeb) || false,
                });
                const attachment = await letter._fetchAttachment();
                if (bool(attachment)) {
                    update(document, {
                        'pdfBin': route === 'print' && decode(await attachment.datas),
                        'pages': route === 'estimate' && await this._countPagesPdf(Buffer.from(await attachment.datas).toString()),
                    });
                }
                else {
                    await letter.write({
                        'infoMsg': 'The attachment could not be generated.',
                        'state': 'error',
                        'errorCode': 'UNKNOWN_ERROR'
                    })
                    continue;
                }
                if ((await companyId.externalReportLayoutId).eq(await this.env.ref('l10n_de.externalLayoutDin5008', false))) {
                    update(document, {
                        'rightaddress': 0,
                    });
                  }
            }
            documents.push(document);
        }

        return {
            'accountToken': accountToken,
            'dbuuid': dbuuid,
            'documents': documents,
            'options': {
                'color': this.ok && await this[0].color,
                'cover': this.ok && await this[0].cover,
                'duplex': this.ok && await this[0].duplex,
                'currencyName': 'EUR',
            },
            // this will not raise the InsufficientCreditError which is the behaviour we want for now
            'batch': true,
        }
    }

    async _getErrorMessage(error) {
        if (error === 'CREDIT_ERROR') {
            const link = await this.env.items('iap.account').getCreditsUrl('snailmail');
            return await this._t('You don\'t have enough credits to perform this operation.<br>Please go to your <a href=%s target="new">iap account</a>.', link);
        }
        if (error === 'TRIAL_ERROR') {
            const link = await this.env.items('iap.account').getCreditsUrl('snailmail', true);
            return await this._t('You don\'t have an IAP account registered for this service.<br>Please go to <a href=%s target="new">iap.theverp.com</a> to claim your free credits.', link);
        }
        if (error === 'NO_PRICE_AVAILABLE') {
            return await this._t('The country of the partner is not covered by Snailmail.');
        }
        if (error === 'MISSING_REQUIRED_FIELDS') {
            return await this._t('One or more required fields are empty.');
        }
        if (error == 'FORMAT_ERROR') {
            return await this._t('The attachment of the letter could not be sent. Please check its content and contact the support if the problem persists.');
        }
        else {
            return await this._t('An unknown error happened. Please contact the support.');
        }
        return error;
    }

    async _getFailureType(error) {
        if (error === 'CREDIT_ERROR') {
            return 'snCredit';
        }
        if (error === 'TRIAL_ERROR') {
            return 'snTrial';
        }
        if (error === 'NO_PRICE_AVAILABLE') {
            return 'snPrice';
        }
        if (error === 'MISSING_REQUIRED_FIELDS') {
            return 'snFields';
        }
        if (error === 'FORMAT_ERROR') {
            return 'snFormat';
        }
        else {
            return 'snError';
        }
    }

    async _snailmailPrint(immediate: boolean=true) {
        const validAddressLetters = await this.filtered((l) => l._isValidAddress(l));
        const invalidAddressLetters = this.sub(validAddressLetters);
        await invalidAddressLetters._snailmailPrintInvalidAddress();
        if (validAddressLetters.ok && immediate) {
            for (const letter of validAddressLetters) {
                await letter._snailmailPrintValidAddress();
                await this.env.cr.commit();
                await this.env.cr.reset();
            }
        }
    }

    async _snailmailPrintInvalidAddress() {
        const error = 'MISSING_REQUIRED_FIELDS';
        const errorMessage = await this._t("The address of the recipient is not complete");
        await this.write({
            'state': 'error',
            'errorCode': error,
            'infoMsg': errorMessage,
        });
        await (await (await this['notificationIds']).sudo()).write({
            'notificationStatus': 'exception',
            'failureType': await this._getFailureType(error),
            'failureReason': errorMessage,
        });
        await (await this['messageId'])._notifyMessageNotificationUpdate();
    }

    /**
     * get response
        {
            'request_code': RESPONSE_OK, # because we receive 200 if good or fail
            'total_cost': total_cost,
            'credit_error': credit_error,
            'request': {
                'documents': documents,
                'options': options
                }
            }
        }
     */
    async _snailmailPrintValidAddress() {
      const sudo = await this.env.items('ir.config.parameter').sudo();
        const endpoint = await sudo.getParam('snailmail.endpoint', DEFAULT_ENDPOINT);
        const timeout = parseInt(await sudo.getParam('snailmail.timeout', DEFAULT_TIMEOUT));
        const params = await this._snailmailCreate('print');
        let response;
        try {
            response = await iapJsonrpc(this.env, endpoint + PRINT_ENDPOINT, {params: params, timeout: timeout});
        } catch(e) {
          if (isInstance(e, AccessError)) {
            for (const doc of params['documents']) {
                const letter = this.browse(doc['letterId']);
                await letter.set('state', 'error');
                await letter.set('errorCode', 'UNKNOWN_ERROR');
            }
            throw e;
          }
          throw e;
        }
        for (const doc of response['request']['documents']) {
          let notificationData, letterData;
            if (doc['sent'] && response['requestCode'] == 200) {
                const note = await this._t('The document was correctly sent by post.<br>The tracking id is %s', doc['sendId']);
                letterData = {'infoMsg': note, 'state': 'sent', 'errorCode': false}
                notificationData = {
                    'notificationStatus': 'sent',
                    'failureType': false,
                    'failureReason': false,
                }
            }
            else {
                const error = response['requestCode'] == 200 ? doc['error'] : response['reason'];

                const note = await this._t('An error occurred when sending the document by post.<br>Error: %s', await this._getErrorMessage(error));
                letterData = {
                    'infoMsg': note,
                    'state': 'error',
                    'errorCode': ERROR_CODES.includes(error) ? error : 'UNKNOWN_ERROR'
                }
                notificationData = {
                    'notificationStatus': 'exception',
                    'failureType': await this._getFailureType(error),
                    'failureReason': note,
                }
            }

            const letter = this.browse(doc['letterId']);
            await letter.write(letterData);
            await (await (await letter.notificationIds).sudo()).write(notificationData);
        }

        await (await this['messageId'])._notifyMessageNotificationUpdate();
    }

    async snailmailPrint() {
        await this.write({'state': 'pending'});
        await (await (await this['notificationIds']).sudo()).write({
            'notificationStatus': 'ready',
            'failureType': false,
            'failureReason': false,
        })
        await (await this['messageId'])._notifyMessageNotificationUpdate();
        if (len(this) == 1) {
            await this._snailmailPrint();
        }
    }

    async cancel() {
        await this.write({'state': 'canceled', 'errorCode': false});
        await (await (await this['notificationIds']).sudo()).write({
            'notificationStatus': 'canceled',
        });
        await (await this['messageId'])._notifyMessageNotificationUpdate();
      }

    @api.model()
    async _snailmailCron(autocommit: boolean=true) {
        const lettersSend = await this.search([
            '|',
            ['state', '=', 'pending'],
            '&',
            ['state', '=', 'error'],
            ['errorCode', 'in', ['TRIAL_ERROR', 'CREDIT_ERROR', 'MISSING_REQUIRED_FIELDS']]
        ]);
        for (const letter of lettersSend) {
            await letter._snailmailPrint();
            if (await letter.errorCode === 'CREDIT_ERROR') {
                break  // avoid spam;
            }
            // Commit after every letter sent to avoid to send it again in case of a rollback
            if (autocommit) {
                await this.env.cr.commit();
                await this.env.cr.reset();
            }
        }
    }

    @api.model()
    async _isValidAddress(record) {
        record.ensureOne();
        const requiredKeys = ['street', 'city', 'zip', 'countryId'];
        return (await Promise.all(requiredKeys.map(async (key) => await record[key]))).every(key => key);
    }

    async _appendCoverPage(invoiceBin: Buffer) {
      const partnerId = await this['partnerId'];
        const addressSplit = (await (await partnerId.withContext({showAddress: true, lang: 'en_US'}))._getName()).split('\n');
        addressSplit[0] = await partnerId.label || (await partnerId.parentId).ok && await (await partnerId.parentId).label || addressSplit[0];
        const address = addressSplit.join('<br/>');
        const addressX = 118 * mm;
        const addressY = 60 * mm;
        const frameWidth = 85.5 * mm;
        const frameHeight = 25.5 * mm;
      /*
        const coverBuf = io.BytesIO()
        canvas = Canvas(cover_buf, pagesize=A4)
        styles = getSampleStyleSheet()

        frame = Frame(address_x, A4[1] - address_y - frame_height, frame_width, frame_height)
        story = [Paragraph(address, styles['Normal'])]
        address_inframe = KeepInFrame(0, 0, story)
        frame.addFromList([address_inframe], canvas)
        canvas.save()
        cover_buf.seek(0)

        invoice = PdfFileReader(io.BytesIO(invoice_bin))
        cover_bin = io.BytesIO(cover_buf.getvalue())
        cover_file = PdfFileReader(cover_bin)
        const merger = new PdfFileMerger();

        merger.push(coverFile, false);
        merger.push(invoice, false);

        const outBuff = Buffer.from('');
        await merger.write(outBuff);
        return outBuff.valueOf();
        */
       return Buffer.from('');
    }

    /**
     * Fill the margins with white for validation purposes.
     * @param invoiceBin 
     * @returns 
     */
    async _overwriteMargins(invoiceBin: Buffer) {
      /*
        pdf_buf = io.BytesIO()
        canvas = Canvas(pdf_buf, pagesize=A4)
        canvas.setFillColorRGB(255, 255, 255)
        page_width = A4[0]
        page_height = A4[1]

        # Horizontal Margin
        hmargin_width = page_width
        hmargin_height = 5 * mm

        # Vertical Margin
        vmargin_width = 5 * mm
        vmargin_height = page_height

        # Bottom left square
        sq_width = 15 * mm

        # Draw the horizontal margins
        canvas.rect(0, 0, hmargin_width, hmargin_height, stroke=0, fill=1)
        canvas.rect(0, page_height, hmargin_width, -hmargin_height, stroke=0, fill=1)

        # Draw the vertical margins
        canvas.rect(0, 0, vmargin_width, vmargin_height, stroke=0, fill=1)
        canvas.rect(page_width, 0, -vmargin_width, vmargin_height, stroke=0, fill=1)

        # Draw the bottom left white square
        canvas.rect(0, 0, sq_width, sq_width, stroke=0, fill=1)
        canvas.save()
        pdf_buf.seek(0)

        new_pdf = PdfFileReader(pdf_buf)
        curr_pdf = PdfFileReader(io.BytesIO(invoice_bin))
        out = PdfFileWriter()
        for page in curr_pdf.pages:
            page.mergePage(new_pdf.getPage(0))
            out.addPage(page)
        out_stream = io.BytesIO()
        out.write(out_stream)
        out_bin = out_stream.getvalue()
        out_stream.close()
        return out_bin
        */
       return Buffer.from('');
    }
}