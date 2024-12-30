import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { update } from "../../../core/tools";

@MetaModel.define()
class AccountCommonAccountReport extends TransientModel {
    static _module = module;
    static _name = 'account.common.account.report';
    static _parents = "account.common.report";
    static _description = 'Account Common Account Report';

    static displayAccount = Fields.Selection([['all', 'All'], 
                                        ['movement', 'With movements'],
                                        ['notZero', 'With balance is not equal to 0']],
                                       {string: 'Display Accounts',
                                       required: true, default: 'movement'});
    static analyticAccountIds = Fields.Many2many('account.analytic.account', 
                                            {string: 'Analytic Accounts'});
    static accountIds = Fields.Many2many('account.account', {string: 'Accounts'});
    static partnerIds = Fields.Many2many('res.partner', {string: 'Partners'});

    async prePrintReport(data) {
        update(data['form'], await this.readOne(['displayAccount']));
        update(data['form'], {
            'analyticAccountIds': (await this['analyticAccountIds']).ids,
            'partnerIds': (await this['partnerIds']).ids,
            'accountIds': (await this['accountIds']).ids,
        })
        return data;
    }
}
