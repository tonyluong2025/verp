import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class SnailmailConfirmInvoiceSend extends TransientModel {
    static _module = module;
    static _name = 'snailmail.confirm.invoice';
    static _parents = ['snailmail.confirm'];
    static _description = 'Snailmail Confirm Invoice';

    static invoiceSendId = Fields.Many2one('account.invoice.send');

    async _confirm() {
        this.ensureOne();
        await (await this['invoiceSendId'])._printAction();
    }

    async _continue() {
        this.ensureOne();
        return (await this['invoiceSendId']).sendAndPrint();
    }
}