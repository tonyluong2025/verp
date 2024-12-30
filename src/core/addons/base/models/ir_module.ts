import fs from "fs/promises";
import _ from "lodash";
import assert from "node:assert";
import { format } from "node:util";
import { api, modules, tools } from "../../..";
import { getattr, setattr } from "../../../api/func";
import { Fields } from "../../../fields";
import { Dict, OrderedDict } from "../../../helper/collections";
import { AccessDenied, RuntimeError, UserError } from "../../../helper/errors";
import { WebRequest } from "../../../http";
import { MetaModel, Model, _super } from "../../../models";
import { getModuleIcon, getResourcePath } from "../../../modules";
import { expression } from "../../../osv";
import { b64encode, filePath } from "../../../tools";
import { bool } from "../../../tools/bool";
import { documentFromString } from "../../../tools/html";
import { extend, len } from "../../../tools/iterable";
import { publishString } from "../../../tools/mail";
import { setOptions, topologicalSort } from "../../../tools/misc";
import { parseVersion } from "../../../tools/parse_version";
import { quoteList } from "../../../tools/sql";
import { UpCamelCase, f } from "../../../tools/utils";
import { iterlinks, parseHtml, serializeHtml } from "../../../tools/xml";
import { MODULE_UNINSTALL_FLAG } from "./ir_model";

const ACTION_DICT = {
  'viewMode': 'form',
  'resModel': 'base.module.upgrade',
  'target': 'new',
  'type': 'ir.actions.actwindow',
}

const STATES = [
  ['uninstallable', 'Uninstallable'],
  ['uninstalled', 'Not Installed'],
  ['installed', 'Installed'],
  ['to upgrade', 'To be upgraded'],
  ['to remove', 'To be removed'],
  ['to install', 'To be installed'],
]

/**
 * Decorator checking that the calling user is an administrator, and logging the call.

  Raises an AccessDenied error if the user does not have administrator privileges, according
  to `user._isAdmin()`.
 * @param method 
 * @returns 
 */
function assertLogAdminAccess() {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const method = descriptor.value;
    const checkAndLog = async function (...args: any[]) {
      const user = await this.env.user();
      let req;
      if (args.length) {
        const kw = args[args.length - 1];
        if (typeof (kw) === 'object') {
          req = kw.req;
        }
      }
      const origin = req ? req.socket.remoteAddress : 'n/a';
      const logData = [method.name, await (await this.sudo()).mapped('displayName'), await user.login, user.id, origin];
      if (! await this.env.isAdmin()) {
        console.warn('DENY access to module.%s on "%s" to user "%s" ID #%s via %s', ...logData);
        throw new AccessDenied();
      }
      // console.info('ALLOW access to module.%s on %s to user %s #%s via %s', ...logData);
      return method.call(this, ...args);
    }
    setattr(checkAndLog, 'name', method.name);
    descriptor.value = checkAndLog;
  }
}

class Writer {

}
/**
 *  Custom docutils html4ccs1 writer that doesn't add the warnings to the output document.
 */
class MyWriter extends Writer {
  getTransforms() {
    return [null, null]//[MyFilterMessages, writer_aux.Admonitions]
  }
}

@MetaModel.define()
class ModuleCategory extends Model {
  static _module = module;
  static _name = "ir.module.category"
  static _description = "Application"
  static _order = 'label'

  static label = Fields.Char({ string: 'Label', required: true, translate: true, index: true })
  static parentId = Fields.Many2one('ir.module.category', { string: 'Parent Application', index: true })
  static childIds = Fields.One2many('ir.module.category', 'parentId', { string: 'Child Applications' })
  static moduleNr = Fields.Integer({ string: 'Number of Apps', compute: '_computeModuleNr' })
  static moduleIds = Fields.One2many('ir.module.module', 'categoryId', { string: 'Modules' })
  static description = Fields.Text({ string: 'Description', translate: true })
  static sequence = Fields.Integer({ string: 'Sequence' })
  static visible = Fields.Boolean({ string: 'Visible', default: true })
  static exclusive = Fields.Boolean({ string: 'Exclusive' })
  static xmlid = Fields.Char({ string: 'External ID', compute: '_computeXmlid' })

  @api.depends('moduleIds')
  async _computeModuleNr() {
    const cr = this._cr;
    const res = await cr.execute(`SELECT "categoryId", COUNT(*)::int AS counter
                  FROM "irModuleModule"
                  WHERE "categoryId" IN (%s)
                    OR "categoryId" IN (SELECT id
                                          FROM "irModuleCategory"
                                        WHERE parentId IN (%s))
                  GROUP BY "categoryId"`, this.ids);
    const result = Dict.from<any>(res.map(r => [res['categoryId'], res['counter']]));
    for (const cat of await this.filtered('id')) {
      const res = await cr.execute('SELECT id FROM "irModuleCategory" WHERE "parentId"=%s', [cat.id]);
      await cat.set('moduleNr', res.reduce((pre, cur) => pre + result.get(cur.id, 0), result.get(cat.id, 0)));
    }
  }

  async _computeXmlid() {
    const xmlids = new Dict();
    const domain = [['model', '=', this._name], ['resId', 'in', this.ids]];
    const sudo = await this.env.items('ir.model.data').sudo();
    for (const data of await sudo.searchRead(domain, ['module', 'label', 'resId'])) {
      xmlids[data['resId']] = xmlids[data['resId']] ?? [];
      xmlids[data['resId']].push(`${data['module']}.${data['label']}`);
    }
    for (const cat of this) {
      await cat.set('xmlid', xmlids.get(cat.id, [''])[0]);
    }
  }
}

