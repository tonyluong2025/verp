import { readFile } from "fs/promises";
import { api, Fields } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models";
import { getResourcePath } from "../../../core/modules";
import { b64encode, bool, f, update } from "../../../core/tools";
import {v4 as uuid4} from 'uuid';

export const RATING_LIMIT_SATISFIED = 5;
export const RATING_LIMIT_OK = 3;
export const RATING_LIMIT_MIN = 1;

@MetaModel.define()
class Rating extends Model {
    static _module = module;
    static _name = "rating.rating";
    static _description = "Rating";
    static _order = 'updatedAt desc';
    static _recName = 'resName';
    
    static _sqlConstraints = [
        ['ratingRange', 'check(rating >= 0 and rating <= 5)', 'Rating should be between 0 and 5'],
    ];

    @api.depends('resModel', 'resId')
    async _computeResName() {
        for (const rating of this) {
            const label = (await this.env.items(await rating.resModel).sudo()).browse(await rating.resId).nameGet();
            await rating.set('resName', bool(label) && label[0][1] || f('%s/%s', await rating.resModel, await rating.resId));
        }
    }

    @api.model()
    async _defaultAccessToken() {
        return uuid4();
    }

    @api.model()
    async _selectionTargetModel() {
        return (await (await this.env.items('ir.model').sudo()).search([])).map(async (model) => [await model.model, await model.label]);
    }

    static createdAt = Fields.Datetime({string: "Submitted on"});
    static resName = Fields.Char({string: 'Resource name', compute: '_computeResName', store: true, help: "The name of the rated resource."});
    static resModelId = Fields.Many2one('ir.model', {string: 'Related Document Model', index: true, ondelete: 'CASCADE', help: 'Model of the followed resource'});
    static resModel = Fields.Char({string: 'Document Model', related: 'resModelId.model', store: true, index: true, readonly: true});
    static resId = Fields.Integer({string: 'Document', required: true, help: "Identifier of the rated object", index: true});
    static resourceRef = Fields.Reference({
        string: 'Resource Ref', selection: '_selectionTargetModel',
        compute: '_computeResourceRef', readonly: true});
    static parentResName = Fields.Char('Parent Document Name', {compute: '_computeParentResName', store: true});
    static parentResModelId = Fields.Many2one('ir.model', {string: 'Parent Related Document Model', index: true, ondelete: 'CASCADE'});
    static parentResModel = Fields.Char('Parent Document Model', {store: true, related: 'parentResModelId.model', index: true, readonly: false});
    static parentResId = Fields.Integer('Parent Document', {index: true});
    static parentRef = Fields.Reference(
        {string: 'Parent Ref', selection: '_selectionTargetModel',
        compute: '_computeParentRef', readonly: true});
    static ratedPartnerId = Fields.Many2one('res.partner', {string: "Rated Operator", help: "Owner of the rated resource"});
    static ratedPartnerName = Fields.Char({related: "ratedPartnerId.label"});
    static partnerId = Fields.Many2one('res.partner', {string: 'Customer', help: "Author of the rating"});
    static rating = Fields.Float({string: "Rating Value", groupOperator: "avg", default: 0, help: "Rating value: 0=Unhappy, 5=Happy"});
    static ratingImage = Fields.Binary('Image', {compute: '_computeRatingImage'});
    static ratingText = Fields.Selection([
        ['top', 'Satisfied'],
        ['ok', 'Okay'],
        ['ko', 'Dissatisfied'],
        ['none', 'No Rating yet']], {string: 'Rating', store: true, compute: '_computeRatingText', readonly: true});
    static feedback = Fields.Text('Comment', {help: "Reason of the rating"});
    static messageId = Fields.Many2one(
        'mail.message', {string: "Message",
        index: true, ondelete: 'CASCADE',
        help: "Associated message when posting a review. Mainly used in website addons."});
    static isInternal = Fields.Boolean('Visible Internally Only', {readonly: false, related: 'messageId.isInternal', store: true});
    static accessToken = Fields.Char('Security Token', {default: self => self._defaultAccessToken(), help: "Access token to set the rating of the value"});
    static consumed = Fields.Boolean({string: "Filled Rating", help: "Enabled if the rating has been filled."});

