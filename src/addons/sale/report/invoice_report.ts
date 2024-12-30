import { Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountInvoiceReport extends Model {
    static _module = module;
    static _parents = 'account.invoice.report';

    static teamId = Fields.Many2one('crm.team', {string: 'Sales Team'});

    async _select() {
        return (await _super(AccountInvoiceReport, this)._select()) + `, move."teamId" as "teamId"`;
    }
}