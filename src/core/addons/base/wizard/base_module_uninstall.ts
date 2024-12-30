import { api } from "../../..";
import { Fields } from "../../../fields";
import { MetaModel, TransientModel } from "../../../models";
import { bool } from "../../../tools/bool";

@MetaModel.define()
class BaseModuleUninstall extends TransientModel {
  static _module = module;
  static _name = "base.module.uninstall";
  static _description = "Module Uninstall";

  static showAll = Fields.Boolean();
  static moduleId = Fields.Many2one('ir.module.module', {string: "Module", required: true, domain: [['state', 'in', ['installed', 'to upgrade', 'to install']]], ondelete: 'CASCADE', readonly: true}
  );
  static moduleIds = Fields.Many2many('ir.module.module', {string: "Impacted modules", compute: '_computeModuleIds'});
  static modelIds = Fields.Many2many('ir.model', {string: "Impacted data models", compute: '_computeModelIds'});

  /**
   * Return all the modules impacted by self.
   * @returns 
   */
  async _getModules() {
    const moduleId = await this['moduleId'];
    return moduleId.downstreamDependencies(moduleId);
  }

  @api.depends('moduleId', 'showAll')
  async _computeModuleIds() {
    for (const wizard of this) {
      const modules = await wizard._getModules();
      await wizard.set('moduleIds', await wizard.showAll ? modules : await modules.filtered('application'));
    }
  }

  /**
   * Return the models (ir.model) to consider for the impact.
   * @returns 
   */
  async _getModels() {
    return this.env.items('ir.model').search([['transient', '=', false]]);
  }

  @api.depends('moduleIds')
  async _computeModelIds() {
    const irModels = await this._getModels();
    const irModelsXids = await irModels._getExternalIds();
    for (const wizard of this) {
      if (bool(await wizard.moduleId)) {
        const moduleNames = await (await wizard._getModules()).mapped('label');

        function lost(model) {
          const xids = irModelsXids[model.id] ?? [];
          return xids.length && xids.every(xid => moduleNames.includes(xid.split('.')[0]));
        }

        // find the models that have all their XIDs in the given modules
        await this.set('modelIds', await (await irModels.filtered(lost)).sorted('label'));
      }
    }
  }

  @api.onchange('moduleId')
  async _onchangeModuleId() {
    // if we select a technical module, show technical modules by default
    if (! (await this['moduleId']).application) {
      await this.set('showAll', true);
    }
  }

  async actionUninstall() {
    const modules = await (this as any).moduleId;
    return modules.buttonImmediateUninstall();
  }
}