@MetaModel.define()
class Module extends Model {
  static _module = module;
  protected static _name = "ir.module.module";
  protected static _recName = "shortdesc";
  protected static _description = "Module";
  protected static _order = 'application desc,sequence,label';

  static label = Fields.Char({ string: 'Technical Name', readonly: true, required: true, index: true });
  static categoryId = Fields.Many2one('ir.module.category', { string: 'Category', readonly: true, index: true });
  static shortdesc = Fields.Char('Module Name', { readonly: true, translate: true });
  static summary = Fields.Char('Summary', { readonly: true, translate: true });
  static description = Fields.Text('Description', { readonly: true, translate: true });
  static descriptionHtml = Fields.Html('Description HTML', { compute: '_getDesc' });
  static author = Fields.Char("Author", { readonly: true });
  static maintainer = Fields.Char('Maintainer', { readonly: true });
  static contributors = Fields.Text({ string: 'Contributors', readonly: true });
  static website = Fields.Char("Website", { readonly: true });

  // attention: Incorrect field names !!
  //   installedVersion refers the latest version (the one on disk)
  //   latestVersion refers the installed version (the one in database)
  //   publishedVersion refers the version available on the repository
  static installedVersion = Fields.Char('Latest Version', { compute: '_getLatestVersion' });
  static latestVersion = Fields.Char('Installed Version', { readonly: true });
  static publishedVersion = Fields.Char('Published Version', { readonly: true });

  static url = Fields.Char('URL', { readonly: true });
  static sequence = Fields.Integer('Sequence', { default: 100 });
  static dependenciesId = Fields.One2many('ir.module.module.dependency', 'moduleId', { string: 'Dependencies', readonly: true });
  static exclusionIds = Fields.One2many('ir.module.module.exclusion', 'moduleId', { string: 'Exclusions', readonly: true });
  static autoInstall = Fields.Boolean('Automatic Installation', { help: 'An auto-installable module is automatically installed by the system when all its dependencies are satisfied. If the module has no dependency, it is always installed.' });
  static state = Fields.Selection(STATES, { string: 'Status', default: 'uninstallable', readonly: true, index: true });
  static demo = Fields.Boolean('Demo Data', { default: false, readonly: true });
  static web = Fields.Boolean('Has web', { default: false, readonly: true });
  static license = Fields.Selection([
    ['GPL-2', 'GPL Version 2'],
    ['GPL-2 or any later version', 'GPL-2 or later version'],
    ['GPL-3', 'GPL Version 3'],
    ['GPL-3 or any later version', 'GPL-3 or later version'],
    ['AGPL-3', 'Affero GPL-3'],
    ['LGPL-3', 'LGPL Version 3'],
    ['MIT Expat', 'MIT Expat'],
    ['Other OSI approved licence', 'Other OSI Approved License'],
    ['OEEL-1', 'Verp Enterprise Edition License v1.0'],
    ['OPL-1', 'Verp Proprietary License v1.0'],
    ['Other proprietary', 'Other Proprietary']
  ], { string: 'License', default: 'MIT Expat', readonly: true });
  static menusByModule = Fields.Text({ string: 'Menus', compute: '_getViews', store: true });
  static reportsByModule = Fields.Text({ string: 'Reports', compute: '_getViews', store: true });
  static viewsByModule = Fields.Text({ string: 'Views', compute: '_getViews', store: true });
  static application = Fields.Boolean('Application', { readonly: true });
  static icon = Fields.Char('Icon URL');
  static iconImage = Fields.Binary({ string: 'Icon', compute: '_getIconImage' });
  static toBuy = Fields.Boolean('Verp Enterprise Module', { default: false });
  static hasIap = Fields.Boolean({ compute: '_computeHasIap' });

