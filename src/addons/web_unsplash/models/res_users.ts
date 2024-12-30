import assert from "assert";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ResUsers extends Model {
    static _module = module;
    static _parents = 'res.users';

    async _hasUnsplashKeyRights(mode='write') {
        this.ensureOne();
        // Website has no dependency to web_unsplash, we cannot warranty the order of the execution
        // of the overwrite done in 5ef8300.
        // So to avoid to create a new module bridge, with a lot of code, we prefer to make a check
        // here for website's user.
        assert(['read', 'write'].includes(mode));
        const websiteGroupRequired = (mode == 'write') && 'website.groupWebsiteDesigner' || 'website.groupWebsitePublisher';
        return this.hasGroup('base.groupErpManager') || this.hasGroup(websiteGroupRequired);
    }
}
