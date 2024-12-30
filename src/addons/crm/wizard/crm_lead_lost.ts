import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class CrmLeadLost extends TransientModel {
    static _module = module;
    static _name = 'crm.lead.lost';
    static _description = 'Get Lost Reason';

    static lostReasonId = Fields.Many2one('crm.lost.reason', {string: 'Lost Reason'});

    async actionLostReasonApply() {
        const leads = await this.env.items('crm.lead').browse(this.env.context['activeIds']);
        return leads.actionSetLost({lostReason: (await this['lostReasonId']).id});
    }
}