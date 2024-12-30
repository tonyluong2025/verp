import { Fields, api } from "../../../core";
import { Dict } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class CalendarEvent extends Model {
    static _module = module;
    static _parents = 'calendar.event';
        
    @api.model()
    async defaultGet(fields) {
        let self = this;
        if (this.env.context['default_opportunityId']) {
            self = await self.withContext({
                default_resModelId: (await this.env.ref('crm.model_crmLead')).id,
                default_res: this.env.context['default_opportunityId']
            });
        }
        const defaults = await _super(CalendarEvent, self).defaultGet(fields);

        // sync resModel / resId to opportunity id (aka creating meeting from lead chatter)
        if (!('opportunityId' in defaults)) {
            if (await self._isCrmLead(defaults, self.env.context)) {
                defaults['opportunityId'] = defaults.get('resId', false) || (self.env.context['default_resId'] ?? false);
            }
        }
        return defaults;
    }

    static opportunityId = Fields.Many2one(
        'crm.lead', {
            string: 'Opportunity', domain: "[['type', '=', 'opportunity']]",
        index: true, ondelete: 'SET NULL'
    });

    async _computeIsHighlighted() {
        await _super(CalendarEvent, this)._computeIsHighlighted();
        if (this.env.context['activeModel'] === 'crm.lead') {
            const opportunityId = this.env.context['activeId'];
            for (const event of this) {
                if ((await event.opportunityId).id == opportunityId) {
                    await event.set('isHighlighted', true);
                }
            }
        }
    }

    @api.modelCreateMulti()
    async create(vals) {
        const events = await _super(CalendarEvent, this).create(vals);
        for (const event of events) {
            const [opportunityId, activityIds] = await event('opportunityId', 'activityIds');
            if (bool(opportunityId) && !bool(activityIds)) {
                const [label, start, duration] = await event('label', 'start', 'duration');
                await opportunityId.logMeeting(label, start, duration);
            }
        }
        return events;
    }

    /**
     *  This method checks if the concerned model is a CRM lead.
            The information is not always in the defaults values,
            this is why it is necessary to check the context too.
 
     * @param defaults 
     * @param ctx 
     * @returns 
     */
    async _isCrmLead(defaults: Dict<any>, ctx?: any) {
        const resModel = defaults.get('resModel', false) || ctx && ctx['default_resModel'];
        const resModelId = defaults.get('resModelId', false) || ctx && ctx['default_resModelId'];

        return resModel && resModel === 'crm.lead' || resModelId && await (await this.env.items('ir.model').sudo()).browse(resModelId).model === 'crm.lead';
    }
}
