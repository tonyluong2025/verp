import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { len, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { reOpen } from "../../../core/tools/mail";
import { getLang } from "../../../core/tools/models";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountInvoiceSend extends TransientModel {
    static _module = module;
    static _name = 'account.invoice.send';
    static _inherits = { 'mail.compose.message': 'composerId' };
    static _description = 'Account Invoice Send';

    static isEmail = Fields.Boolean('Email', { default: async (self) => (await self.env.company()).invoiceIsEmail });
    static invoiceWithoutEmail = Fields.Text({ compute: '_computeInvoiceWithoutEmail', string: 'invoice(s) that will not be sent' });
    static isPrint = Fields.Boolean('Print', { default: async (self) => (await self.env.company()).invoiceIsPrint });
    static printed = Fields.Boolean('Is Printed', { default: false });
    static invoiceIds = Fields.Many2many('account.move', { relation: 'accountMoveAccountInvoiceSendRel', string: 'Invoices' });
    static composerId = Fields.Many2one('mail.compose.message', { string: 'Composer', required: true, ondelete: 'CASCADE' });
    static templateId = Fields.Many2one(
        'mail.template', {
        string: 'Use template', index: true,
        domain: "[['model', '=', 'account.move']]"
    });

    // View fields
    static moveTypes = Fields.Char({
        string: 'Move types',
        compute: '_computeMoveTypes',
        readonly: true,
        help: ['Technical field containing a textual representation of the selected move types, ',
            'if multiple. It is used to inform the user in the window in such case.'].join()
    });

    @api.model()
    async defaultGet(fields) {
        const res = await _super(AccountInvoiceSend, this).defaultGet(fields);
        const resIds = this._context['activeIds'];

        const invoices = await this.env.items('account.move').browse(resIds).filtered(async (move) => move.isInvoice(true));
        if (!bool(invoices)) {
            throw new UserError(await this._t("You can only send invoices."));
        }

        const composer = await this.env.items('mail.compose.message').create({
            'compositionMode': len(resIds) == 1 ? 'comment' : 'massMail',
        })
        update(res, {
            'invoiceIds': resIds,
            'composerId': composer.id,
        })
        return res;
    }

    @api.onchange('invoiceIds')
    async _computeCompositionMode() {
        for (const wizard of this) {
            await (await wizard.composerId).set('compositionMode', len(await wizard.invoiceIds) == 1 ? 'comment' : 'massMail');
        }
    }

    @api.onchange('invoiceIds')
    async _computeMoveTypes() {
        for (const wizard of this) {
            let moveTypes: any;

            if (len(await wizard.invoiceIds) > 1) {
                const moves = this.env.items('account.move').browse(this.env.context['activeIds']);

                // Get the move types of all selected moves and see if there is more than one of them.
                // If so, we'll display a warning on the next window about it.
                const moveTypesSet = new Set(await moves.map(m => m.typeName));

                if (len(moveTypesSet) > 1) {
                    moveTypes = Array.from(moveTypesSet).join(', ');
                }
            }

            await wizard.set('moveTypes', moveTypes);
        }
    }

    @api.onchange('templateId')
    async onchangeTemplateId() {
        for (const wizard of this) {
            const composerId = await wizard.composerId;
            if (composerId.ok) {
                await composerId.set('templateId', (await wizard.templateId).id);
                await wizard._computeCompositionMode();
                await composerId._onchangeTemplateIdWrapper();
            }
        }
    }

    @api.onchange('isEmail')
    async onchangeIsEmail() {
        if (await this['isEmail']) {
            const resIds = this._context['activeIds'];
            const [composerId, templateId] = await this('composerId', 'templateId');
            if (!composerId.ok) {
                await this.set('composerId', await this.env.items('mail.compose.message').create({
                    'compositionMode': len(resIds) == 1 ? 'comment' : 'massMail',
                    'templateId': templateId.id
                }));
            }
            else {
                await composerId.set('compositionMode', len(resIds) == 1 ? 'comment' : 'massMail');
                await composerId.set('templateId', templateId.id);
                await this._computeCompositionMode();
            }
            await composerId._onchangeTemplateIdWrapper();
        }
    }

    @api.onchange('isEmail')
    async _computeInvoiceWithoutEmail() {
        for (const wizard of this) {
            if (await wizard.isEmail && len(await wizard.invoiceIds) > 1) {
                const invoices = await this.env.items('account.move').search([
                    ['id', 'in', this.env.context['activeIds']],
                    ['partnerId.email', '=', false]
                ]);
                if (invoices.ok) {
                    await wizard.set('invoiceWithoutEmail', f("%s\n%s",
                        await this._t("The following invoice(s) will not be sent by email, because the customers don't have email address."),
                        (await invoices.map(async (i) => i.label)).join('\n')
                    )
                    );
                }
                else {
                    await wizard.set('invoiceWithoutEmail', false);
                }
            }
            else {
                await wizard.set('invoiceWithoutEmail', false);
            }
        }
    }

    async _sendEmail() {
        if (await this['isEmail']) {
            const [composerId] = await this('composerId');
            // with_context : we don't want to reimport the file we just exported.
            await (await composerId.withContext({
                noNewInvoice: true,
                mailNotifyAuthor: (await composerId.partnerIds).includes(await (await this.env.user()).partnerId),
                mailingDocumentBased: true,
            }))._actionSendMail();
            if (this.env.context['markInvoiceAsSent']) {
                //Salesman send posted invoice, without the right to write
                //but they should have the right to change this flag
                await (await (await this.mapped('invoiceIds')).sudo()).write({ 'isMoveSent': true });
            }
        }
    }

    /**
     * to override for each type of models that will use this composer.
     * @returns 
     */
    async _printDocument() {
        this.ensureOne();
        const action = await (await this['invoiceIds']).actionInvoicePrint();
        update(action, { 'closeOnReportDownload': true });
        return action;
    }

    async sendAndPrintAction() {
        this.ensureOne();
        // Send the mails in the correct language by splitting the ids per lang.
        // This should ideally be fixed in mail_compose_message, so when a fix is made there this whole commit should be reverted.
        // basically self.body (which could be manually edited) extracts self.template_id,
        // which is then not translated for each customer.
        if (await this['compositionMode'] === 'massMail' && (await this['templateId']).ok) {
            const activeIds = this.env.context['activeIds'] ?? await this['resId'];
            const activeRecords = this.env.items(await this['model']).browse(activeIds);
            const langs = await activeRecords.mapped('partnerId.lang');
            const defaultLang = await getLang(this.env);
            for (const lang of (len(langs) ? langs : [defaultLang])) {
                const activeIdsLang = (await activeRecords.filtered(async (r) => await (await r.partnerId).lang == lang)).ids;
                const selfLang = await this.withContext({ activeIds: activeIdsLang, lang: lang });
                await selfLang.onchangeTemplateId();
                await selfLang._sendEmail();
            }
        }
        else {
            await this._sendEmail();
        }
        if (await this['isPrint']) {
            return this._printDocument();
        }
        return { 'type': 'ir.actions.actwindow.close' }
    }

    async saveAsTemplate() {
        this.ensureOne();
        const [composerId] = await this('composerId');
        await composerId.actionSaveAsTemplate();
        await this.set('templateId', (await composerId.templateId).id);
        const action = reOpen(this, this.id, await this['model'], this._context);
        update(action, { 'label': await this._t('Send Invoice') })
        return action;
    }
}