    @api.depends('resModel', 'resId')
    async _computeResourceRef() {
        for (const rating of this) {
            if (await rating.resModel && await rating.resModel in this.env.models) {
                await rating.set('resourceRef', f('%s,%s', await rating.resModel, await rating.resId || 0));
            }
            else {
                await rating.set('resourceRef', null);
            }
        }
    }

    @api.depends('parentResModel', 'parentResId')
    async _computeParentRef() {
        for (const rating of this) {
            if (await rating.parentResModel && await rating.parentResModel in this.env.models) {
                await rating.set('parentRef', f('%s,%s', await rating.parentResModel, (await rating.parentResId).ok ? await rating.parentResId : 0));
            }
            else {
                await rating.set('parentRef', null);
            }
        }
    }

    @api.depends('parentResModel', 'parentResId')
    async _computeParentResName() {
        for (const rating of this) {
            let name = false;
            if (await rating.parentResModel && (await rating.parentResId).ok) {
                name = await (await this.env.items(await rating.parentResModel).sudo()).browse(await rating.parentResId).nameGet();
                name = bool(name) && name[0][1] || f('%s/%s', await rating.parentResModel, await rating.parentResId);
            }
            await rating.set('parentResName', name);
        }
    }

    async _getRatingImageFilename() {
        this.ensureOne();
        const rating = await this['rating'];
        let ratingInt;
        if (rating >= RATING_LIMIT_SATISFIED) {
            ratingInt = 5;
        }
        else if (rating >= RATING_LIMIT_OK) {
            ratingInt = 3;
        }
        else if (rating >= RATING_LIMIT_MIN) {
            ratingInt = 1;
        }
        else {
            ratingInt = 0;
        }
        return f('rating_%s.png', ratingInt);
    }

    async _computeRatingImage() {
        for (const rating of this) {
            try {
                const imagePath = getResourcePath('rating', 'static/src/img', await rating._getRatingImageFilename());
                await rating.set('ratingImage', imagePath ? b64encode(await readFile(imagePath)) : false);
            } catch(e) {
                await rating.set('ratingImage', false);
            }
        }
    }

    @api.depends('rating')
    async _computeRatingText() {
        for (const rating of this) {
            const rate = await rating.rating;
            if (rate >= RATING_LIMIT_SATISFIED) {
                await rating.set('ratingText', 'top');
            }
            else if (rate >= RATING_LIMIT_OK) {
                await rating.set('ratingText', 'ok');
            }
            else if (rate >= RATING_LIMIT_MIN) {
                await rating.set('ratingText', 'ko');
            }
            else {
                await rating.set('ratingText', 'none');
            }
        }
    }

    @api.modelCreateMulti()
    async create(valsList) {
        for (const values of valsList) {
            if (values['resModelId'] && values['resId']) {
                update(values, await this._findParentData(values));
            }
        }
        return _super(Rating, this).create(valsList);
    }

    async write(values) {
        if (values['resModelId'] && values['resId']) {
            update(values, await this._findParentData(values));
        }
        return _super(Rating, this).write(values);
    }

    async unlink() {
        await (await this.env.items('mail.message').search([['ratingIds', 'in', this.ids]])).unlink();
        return _super(Rating, this).unlink();
    }

    /**
     * Determine the parent res_model/res_id, based on the values to create or write
     * @param values 
     * @returns 
     */
    async _findParentData(values) {
        const currentModelName = await (await this.env.items('ir.model').sudo()).browse(values['resModelId']).model;
        const currentRecord = this.env.items(currentModelName).browse(values['resId']);
        const data = {
            'parentResModelId': false,
            'parentResId': false,
        }
        if (typeof currentRecord['_ratingGetParentFieldName'] === 'function') {
            const currentRecordParent = await currentRecord._ratingGetParentFieldName();
            if (bool(currentRecordParent)) {
                const parentResModel = await currentRecord[currentRecordParent];
                data['parentResModelId'] = (await this.env.items('ir.model')._get(parentResModel._name)).id;
                data['parentResId'] = parentResModel.id;
            }
        }
        return data;
    }

    async reset() {
        for (const record of this) {
            await record.write({
                'rating': 0,
                'accessToken': await record._defaultAccessToken(),
                'feedback': false,
                'consumed': false,
            });
        }
    }

    async actionOpenRatedObject() {
        this.ensureOne();
        return {
            'type': 'ir.actions.actwindow',
            'resModel': await this['resModel'],
            'resId': await this['resId'],
            'views': [[false, 'form']]
        }
    }
}
