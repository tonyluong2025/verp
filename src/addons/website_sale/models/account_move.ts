import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = 'account.move';

    static websiteId = Fields.Many2one('website', {related: 'partnerId.websiteId', string: 'Website',
                                 help: 'Website through which this invoice was created.',
                                 store: true, readonly: true, tracking: true});
}
