import fs from "fs";
import fsPro from "fs/promises";
import * as _ from 'lodash';
import { DateTime } from 'luxon';
import { PDFCatalog, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import puppeteer from 'puppeteer';
import temp from 'temp';
import { encode } from 'utf8';
import xpath from "xpath";
import { api, models, tools } from "../../..";
import { setdefault } from '../../../api';
import { Fields, _Datetime } from "../../../fields";
import { AccessError, OrderedDict, UserError, ValueError } from '../../../helper';
import { MetaModel, Model, _super } from "../../../models";
import { FALSE_DOMAIN, NEGATIVE_TERM_OPERATORS } from "../../../osv/expression";
import { UpCamelCase, _f, b64decode, base64ToImage, bool, config, enumerate, equal, extend, f, isHtmlEmpty, isInstance, isIterable, len, parseInt, pop, range, toFormat, update } from "../../../tools";
import { safeEval } from '../../../tools/save_eval';
import { E, childNodes, getAttributes, getrootXml, markup, parseXml, serializeHtml } from '../../../tools/xml';

const chromiumState = 'ok';
const dpiZoomRatio = false;

@MetaModel.define()
class IrActionsReport extends Model {
    static _module = module;
    static _name = 'ir.actions.report';
    static _description = 'Report Action';
    static _parents = 'ir.actions.mixin';
    static _inherits = { 'ir.actions.actions': 'actionId' };
    static _table = 'irActReportXml';
    static _order = 'label';

    static actionId = Fields.Many2one('ir.actions.actions', { string: 'Action', autojoin: true, index: true, ondelete: "CASCADE", required: true });
    static label = Fields.Char({ translate: true });
    static type = Fields.Char({ default: 'ir.actions.report' });
    static model = Fields.Char({ required: true, string: 'Model Name' });
    static modelId = Fields.Many2one('ir.model', { string: 'Model', compute: '_computeModelId', search: '_searchModelId' })

    static reportType = Fields.Selection([
        ['qweb-html', 'HTML'],
        ['qweb-pdf', 'PDF'],
        ['qweb-text', 'Text'],
    ], { required: true, default: 'qweb-pdf', help: 'The type of the report that will be rendered, each one having its own rendering method. HTML means the report will be opened directly in your browser PDF means the report will be rendered using HtmltoPdf and downloaded by the user.' });
    static reportName = Fields.Char({ string: 'Template Name', required: true });
    static reportModelName = Fields.Char({ string: 'Report Model', required: false, store: true, help: "Model of report in registry" });
    static reportFile = Fields.Char({ string: 'Report File', required: false, readonly: false, store: true, help: "The path to the main report file (depending on Report Type) or empty if the content is in another field" })
    static groupsId = Fields.Many2many('res.groups', { relation: 'resGroupsReportRel', column1: 'uid', column2: 'gid', string: 'Groups' })
    static multi = Fields.Boolean({ string: 'On Multiple Doc.', help: "If set to true, the action will not be displayed on the right toolbar of a form view." })

    static paperformatId = Fields.Many2one('report.paperformat', { string: 'Paper Format' })
    static printReportName = Fields.Char('Printed Report Name', { translate: true, help: "This is the filename of the report going to download. Keep empty to not change the report filename. You can use a javascript expression with the 'object' and 'time' variables." })
    static attachmentUse = Fields.Boolean({ string: 'Reload from Attachment', help: 'If enabled, then the second time the user prints with same attachment name, it returns the previous report.' })
    static attachment = Fields.Char({
        string: 'Save as Attachment Prefix',
        help: 'This is the filename of the attachment used to store the printing result. Keep empty to not save the printed reports. You can use a c expression with the object and time variables.'
    });

    @api.depends('model')
    async _computeModelId() {
        for (const action of this) {
            await action.set('modelId', await this.env.items('ir.model')._get(await action.model).id);
        }
    }

    async _searchModelId(operator, value) {
        let irModelIds;
        if (typeof (value) === 'string') {
            const names = await this.env.items('ir.model').nameSearch(value, { operator: operator });
            irModelIds = names.map(n => n[0]);
        }

        else if (isIterable(value)) {
            irModelIds = value;
        }

        else if ((typeof (value) === 'number') && (typeof (value) !== 'boolean'))
            irModelIds = [value];

        if (bool(irModelIds)) {
            operator = operator in NEGATIVE_TERM_OPERATORS ? 'not in' : 'in'
            const irModel = this.env.items('ir.model').browse(irModelIds)
            return [['model', operator, await irModel.mapped('model')]]
        }
        else if ((typeof (value) === 'boolean') || value == null)
            return [['model', operator, value]]
        else
            return FALSE_DOMAIN
    }

    _getReadableFields() {
        return _.union(_super(IrActionsReport, this)._getReadableFields(), [
            "reportName", "reportType", "target",
            // these two are not real fields of ir.actions.report but are
            // expected in the route /report/<converter>/<reportname> and must
            // not be removed by clean_action
            "context", "data",
            // and this one is used by the frontend later on.
            "closeOnReportDownload",
        ]);
    }

    _validFieldParameter(field, name) {
        // allow specifying rendering options directly from field when using the render mixin
        return (name === 'modelField'
            || _super(IrActionsReport, this)._validFieldParameter(field, name)
        );
    }


    /**
     * Used in the ir.actions.report form view in order to search naively after the view(s)
             used in the rendering.
     * @returns 
     */
    async associatedView() {
        this.ensureOne();
        const actionRef = await this.env.ref('base.actionUiView');
        if (!actionRef || len((await this['reportName']).split('.')) < 2) {
            return false;
        }
        const actionData = await actionRef.readOne();
        actionData['domain'] = [['label', 'ilike', (await this['reportName']).split('.')[1]], ['type', '=', 'qweb']];
        return actionData;
    }

    /**
     * Create a contextual action for each report.
     * @returns 
     */
    async createAction() {
        for (const report of this) {
            const model = await this.env.items('ir.model')._get(await report.model);
            await report.write({ 'bindingModelId': model.id, 'bindingType': 'report' });
        }
        return true;
    }

    /**
     * Remove the contextual actions created for the reports.
     * @returns 
     */
    async unlinkAction() {
        await this.checkAccessRights('write', true);
        await (await this.filtered('bindingModelId')).write({ 'bindingModelId': false });
        return true;
    }

    //--------------------------------------------------------------------------
    // Main report methods
    //--------------------------------------------------------------------------
    async _retrieveStreamFromAttachment(attachment) {
        const buffer = b64decode(await attachment.datas);
        if ((await attachment.mimetype).startsWith('image')) {
            const img = base64ToImage(buffer);
            return img.toColorspace("rgb").toBuffer();
        }
        return buffer;
    }

    /**
     * Retrieve an attachment for a specific record.
 
     * @param record The record owning of the attachment.
     * @returns A recordset of length <=1 or None
     */
    async retrieveAttachment(record) {
        const attachment = await this['attachment'];
        const attachmentName = bool(attachment) ? safeEval(attachment, { 'object': record, 'time': DateTime }) : '';
        if (!attachmentName) {
            return null;
        }
        return this.env.items('ir.attachment').search([
            ['label', '=', attachmentName],
            ['resModel', '=', await this['model']],
            ['resId', '=', record.id]
        ], { limit: 1 });
    }

    /**
     * Hook to handle post processing during the pdf report generation.
        The basic behavior consists to create a new attachment containing the pdf
        base64 encoded.
 
     * @param record The record that will own the attachment.
     * @param buffer The optional name content of the file to avoid reading both times.
     * @returns A modified buffer if the previous one has been modified, None otherwise.
     */
    async _postprocessPdfReport(record, buffer: Uint8Array) {
        const attachment = await this['attachment'];
        const attachmentName = safeEval(attachment, { 'object': record, 'time': Date });
        if (!attachmentName) {
            return null;
        }
        const attachmentVals = {
            'label': attachmentName,
            'raw': buffer,
            'resModel': await this['model'],
            'resId': record.id,
            'type': 'binary',
        }
        try {
            await this.env.items('ir.attachment').create(attachmentVals);
        } catch (e) {
            if (isInstance(e, AccessError)) {
                console.info("Cannot save PDF report %s as attachment", attachmentVals['label']);
            }
            else {
                console.info('The PDF document %s is now saved in the database', attachmentVals['label']);
            }
        }
        return buffer;
    }

    /**
     * Get the current state of chromium: install, ok, upgrade, workers or broken.
        * install: Starting state.
        * upgrade: The binary is an older version (< 0.12.0).
        * ok: A binary was found with a recent version (>= 0.12.0).
        * workers: Not enough workers found to perform the pdf rendering process (< 2 workers).
        * broken: A binary was found but not responding.
     * @returns chromiumState
     */
    @api.model()
    getChromiumState() {
        return chromiumState;
    }

    async getPaperformat() {
        const paperformatId = await this['paperformatId'];
        return bool(paperformatId) ? paperformatId : (await this.env.company()).paperformatId;
    }

    /**
     * Build arguments understandable by PDF options.
 
     * @param paperformatId A report.paperformat record.
     * @param landscape Force the report orientation to be landscape.
     * @param specificPaperformatArgs A dictionary containing prioritized htmltoPdf arguments.
     * @param setViewportSize Enable a viewport sized '1024x1280' or '1280x1024' depending of landscape arg.
     * @returns A list of string representing the htmltoPdf process command args.
    **/
    @api.model()
    async _buildPDFOptions(
        paperformatId,
        landscape,
        specificPaperformatArgs?: any,
        setViewportSize = false) {
        if (landscape == null && specificPaperformatArgs && specificPaperformatArgs['data-report-landscape']) {
            landscape = specificPaperformatArgs['data-report-landscape'];
        }
        const options = {}
        const commandArgs = ['--disable-local-file-access']
        if (setViewportSize) {
            options['landscape'] = landscape;
        }

        // Passing the cookie to htmltoPdf in order to resolve internal links.
        try {
            if (this.env.req) {
                options['cookie'] = options['cookie'] ?? {};
                options['cookie']['session_id'] = this.env.req.session.sid;
            }
        } catch (e) {
            // pass
        }

        // Less verbose error messages
        extend(commandArgs, ['--quiet']);

        // Build paperformat args
        if (bool(paperformatId)) {
            const format = await paperformatId.format;
            if (format && format !== 'custom') {
                options['format'] = format;
            }
            const [height, width] = await paperformatId('pageHeight', 'pageWidth');
            if (height && width && format === 'custom') {
                options['width'] = width + 'mm';
                options['height'] = height + 'mm';
            }
            if (bool(specificPaperformatArgs) && specificPaperformatArgs['data-report-margin-top']) {
                options['margin'] = { top: specificPaperformatArgs['data-report-margin-top'] }
            }
            else {
                options['margin'] = { top: await paperformatId.marginTop }
            }
            let dpi;
            if (bool(specificPaperformatArgs) && specificPaperformatArgs['data-report-dpi']) {
                dpi = parseInt(specificPaperformatArgs['data-report-dpi']);
            }
            else if (await paperformatId.dpi) {
                if (process.platform == 'win32' && parseInt(await paperformatId.dpi) <= 95) {
                    console.info("Generating PDF on Windows platform require DPI >= 96. Using 96 instead.")
                    dpi = 96;
                }
                else {
                    dpi = await paperformatId.dpi;
                }
            }
            if (dpi) {
                extend(commandArgs, ['--dpi', String(dpi)]);
                if (dpiZoomRatio) {
                    extend(commandArgs, ['--zoom', String(96.0 / dpi)]);
                }
            }

            if (bool(specificPaperformatArgs) && specificPaperformatArgs['data-report-header-spacing']) {
                extend(commandArgs, ['--header-spacing', String(specificPaperformatArgs['data-report-header-spacing'])]);
            }
            else if (await paperformatId.headerSpacing) {
                extend(commandArgs, ['--header-spacing', String(await paperformatId.headerSpacing)]);
            }

            extend(commandArgs, ['--margin-left', String(await paperformatId.marginLeft)]);
            extend(commandArgs, ['--margin-bottom', String(await paperformatId.marginBottom)]);
            extend(commandArgs, ['--margin-right', String(await paperformatId.marginRight)]);
            if (!landscape && await paperformatId.orientation) {
                extend(commandArgs, ['--orientation', String(await paperformatId.orientation)]);
            }
            if (await paperformatId.headerLine) {
                extend(commandArgs, ['--header-line']);
            }
            if (await paperformatId.disableShrinking) {
                extend(commandArgs, ['--disable-smart-shrinking']);
            }
        }

        // Add extra time to allow the page to render
        const delay = await (await this.env.items('ir.config.parameter').sudo()).getParam('report.printDelay', '1000');
        extend(commandArgs, ['--javascript-delay', delay]);

        if (landscape) {
            extend(commandArgs, ['--orientation', 'landscape']);
        }
        return commandArgs;
    }

    /**
     * Divide and recreate the header/footer html by merging all found in html.
        The bodies are extracted and added to a list. Then, extract the specificPaperformatArgs.
        The idea is to put all headers/footers together. Then, we will use a javascript trick
        (see minimalLayout template) to set the right header/footer during the processing of htmltoPdf.
        This allows the computation of multiple reports in a single call to htmltoPdf.
 
     * @param html The html rendered by renderQwebHtml.
     * @returns [bodies, header, footer, specificPaperformatArgs]
        bodies: list of string representing each one a html body.
        header: string representing the html header.
        footer: string representing the html footer.
        specificPaperformatArgs: dictionary of prioritized paperformat values.
     */
    async _prepareHtml(html) {
        const IrConfig = await this.env.items('ir.config.parameter').sudo();

        // Return empty dictionary if 'web.minimalLayout' not found.
        let layout = await this.env.ref('web.minimalLayout', false);
        if (!bool(layout)) {
            return {};
        }
        layout = this.env.items('ir.ui.view').browse(await this.env.items('ir.ui.view').getViewId('web.minimalLayout'));
        const baseUrl = await IrConfig.getParam('report.url') || await layout.getBaseUrl();

        const root = getrootXml(parseXml(html));
        const matchKlass = '//div[contains(concat(" ", normalize-space(@class), " "), " {elem} ")]';

        const headerNode = E.div({ id: 'minimalLayoutReportHeaders' }),
            footerNode = E.div({ id: 'minimalLayoutReportFooters' }),
            bodies = [],
            resIds = [];

        let bodyParent: any = xpath.select1('//main', root) as any as Element;
        // Retrieve headers
        for (const node of xpath.select(_f(matchKlass, { elem: 'header' }), root) as Element[]) {
            bodyParent = node.parentNode;
            bodyParent.removeChild(node);
            headerNode.appendChild(node);
        }

        // Retrieve footers
        for (const node of xpath.select(_f(matchKlass, { elem: 'footer' }), root) as Element[]) {
            bodyParent = node.parentNode;
            bodyParent.removeChild(node);
            footerNode.appendChild(node);
        }

        // Retrieve bodies
        let layoutSections;
        for (const node of xpath.select(_f(matchKlass, { elem: 'article' }), root) as Element[]) {
            let layoutWithLang = layout;
            if (node.hasAttribute('data-oe-lang')) {
                // context language to body language
                layoutWithLang = await layoutWithLang.withContext({ lang: node.getAttribute('data-oe-lang') });
                // set header/lang to body lang prioritizing current user language
                if (!bool(layoutSections) || node.getAttribute('data-oe-lang') === this.env.lang) {
                    layoutSections = layoutWithLang;
                }
            }
            const body = await layoutWithLang._render({
                'subst': false,
                'body': markup(serializeHtml(node, 'unicode')),
                'baseUrl': baseUrl,
                'reportXmlid': await this['xmlid']
            });
            bodies.push(body);
            if (node.getAttribute('data-oe-model') === await this['model']) {
                resIds.push(parseInt(node.getAttribute('data-oe-id') ?? 0));
            }
            else {
                resIds.push(null);
            }
        }

        if (!bodies.length) {
            const body = childNodes(bodyParent, _.isElement).map(c => serializeHtml(c, 'unicode')).join('');
            bodies.push(body);
        }
        // Get paperformat arguments set in the root html tag. They are prioritized over
        // paperformat-record arguments.
        const specificPaperformatArgs = {};
        for (const attribute of getAttributes(root)) {
            if (attribute.name.startsWith('data-report-')) {
                specificPaperformatArgs[attribute.name] = attribute.value;
            }
        }
        const header = await (bool(layoutSections) ? layoutSections : layout)._render({
            'subst': true,
            'body': markup(serializeHtml(headerNode, 'unicode')),
            'baseUrl': baseUrl
        });
        const footer = await (bool(layoutSections) ? layoutSections : layout)._render({
            'subst': true,
            'body': markup(serializeHtml(footerNode, 'unicode')),
            'baseUrl': baseUrl
        });

        return [bodies, resIds, header, footer, specificPaperformatArgs];
    }

    /**
     * Execute htmltoPdf as a subprocess in order to convert html given in input into a pdf
        document.
 
     * @param bodies The html bodies of the report, one per page.
     * @param header The html header of the report containing all headers.
     * @param footer The html footer of the report containing all footers.
     * @param landscape Force the pdf to be rendered under a landscape format.
     * @param specificPaperformatArgs dict of prioritized paperformat arguments.
     * @param setViewportSize Enable a viewport sized '1024x1280' or '1280x1024' depending of landscape arg.
     * @returns Content of the pdf as bytes
     */
    @api.model()
    async _runPrintPdf(bodies: string[], opts: { header?: string, footer?: string, landscape?: boolean, specificPaperformatArgs?: {}, setViewportSize?: boolean } = {}) {
        const { header, footer, landscape, specificPaperformatArgs, setViewportSize } = opts;
        const paperformatId = await this.getPaperformat();

        // Build the base command args for htmltoPdf bin
        const commandArgs = await this._buildPDFOptions(
            paperformatId,
            landscape,
            specificPaperformatArgs,
            setViewportSize);

        const filesCommandArgs = [],
            temporaryFiles = [];
        if (header) {
            const dataFile: temp.OpenFile = await temp.open({ suffix: '.html', prefix: 'report.header.tmp.' });
            await fsPro.writeFile(dataFile.path, encode(header));
            temporaryFiles.push(dataFile.path);
            extend(filesCommandArgs, ['--header-html', dataFile.path]);
        }
        if (footer) {
            const dataFile: temp.OpenFile = await temp.open({ suffix: '.html', prefix: 'report.footer.tmp.' });
            await fsPro.writeFile(dataFile.path, encode(footer));
            temporaryFiles.push(dataFile.path);
            extend(filesCommandArgs, ['--footer-html', dataFile.path]);
        }
        const paths = [];
        for (const [i, body] of enumerate(bodies)) {
            const prefix = f('%s%d.', 'report.body.tmp.', i);
            const dataFile: temp.OpenFile = await temp.open({ suffix: '.html', prefix });
            await fsPro.writeFile(dataFile.path, encode(body));
            paths.push(dataFile.path);
            temporaryFiles.push(dataFile.path);
        }

        const pdfReport: temp.OpenFile = await temp.open({ suffix: '.pdf', prefix: 'report.tmp.' });
        fs.closeSync(pdfReport.fd);
        temporaryFiles.push(pdfReport.path);
        try {
            const browser = await puppeteer.launch({
                executablePath: tools.config.options['chromePath'],
                headless: true,
                args: ["--fast-start", "--disable-extensions", "--no-sandbox"],
                // ignoreHTTPSErrors: true
            });
            const page = await browser.newPage();
            await page.setContent(bodies[0]); // Tony must check multi articles/bodies
            const pdfContent = await page.pdf({
                format: 'A4',
                displayHeaderFooter : true,
                headerTemplate: '<div id="header-template" style="font-size:10px !important; color:#808080; padding-left:10px"><span class="date"></span><span class="title">Bao cao</span><span class="url">link</span><span class="pageNumber">01</span><span class="totalPages">100</span></div>',
                footerTemplate: '<span style="-webkit-print-color-adjust: exact;color:#000 !important;" class="page-footer">©2020, Some footer text.</span>',
                // headerTemplate: header,
                // footerTemplate: footer,
                margin: {
                    top: "20px",
                    left: "20px",
                    right: "20px",
                    bottom: "20px"
                }
            });
            await browser.close();
            return pdfContent;
        } catch (e) {
            console.log(e);
        }
        const pdfContent = await fsPro.readFile(pdfReport.path);

        // Manual cleanup of the temporary files
        for (const temporaryFile of temporaryFiles) {
            try {
                await fsPro.unlink(temporaryFile);
            } catch (e) {
                console.error('Error when trying to remove file %s', temporaryFile);
            }
        }
        return pdfContent;
    }
    /**
     * Get the first record of ir.actions.report having the ``reportName`` as value for
        the field reportName.
     * @param reportName 
     * @returns 
     */
    @api.model()
    async _getReportFromName(reportName) {
        const reportObj = this.env.items('ir.actions.report');
        const conditions = [['reportName', '=', reportName]];
        const context = await this.env.items('res.users').contextGet();
        return (await (await reportObj.withContext(context)).sudo()).search(conditions, { limit: 1 });
    }

    /**
     * Computes and returns the barcode check digit. The used algorithm
        follows the GTIN specifications and can be used by all compatible
        barcode nomenclature, like as EAN-8, EAN-12 (UPC-A) or EAN-13.
 
        https://www.gs1.org/sites/default/files/docs/barcodes/GS1_General_Specifications.pdf
        https://www.gs1.org/services/how-calculate-check-digit-manually
 
     * @param numericBarcode the barcode to verify/recompute the check digit
     * @returns the number corresponding to the right check digit
     */
    @api.model()
    getBarcodeCheckDigit(numericBarcode: string) {
        // Multiply value of each position by
        // N1  N2  N3  N4  N5  N6  N7  N8  N9  N10 N11 N12 N13 N14 N15 N16 N17 N18
        // x3  X1  x3  x1  x3  x1  x3  x1  x3  x1  x3  x1  x3  x1  x3  x1  x3  CHECKSUM
        let oddsum = 0, evensum = 0;
        const code = _.reverse(numericBarcode).slice(1);  // Remove the check digit and reverse the barcode.
        // The CHECKSUM digit is removed because it will be recomputed and it must not interfer with
        // the computation. Also, the barcode is inverted, so the barcode length doesn't matter.
        // Otherwise, the digits' group (even or odd) could be different according to the barcode length.
        for (const [i, digit] of enumerate(code)) {
            if (i % 2 == 0) {
                evensum += parseInt(digit);
            }
            else {
                oddsum += parseInt(digit);
            }
        }
        const total = evensum * 3 + oddsum;
        return (10 - total % 10) % 10;
    }

    /**
     * Checks if the given barcode is correctly encoded.
 
     * @param barcode 
     * @param encoding 
     * @returns true if the barcode string is encoded with the provided encoding.
     */
    @api.model()
    checkBarcodeEncoding(barcode, encoding) {
        if (encoding == "any") {
            return true;
        }
        const barcodeSizes = {
            'ean8': 8,
            'ean13': 13,
            'upca': 12,
        }
        const barcodeSize = barcodeSizes[encoding];
        return (encoding !== 'ean13' || barcode[0] !== '0')
            && len(barcode) == barcodeSize
            && /^\d+$/.test(barcode)
            && this.getBarcodeCheckDigit(barcode) == parseInt(barcode.slice(-1)[0]);
    }

    @api.model()
    barcode(barcodeType, value, kwargs: {} = {}) {
        const defaults = {
            'width': [600, parseInt],
            'height': [100, parseInt],
            'humanreadable': [false, (x) => bool(parseInt(x))],
            'quiet': [true, (x) => bool(parseInt(x))],
            'mask': [null, (x) => x],
            'barBorder': [4, parseInt],
            // The QR code can have different layouts depending on the Error Correction Level
            // See: https://en.wikipedia.org/wiki/QR_code#Error_correction
            // Level 'L' – up to 7% damage   (default)
            // Level 'M' – up to 15% damage  (i.e. required by l10n_ch QR bill)
            // Level 'Q' – up to 25% damage
            // Level 'H' – up to 30% damage
            'barLevel': ['L', (x) => ['L', 'M', 'Q', 'H'].includes(x) && x || 'L'],
        }
        kwargs = Object.fromEntries(Object.entries<any>(defaults).map(([k, [v, validator]]) => [k, validator(kwargs[k] ?? v)]));
        kwargs['humanReadable'] = pop(kwargs, 'humanreadable');

        if (barcodeType == 'UPCA' && [11, 12, 13].includes(len(value))) {
            barcodeType = 'EAN13';
            if ([11, 12].includes(len(value))) {
                value = f('0%s', value);
            }
        }
        else if (barcodeType === 'auto') {
            const symbologyGuess = { 8: 'EAN8', 13: 'EAN13' }
            barcodeType = symbologyGuess[len(value)] ?? 'Code128';
        }
        else if (barcodeType === 'QR') {
            // for `QR` type, `quiet` is not supported. And is simply ignored.
            // But we can use `barBorder` to get a similar behaviour.
            if (kwargs['quiet']) {
                kwargs['barBorder'] = 0;
            }
        }
        if (['EAN8', 'EAN13'].includes(barcodeType) && !this.checkBarcodeEncoding(value, barcodeType.toLocaleLowerCase())) {
            // If the barcode does not respect the encoding specifications, convert its type into Code128.
            // Otherwise, the report-lab method may return a barcode different from its value. For instance,
            // if the barcode type is EAN-8 and the value 11111111, the report-lab method will take the first
            // seven digits and will compute the check digit, which gives: 11111115 -> the barcode does not
            // match the expected value.
            barcodeType = 'Code128';
        }
        try {
            const barcode = createBarcodeDrawing(barcodeType, value, 'png', kwargs);

            // If a mask is asked and it is available, call its function to
            // post-process the generated QR-code image
            if (kwargs['mask']) {
                const availableMasks = this.getAvailableBarcodeMasks();
                const maskToApply = availableMasks[kwargs['mask']];
                if (maskToApply) {
                    maskToApply(kwargs['width'], kwargs['height'], barcode);
                }
            }
            return barcode.toString();//'png');
        } catch (e) {
            // except (ValueError, AttributeError):
            if (barcodeType === 'Code128') {
                throw new ValueError("Cannot convert into barcode.");
            }
            else if (barcodeType === 'QR') {
                throw new ValueError("Cannot convert into QR code.");
            }
            else {
                return this.barcode('Code128', value, kwargs);
            }
        }
    }

    /**
     * Hook for extension.
        This function returns the available QR-code masks, in the form of a
        list of (code, mask_function) elements, where code is a string identifying
        the mask uniquely, and mask_function is a function returning a reportlab
        Drawing object with the result of the mask, and taking as parameters:
            - width of the QR-code, in pixels
            - height of the QR-code, in pixels
            - reportlab Drawing object containing the barcode to apply the mask on
     * @returns 
     */
    @api.model()
    getAvailableBarcodeMasks() {
        return {}
    }


    /**
     * Allow to render a QWeb template sevrer-side. This function returns the 'ir.ui.view'
        render but embellish it with some variables/methods used in reports.

     * @param template 
     * @param values additional methods/variables used in the rendering
     * @returns html representation of the template
     */
    async _renderTemplate(template, values?: any) {
        if (values == null) {
            values = {};
        }

        let context = Object.assign({}, this.env.context, { inheritBranding: false });

        // Browse the user instead of using the sudo self.env.user
        const user = this.env.items('res.users').browse(this.env.uid);
        const req = this.env.req;
        let website;
        if (req && req.params['website']) {
            if (req.params['website'] != null) {
                website = req.params['website'];
                context = Object.assign(context, { translatable: context['lang'] !== await (await this.env.items('ir.http')._getDefaultLang(req)).code });
            }
        }
        const viewObj = await (await this.env.items('ir.ui.view').sudo()).withContext(context);
        const self = await this.withContext({ tz: await user.tz });
        update(values, {
            toFormat: toFormat,
            contextTimestamp: (date: Date) => _Datetime.contextTimestamp(self, date),
            user: user,
            resCompany: await this.env.company(),
            website: website,
            webBaseUrl: await (await this.env.items('ir.config.parameter').sudo()).getParam('web.base.url', ''),
        })
        return viewObj._renderTemplate(template, values);
    }

    /**
    Merge the existing attachments by adding one by one the content of the attachments
        and then, we add the pdfContent if exists. Create the attachments for each record individually
        if required.
 
    * @param saveInAttachment The retrieved attachments as map record.id -> attachmentId.
    * @param pdfContent The pdf content newly generated by htmltoPdf.
    * @param resIds the ids of record to allow postprocessing.
    * @returns The pdf content of the merged pdf.
    */
    async _postPdf(saveInAttachment: OrderedDict<Uint8Array>, pdfContent?: Uint8Array, resIds?: any) {
        function closeStreams(streams) {
            for (const stream of streams) {
                try {
                    stream.close();
                } catch (e) {
                }
            }
        }

        // Check special case having only one record with existing attachment.
        // In that case, return directly the attachment content.
        // In that way, we also ensure the embedded files are well preserved.
        if (len(saveInAttachment) == 1 && !pdfContent) {
            return Object.values<any>(saveInAttachment)[0].getvalue();
        }
        // Create a list of streams representing all sub-reports part of the final result
        // in order to append the existing attachments and the potentially modified sub-reports
        // by the _postprocess_pdf_report calls.
        const streams = [];

        // In htmltoPdf has been called, we need to split the pdf in order to call the postprocess method.
        if (pdfContent) {
            let pdfContentStream = pdfContent;
            // Build a record_map mapping id -> record
            const recordMap = Object.fromEntries(await this.env.items(await this['model']).browse(resIds.filter(resId => bool(resId))).map(r => [r.id, r]));

            // If no value in attachment or no record specified, only append the whole pdf.
            if (!bool(recordMap) || !bool(await this['attachment'])) {
                streams.push(pdfContentStream);
            }
            else {
                if (len(resIds) == 1) {
                    // Only one record, so postprocess directly and append the whole pdf.
                    if (resIds[0] in recordMap && !(resIds[0] in saveInAttachment)) {
                        const newStream = await this._postprocessPdfReport(recordMap[resIds[0]], pdfContentStream);
                        // If the buffer has been modified, mark the old buffer to be closed as well.
                        if (newStream && !equal(newStream, pdfContentStream)) {
                            closeStreams([pdfContentStream]);
                            pdfContentStream = newStream;
                        }
                    }
                    streams.push(pdfContentStream);
                }
                else {
                    // In case of multiple docs, we need to split the pdf according the records.
                    // To do so, we split the pdf based on top outlines computed by htmltoPdf.
                    // An outline is a <h?> html tag found on the document. To retrieve this table,
                    // we look on the pdf structure using pypdf to compute the outlines_pages from
                    // the top level heading in /Outlines.
                    const reader = await PDFDocument.load(pdfContentStream);
                    const root: PDFCatalog = reader.catalog;
                    const outlinesPages = [];
                    const outlines = root.lookup(PDFName.of('Outlines')) as PDFDict;
                    if (outlines && outlines.has(PDFName.of('First'))) {
                        let node = outlines.get(PDFName.of('First')) as PDFDict;
                        while (true) {
                            const dests = root.lookup(PDFName.of('Dests')) as PDFDict;
                            const dest = node.get(PDFName.of('Dest'))
                            outlinesPages.push(dests.get(PDFName.of(dest.toString()))[0]);
                            if (!node.has(PDFName.of('Next'))) {
                                break;
                            }
                            node = node.get(PDFName.of('Next')) as PDFDict;
                        }
                        outlinesPages.sort();
                    }
                    // There should be only one top-level heading by document
                    // There should be a top-level heading on first page
                    if (outlinesPages.length == len(resIds) && outlinesPages[0] == 0) {
                        for (const [i, num] of enumerate(outlinesPages)) {
                            const to = i + 1 < outlinesPages.length ? outlinesPages[i + 1] : reader.getPageCount();
                            const attachmentWriter = await PDFDocument.create();
                            for (const j of range(num, to)) {
                                attachmentWriter.addPage(reader.getPage(j));
                            }
                            let stream = await attachmentWriter.save();
                            if (resIds[i] && !(resIds[i] in saveInAttachment)) {
                                const newStream = await this._postprocessPdfReport(recordMap[resIds[i]], stream);
                                // If the buffer has been modified, mark the old buffer to be closed as well.
                                if (newStream && !equal(newStream, stream)) {
                                    closeStreams([stream]);
                                    stream = newStream;
                                }
                            }
                            streams.push(stream);
                        }
                        closeStreams([pdfContentStream]);
                    }
                    else {
                        // We can not generate separate attachments because the outlines
                        // do not reveal where the splitting points should be in the pdf.
                        console.info('The PDF report can not be saved as attachment.')
                        streams.push(pdfContentStream);
                    }
                }
            }
        }
        // If attachment_use is checked, the records already having an existing attachment
        // are not been rendered by htmltoPdf. So, create a new stream for each of them.
        if (await this['attachmentUse']) {
            for (const stream of Object.values(saveInAttachment)) {
                streams.push(stream);
            }
        }

        // Build the final pdf.
        // If only one stream left, no need to merge them (and then, preserve embedded files).
        let result;
        if (streams.length == 1) {
            result = streams[0].getvalue();
        }
        else {
            try {
                result = await this._mergePdfs(streams);
            } catch (e) {
                // except utils.PdfReadError:
                throw new UserError(await this._t("One of the documents you are trying to merge is encrypted"))
            }
        }
        // We have to close the streams after PdfFileWriter's call to write()
        closeStreams(streams);
        return result;
    }

    async _getUnreadablePdfs(streams) {
        const unreadableStreams = [];

        for (const stream of streams) {
            /* ex:const { Readable } = require("stream")
             const readable = Readable.from(["input string"]);

             readable.on("data", (chunk) => {
                console.log(chunk) // will be called once with `"input string"`
             })
            */
            // const writer = new PdfFileWriter();
            // const resultStream = new Buffer();
            // try {
            //     const reader = new PdfFileReader(stream);
            //     writer.appendPagesFromReader(reader);
            //     writer.write(resultStream);
            // } catch(e) {
            //     unreadableStreams.push(stream);
            // }
        }
        return unreadableStreams;
    }

    async _raiseOnUnreadablePdfs(streams, streamRecord: Map<any, any>) {
        const unreadablePdfs = await this._getUnreadablePdfs(streams);
        if (bool(unreadablePdfs)) {
            const records = await Promise.all(unreadablePdfs.filter(s => streamRecord.has(s)).map(async (s) => streamRecord.get(s).label));
            throw new UserError(await this._t(
                "Verp is unable to merge the PDFs attached to the following records:\n \
                %s\n\n \
                Please exclude them from the selection to continue. It's possible to \
                still retrieve those PDFs by selecting each of the affected records \
                individually, which will avoid merging."), records.join('\n'));
        }
    }

    async _mergePdfs(streams: Uint8Array[]) {
        const writer = await PDFDocument.create();
        for (const stream of streams) {
            const reader = await PDFDocument.load(stream);
            const copiedPagesA = await writer.copyPages(reader, reader.getPageIndices());
            copiedPagesA.forEach((page) => writer.addPage(page));
        }
        const resultStream = await writer.save();
        streams.push(resultStream);
        return resultStream.valueOf();
    }

    /**
     * @param resIds 
     * @param data 
     * @returns 
     */
    async _renderQwebPdf(resIds?: any, data?: any) {
        if (!data) {
            data = {}
        }
        setdefault(data, 'reportType', 'pdf');

        // access the report details with sudo() but evaluation context as sudo(false)
        const selfSudo = await this.sudo();

        // In case of test environment without enough workers to perform calls to htmltoPdf,
        // fallback to renderHtml.
        if ((config.get('testEnable') || config.get('testFile')) && !this.env.context['forceReportRendering']) {
            return selfSudo._renderQwebHtml(resIds, data);
        }

        // As the assets are generated during the same transaction as the rendering of the
        // templates calling them, there is a scenario where the assets are unreachable: when
        // you make a request to read the assets while the transaction creating them is not done.
        // Indeed, when you make an asset request, the controller has to read the `ir.attachment`
        // table.
        // This scenario happens when you want to print a PDF report for the first time, as the
        // assets are not in cache and must be generated. To workaround this issue, we manually
        // commit the writes in the `ir.attachment` table. It is done thanks to a key in the context.
        const context = Object.assign({}, this.env.context);
        if (!config.get('testEnable') && !('commitAssetsbundle' in context)) {
            context['commitAssetsbundle'] = true;
        }
        // Disable the debug mode in the PDF rendering in order to not split the assets bundle
        // into separated files to load. This is done because of an issue in htmltoPdf
        // failing to load the CSS/Javascript resources in time.
        // Without this, the header/footer of the reports randomly disappear
        // because the resources files are not loaded in time.
        // https://github.com/htmltoPdf/htmltoPdf/issues/2083
        context['debug'] = false;

        const saveInAttachment = new OrderedDict();
        // Maps the streams in `save_in_attachment` back to the records they came from
        const streamRecord = new Map<any, any>();
        if (bool(resIds)) {
            // Dispatch the records by ones having an attachment and ones requesting a call to
            // htmltoPdf.
            const model = this.env.items(await selfSudo.model);
            const recordIds = model.browse(resIds);
            let wkRecordIds = model;
            if (await selfSudo.attachment) {
                for (const recordId of recordIds) {
                    const attachment = await selfSudo.retrieveAttachment(recordId);
                    if (attachment) {
                        const stream = await selfSudo._retrieveStreamFromAttachment(attachment);
                        saveInAttachment[recordId.id] = stream;
                        streamRecord.set(stream, recordId);
                    }
                    if (! await selfSudo.attachmentUse || !attachment) {
                        wkRecordIds = wkRecordIds.add(recordId);
                    }
                }
            }
            else {
                wkRecordIds = recordIds;
            }
            resIds = wkRecordIds.ids;
        }
        // A call to htmltoPdf is mandatory in 2 cases:
        // - The report is not linked to a record.
        // - The report is not fully present in attachments.
        if (bool(saveInAttachment) && !bool(resIds)) {
            console.info('The PDF report has been generated from attachments.');
            if (len(saveInAttachment) > 1) {
                await this._raiseOnUnreadablePdfs(Object.values(saveInAttachment), streamRecord);
            }
            return [await selfSudo._postPdf(saveInAttachment), 'pdf'];
        }

        if (this.getChromiumState() === 'install') {
            // htmltoPdf is not installed
            // the call should be catched before (cf /report/checkHtmltoPdf) but
            // if get_pdf is called manually (email template), the check could be
            // bypassed
            // throw new UserError(await this._t("Unable to find HtmltoPdf on this system. The PDF can not be created."));
        }

        const html = (await (await selfSudo.withContext(context))._renderQwebHtml(resIds, data))[0];

        const [bodies, htmlIds, header, footer, specificPaperformatArgs] = await (await selfSudo.withContext(context))._prepareHtml(html);

        if (await selfSudo.attachment && !equal(resIds, htmlIds)) {
            throw new UserError(await this._t("The report's template '%s' is wrong, please contact your administrator. \n\n \
                    Can not separate file to save as attachment because the report's template does not contains the attributes 'data-oe-model' and 'data-oe-id' on the div with 'article' classname.", await this['label']));
        }

        const pdfContent = await this._runPrintPdf(bodies, { header, footer, landscape: context['landscape'], specificPaperformatArgs: specificPaperformatArgs, setViewportSize: context['setViewportSize'] });
        if (bool(resIds)) {
            await this._raiseOnUnreadablePdfs(Object.values(saveInAttachment), streamRecord);
            console.info('The PDF report has been generated for model: %s, records %s.', await selfSudo.model, String(resIds));
            return [await selfSudo._postPdf(saveInAttachment, pdfContent, htmlIds), 'pdf'];
        }
        return [pdfContent, 'pdf'];
    }

    @api.model()
    async _renderQwebText(docids, data?: any) {
        if (!data) {
            data = {}
        }
        setdefault(data, 'reportType', 'text');
        setdefault(data, '__keepEmptyLines', true);
        data = await this._getRenderingContext(docids, data);
        return [await this._renderTemplate(await this['reportName'], data), 'text'];
    }

    /**
     * This method generates and returns html version of a report.
     * @param docids 
     * @param data 
     * @returns 
     */
    @api.model()
    async _renderQwebHtml(docids, data?: any) {
        if (!data) {
            data = {}
        }
        setdefault(data, 'reportType', 'html');
        data = await this._getRenderingContext(docids, data);
        return [await this._renderTemplate(await this['reportName'], data), 'html'];
    }

    async _getRenderingContextModel() {
        const reportModelName = await this['reportModelName'] || f('report.%s', await this['reportName']);
        return this.env.items(reportModelName);
    }

    async _getRenderingContext(docids, data) {
        // If the report is using a custom model to render its html, we must use it.
        // Otherwise, fallback on the generic html rendering.
        let reportModel = await this._getRenderingContextModel();

        data = Object.assign({}, data);

        if (reportModel != null) {
            // _render_ may be executed in sudo but evaluation context as real user
            reportModel = await reportModel.sudo(false);
            update(data, await reportModel._getReportValues(docids, data));
        }
        else {
            // _render_ may be executed in sudo but evaluation context as real user
            const docs = (await this.env.items(await this['model']).sudo(false)).browse(docids);
            update(data, {
                'docIds': docids,
                'docModel': await this['model'],
                'docs': docs,
            });
        }
        data['isHtmlEmpty'] = isHtmlEmpty;
        return data;
    }

    async _render(resIds, data?: any) {
        const reportType = (await this['reportType']).toLowercase().replace('-', '_');
        const renderFunc = this['_render' + UpCamelCase(reportType)];
        if (!renderFunc) {
            return null;
        }
        return renderFunc(resIds, data);
    }

    /**
     * Return an action of type ir.actions.report.
  
     * @param docIds id/ids/browse record of the records to print (if not used, pass an empty list)
     * @param data 
     * @param config 
     * @returns 
     */
    async reportAction(docIds, data?: any, config = true) {
        let context = this.env.context;
        let activeIds;
        if (docIds) {
            if (isInstance(docIds, models.Model)) {
                activeIds = docIds.ids;
            }
            else if (typeof (docIds) === 'number') {
                activeIds = [docIds];
            }
            else if (Array.isArray(docIds)) {
                activeIds = docIds;
            }
            context = Object.assign({}, this.env.context, { activeIds: activeIds });
        }

        const [reportName, reportType, reportFile, label] = await this('reportName', 'reportType', 'reportFile', 'label');
        const reportAction = {
            'context': context,
            'data': data,
            'type': 'ir.actions.report',
            'reportName': reportName,
            'reportType': reportType,
            'reportFile': reportFile,
            'label': label,
        }

        const discardLogoCheck = this.env.context['discardLogoCheck'];
        if (await this.env.isAdmin() && ! await (await this.env.company()).externalReportLayoutId && config && !discardLogoCheck) {
            return this._actionConfigureExternalReportLayout(reportAction);
        }

        return reportAction;
    }

    async _actionConfigureExternalReportLayout(reportAction) {
        const action = this.env.items("ir.actions.actions")._forXmlid("web.actionBaseDocumentLayoutConfigurator");
        const ctx = JSON.parse(action['context'] ?? '{}');
        reportAction['closeOnReportDownload'] = true;
        ctx['reportAction'] = reportAction;
        action['context'] = ctx;
        return action;
    }
}

function createBarcodeDrawing(barcodeType: any, value: any, format: string, opts: {} = {}) {
    console.warn('Function not implemented.');
    return '';
}
