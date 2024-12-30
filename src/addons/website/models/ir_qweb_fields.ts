import { api } from "../../../core";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { update } from "../../../core/tools";

@MetaModel.define()
class ContactConverter extends AbstractModel {
    static _module = module;
    static _parents = 'ir.qweb.field.contact';

    @api.model()
    async getAvailableOptions() {
        const options = await _super(ContactConverter, this).getAvailableOptions();
        update(options, {
            websiteDescription: {type: 'boolean', string: await this._t('Display the website description')},
            userBio: {type: 'boolean', string: await this._t('Display the biography')},
            badges: {type: 'boolean', string: await this._t('Display the badges')}
        });
        return options;
    }
}