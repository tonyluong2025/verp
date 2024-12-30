import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Page extends Model {
    static _module = module;
    static _parents = 'website.page';

    async _getCachedBlacklist() {
        return (await _super(Page, this)._getCachedBlacklist()).concat([
            // Contains a form with a dynamically added CSRF token
            'data-snippet="sDonation"',
        ]);
    }
}
