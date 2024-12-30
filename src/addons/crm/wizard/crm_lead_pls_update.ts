import { Fields, _Date } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class CrmUpdateProbabilities extends TransientModel {
    static _module = module;
    static _name = 'crm.lead.pls.update';
    static _description = "Update the probabilities";

    async _getDefaultPlsStartDate() {
        const plsStartDateConfig = await (await this.env.items('ir.config.parameter').sudo()).getParam('crm.plsStartDate');
        return _Date.toDate(plsStartDateConfig);
    }

    async _getDefaultPlsFields() {
        const plsFieldsConfig = await (await this.env.items('ir.config.parameter').sudo()).getParam('crm.plsFields');
        if (plsFieldsConfig) {
            const names = plsFieldsConfig.split(',');
            const fields = await this.env.items('ir.model.fields').search([['label', 'in', names], ['model', '=', 'crm.lead']]);
            return this.env.items('crm.lead.scoring.frequency.field').search([['fieldId', 'in', fields.ids]]);
        }
        else {
            return null;
        }
    }

    static plsStartDate = Fields.Date({required: true, default: self => self._getDefaultPlsStartDate()});
    static plsFields = Fields.Many2many('crm.lead.scoring.frequency.field', {default: self => self._getDefaultPlsFields()});

    async actionUpdateCrmLeadProbabilities() {
        if (await (await this.env.user())._isAdmin()) {
            const sudo = await this.env.items('ir.config.parameter').sudo();
            const setParam = sudo.setParam;
            if (await this['plsFields']) {
                const plsFieldsStr = (await (await this['plsFields']).mapped('fieldId.label')).join(',');
                await setParam.call(sudo, 'crm.plsFields', plsFieldsStr);
            }
            else {
                await setParam.call(sudo, 'crm.plsFields', "");
            }
            await setParam.call(sudo, 'crm.plsStartDate', String(await this['plsStartDate']));
            await (await this.env.items('crm.lead').sudo())._cronUpdateAutomatedProbabilities();
        }
    }
}