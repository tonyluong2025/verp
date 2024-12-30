import { getattr } from "../../../core/api/func";
import { Fields } from "../../../core/fields";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class IrModelField extends Model {
    static _module = module;
    static _parents = 'ir.model.fields';

    static tracking = Fields.Integer({
        string: "Enable Ordered Tracking",
        help:"If set every modification done to this field is tracked in the chatter. Value is used to order tracking values.",
    });

    /**
     * Tracking value can be either a boolean enabling tracking mechanism
        on field, either an integer giving the sequence. Default sequence is
        set to 100.
     * @param field 
     * @param modelId 
     * @returns 
     */
    async _reflectFieldParams(field, modelId) {
        const vals = await _super(IrModelField, this)._reflectFieldParams(field, modelId);
        let tracking = getattr(field, 'tracking', null);
        if (tracking == true) {
            tracking = 100;
        }
        else if (tracking === false) {
            tracking = null;
        }
        vals['tracking'] = tracking;
        return vals;
    }

    async _instanciateAttrs(fieldData) {
        const attrs = await _super(IrModelField, this)._instanciateAttrs(fieldData);
        if (bool(attrs) && fieldData['tracking']) {
            attrs['tracking'] = fieldData['tracking'];
        }
        return attrs;
    }
}