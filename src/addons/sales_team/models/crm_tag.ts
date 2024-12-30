import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";
import { getRandom } from "../../../core/tools";

@MetaModel.define()
class Tag extends Model {
    static _module = module;
    static _name = "crm.tag";
    static _description = "CRM Tag";

    _getDefaultColor() {
        return getRandom(1, 11);
    }

    static label = Fields.Char('Tag Name', {required: true, translate: true});
    static color = Fields.Integer('Color', {default: self => self._getDefaultColor()})

    static _sqlConstraints = [
        ['label_uniq', 'unique (label)', "Tag name already exists !"],
    ]
}