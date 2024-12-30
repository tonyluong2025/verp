import _ from "lodash";
import { api } from "../../..";
import { AbstractModel } from "../../../models"
import { MetaModel } from "../../../models"
import { UpCamelCase, _toHyphen, bool, sorted } from "../../../tools";

@MetaModel.define()
class IrModelReferenceReport extends AbstractModel {
    static _module = module;
    static _name = 'report.base.irmodulereference';
    static _description = 'Module Reference Report (base)';

    @api.model()
    async _objectFind(module) {
        const Data = await this.env.items('ir.model.data').sudo();
        const data = await Data.search([['model','=','ir.model'], ['module','=', await module.label]]);
        const resIds = await data.mapped('resId');
        return this.env.items('ir.model').browse(resIds);
    }

    async _fieldsFind(model, module) {
        const Data = await this.env.items('ir.model.data').sudo();
        const fnameWildcard = 'field_' + _.camelCase(model.replace('.', '_')) + '_%';
        const data = await Data.search([['model', '=', 'ir.model.fields'], ['module', '=', await module.label], ['label', 'like', fnameWildcard]]);
        if (bool(data)) {
            const resIds = await data.mapped('resId');
            const fnames = await this.env.items('ir.model.fields').browse(resIds).mapped('label');
            return sorted((await this.env.items(model).fieldsGet(fnames)).items());
        }
        return [];
    }

    @api.model()
    async _getReportValues(docids, data?: any) {
        const report = await this.env.items('ir.actions.report')._getReportFromName('base.reportIrmodulereference');
        const selectedModules = this.env.items('ir.module.module').browse(docids);
        return {
            'docIds': docids,
            'docModel': await report.model,
            'docs': selectedModules,
            'findobj': this._objectFind,
            'findfields': this._fieldsFind,
        }
    }
}