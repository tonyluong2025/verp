import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class MailMessage extends Model {
    static _module = module;
    static _parents = 'mail.message';

    async _portalMessageFormat(fieldList) {
        // inlude rating value in data if requested
        if (this._context['ratingInclude']) {
            fieldList = fieldList.concat(['ratingValue']);
        }
        return _super(MailMessage, this)._portalMessageFormat(fieldList);
    }

    /**
     * Override the method to add information about a publisher comment
        on each rating messages if requested, and compute a plaintext value of it.
     * @param fnames 
     * @param formatReply 
     * @returns 
     */
    async _messageFormat(fnames, formatReply=true) {
        const valsList = await _super(MailMessage, this)._messageFormat(fnames, formatReply);

        if (this._context['ratingInclude']) {
            const infos = ["id", "publisherComment", "publisherId", "publisherDatetime", "messageId"];
            const relatedRating = await (await (await this.env.items('rating.rating').sudo()).search([['messageId', 'in', this.ids]])).read(infos);
            const midRatingTree = Object.fromEntries(relatedRating.map(rating => [rating['messageId'][0], rating]));
            for (const vals of valsList) {
                vals["rating"] = midRatingTree[vals['id']] ?? {};
            }
        }
        return valsList;
    }
}