import { api } from "../../..";
import { Fields } from "../../../fields";
import { UserError } from "../../../helper/errors";
import { MetaModel, TransientModel, _super } from "../../../models";
import { Registry } from "../../../modules/registry";
import { quoteList } from "../../../tools";
import { bool } from "../../../tools/bool";
import { getrootXml, parseXml } from "../../../tools/xml";

@MetaModel.define()
class BaseModuleUpgrade extends TransientModel {
  static _module = module;
  static _name = "base.module.upgrade";
  static _description = "Module Upgrade";

  static moduleInfo = Fields.Text('Apps to Update', { readonly: true, default: async (self) => await self._defaultModuleInfo() });

  @api.model()
  @api.returns('ir.module.module')
  async getModuleList() {
    const states = ['to upgrade', 'to remove', 'to install'];
    return this.env.items('ir.module.module').search([['state', 'in', states]]);
  }

  @api.model()
  async _defaultModuleInfo() {
    const res = [];
    for (const mod of await this.getModuleList()) {
      const [label, state] = await mod(['label', 'state']);
      res.push(`${label}: ${state}`);
    }
    return res.join('\n');
  }

  @api.model()
  async fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
    const res = await _super(BaseModuleUpgrade, this).fieldsViewGet(viewId, viewType, toolbar, false);
    if (viewType !== 'form') {
      return res;
    }

    if (!(this._context['activeModel'] && this._context['activeId'])) {
      return res;
    }

    if (!bool(await this.getModuleList())) {
      res['arch'] = `<form string="Upgrade Completed">
                              <separator string="Upgrade Completed" colspan="4"/>
                              <footer>
                                  <button name="config" string="Start Configuration" type="object" class="btn-primary" data-hotkey="q"/>
                                  <button special="cancel" data-hotkey="z" string="Close" class="btn-secondary"/>
                              </footer>
                            </form>`;
      res['dom'] = getrootXml(parseXml(res['arch']));
    }
    return res;
  }

  async upgradeModuleCancel() {
    const mod = this.env.items('ir.module.module');
    const toInstall = await mod.search([['state', 'in', ['to upgrade', 'to remove']]]);
    await toInstall.write({ 'state': 'installed' });
    const toUninstall = await mod.search([['state', '=', 'to install']]);
    await toUninstall.write({ 'state': 'uninstalled' });
    return { 'type': 'ir.actions.actwindow.close' };
  }

  async upgradeModule() {
    const mod = this.env.items('ir.module.module');

    // install/upgrade: double-check preconditions
    const modules = await mod.search([['state', 'in', ['to upgrade', 'to install']]]);
    if (bool(modules)) {
      const query = ` SELECT d.label
                      FROM "irModuleModule" m
                      JOIN "irModuleModuleDependency" d ON (m.id = d."moduleId")
                      LEFT JOIN "irModuleModule" m2 ON (d.label = m2.label)
                      WHERE m.id in (%s) and (m2.state IS NULL or m2.state IN (%s)) `;
      const res = await this._cr.execute(query, [String(modules.ids ?? []), quoteList(['uninstalled',])]);
      const unmetPackages = res.map(row => row['label']);
      if (unmetPackages.length) {
        throw new UserError(await this._t('The following modules are not installed or unknown: %s', '\n\n' + unmetPackages.join('n')));
      }
      await modules.download();
    }
    // terminate transaction before re-creating cursor below
    await this._cr.commit();
    await Registry.new(this._cr.dbName, { updateModule: true });
    await this._cr.reset(true);

    return { 'type': 'ir.actions.actwindow.close' }
  }

  async config() {
    // pylint: disable=next-method-called
    return this.env.items('res.config').next();
  }
}