import { randomInt } from "crypto";
import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

/**
 * Stage for utm campaigns.
 */
@MetaModel.define()
class UtmStage extends Model {
    static _module = module;
    static _name = 'utm.stage';
    static _description = 'Campaign Stage';
    static _order = 'sequence';

    static label = Fields.Char({required: true, translate: true});
    static sequence = Fields.Integer();
}

@MetaModel.define()
class UtmMedium extends Model {
    static _module = module;
    static _name = 'utm.medium';
    static _description = 'UTM Medium';
    static _order = 'label';

    static label = Fields.Char({string: 'Medium Name', required: true});
    static active = Fields.Boolean({default: true});
}

@MetaModel.define()
class UtmCampaign extends Model {
    static _module = module;
    static _name = 'utm.campaign';
    static _description = 'UTM Campaign';

    static label = Fields.Char({string: 'Campaign Name', required: true, translate: true});

    static userId = Fields.Many2one('res.users', {string: 'Responsible',
        required: true, default: self => self.env.uid});
    static stageId = Fields.Many2one('utm.stage', {string: 'Stage', ondelete: 'RESTRICT', required: true,
        default: self => self.env.items('utm.stage').search([], {limit: 1}),
        groupExpand: '_groupExpandStageIds'});
    static tagIds = Fields.Many2many('utm.tag', {relation: 'utmTagRel', column1: 'tagId', column2: 'campaignId', string: 'Tags'});

    static isAutoCampaign = Fields.Boolean({default: false, string: "Automatically Generated Campaign", help: "Allows us to filter relevant Campaigns"});
    static color = Fields.Integer({string: 'Color Index'});

    /**
     * Read group customization in order to display all the stages in the
            kanban view, even if they are empty
     * @param stages 
     * @param domain 
     * @param order 
     * @returns 
     */
    @api.model()
    async _groupExpandStageIds(stages, domain, order) {
        const stageIds = await stages._search([], {order: order, accessRightsUid: global.SUPERUSER_ID});
        return stages.browse(stageIds);
    }
}

@MetaModel.define()
class UtmSource extends Model {
    static _module = module;
    static _name = 'utm.source';
    static _description = 'UTM Source';

    static label = Fields.Char({string: 'Source Name', required: true, translate: true});
}

/**
 * Model of categories of utm campaigns, i.e. marketing, newsletter, ...
 */
@MetaModel.define()
class UtmTag extends Model {
    static _module = module;
    static _name = 'utm.tag';
    static _description = 'UTM Tag';
    static _order = 'label';

    async _defaultColor() {
        return randomInt(1, 11);
    }

    static label = Fields.Char({required: true, translate: true});
    static color = Fields.Integer({string: 'Color Index', default: self => self._defaultColor(),
        help: 'Tag color. No color means no display in kanban to distinguish internal tags from public categorization tags.'});

    static _sqlConstraints = [
        ['label_uniq', 'unique (label)', "Tag label already exists !"],
    ];
}