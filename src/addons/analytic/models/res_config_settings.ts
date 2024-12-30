import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static groupAnalyticAccounting = Fields.Boolean({string: 'Analytic Accounting', impliedGroup: 'analytic.groupAnalyticAccounting'});
}