  @api.model()
  async fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
    const res = await _super(Module, this).fieldsViewGet(viewId, viewType, toolbar, false);
    if (viewType === 'form' && (res['toolbar'] ?? false)) {
      const installId = (await this.env.ref('base.actionServerModuleImmediateInstall')).id;
      const action = res['toolbar']['action']?.filter(rec => (rec['id'] ?? false) !== installId);
      res['toolbar'] = { 'action': action }
    }
    return res;
  }

  getModuleInfo(name: string) {
    try {
      return modules.loadInformationFromDescriptionFile(name);
    } catch (e) {
      console.debug('Error when trying to fetch information for module %s', name);
      return new Dict<any>();
    }
  }

  @api.depends('label', 'description')
  async _getDesc() {
    for (const modul of this as any) {
      const label = await modul.label;
      if (!label) {
        await modul.set('descriptionHtml', false);
        continue;
      }
      const modulePath = modules.getModulePath(label, false, false);  // avoid to log warning for fake community module
      let _path;
      if (modulePath) {
        _path = modules.checkResourcePath(modulePath, 'static/description/index.html')
      }
      if (modulePath && _path) {
        const docRaw = await fs.readFile(filePath(_path), 'utf8');
        const docHtml = documentFromString(docRaw as string, { parser: parseHtml, boundTag: 'div' });
        for (const [el, attribute, link, pos] of iterlinks(docHtml as any)) {
          const src = el.getAttribute('src');
          if (src && !src.includes('//') && !src.includes('static/')) {
            el.setAttribute('src', f("/%s/static/description/%s", label, src));
          }
        }
        // remove the rendered tag <div> that was added in order to wrap potentially multiples nodes into one.
        await modul.set('descriptionHtml', tools.htmlSanitize(serializeHtml(docHtml)));
      }
      else {
        const overrides = {
          'embedStylesheet': false,
          'doctitleXform': false,
          'outputEncoding': 'unicode',
          'xmlDeclaration': false,
          'fileInsertionEnabled': false,
        }
        const [application, description] = await modul('application', 'description');
        const html = publishString(!application && description ? description : '', { settingsOverrides: overrides, writer: new MyWriter() })
        await modul.set('descriptionHtml', tools.htmlSanitize(html));
      }
    }
  }

  @api.depends('label')
  async _getLatestVersion() {
    const defaultVersion = modules.adaptVersion('1.0');
    for (const modul of this) {
      await modul.set('installedVersion', this.getModuleInfo(await modul.label).get('version', defaultVersion));
    }
  }

  @api.depends('label', 'state')
  async _getViews() {
    const IrModelData = await this.env.items('ir.model.data').withContext({ activeTest: true });
    const dmodels = ['ir.ui.view', 'ir.actions.report', 'ir.ui.menu'];

    for (const modul of this) {
      // Skip uninstalled modules below, no data to find anyway.
      if (!['installed', 'to upgrade', 'to remove'].includes(await modul.state)) {
        await modul.set('viewsByModule', "");
        await modul.set('reportsByModule', "");
        await modul.set('menusByModule', "");
        continue;
      }

      // then, search and group ir.model.data records
      const imdModels = new Dict();
      const imdDomain = [['module', '=', await modul.label], ['model', 'in', dmodels]];
      for (const data of await (await IrModelData.sudo()).search(imdDomain)) {
        imdModels[data.model] = imdModels[data.model] ?? [];
        imdModels[data.model].push(data.resId);
      }

      const self = this;
      async function browse(model) {
        // as this method is called before the module update, some xmlid
        // may be invalid at this stage; explictly filter records before
        // reading them
        return self.env.items(model).browse(imdModels[model]).exists();
      }

      function formatView(v) {
        return f('%s%s (%s)', v.inheritId && '* INHERIT ' || '', v.label, v.type);
      }

      await modul.set('viewsByModule', [...(await browse('ir.ui.view'))].map(v => formatView(v)).sort().join('\n'));
      await modul.set('reportsByModule', (await Promise.all([...(await browse('ir.actions.report'))].map(async r => await r.label))).sort().join('\n'));
      await modul.set('menusByModule', (await Promise.all([...(await browse('ir.ui.menu'))].map(async m => await m.completeName))).sort().join('\n'));
    }
  }

  @api.depends('icon')
  async _getIconImage() {
    for (const modul of this) {
      await modul.set('iconImage', '');
      let path;
      if (await modul.icon) {
        const pathParts = (await modul.icon).split('/');
        path = getResourcePath(pathParts[1], ...pathParts.slice(2));
      }
      else if (bool(modul.id)) {
        path = getModuleIcon(await modul.label);
      }
      else {
        path = '';
      }
      if (path) {
        const buffer = await fs.readFile(filePath(path));
        await modul.set('iconImage', b64encode(buffer));
      }
    }
  }

  async _updateDependencies(depends = [], autoInstallRequirements: any) {
    const self: any = this;
    const existing = [];
    const dependenciesId = await self.dependenciesId;
    for (const dep of dependenciesId) {
      existing.push(await dep.label);
    }
    for (const dep of _.difference(depends, existing)) {
      await this._cr.execute(`INSERT INTO "irModuleModuleDependency" ("moduleId", "label") values ($1, $2)`, { bind: [self.id, dep] });
    }
    for (const dep of _.difference(existing, depends)) {
      await this._cr.execute('DELETE FROM "irModuleModuleDependency" WHERE "moduleId" = $1 and "label" = $2', { bind: [self.id, dep] });
    }
    autoInstallRequirements = bool(autoInstallRequirements) ? autoInstallRequirements : [''];
    const sql = `UPDATE "irModuleModuleDependency" SET "autoInstallRequired" = ("label" IN (${quoteList(autoInstallRequirements)})) WHERE "moduleId" = ${self.id}`;
    await this._cr.execute(sql);
    this.invalidateCache(['dependenciesId'], this.ids);
  }

  async _updateExclusions(excludes = []) {
    const self: any = this;
    const existing = [];
    for (const excl of await self.exclusionIds) {
      existing.push(await excl.label);
    }
    for (const label of _.difference(excludes, existing)) {
      await this._cr.execute('INSERT INTO "irModuleMmoduleDependency" ("moduleId", "label") VALUES ($1, $2)', { bind: [self.id, label] });
    }
    for (const label of _.difference(existing, excludes)) {
      await this._cr.execute('DELETE FROM "irModuleMmoduleDependency" WHERE "moduleId"=$1 AND "label"=$2', { bind: [self.id, label] });
    }
    this.invalidateCache(['exclusionIds'], self.ids);
  }

  async _updateCategory(category: string = 'Uncategorized') {
    const self: any = this;
    let currentCategory = await self.categoryId;
    const currentCategoryPath = [];
    while (currentCategory.ok) {
      currentCategoryPath.unshift(await currentCategory.label);
      currentCategory = await currentCategory.parentId;
    }

    const categs = category.split('/');
    if (_.difference(categs, currentCategoryPath).length) {
      const catId = await modules.db.createCategories(this._cr, categs);
      await this.write({ 'categoryId': catId });
    }
  }

  async _updateTranslations(filterLang: any, overwrite = false) {
    if (!filterLang?.length) {
      const langs = await this.env.items('res.lang').getInstalled();
      filterLang = langs.map(([code, _]) => code);
    }
    else if (!Array.isArray(filterLang)) {
      filterLang = [filterLang];
    }

    const updateMods: any = await this.filtered(async (r) => ['installed', 'to install', 'to upgrade'].includes(await r.state));
    const modDict = {};
    for (const mod of updateMods) {
      modDict[await mod.label] = await (await mod.dependenciesId).mapped('label');
    }
    const modNames = topologicalSort(modDict);
    await this.env.items('ir.translation')._loadModuleTerms(modNames, filterLang, overwrite);
  }

  async updateThemeImages() {
    console.warn("updateThemeImages not implemented.")
  }

  /**
   * Remove the copies of the views installed by the modules in `self`.

    Those copies do not have an external id so they will not be cleaned by
    `_moduleDataUninstall`. This is why we rely on `key` instead.

    It is important to remove these copies because using them will crash if
    they rely on data that don't exist anymore if the module is removed.
   */
  async _removeCopiedViews() {
    const domain = expression.OR(await this.map(async (m) => [['key', '=like', await m.label + '.%']]));
    const orphans = await (await this.env.items('ir.ui.view').withContext({ 'activeTest': false, [MODULE_UNINSTALL_FLAG]: true })).search(domain);
    await orphans.unlink();
  }

  @api.returns('self')
  async downstreamDependencies(knownDeps?: any, excludeStates?: string[]) {
    excludeStates = excludeStates ?? ['uninstalled', 'uninstallable', 'to remove'];
    if (!this.ok) {
      return this;
    }
    knownDeps = knownDeps ?? this.browse();
    const query = `SELECT DISTINCT m.id
                FROM "irModuleModuleDependency" d
                JOIN "irModuleModule" m ON (d."moduleId"=m.id)
                WHERE
                    d.label IN (SELECT label from "irModuleModule" where id in (%s)) AND
                    m.state NOT IN (%s) AND
                    m.id NOT IN (%s)`
    const res = await this._cr.execute(query, [String(this.ids), quoteList(excludeStates), String(len(knownDeps.ids) ? knownDeps.ids : this.ids)]);
    const newDeps = this.browse(res.map(row => row['id']));
    const missingMods = newDeps.sub(knownDeps);
    knownDeps = knownDeps.or(newDeps);
    if (missingMods.ok) {
      knownDeps = knownDeps.or(await missingMods.downstreamDependencies(knownDeps, excludeStates));
    }
    return knownDeps;
  }

  /**
   * Return the dependency tree of modules of the modules in `self`, and
    that satisfy the `excludeStates` filter.
   * @param param0 
   */
  @api.returns('self')
  async upstreamDependencies(options: { knownDeps?: any, excludeStates?: string[] } = {}) {
    setOptions(options, { excludeStates: ['installed', 'uninstallable', 'to remove'] });
    if (!this.ok) {
      return this;
    }
    let knownDeps = options.knownDeps || this.browse();
    const query = `SELECT DISTINCT m.id
                FROM "irModuleModuleDependency" d
                JOIN "irModuleModule" m ON (d."moduleId"=m.id)
                WHERE
                    m.label IN (SELECT label from "irModuleModuleDependency" where "moduleId" in (%s)) AND
                    m.state NOT IN (%s) AND
                    m.id NOT IN (%s)`
    const res = await this._cr.execute(query, [this.ids.join(','), quoteList(options.excludeStates), (len(knownDeps.ids) ? knownDeps.ids : this.ids).join(',')]);
    const newDeps = this.browse(res.map(row => row['id']));
    const missingMods = newDeps.sub(knownDeps);
    knownDeps = knownDeps.or(newDeps);
    if (missingMods.ok) {
      knownDeps = knownDeps.or(await missingMods.upstreamDependencies({ knownDeps: knownDeps, excludeStates: options.excludeStates }));
    }
    return knownDeps;
  }

  /**
   * Return the action linked to an ir.actions.todo is there exists one that
    should be executed. Otherwise, redirect to /web
   * @returns 
   */
  async next() {
    const Todos = this.env.items('ir.actions.todo');
    // console.info('getting next %s', Todos);
    const activeTodo = await Todos.search([['state', '=', 'open']], { limit: 1 });
    if (bool(activeTodo)) {
      console.info('next action is "%s"', await activeTodo.label);
      return activeTodo.actionLaunch();
    }
    return {
      'type': 'ir.actions.acturl',
      'target': 'self',
      'url': '/web',
    }
  }

  _checkExternalDependencies(terp: Dict<any>) {
    const depends = terp.get('externalDependencies');
    if (!bool(depends)) {
      return;
    }
    for (const binary of depends.get('bin', [])) {
      try {
        tools.findInPath(binary);
      } catch (e) {
        throw new Error(`Unable to find ${binary} in path`);
      }
    }
  }

  async checkExternalDependencies(moduleName: string, newstate: string = 'to install') {
    const terp = this.getModuleInfo(moduleName);
    try {
      this._checkExternalDependencies(terp);
    } catch (e) {
      let msg;
      if (newstate === 'to install') {
        msg = 'Unable to install module "%s" because an external dependency is not met: %s';
      }
      else if (newstate === 'to upgrade') {
        msg = 'Unable to upgrade module "%s" because an external dependency is not met: %s';
      }
      else {
        msg = 'Unable to process module "%s" because an external dependency is not met: %s';
      }
      throw new UserError(await this._t(msg, moduleName, e));
    }
  }

  async _stateUpdate(newstate: string, statesToUpdate: string[], level: number = 100) {
    if (level < 1) {
      throw new UserError(await this._t('Recursion error in modules dependencies !'));
    }

    // whether some modules are installed with demo data
    let _demo = false;

    for (const modul of this) {
      let [label, state, demo, dependenciesId] = await modul('label', 'state', 'demo', 'dependenciesId');
      if (!statesToUpdate.includes(state)) {
        _demo = _demo || demo;
        continue;
      }

      // determine dependency modules to update/others
      let [updateMods, readyMods] = [this.browse(), this.browse()];
      for (let dep of dependenciesId) {
        if (await dep.state === 'unknown') {
          throw new UserError(await this._t("You try to install module '%s' that depends on module '%s'. But the latter module is not available in your system.", label, await dep.label));
        }
        const dependId = await dep.dependId; // => _computeDepend
        const depState = await dependId.state;
        if (depState === newstate) {
          readyMods = readyMods.add(dependId);
        }
        else {
          updateMods = updateMods.add(dependId);
        }
      }
      // update dependency modules that require it, and determine demo for module
      const updateDemo = await updateMods._stateUpdate(newstate, statesToUpdate, level - 1);
      let fDemo = false;
      for (const mod of readyMods) {
        if (await mod.demo) {
          fDemo = true;
          break;
        }
      }
      const moduleDemo = demo || updateDemo || fDemo;
      _demo = _demo || moduleDemo;

      if (statesToUpdate.includes(state)) {
        // check dependencies and update module itself
        await this.checkExternalDependencies(label, newstate);
        // console.log('Module', label, state, '=>', newstate);
        await modul.write({ 'state': newstate, 'demo': moduleDemo });
        await modul.flush();
      }
    }

    return _demo;
  }

  @assertLogAdminAccess()
  async buttonInstall() {
    const autoDomain = [['state', '=', 'uninstalled'], ['autoInstall', '=', true]];

    const installStates = new Set(['installed', 'to install', 'to upgrade']);
    async function mustInstall(module) {
      const dependenciesId = await module.dependenciesId;
      const states = new Set<any>();
      for (const dep of dependenciesId) {
        if (await dep.autoInstallRequired) {
          states.add(await dep.state);
        }
      }
      return _.lte(states, installStates) && states.has('to install');
    }

    let modules: any = this;
    while (modules.ok) {
      await modules._stateUpdate('to install', ['uninstalled']);
      modules = await (await this.search(autoDomain)).filtered(mustInstall);
    }

    const installMods = await this.search([['state', 'in', Array.from(installStates)]]);

    const installNames = new Set<any>();
    for (const modul of installMods) {
      installNames.add(await modul.label);
    }
    for (const modul of installMods) {
      for (const exclusion of await modul.exclusionIds) {
        if (installNames.has(await exclusion.label)) {
          const msg = await this._t('Modules "%s" and "%s" are incompatible.');
          throw new UserError(msg, await modul.shortdesc, await (await exclusion.exclusionId).shortdesc);
        }
      }
    }

    async function closure(module) {
      let todo = module;
      let result = module;
      while (todo.ok) {
        result = result.or(todo);
        todo = await (await todo.dependenciesId).dependId;
      }
      return result;
    }

    const exclusives = await this.env.items('ir.module.category').search([['exclusive', '=', true]]);
    for (const category of exclusives) {
      // retrieve installed modules in category and sub-categories
      const categories = await category.search([['id', 'childOf', category.ids]]);
      const modules = await installMods.filtered(async (mod) => await categories.constains(await mod.categoryId));
      // the installation is valid if all installed modules in categories
      // belong to the transitive dependencies of one of them
      if (modules.ok) {
        for (const modul of modules) {
          if (modules.lt(await closure(modul))) {
            let msg = await this._t('You are trying to install incompatible modules in category "%s":');
            const labels = Dict.from((await this.fieldsGet(['state']))['state']['selection']);
            msg = format(msg, await category.label);
            const msgs = [];
            for (const mod of modules) {
              msgs.push(msg + `- ${await modul.shortdesc} (${labels[await modul.state]})`);
            }
            throw new UserError(msgs.join('\n'));
          }
        }
      }
    }

    return { ...ACTION_DICT, label: await this._t('Install') };
  }

  @assertLogAdminAccess()
  async buttonInstallCancel() {
    await this.write({ 'state': 'uninstalled', 'demo': false });
    return true;
  }

  /**
   * Installs the selected module(s) immediately and fully,
        returns the next res.config action to execute

    @returns next res.config item to execute
    @type dict[str, object]
   * @returns 
   */
  @assertLogAdminAccess()
  async buttonImmediateInstall(options: { req?: WebRequest } = {}) {
    console.info('User #%s triggered module installation', this.env.uid);
    // We use here the request object (which is thread-local) as a kind of
    // "global" env because the env is not usable in the following use case.
    // When installing a Chart of Account, I would like to send the
    // allowed companies to configure it on the correct company.
    // Otherwise, the SUPERUSER won't be aware of that and will try to
    // configure the CoA on his own company, which makes no sense.
    if (options.req) {
      setattr(options.req, 'allowedCompanyIds', (await this.env.companies()).ids);
    }
    return this._buttonImmediateFunction(this.buttonInstall);
  }

  /**
   * Perform the various steps required to uninstall a module completely including the deletion of all database structures created by the module: tables, columns, constraints, etc.
   */
  @assertLogAdminAccess()
  async moduleUninstall() {
    const modulesToRemove = await this.mapped('label');
    await this.env.items('ir.model.data')._moduleDataUninstall(modulesToRemove);
    // we deactivate prefetching to not try to read a column that has been deleted
    await (await this.withContext({ prefetchFields: false })).write({ 'state': 'uninstalled', 'latestVersion': false });
    return true;
  }

  async _buttonImmediateFunction(func) {
    if (getattr(this.env, 'testing', false)) {
      throw new RuntimeError(
        `Module operations inside tests are not transactional and thus forbidden.\n
        If you really need to perform module operations to test a specific behavior, it 
        is best to write it as a standalone script, and ask the runbot/metastorm team 
        for help.`
      )
    }
    try {
      // This is done because the installation/uninstallation/upgrade can modify a currently
      // running cron job and prevent it from finishing, and since the irCron table is locked
      // during execution, the lock won't be released until timeout.
      await this._cr.execute(`SELECT * FROM "irCron" FOR UPDATE NOWAIT`);
    } catch (e) {
      throw new UserError(await this._t(`Verp is currently processing a scheduled action. Module operations are not possible at this time, please try again later or contact your system administrator.`));
    }

    await this._cr.close();

    await func.call(this, this);

    await this._cr.commit();
    // for debug
    // await this._cr.reset();
    const registry = await modules.registry.Registry.new(this._cr.dbName, { updateModule: true, req: this.env.req });
    // for debug
    // await this._cr.commit();
    await this._cr.reset(true);
    // check
    // assert (this.env.registry === registry);

    const config = await this.env.items('ir.module.module').next() || {}
    if (!['ir.actions.actwindow.close',].includes(config['type'])) {
      return config;
    }

    // reload the client; open the first available root menu
    const menu = (await this.env.items('ir.ui.menu').search([['parentId', '=', false]]))(0);
    return {
      'type': 'ir.actions.client',
      'tag': 'reload',
      'params': { 'menuId': menu.id },
    }
  }

  /**
   * Uninstall the selected module(s) immediately and fully,
    returns the next res.config action to execute
   * @returns 
   */
  @assertLogAdminAccess()
  async buttonImmediateUninstall() {
    console.info('User #%d triggered module uninstallation', this.env.uid);
    return this._buttonImmediateFunction(this.buttonUninstall);
  }

  /**
   * Launch the wizard to uninstall the given module.
   * @returns 
   */
  @assertLogAdminAccess()
  async buttonUninstallWizard() {
    return {
      'type': 'ir.actions.actwindow',
      'target': 'new',
      'label': await this._t('Uninstall module'),
      'viewMode': 'form',
      'resModel': 'base.module.uninstall',
      'context': { 'default_moduleId': this.id },
    }
  }

  /**
   * Upgrade the selected module(s) immediately and fully,
    return the next res.config action to execute
   * @returns 
   */
  @assertLogAdminAccess()
  async buttonImmediateUpgrade() {
    return this._buttonImmediateFunction(this.buttonUpgrade);
  }

  @assertLogAdminAccess()
  async buttonUninstall() {
    if ((await this.mapped('label')).includes('base')) {
      throw new UserError(await this._t("The `base` module cannot be uninstalled"));
    }
    for (const state of await this.mapped('state')) {
      if (!['installed', 'to upgrade'].includes(state)) {
        throw new UserError(await this._t(
          "One or more of the selected modules have already been uninstalled, if you believe this to be an error, you may try again later or contact support."
        ));
      }
    }
    const deps = await this.downstreamDependencies();
    await this.add(deps).write({ 'state': 'to remove' });
    return { ...ACTION_DICT, label: await this._t('Uninstall') };
  }

  async buttonUninstallCancel() {
    await this.write({ 'state': 'installed' });
    return true;
  }

  @assertLogAdminAccess()
  async buttonUpgrade() {
    if (!this.ok) {
      return;
    }
    const Dependency = this.env.items('ir.module.module.dependency');
    await this.updateList();

    const todo = [...this];
    if ('base' in await this.mapped('label')) {
      // If an installed module is only present in the dependency graph through  a new, uninstalled dependency, it will not have been selected yet.
      // An update of 'base' should also update these modules, and as a consequence  install the new dependency.
      extend(todo, await this.search([
        ['state', '=', 'installed'],
        ['label', '!=', 'studioCustomization'],
        ['id', 'not in', this.ids],
      ]));
    };
    let i = 0;
    while (i < todo.length) {
      const modul = todo[i];
      const label = await modul.label;
      i += 1;
      if (!['installed', 'to upgrade'].includes(await modul.state)) {
        throw new UserError(await this._t("Can not upgrade module '%s'. It is not installed.", label));
      }
      if (this.getModuleInfo(label).get("installable", true)) {
        await this.checkExternalDependencies(label, 'to upgrade');
      }
      for (const dep of await Dependency.search([['label', '=', label]])) {
        const moduleId = await dep.moduleId;
        if (
          await moduleId.state === 'installed'
          && !todo.map(m => m['id']).includes(moduleId.id)
          && await moduleId.label !== 'studioCustomization'
        ) {
          todo.push(await dep.moduleId);
        }
      }
    }
    await this.browse(todo.map(m => m['id'])).write({ 'state': 'to upgrade' })

    const toInstall = [];
    for (const modul of todo) {
      const label = await modul.label;
      if (!this.getModuleInfo(label).get("installable", true)) {
        continue;
      }
      for (const dep of await modul.dependenciesId) {
        const [depLabel, depState] = await dep('label', 'state');
        if (depState === 'unknown') {
          throw new UserError(await this._t('You try to upgrade the module %s that depends on the module: %s.\nBut this module is not available in your system.', label, depLabel));
        }
        if (depState === 'uninstalled') {
          extend(toInstall, (await this.search([['label', '=', depLabel]])).ids);
        }
      }
    }

    await this.browse(toInstall).buttonInstall()
    return { ...ACTION_DICT, label: await this._t('Apply Schedule Upgrade') };
  }

  @assertLogAdminAccess()
  async buttonUpgradeCancel() {
    await this.write({ 'state': 'installed' });
    return true;
  }

  getValuesFromTerp(terp: Dict<any>) {
    const contributors = terp.get('contributors', []).join(', ');
    return {
      'description': terp.get('description', ''),
      'shortdesc': terp.get('label', ''),
      'author': terp.get('author', 'Unknown'),
      'maintainer': terp.get('maintainer', false),
      'contributors': contributors.length ? contributors : false,
      'website': terp.get('website', ''),
      'license': terp.get('license', 'MIT Expat'),
      'sequence': terp.get('sequence', 100),
      'application': terp.get('application', false),
      'autoInstall': terp.get('autoInstall', false) != false,
      'icon': terp.get('icon', false),
      'summary': terp.get('summary', ''),
      'url': terp.get('url') ?? terp.get('liveTestUrl', ''),
      'toBuy': false
    }
  }

  @api.model()
  async create(vals) {
    const newMod = await _super(Module, this).create(vals);
    const moduleMetadata = {
      'label': `module${UpCamelCase(vals['label'])}`,
      'model': 'ir.module.module',
      'module': 'base',
      'resId': newMod.id,
      'noupdate': true,
    }
    await this.env.items('ir.model.data').create(moduleMetadata);
    return newMod;
  }


  @assertLogAdminAccess()
  @api.model()
  async updateList() {
    const res = [0, 0];    // [update, add]

    const defaultVersion = modules.adaptVersion('1.0');
    const knownMods = await (await this.withContext({ lang: null })).search([]);
    const knownModsNames = {}
    for (const mod of knownMods) {
      knownModsNames[await mod.label] = mod;
    }

    // iterate through detected modules and update/create them in db
    for (const modName of modules.getModules()) {
      let mod = knownModsNames[modName];
      const terp = this.getModuleInfo(modName);
      const values = this.getValuesFromTerp(terp);

      if (bool(mod)) {
        const updatedValues = {};
        for (const key of Object.keys(values)) {
          const old = await mod[key];
          if ((old || values[key]) && values[key] !== old) {
            updatedValues[key] = values[key];
          }
        }
        if (terp.get('installable', true) && await mod.state === 'uninstallable') {
          updatedValues['state'] = 'uninstalled';
        }
        if (parseVersion(terp.get('version', defaultVersion)) > parseVersion(await mod.latestVersion ?? defaultVersion)) {
          res[0] += 1;
        }
        if (len(updatedValues)) {
          await mod.write(updatedValues);
        }
      } else {
        const modPath = modules.getModulePath(modName);
        if (!modPath || !len(terp)) {
          ``
          continue;
        }
        const state = terp.get('installable', true) ? "uninstalled" : "uninstallable";
        mod = await this.create([Dict.from<any>({ label: modName, state: state, ...values })]);
        res[1] += 1;
      }
      await mod._updateDependencies(terp.get('depends', []), terp.get('autoInstall'));
      await mod._updateExclusions(terp.get('excludes', []));
      await mod._updateCategory(terp.get('category', 'Uncategorized'));
    }
    return res;
  }

  @assertLogAdminAccess()
  async download(download = true) {
    return [];
  }

  @assertLogAdminAccess()
  @api.model()
  async installFromUrls(urls) {
    console.warn('Not Implemented');
  }

  @api.model()
  getAppsServer() {
    return tools.config.get('appsServer') || 'https://apps.theverp.com/apps';
  }

  @api.ondelete(false)
  async _unlinkExceptInstalled() {
    for (const modul of this) {
      if (['installed', 'to upgrade', 'to remove', 'to install'].includes(await modul.state)) {
        throw new UserError(await this._t('You are trying to remove a module that is installed or will be installed.'));
      }
    }
  }

  async unlink() {
    this.clearCaches();
    return _super(Module, this).unlink();
  }

  async _computeHasIap() {
    for (const modul of this) {
      await modul.set('hasIap', bool(modul.id) && (await (await modul.upstreamDependencies({ excludeStates: [''] })).mapped('label')).includes('iap'));
    }
  }

  async _check() {
    for (const modul of this) {
      if (! await modul.descriptionHtml) {
        console.warn('%s: description is empty !', await modul.label);
      }
    }
  }

  /**
   * Return the set of installed modules as a dictionary {name: id} 
   * @returns 
   */
  @api.model()
  @tools.ormcache()
  async _installed() {
    const res = {}
    for (const modul of await (await this.sudo()).searchRead([['state', '=', 'installed']], ['label'])) {
      res[modul.label] = modul.id;
    }
    return res;
  }

  @api.model()
  async searchpanelSelectRange(fieldName, kwargs: {} = {}) {
    if (fieldName === 'categoryId') {
      const enableCounters = kwargs['enableCounters'] || false;
      let domain = [['parentId', '=', false], ['childIds.moduleIds', '!=', false]];

      const excludedXmlids = [
        'base.category_websiteTheme',
        'base.category_theme',
      ];
      if (! await this.userHasGroups('base.groupNoOne')) {
        excludedXmlids.push('base.category_hidden');
      }
      const excludedCategoryIds = [];
      for (const excludedXmlid of excludedXmlids) {
        const categ = await this.env.ref(excludedXmlid, false);
        if (!bool(categ)) {
          continue;
        }
        excludedCategoryIds.push(categ.id);
      }
      if (excludedCategoryIds.length) {
        domain = expression.AND([
          domain,
          [['id', 'not in', excludedCategoryIds]],
        ]);
      }
      const records = await this.env.items('ir.module.category').searchRead(domain, ['displayName'], { order: "sequence" });

      const valuesRange = new OrderedDict<any>();
      for (const record of records) {
        const recordId = record['id'];
        if (enableCounters) {
          const modelDomain = expression.AND([
            kwargs['searchDomain'] ?? [],
            kwargs['categoryDomain'] ?? [],
            kwargs['filterDomain'] ?? [],
            [['categoryId', 'childOf', recordId], ['categoryId', 'not in', excludedCategoryIds]]
          ]);
          record['__count'] = await this.env.items('ir.module.module').searchCount(modelDomain);
        }
        valuesRange[recordId] = record;
      }
      return {
        'parentField': 'parentId',
        'values': Object.values(valuesRange),
      }
    }
    return _super(Module, this).searchpanelSelectRange(fieldName, kwargs);
  }
}

