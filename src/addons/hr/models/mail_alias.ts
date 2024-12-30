import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class Alias extends Model {
    static _module = module;
    static _parents = 'mail.alias';

    static aliasContact = Fields.Selection({
        selectionAdd: [
            ['employees', 'Authenticated Employees'],
        ], ondelete: { 'employees': 'CASCADE' }
    });

    async _getAliasContactDescription() {
        if (await this['aliasContact'] === 'employees') {
            return this._t('addresses linked to registered employees');
        }
        return _super(Alias, this)._getAliasContactDescription();
    }
}