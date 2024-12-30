import { api } from "../../../core";
import { _super, AbstractModel, MetaModel } from "../../../core/models"
import { parseFloat, pop } from "../../../core/tools";

@MetaModel.define()
class MailThread extends AbstractModel {
    static _module = module;
    static _parents = 'mail.thread';

    @api.returns('mail.message', (value) => value.id)
    async messagePost(opts) {
        const ratingValue = pop(opts, 'ratingValue', false);
        const ratingFeedback = pop(opts, 'ratingFeedback', false);
        const message = await _super(MailThread, this).messagePost(opts);

        // create rating.rating record linked to given rating_value. Using sudo as portal users may have
        // rights to create messages and therefore ratings (security should be checked beforehand)
        if (ratingValue) {
            await (await this.env.items('rating.rating').sudo()).create({
                'rating': ratingValue != null ? parseFloat(ratingValue) : false,
                'feedback': ratingFeedback,
                'resModelId': await this.env.items('ir.model')._getId(this._name),
                'resId': this.id,
                'messageId': message.id,
                'consumed': true,
                'partnerId': (await (await this.env.user()).partnerId).id,
            });
        }
        return message;
    }
}