const DEP_STATES = [...STATES, ['unknown', 'Unknown']]

@MetaModel.define()
class ModuleDependency extends Model {
  static _module = module;
  static _name = "ir.module.module.dependency";
  static _description = "Module dependency";

  // the dependency name
  static label = Fields.Char({ index: true });

  // the module that depends on it
  static moduleId = Fields.Many2one('ir.module.module', { string: 'Module', ondelete: 'CASCADE' });

  // the module corresponding to the dependency, and its status
  static dependId = Fields.Many2one('ir.module.module', { string: 'Dependency', compute: '_computeDepend', search: '_searchDepend' });
  static state = Fields.Selection(DEP_STATES, { string: 'Status', compute: '_computeState' });

  static autoInstallRequired = Fields.Boolean({ default: true, help: "Whether this dependency blocks automatic installation of the dependent" });

  @api.depends('label')
  async _computeDepend() {
    // retrieve all modules corresponding to the dependency names
    let names = new Set(await this.map(async (dep) => dep.label));
    const mods = await this.env.items('ir.module.module').search([['label', 'in', [...names]]]);

    // index modules by name, and assign dependencies
    const nameMod = Object.fromEntries(await mods.map(async (mod) => [await mod['label'], mod]));
    for (const dep of this) {
      await dep.set('dependId', nameMod[await dep.label]);
    }
  }

