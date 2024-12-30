import { _Datetime, Fields } from "../../../core";
import { AccessError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Rating extends Model {
    static _module = module;
    static _parents = 'rating.rating';

    // Adding information for comment a rating message
    static publisherComment = Fields.Text("Publisher comment");
    static publisherId = Fields.Many2one('res.partner', {string: 'Commented by', ondelete: 'SET NULL', readonly: true});
    static publisherDatetime = Fields.Datetime("Commented on", {readonly: true});

    async write(values) {
        if (values['publisherComment']) {
            const user = await this.env.user();
            if (! await user.hasGroup("website.groupWebsitePublisher")) {
                throw new AccessError(await this._t("Only the publisher of the website can change the rating comment"));
            }
            if (! values['publisherDatetime']) {
                values['publisherDatetime'] = _Datetime.now();
            }
            if (! values['publisherId']) {
                values['publisherId'] = (await user.partnerId).id;
            }
        }
        return _super(Rating, this).write(values);
    }
}