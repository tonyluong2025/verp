import { Fields } from "../../../core";
import { Dict } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class LostReason extends Model {
    static _module = module;
    static _name = 'crm.lost.reason';
    static _description = 'Opp. Lost Reason';

    static label = Fields.Char('Description', { required: true, translate: true });
    static active = Fields.Boolean('Active', { default: true });
    static leadsCount = Fields.Integer('Leads Count', { compute: '_computeLeadsCount' });

    async _computeLeadsCount() {
        const leadData = await (await this.env.items('crm.lead').withContext({ activeTest: false })).readGroup([['lostReason', 'in', this.ids]], ['lostReason'], ['lostReason']);
        const mappedData = Dict.from(leadData.map(data => [data['lostReason'][0], data['lostReasonCount']]));
        for (const reason of this) {
            await reason.set('leadsCount', mappedData.get(reason.id, 0));
        }
    }

    async actionLostLeads() {
        return {
            'label': await this._t('Leads'),
            'viewMode': 'tree,form',
            'domain': [['lostReason', 'in', this.ids]],
            'resModel': 'crm.lead',
            'type': 'ir.actions.actwindow',
            'context': { 'create': false, 'activeTest': false },
        }
    }
}