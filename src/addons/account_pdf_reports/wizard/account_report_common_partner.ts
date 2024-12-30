import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { update } from "../../../core/tools";

@MetaModel.define()
class AccountingCommonPartnerReport extends TransientModel {
    static _module = module;
    static _name = 'account.common.partner.report';
    static _parents = "account.common.report";
    static _description = 'Account Common Partner Report';

    static resultSelection = Fields.Selection([['customer', 'Receivable Accounts'],
                                         ['supplier', 'Payable Accounts'],
                                         ['customerSupplier', 'Receivable and Payable Accounts']
                                         ], {string: "Partner's", required: true, default: 'customer'});
    static partnerIds = Fields.Many2many('res.partner', {string: 'Partners'});

    async prePrintReport(data) {
        update(data['form'], await this.readOne(['resultSelection']));
        update(data['form'], {'partnerIds': (await this['partnerIds']).ids});
        return data;
    }
}