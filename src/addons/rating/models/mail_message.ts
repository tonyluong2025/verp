import { api, Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class MailMessage extends Model {
    static _module = module;
    static _parents = 'mail.message';

    static ratingIds = Fields.One2many('rating.rating', 'messageId', {groups: 'base.groupUser', string: 'Related ratings'});
    static ratingValue = Fields.Float(
        'Rating Value', {compute: '_computeRatingValue', computeSudo: true,
        store: false, search: '_searchRatingValue'});

    @api.depends('ratingIds', 'ratingIds.rating')
    async _computeRatingValue() {
        const ratings = await this.env.items('rating.rating').search([['messageId', 'in', this.ids], ['consumed', '=', true]], {order: 'createdAt DESC'});
        const mapping = Object.fromEntries(await ratings.map(async (r) => [(await r.messageId).id, await r.rating]));
        for (const message of this) {
            await message.set('ratingValue', mapping[message.id] ?? 0.0);
        }
    }

    async _searchRatingValue(operator, operand) {
        const ratings = await (await this.env.items('rating.rating').sudo()).search([
            ['rating', operator, operand],
            ['messageId', '!=', false]
        ]);
        return [['id', 'in', (await ratings.mapped('messageId')).ids]];
    }
}