  async _searchDepend(operator, value) {
    assert(operator === 'in')
    const modules = this.env.items('ir.module.module').browse(value);
    return [['label', 'in', await modules.mapped('label')]];
  }

  @api.depends('dependId.state')
  async _computeState() {
    for (const dependency of this) {
      const dependId = await dependency.dependId; // => _computeDepend
      await dependency.set('state', await dependId.state || 'unknown');
    }
  }
}

@MetaModel.define()
class ModuleExclusion extends Model {
  static _module = module;
  static _name = "ir.module.module.exclusion";
  static _description = "Module exclusion";

  // the exclusion name
  static label = Fields.Char({ index: true });

  // the module that excludes it
  static moduleId = Fields.Many2one('ir.module.module', { string: 'Module', ondelete: 'CASCADE' });

  // the module corresponding to the exclusion, and its status
  static exclusionId = Fields.Many2one('ir.module.module', { string: 'Exclusion Module', compute: '_computeExclusion', search: '_searchExclusion' });
  static state = Fields.Selection(DEP_STATES, { string: 'Status', compute: '_computeState' });

  @api.depends('label')
  async _computeExclusion() {
    // retrieve all modules corresponding to the exclusion names
    const names = Array.from(new Set(
      await Promise.all([...this].map(excl => excl.label))
    ));
    const mods = await this.env.items('ir.module.module').search([['label', 'in', names]]);

    // index modules by label, and assign dependencies
    const nameMod = Object.fromEntries(await Promise.all([...mods].map(async mod => [await mod.label, mod])));
    for (const excl of this) {
      await excl.set('exclusionId', nameMod[await excl.label]);
    }
  }

  async _searchExclusion(operator, value) {
    assert(operator === 'in');
    const modules = this.env.items('ir.module.module').browse(value);
    return [['label', 'in', await modules.mapped('label')]];
  }

  @api.depends('exclusionId.state')
  async _computeState() {
    for (const exclusion of this) {
      await exclusion.set('state', await (await exclusion.exclusionId).state || 'unknown');
    }
  }
}