import assert from 'assert';
import fs from 'fs/promises';
import _ from 'lodash';
import { format } from 'util';
import { v4 as uuid4 } from 'uuid';
import xpath, { select, select1 } from 'xpath/xpath';
import { api, tools } from '../../..';
import { getattr, hasattr, setattr, setdefault } from '../../../api';
import { _Datetime, Fields } from "../../../fields";
import { DefaultDict, DefaultDict2, Dict } from '../../../helper/collections';
import { AccessError, ValidationError, ValueError, XmlError } from '../../../helper/errors';
import { WebRequest } from '../../../http';
import { MetaModel, Model, ModelRecords, TransientModel, _super, checkMethodName } from "../../../models";
import { getResourceFromPath, getResourcePath } from '../../../modules/modules';
import { Expression } from '../../../osv/expression';
import { urlEncode, urlQuotePlus } from '../../../service/middleware/utils';
import { ACTION_TYPES, _f, _fixMultipleRoots, _format, bool, constantMapping, enumerate, extend, f, imageDataUri, isDigit, isInstance, len, parseInt, quoteList, rstringPart, stringBase64, toText } from '../../../tools';
import { fnfilter } from '../../../tools/fnmatch';
import { getDiff } from '../../../tools/html';
import * as lazy from '../../../tools/lazy';
import { safeEval } from '../../../tools/save_eval';
import { applyInheritanceSpecs, locateNode } from '../../../tools/template_inheritance';
import { TRANSLATED_ATTRS, _t, xmlTranslate } from '../../../tools/translate';
import { getDictAsts, getDomainIdentifiers, getVariableNames, validView } from '../../../tools/view_validation';
import { childNodes, E, getAttribute, getAttributes, getpath, getrootXml, isElement, isProcessingInstruction, isText, iterancestors, iterchildren, iterdescendants, parseXml, popAttribute, serializeHtml, serializeXml } from '../../../tools/xml';
import { DateTime } from 'luxon';
import { stringify } from '../../../tools/json';

const MOVABLE_BRANDING = ['data-oe-model', 'data-oe-id', 'data-oe-field', 'data-oe-xpath', 'data-oe-source-id'];
const TRANSLATED_ATTRS_RE = new RegExp(`@(${TRANSLATED_ATTRS.keys().join('|')})\\b`);
const WRONGCLASS = /(class\s*=|=\s*class|contains\(class)/g;
const WRONGHASCLASS = /(hasclass)/g;
const regexObjectName = /^[a-z0-9_.]+$/g;

/**
 * Generate a query string keeping the current request querystring's parameters specified
  in ``keep_params`` and also adds the parameters specified in ``additional_params``.

  Multiple values query string params will be merged into a single one with comma seperated
  values.

  The ``keepParams`` arguments can use wildcards too, eg:

      keepQuery('search', 'shop_*', {page: 4})
 * @param keepParams 
 * @returns 
 */
function keepQuery(req: WebRequest, ...keepParams: any[]) {
  let additionalParams: any = {};
  if (keepParams.length == 0) {
    keepParams = ['*'];
  }
  else {
    const last = keepParams.slice(-1)[0];
    if (typeof (last) === 'object') {
      additionalParams = keepParams.pop();
    }
  }
  const params = Object.assign({}, additionalParams);
  const qsKeys = req ? Object.keys(req.uri.searchQuery) : [];
  for (const keepParam of keepParams) {
    for (const param of fnfilter(qsKeys, keepParam)) {
      if (!(param in additionalParams) && qsKeys.includes(param)) {
        params[param] = req.uri.searchQuery[param];
      }
    }
  }
  return urlEncode(params);
}

async function getViewArchFromFile(filepath: string, xmlid: string) {
  const [module, viewId] = xmlid.split('.');

  let xpath = `//*[@id='${xmlid}' or @id='${viewId}']`
  // when view is created from model with inherit of irUiView, the
  // xmlid has been suffixed by 'IrUiView'. We need to also search
  // for views without this prefix.
  if (viewId.endsWith('IrUiView')) {
    // len('IrUiView') == 8
    xpath = xpath.slice(0, -1) + ` or @id='${xmlid.slice(0, -8)}' or @id='${viewId.slice(0, -8)}']`;
  }

  const buffer = await fs.readFile(__dirname + '/webclient_templates.xml', 'utf-8');
  const document = parseXml(buffer);//, {ensureHeadBody: false});
  const nodes: any[] = select(xpath, document);
  for (const node of nodes) {
    if (node.tagName === 'record') {
      let fieldArch: any = select1('field[@name="arch"]', node);
      if (fieldArch != null) {
        fieldArch = _fixMultipleRoots(fieldArch);
        const inner = Array.from(fieldArch.childNodes ?? []).map(child => serializeXml(child)).join('');
        return fieldArch.textContent + inner
      }
      const fieldView: any = select1('field[@name="viewId"]', node);
      if (fieldView != null) {
        const [refModule, dot, refViewId] = rstringPart(fieldView.getAttribute('ref'), '.');
        const refXmlid = `${refModule || module}.${refViewId}`
        return getViewArchFromFile(filepath, refXmlid);
      }
      return null;
    }
    else if (node.tagName === 'template') {
      // The following dom operations has been copied from convert.js's _tagTemplate()
      if (!node.getAttribute('inheritId')) {
        node.setAttribute('t-name', xmlid);
        node.tagName = 't';
      }
      else {
        node.tagName = 'data';
      }
      node.removeAttribute('id');
      return serializeHtml(node, 'unicode');
    }
  }
  console.warn("Could not find view arch definition in file '%s' for xmlid '%s'", filepath, xmlid);
  return null;
}

/**
 * Functionally identical to safe_eval(), but optimized with special-casing.
 * @param expr 
 * @param globalsDict 
 * @returns 
 */
function quickEval(expr, globalsDict) {
  // most (~95%) elements are 1/true/0/false
  if (expr === '1')
    return 1;
  if (expr === 'true' || expr === 'true')
    return true;
  if (expr === '0')
    return 0;
  if (expr === 'false' || expr === 'false')
    return false;
  return safeEval(expr, globalsDict);
}

function* attNames(name): Generator<any, void, any> {
  yield name;
  yield `t-att-${name}`;
  yield `t-attf-${name}`;
}

@MetaModel.define()
class ViewCustom extends Model {
  static _module = module;
  static _name = 'ir.ui.view.custom';
  static _description = 'Custom View';
  static _order = 'createdAt desc';  // search({limit: 1}) should return the last customization

  static refId = Fields.Many2one('ir.ui.view', { string: 'Original View', index: true, required: true, ondelete: 'CASCADE' });
  static userId = Fields.Many2one('res.users', { string: 'User', index: true, required: true, ondelete: 'CASCADE' });
  static arch = Fields.Text({ string: 'View Architecture', required: true });

  async nameGet() {
    const res = [];
    for (const rec of (this as any)) {
      res.push([rec.id, await (await rec.userId).label]);
    }
    return res;
  }

  @api.model()
  async _nameSearch(name = '', args?: any, operator = 'ilike', { limit=100, nameGetUid=false }={}) {
    if (name) {
      return this._search([['userId', operator, name]].concat(args || []), {limit, accessRightsUid: nameGetUid});
    }
    return _super(ViewCustom, this)._nameSearch(name, args, operator, {limit, nameGetUid});
  }

  async _autoInit() {
    await _super(ViewCustom, this)._autoInit();
    await tools.createIndex(this._cr, 'irUiViewCustom_userId_ref_id', this.cls._table, ['"userId"', '"refId"']);
  }
}

@MetaModel.define()
class View extends Model {
  static _module = module;
  static _name = 'ir.ui.view';
  static _description = 'View';
  static _order = "priority,label,id";

  static label = Fields.Char({ string: 'View Name', required: true });
  static model = Fields.Char({ index: true });
  static key = Fields.Char();
  static priority = Fields.Integer({ string: 'Sequence', default: 16, required: true });
  static type = Fields.Selection([['tree', 'Tree'],
  ['form', 'Form'],
  ['graph', 'Graph'],
  ['pivot', 'Pivot'],
  ['calendar', 'Calendar'],
  ['gantt', 'Gantt'],
  ['kanban', 'Kanban'],
  ['search', 'Search'],
  ['qweb', 'QWeb']], { string: 'View Type' });
  static arch = Fields.Text({ compute: '_computeArch', inverse: '_inverseArch', string: 'View Architecture', help: `This field should be used when accessing view arch. It will use translation. Note that it will read 'archDb' or 'archFs' if in dev-xml mode.` });
  static archBase = Fields.Text({ compute: '_computeArchBase', inverse: '_inverseArchBase', string: 'Base View Architecture', help: "This field is the same as `arch` field without translations" });
  static archDb = Fields.Text({ string: 'Arch Blob', translate: xmlTranslate, help: "This field stores the view arch." });
  static archFs = Fields.Char({ string: 'Arch Filename', help: `File from where the view originates. Useful to (hard) reset broken views or to read arch from file in dev-xml mode.` });
  static archUpdated = Fields.Boolean({ string: 'Modified Architecture' });
  static archPrev = Fields.Text({ string: 'Previous View Architecture', help: `This field will save the current 'archDb' before writing on it. Useful to (soft) reset a broken view.` });
  static inheritId = Fields.Many2one('ir.ui.view', { string: 'Inherited View', ondelete: 'RESTRICT', index: true });
  static inheritChildrenIds = Fields.One2many('ir.ui.view', 'inheritId', { string: 'Views which inherit from this one' });
  static fieldParent = Fields.Char({ string: 'Child Field' });
  static modelDataId = Fields.Many2one('ir.model.data', { string: "Model Data", compute: '_computeModelDataId', search: '_searchModelDataId' });
  static xmlid = Fields.Char({ string: "External ID", compute: '_computeXmlid', help: "ID of the view defined in xml file" });
  static groupsId = Fields.Many2many('res.groups', { relation: 'irUiViewGroupRel', column1: 'viewId', column2: 'groupId', string: 'Groups', help: "If this field is empty, the view applies to all users. Otherwise, the view applies to the users of those groups only." });
  static mode = Fields.Selection([['primary', "Base view"], ['extension', "Extension View"]], {
    string: "View inheritance mode", default: 'primary', required: true, help: `Only applies if this view inherits from an other one (inheritId is not false/Null).
    * if extension (default), if this view is requested the closest primary view is looked up (via inheritId), then all views inheriting from it with this view's model are applied
    * if primary, the closest primary view is fully resolved (even if it uses a different model than this one), then this view's inheritance specs (<xpath/>) are applied, and the result is used as if it were this view's
    actual arch.
  `});
  static active = Fields.Boolean({
    default: true, help: `If this view is inherited,
    * if true, the view always extends its parent
    * if false, the view currently does not extend its parent but can be enabled
  `});

  static _sqlConstraints = [
    ['inheritanceMode',
      `CHECK (mode != 'extension' OR "inheritId" IS NOT NULL)`,
      "Invalid inheritance mode: if the mode is 'extension', the view must extend an other view"],
    ['qwebRequiredKey',
      "CHECK (type != 'qweb' OR key IS NOT NULL)",
      "Invalid key: QWeb view should have a key"],
  ];

  @api.depends('archDb', 'archFs', 'archUpdated')
  @api.dependsContext('readArchFromFile', 'lang')
  async _computeArch() {
    const self = this;
    async function resolveExternalIds(archFs: string, viewXmlid: string) {
      async function replacer(prefix, xmlid) {
        if (!xmlid.includes('.')) {
          xmlid = format('%s.%s', viewXmlid.split('.')[0], xmlid);
        }
        let [resModel, resId] = await self.env.items('ir.model.data')._xmlidToResModelResId(xmlid);
        if (resModel in ACTION_TYPES) {
          resId = (await self.env.items(resModel).browse(resId).actionId).id;// get baseActionId
        }
        return prefix + String(resId);

      }
      const regex = /(?<prefix>[^%])%\((?<xmlid>.*?)\)[ds]/g;
      const promises = [];
      archFs.replace(regex, (match, ...args: any[]) => {
        const promise = replacer(args[0], args[1]);
        promises.push(promise);
        return match;
      });
      const data = await Promise.all(promises);
      return archFs.replace(regex, () => data.shift());
    }

    let arch;
    for (const view of this) {
      const readFile = this._context['readArchFromFile'] ||
        (tools.config.options['devMode']?.includes('xml') && !await view.archUpdated);
      if (readFile) {
        let [archFs, xmlid, key] = await view(['archFs', 'xmlid', 'key']);
        if (archFs && (xmlid || key)) {
          xmlid = xmlid || key;
          // It is safe to split on / herebelow because archFs is explicitely stored with '/'
          const args: any[] = archFs.split('/');
          const fullpath = getResourcePath(args[0], ...args.slice(1));
          if (fullpath) {
            arch = await getViewArchFromFile(fullpath, xmlid);
            if (arch) {
              // replace %(xmlid)s, %(xmlid)d, %%(xmlid)s, %%(xmlid)d by the resId
              arch = (await resolveExternalIds(arch, xmlid)).replace('%%', '%');
              if (this.env.context['lang']) {
                const tr = await this._fields['archDb'].getTransFunc(view);
                arch = await tr(view.id, arch);
              }
            }
          }
          else {
            console.warn("View %s: Full path [%s] cannot be found.", xmlid, archFs);
            arch = false;
          }
        }
      }
      await view.set('arch', toText(arch || await view.archDb));
    }
  }

  async _inverseArch() {
    for (const view of this) {
      const data = new Dict({ archDb: await view.arch });
      if ('installFilename' in this._context) {
        // we store the relative path to the resource instead of the absolute path, if found
        // (it will be missing e.g. when importing data-only modules using baseImportModule)
        const pathInfo = getResourceFromPath(this._context['installFilename']);
        if (bool(pathInfo)) {
          data['archFs'] = pathInfo.slice(0, 2).join('/');
          data['archUpdated'] = false;
        }
      }
      await view.write(data);
    }
    // the field 'arch' depends on the context and has been implicitly
    // modified in all languages; the invalidation below ensures that the
    // field does not keep an old value in another environment
    this.invalidateCache(['arch'], this._ids);
  }

  @api.depends('arch')
  @api.dependsContext('readArchFromFile')
  async _computeArchBase() {
    // 'arch_base' is the same as 'arch' without translation
    for (const [view, viewWoLang] of _.zip<any, any>([...this], [...(await this.withContext({ lang: null }))])) {
      await view.set('archBase', await viewWoLang.arch);
    }
  }

  async _inverseArchBase() {
    for (const [view, viewWoLang] of _.zip([...this], [...await this.withContext({ lang: null })])) {
      await viewWoLang.set('arch', await view.archBase);
    }
  }

  /**
   * Reset the view arch to its previous arch (soft) or its XML file arch if exists (hard).
   * @param mode 
   */
  async resetArch(mode: string = 'soft') {
    for (const view of this) {
      let arch = false;
      if (mode === 'soft') {
        arch = await view.archPrev;
      }
      else if (mode === 'hard' && await view.archFs) {
        arch = await (await view.withContext({ readArchFromFile: true, lang: null })).arch;
      }
      if (bool(arch)) {
        // Don't save current arch in previous since we reset, this arch is probably broken
        await (await view.withContext({ noSavePrev: true, lang: null }).write({ 'archDb': arch }));
      }
    }
  }

  @api.depends('updatedAt')
  async _computeModelDataId() {
    // get the first ir_model_data record corresponding to self
    for (const view of this) {
      await view.set('modelDataId', false);
    }
    const domain = [['model', '=', 'ir.ui.view'], ['resId', 'in', this.ids]];
    for (const data of await (await this.env.items('ir.model.data').sudo()).searchRead(domain, ['resId'], { order: 'id desc' })) {
      const view = this.browse(data['resId']);
      await view.set('modelDataId', data['id']);
    }
  }

  async _searchModelDataId(operator, value) {
    const label = typeof (value) === 'string' ? 'label' : 'id';
    const domain = [['model', '=', 'ir.ui.view'], [label, operator, value]];
    const data = await (await this.env.items('ir.model.data').sudo()).search(domain);
    return [['id', 'in', await data.mapped('resId')]];
  }

  async _computeXmlid() {
    const xmlids = new DefaultDict();
    const domain = [['model', '=', 'ir.ui.view'], ['resId', 'in', this.ids]];
    for (const data of await (await this.env.items('ir.model.data').sudo()).searchRead(domain, ['module', 'label', 'resId'])) {
      xmlids[data['resId']] = xmlids[data['resId']] || [];
      xmlids[data['resId']].push(`${data['module']}.${data['label']}`);
    }
    for (const view of this as any) {
      await view.set('xmlid', xmlids.get(view.id, [''])[0]);
    }
  }

  /**
   * Check whether view inheritance is based on translated attribute.
   * @param arch 
   */
  async _validInheritance(arch) {
    const self = this as any;
    const nodes: any[] = xpath.select('//*[@position]', arch);
    for (const node of nodes) {
      if (node.tagName === 'xpath') {
        const expr = node.getAttribute('expr') || '';
        const match = expr.match(TRANSLATED_ATTRS_RE);
        if (match) {
          const msg = `View inheritance may not use attribute ${match[1]} as a selector.`
          await this._raiseViewError(msg, node);
        }
        // if (expr.match(WRONGCLASS)) { // TODO check contains(@class, '')
        //   console.log(`Error-prone use of @class in view ${await self.label} (${await self.xmlid}): use the hasclass(*classes) function to filter elements by their classes`)
        // }
        if (expr.match(WRONGHASCLASS)) {
          console.log(`Error-prone use of hasclass in view ${await self.label} (${await self.xmlid}): use the @class="class-name" or contains(@class,"class-name") function to filter elements by their classes`)
        }
      }
      else {
        for (const attr of TRANSLATED_ATTRS.keys()) {
          if (node.getAttribute(attr)) {
            const message = f("View inheritance may not use attribute %r as a selector.", attr);
            await this._raiseViewError(message, node);
          }
        }
      }
    }
    return true;
  }

  @api.constrains('archDb')
  async _checkXml() {
    // Sanity checks: the view should not break anything upon rendering!
    // Any exception raised below will cause a transaction rollback.
    const partialValidation = this.env.context['irUiViewPartialValidation'];
    const self: any = await this.withContext({ validateViewIds: partialValidation ? this._ids : true });

    for (const view of self) {
      let combinedArch;
      try {
        const [type, arch, inheritId] = await view(['type', 'arch', 'inheritId']);

        // verify the view is valid xml and that the inheritance resolves
        if (bool(inheritId)) {
          const viewArch = getrootXml(parseXml(arch));
          await view._validInheritance(viewArch);
        }
        combinedArch = await view._getCombinedArch();
        if (type === 'qweb') {
          continue;
        }
      } catch (e) {
        const err = new ValidationError(await this._t('Error while validating view:\n\n%s', e));
        err.stack = e.stack;
        throw err;
      }
      let curArch;
      try {
        const [model, label, xmlid, archFs] = await view(['model', 'label', 'xmlid', 'archFs']);
        // verify that all fields used are valid, etc.
        await view._validateView(combinedArch, model);
        let combinedArchs = [combinedArch];
        if (combinedArchs[0].tagName === 'data') {
          // A <data> element is a wrapper for multiple root nodes
          combinedArchs = Array.from(combinedArchs[0].childNodes);
        }
        for (const arch of combinedArchs) {
          curArch = arch;
          for (const node of xpath.select('//*[@__validate__]', arch)) {
            (node as Element).removeAttribute['__validate__'];
          }
          const check = validView(arch, { env: self.env, model: model });
          if (!check) {
            const viewName = xmlid ? `${label} (${xmlid})` : label;
            throw new ValidationError(_format(await this._t(
              'Invalid view {name} definition in {file}'),
              { name: viewName, file: archFs }
            ));
          }
          if (check === "Warning") {
            const viewName = xmlid ? `${label} (${xmlid})` : label;
            console.warn('Invalid view %s definition in %s \n%s', viewName, archFs, arch);
          }
        }
      } catch (e) {
        if (isInstance(e, ValueError)) {
          const lines = serializeXml(combinedArch, 'unicode').split('\n');
          const fivelines = lines.slice(0, 5).join();
          const err = new ValidationError(_format(await this._t(
            "Error while validating view near:\n{fivelines}\n{error}"),
            { fivelines: fivelines, error: e, arch: combinedArch },
          ))
          err.stack = e.stack;
          throw err;
        }
        else {
          throw e;
        }
      }
    }
    return true;
  }

  @api.constrains('type', 'groupsId', 'inheritId')
  async _checkGroups() {
    for (const view of this) {
      if (await view.type === 'qweb' &&
        (await view.groupsId).ok &&
        (await view.inheritId).ok &&
        await view.mode !== 'primary') {
        throw new ValidationError(await this._t("Inherited Qweb view cannot have 'Groups' define on the record. Use 'groups' attributes inside the view definition"));
      }
    }
  }

  @api.constrains('inheritId')
  async _check000Inheritance() {
    // NOTE: constraints methods are check alphabetically. Always ensure this method will be
    //       called before other constraint methods to avoid infinite loop in `_getCombinedArch`.
    if (! await this._checkRecursion('inheritId')) {
      throw new ValidationError(await this._t('You cannot create recursive inherited views.'));
    }
  }

  async _autoInit() {
    await _super(View, this)._autoInit();
    await tools.createIndex(this._cr, 'irUiView_model_inheritId_index', this.cls._table, ['"model"', '"inheritId"']);
  }


  async _computeDefaults(values) {
    if ('inheritId' in values) {
      // Do not automatically change the mode if the view already has an inheritId,
      // and the user change it to another.
      if (!values['inheritId']) {
        setdefault(values, 'mode', values['inheritId'] ? 'extension' : 'primary');
      }
      else {
        let doit = true;
        for (const view of this) {
          if (bool(await view.inheritId)) {
            doit = false;
            break;
          }
        }
        if (doit) {
          setdefault(values, 'mode', values['inheritId'] ? 'extension' : 'primary');
        }
      }
    }
    return values;
  }

  /**
   * Validate the architecture of all the views of a given module that
        are impacted by view updates, but have not been checked yet.
   * @param module 
   * @returns 
   */
  @api.model()
  async _validateModuleViews(module) {
    assert(this.pool._init)

    // only validate the views that still exist...
    const prefix = module + '.';
    const prefixLen = prefix.length;
    const names = Array.from(this.pool.loadedXmlids).filter(xmlid => xmlid.startsWith(prefix)).map(xmlid => xmlid.slice(prefixLen));
    if (!names.length) {
      return;
    }

    // retrieve the views with an XML id that has not been checked yet, i.e.,
    // the views with noupdate=true on their xml id
    const query = `
      SELECT v.id
      FROM "irUiView" v
      JOIN "irModelData" md ON (md.model = 'ir.ui.view' AND md."resId" = v.id)
      WHERE md.module = '%s' AND md.label IN (%s) AND md.noupdate
    `
    const res = await this._cr.execute(query, [module, quoteList(names)]);
    const views = this.browse(res.map(row => row['id']));

    for (const view of views) {
      await view._checkXml();
    }
  }

  async _raiseViewError(message, node?: Element, fromTraceback?: any) {
    const err = new ValueError(message);
    err.stack = fromTraceback;
    const self: any = this;
    setattr(err, 'context', {
      'view': this,
      'label': await self.label ?? null,
      'xmlid': self.env.context['installXmlid'] ?? await self.xmlid,
      'view.model': await self.model,
      'view.parent': await self.inheritId,
      'file': self.env.context['installFilename'],
      'line': node != null ? getattr(node, 'line', 1) : 1,
    });
    throw err;
  }

  /**
   * Handle a view issue by logging a warning.

   * @param message message to raise or log, augmented with contextual view information
   * @param node the lxml element where the error is located (if any)
   */
  async _logViewWarning(message, node: Element) {
    const self: any = this;
    const errorContext = {
      'view': self,
      'label': await self.label ?? null,
      'xmlid': self.env.context['installXmlid'] ?? await self.xmlid,
      'view.model': await self.model,
      'view.parent': await self.inheritId,
      'file': self.env.context['installFilename'],
      'line': node != null ? getattr(node, 'line', 1) : 1,
    }
    console.warn(
      "\tView warning: %s\n\t%s", message, stringify(errorContext)
    )
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const values of valsList) {
      if (!values['type']) {
        if (values['inheritId']) {
          values['type'] = await this.browse(values['inheritId']).type;
        }
        else {
          try {
            if (!values['arch'] && !values['archBase']) {
              throw new ValidationError(await this._t('Missing view architecture.'));
            }
            const xml = getrootXml(parseXml(values['arch'] ?? values['archBase']));
            values['type'] = xml.tagName;
          } catch (e) {
            if (!isInstance(e, XmlError)) {
              // don't raise here, the constraint that runs `this._checkXml` will do the job properly.
              throw e;
            }
          }
        }
      }
      if (!values['key'] && values['type'] === 'qweb') {
        values['key'] = `genKey.${uuid4().slice(0, 6)}`;
      }
      if (!values['label']) {
        values['label'] = `${values['model']} ${values['type']}`;
      }
      // Create might be called with either `arch` (xml files), `archBase` (form view) or `archDb`.
      values['archPrev'] = values['archBase'] ?? values['archDb'] ?? values['arch'];
      // write on arch: bypass _inverseArch()
      if ('arch' in values) {
        values['archDb'] = values.pop('arch');
        if ('installFilename' in this._context) {
          // we store the relative path to the resource instead of the absolute path, if found (it will be missing e.g. when importing data-only modules using base_import_module)
          const pathInfo = getResourceFromPath(this._context['installFilename'] || '');
          if (pathInfo) {
            values['archFs'] = pathInfo.slice(0, 2).join('/');
            values['archUpdated'] = false;
          }
        }
      }
      Object.assign(values, await this._computeDefaults(values));
    }

    this.clearCaches();
    const result = await _super(View, await this.withContext({ irUiViewPartialValidation: true })).create(valsList);
    return result.withEnv(this.env);
  }

  async write(vals) {
    // Keep track if view was modified. That will be useful for the --dev mode
    // to prefer modified arch over file arch.
    if (!('archUpdated' in vals) && ('arch' in vals || 'archBase' in vals) && !('installFilename' in this._context)) {
      vals['archUpdated'] = true;
    }

    // drop the corresponding view customizations (used for dashboards for example), otherwise
    // not all users would see the updated views
    const customView = await this.env.items('ir.ui.view.custom').search([['refId', 'in', this.ids]]);
    if (customView.ok) {
      await customView.unlink();
    }
    this.clearCaches();
    if ('archDb' in vals && !this.env.context['noSavePrev']) {
      vals['archPrev'] = await this('archDb');
    }
    const res = await _super(View, this).write(await this._computeDefaults(vals));

    // Check the xml of the view if it gets re-activated.
    // Ideally, `active` shoud have been added to the `api.constrains` of `_checkXml`,
    // but the ORM writes and validates regular field (such as `active`) before inverse fields (such as `arch`),
    // and therefore when writing `active` and `arch` at the same time, `_checkXml` is called twice,
    // and the first time it tries to validate the view without the modification to the arch,
    // which is problematic if the user corrects the view at the same time he re-enables it.
    if (vals['active']) {
      // Call `_validateFields` instead of `_checkXml` to have the regular constrains error dialog
      // instead of the traceback dialog.
      await this._validateFields(['archDb']);
    }

    return res;
  }

  async unlink() {
    // if in uninstall mode and has children views, emulate an ondelete CASCADE
    const inheritChildrenIds = await (this as any).inheritChildrenIds;
    if ((this.env.context['_forceUnlink'] ?? false) && bool(inheritChildrenIds)) {
      await inheritChildrenIds.unlink();
    }
    return _super(View, this).unlink();
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    this.ensureOne();
    const key = await this('key');
    if (key && defaultValue && !(key in defaultValue)) {
      const newKey = key + `_${uuid4().slice(0, 6)}`;
      defaultValue = Object.assign({}, defaultValue, { key: newKey });
    }
    return _super(View, this).copy(defaultValue);
  }

  /**
   * Return the arch of ``this`` (as a string) combined with its inherited views.
   * @returns 
   */
  async getCombinedArch(): Promise<[Element, string]> {
    const dom = await this._getCombinedArch();
    return [dom, serializeHtml(dom, 'unicode')];
  }


  /**
   * Return this's arch combined with its inherited views archs.

    @param hierarchy mapping from parent views to their child views
    @returns combined architecture
   */
  async _combine(hierarchy: DefaultDict<any, any>) {
    this.ensureOne();
    assert(await this['mode'] === 'primary');
    /**
    # We achieve a pre-order depth-first hierarchy traversal where
    # primary views (and their children) are traversed after all the
    # extensions for the current primary view have been visited.
    #
    # https://en.wikipedia.org/wiki/Tree_traversal#Depth-first_search_of_binary_tree
    #
    # Example:                  hierarchy = {
    #                               1: [2, 3],  # primary view
    #             1*                2: [4, 5],
    #            / \                3: [],
    #           2   3               4: [6],     # primary view
    #          / \                  5: [7, 8],
    #         4*  5                 6: [],
    #        /   / \                7: [],
    #       6   7   8               8: [],
    #                           }
    #
    # Tree traversal order (`view` and `queue` at the `while` stmt):
    #   1 [2, 3]
    #   2 [5, 3, 4]
    #   5 [7, 8, 3, 4]
    #   7 [8, 3, 4]
    #   8 [3, 4]
    #   3 [4]
    #   4 [6]
    #   6 []
    **/
    const archDb = await this['archDb'];
    let combinedArch = getrootXml(parseXml(archDb));
    if (this.env.context['inheritBranding']) {
      Object.entries<any>({
        'data-oe-model': 'ir.ui.view',
        'data-oe-id': String(this.id),
        'data-oe-field': 'arch',
      }).forEach(([k, v]) => combinedArch.setAttribute(k, v));
    }
    this._addValidationFlag(combinedArch);

    /**
    # The depth-first traversal is implemented with a double-ended queue.
    # The queue is traversed from left to right, and after each view in the
    # queue is processed, its children are pushed at the left of the queue,
    # so that they are traversed in order.  The queue is therefore mostly
    # used as a stack.  An exception is made for primary views, which are
    # pushed at the other end of the queue, so that they are applied after
    # all extensions have been applied.
    **/
    const queue = await tools.sortedAsync(hierarchy[this.id] || [], async (v) => v.mode);
    while (queue.length) {
      const view = queue.shift();
      const arch = await view.arch;
      const dom = getrootXml(parseXml(arch));
      if (view.env.context['inheritBranding']) {
        await view.inheritBranding(dom);
      }
      this._addValidationFlag(combinedArch, view, dom);
      combinedArch = await view.applyInheritanceSpecs(combinedArch, dom);

      const list = hierarchy[view.id] || [];
      for (let index = list.length - 1; index >= 0; index--) {
        const childView = list[index];
        if (await childView.mode === 'primary') {
          queue.push(childView);
        }
        else {
          queue.unshift(childView);
        }
      }
    }
    return combinedArch;
  }

  /**
   * Return the arch of ``this`` (as an etree) combined with its inherited views.
   * @returns 
   */
  async _getCombinedArch() {
    let root: any = this;
    const viewIds = [];
    while (true) {
      viewIds.push(root.id);
      const inheritId = await root.inheritId;
      if (!bool(inheritId)) {
        break;
      }
      root = inheritId;
    }
    let views = this.browse(viewIds);

    // Add inherited views to the list of loading forced views
    // Otherwise, inherited views could not find elements created in
    // their direct parents if that parent is defined in the same module
    // introduce checkViewIds in context
    if (!('checkViewIds' in views.env.context)) {
      views = await views.withContext({ checkViewIds: [] });
    }
    extend(views.env.context['checkViewIds'], viewIds);

    // Map each node to its children nodes. Note that all children nodes are
    // part of a single prefetch set, which is all views to combine.
    const treeViews = await views._getInheritingViews();
    const hierarchy = new DefaultDict();
    for (const view of treeViews) {
      const id = (await view.inheritId).id;
      hierarchy[id] = hierarchy[id] || [];
      hierarchy[id].push(view);
    }

    // optimization: make root part of the prefetch set, too
    let arch = await root.withPrefetch(treeViews._prefetchIds)._combine(hierarchy);
    const res = getrootXml(arch);
    return res;
  }

  /*------------------------------------------------------
  * Inheritance mecanism
  *-----------------------------------------------------*/

  /**
   * Return a domain to filter the sub-views to inherit from.
   * @returns 
   */
  @api.model()
  async _getInheritingViewsDomain() {
    return [['active', '=', true]];
  }

  /**
   * This method is meant to be overridden by other modules.
   * @returns 
   */
  @api.model()
  async _getFilterXmlidQuery() {
    return `SELECT "resId" FROM "irModelData"
      WHERE "resId" IN ({resIds}) AND model = 'ir.ui.view' AND module IN ({modules})
    `
  }

  /**
   * Determine the views that inherit from the current recordset, and return
        them as a recordset, ordered by priority then by id.
   * @returns 
   */
  async _getInheritingViews() {
    await this.checkAccessRights('read');
    const domain = await this._getInheritingViewsDomain();
    const e = await Expression.new(domain, this.env.items('ir.ui.view'));
    const [fromClause, whereClause, whereParams] = e.query.getSql();
    assert(fromClause === '"irUiView"', `Unexpected from clause: ${fromClause}`);

    await this._flushSearch(domain, { fields: ['inheritId', 'priority', 'model', 'mode'], order: 'id' });
    const query = `
        WITH RECURSIVE "irUiViewInherits" AS (
            SELECT id, "inheritId", priority, mode, model
            FROM "irUiView"
            WHERE id IN (${String(this.ids) || 'NULL'}) AND ${whereClause}
        UNION
            SELECT "irUiView".id, "irUiView"."inheritId", "irUiView".priority, "irUiView".mode, "irUiView".model
            FROM "irUiView"
            INNER JOIN "irUiViewInherits" parent ON parent.id = "irUiView"."inheritId"
            WHERE coalesce("irUiView".model, '') = coalesce(parent.model, '')
                  AND "irUiView".mode = 'extension'
                  AND ${whereClause}
        )
        SELECT
            v.id, v."inheritId", v.mode,
            ARRAY(SELECT r."groupId" FROM "irUiViewGroupRel" r WHERE r."viewId"=v.id) as "groupIds"
        FROM "irUiViewInherits" v
        ORDER BY v.priority, v.id
    `
    // ORDER BY v.priority, v.id:
    //  1/ sort by priority: abritrary value set by developers on some
    //     views to solve "dependency hell" problems and force a view
    //     to be combined earlier or later. e.g. all views created via
    //     studio have a priority=99 to be loaded last.
    //  2/ sort by view id: the order the views were inserted in the
    //     database. e.g. base views are placed before stock ones.

    let rows = await this.env.cr.execute(query, [...whereParams, ...whereParams]);

    // filter out forbidden views
    if (rows.some(row => len(row['groupIds']) > 0)) {
      const userGroups = (await (await this.env.user()).groupsId).ids;
      rows = rows.filter(row => !(len(row['groupIds']) && _.intersection(userGroups, row['groupIds']).length == 0));
    }

    let views = this.browse(rows.map(row => row['id']));

    // optimization: fill in cache of inheritId and mode
    this.env.cache.update(views, this._fields['inheritId'], rows.map(row => row['inheritId']));
    this.env.cache.update(views, this._fields['mode'], rows.map(row => row['mode']));

    // During an upgrade, we can only use the views that have been
    // fully upgraded already.
    if (this.pool._init && !this._context['loadAllViews']) {
      views = await views._filterLoadedViews();
    }
    return views;
  }

  /**
   * During the module upgrade phase it may happen that a view is
        present in the database but the fields it relies on are not
        fully loaded yet. This method only considers views that belong
        to modules whose code is already loaded. Custom views defined
        directly in the database are loaded only after the module
        initialization phase is completely finished.
   * @returns 
   */
  async _filterLoadedViews() {
    // check that all found ids have a corresponding xmlid in a loaded module
    const checkViewIds = await this.env.context['checkViewIds'];
    const idsToCheck = this.ids.filter(vid => !checkViewIds.includes(vid));
    if (!idsToCheck.length) {
      return this;
    }
    const loadedModules = Array.from(this.pool._initModules).concat(this._context['installModule'] || []);
    let query = await this._getFilterXmlidQuery();
    query = _format(query, { 'resIds': String(idsToCheck), 'modules': loadedModules.length ? quoteList(loadedModules) : 'NULL' });
    const rows = await this.env.cr.execute(query);
    const validViewIds = new Set(_.union(rows.map(row => row['resId']), checkViewIds));
    return this.browse(this.ids.filter(vid => validViewIds.has(vid)));
  }

  /**
   * Locate a node in a source (parent) architecture.

    Given a complete source (parent) architecture (i.e. the field
    `arch` in a view), and a 'spec' node (a node in an inheriting
    view that specifies the location in the source view of what
    should be changed), return (if it exists) the node in the
    source view matching the specification.

    @param arch a parent architecture to modify
    @param spec a modifying node in an inheriting view
    @returns a node in the source matching the spec
   */
  async locateNode(arch, spec) {
    return locateNode(arch, spec);
  }

  async inheritBranding(specsTree) {
    for (const node of iterchildren(specsTree)) {
      if (isElement(node)) {
        const _xpath = getpath(node);
        if (node.tagName === 'data' || node.tagName === 'xpath' || node.getAttribute('position')) {
          await this.inheritBranding(node);
        }
        else if (node.getAttribute('t-field')) {
          node.setAttribute('data-oe-xpath', _xpath);
          await this.inheritBranding(node);
        }
        else {
          node.setAttribute('data-oe-id', String(this.id));
          node.setAttribute('data-oe-xpath', _xpath);
          node.setAttribute('data-oe-model', 'ir.ui.view');
          node.setAttribute('data-oe-field', 'arch');
        }
      }
    }
    return specsTree;
  }

  /**
   * Add a validation flag on elements in ``combinedArch`` or ``arch``.
    This is part of the partial validation of views.

    @param combinedArch: the architecture to be modified by ``arch``
    @param view an optional view inheriting ``this``
    @param arch an optional modifying architecture from inheriting
        view ``view``
   */
  _addValidationFlag(combinedArch, view?: any, arch?: any) {
    // validateViewIds is either falsy (no validation), true (full
    // validation) or a collection of ids (partial validation)
    const validateViewIds = this.env.context['validateViewIds']
    if (validateViewIds == null) {
      return;
    }

    const root = getrootXml(combinedArch);
    if (validateViewIds == true || validateViewIds.includes(this.id)) {
      // optimization, flag the root node
      root.setAttribute('__validate__', '1');
      return;
    }

    if (view == null || !validateViewIds.includes(view.id)) {
      return;
    }

    const nodes: any[] = arch ? xpath.select('//*[@position]', arch) : [];
    for (const node of nodes) {
      if (['after', 'before', 'inside'].includes(node.getAttribute('position'))) {
        // validate the elements being inserted, except the ones that
        // specify a move, as in:
        //   <field name="foo" position="after">
        //       <field name="bar" position="move"/>
        //   </field>
        for (const child of Array.from<Element>(node.childrenNodes ?? []).filter(child => isElement(child))) {
          if (!child.getAttribute('position')) {
            child.setAttribute('__validate__', '1');
          }
        }
      }
      if (node.getAttribute('position') === 'replace') {
        // validate everything, since this impacts the whole arch
        root.setAttribute('__validate__', '1');
        break;
      }
      if (node.getAttribute('position') === 'attributes') {
        // validate the element being modified by adding
        // attribute "__validate__" on it:
        //   <field name="foo" position="attributes">
        //       <attribute name="readonly">1</attribute>
        //       <attribute name="__validate__">1</attribute>    <!-- add this -->
        //   </field>
        node.appendChild(E.attribute('1', { name: '__validate__' }));
      }
    }
  }

  /**
   * Fetches the default view for the provided (model, viewType) pair:
      primary view with the lowest priority.

    @param model
    @param viewType
    @return id of the default view of false if none found
   */
  // default view selection
  @api.model()
  async defaultView(model, viewType) {
    const domain = [['model', '=', model], ['type', '=', viewType], ['mode', '=', 'primary']];
    return (await this.search(domain, { limit: 1 })).id;
  }

  /**
   * Apply an inheriting view (a descendant of the base view)

    Apply to a source architecture all the spec nodes (i.e. nodes
    describing where and what changes to apply to some parent
    architecture) given by an inheriting view.

    @param source a parent architecture to modify
    @param specsTree a modifying architecture in an inheriting view
    @param preLocate function that is execute before locating a node.
                                    This function receives an arch as argument.
    @returns a modified source where the specs are applied
   */
  @api.model()
  async applyInheritanceSpecs(source, specsTree, preLocate = (s) => true) {
    // Queue of specification nodes (i.e. nodes describing where and
    // changes to apply to some parent architecture).
    try {
      source = await applyInheritanceSpecs(
        source, specsTree,
        this._context['inheritBranding'],
        preLocate,
      )
    } catch (e) {
      if (isInstance(e, ValueError)) {
        await this._raiseViewError(String(e), specsTree);
      }
      else {
        throw e;
      }
    }
    return source;
  }

  async getViewXmlid() {
    const domain = [['model', '=', 'ir.ui.view'], ['resId', '=', this.id]];
    const xmlid = (await (await this.env.items('ir.model.data').sudo()).searchRead(domain, ['module', 'label']))[0];
    return format('%s.%s', xmlid['module'], xmlid['label']);
  }

  /**
   * Return the view ID corresponding to ``template``, which may be a
    view ID or an XML ID. Note that this method may be overridden for other
    kinds of template values.

    This method could return the ID of something that is not a view (when
    using fallback to `_xmlidToResId`).
   * @param template 
   * @returns 
   */
  @api.model()
  async getViewId(template) {
    if (typeof (template) === 'number') {
      return template;
    }
    if (!template.includes('.')) {
      throw new ValueError('Invalid template id: %s', template);
    }
    const view = await (await this.sudo()).search([['key', '=', template]], { limit: 1 });
    return view.ok && bool(view.id) ? view.id : await this.env.items('ir.model.data')._xmlidToResId(template, true);
  }

  @api.model()
  async renderPublicAsset(template, values) {
    template = (await this.sudo()).browse(await this.getViewId(template));
    await template._checkViewAccess();
    return (await template.sudo())._render(values, "ir.qweb");
  }

  async _renderTemplate(template, values?: any, engine: string = 'ir.qweb') {
    const viewId = await this.getViewId(template);
    return this.browse(viewId)._render(values, engine);
  }

  async _render(values?: any, engine: string = 'ir.qweb', minimalQcontext: boolean = false) {

    assert(typeof (this.id) === 'number');

    const qcontext = minimalQcontext ? new Dict<any>() : await this._prepareQcontext();
    qcontext.updateFrom(values ?? {});

    return this.env.items(engine)._render(this.id, qcontext);
  }

  /**
   * Apply group restrictions: elements with a 'groups' attribute should
    be made invisible to people who are not members.
   * @param node 
   * @param nameManager 
   * @param nodeInfo 
   * @returns 
   */
  async _applyGroups(node: Element, nameManager: NameManager, nodeInfo: { modifiers: {}; editable: any; }) {
    if (node.getAttribute('groups')) {
      const canSee = await this.userHasGroups(node.getAttribute('groups'));
      if (!canSee) {
        node.setAttribute('invisible', '1');
        nodeInfo['modifiers']['invisible'] = true;
        if (node.getAttribute('attrs')) {
          node.removeAttribute('attrs');    // avoid making field visible later
        }
      }
      node.removeAttribute('groups');
    }
  }

  /**
   * Returns the qcontext : rendering context with website specific value (required
          to render website layout template)
   */
  @api.model()
  async _prepareQcontext() {
    const req = this.env.req;
    const qcontext = new Dict<any>({
      request: req,  // might be unbound if we're not in an httpRequest context
      debug: req && req.session ? req.session.debug : '',
      env: this.env,
      viewId: (this as any).id,
      xmlid: await (await this.sudo()).key,
      userId: this.env.items("res.users").browse((await this.env.user()).id),
      resCompany: await (await this.env.company()).sudo(),
      testModeEnabled: bool(tools.config.get('testEnable')) || tools.config.get('testFile'),
      keepQuery: keepQuery,
      quotePlus: urlQuotePlus,
      DateTime: DateTime,
      toText: toText,
      imageDataUri: imageDataUri,
      decode: stringBase64,
      now: _Datetime.now
    })
    return qcontext;
  }


  /*------------------------------------------------------
  # Postprocessing: translation, groups and modifiers
  #------------------------------------------------------
  # TODO: remove group processing from irQweb
  #------------------------------------------------------*/
  /**
   * Return an architecture and a description of all the fields.

    The field description combines the result of fieldsGet() and
    postprocess().

   * @param node the architecture as an etree
   * @param model the view's reference model name
   * @returns a tuple [arch, fields] where arch is the given node as a
        string and fields is the description of all the fields.
   */
  async postprocessAndFields(node, model?: string) {
    if (this.ok) {
      this.ensureOne();      // self is at most one view
    }
    const nameManager = await this._postprocessView(node, model || await this['model']);

    const arch = serializeXml(node).replace('\t', '');
    return [node, arch, Dict.from(nameManager.availableFields)];
  }

  /**
   * 
   * @param node 
   * @param modelName 
   * @param editable 
   */
  async _postprocessView(node: Element, modelName: string, editable: boolean = true) {
    const root = node;

    if (!(modelName in this.env.models)) {
      await this._raiseViewError(await this._t('Model not found: %s', modelName), root);
    }
    const model = this.env.items(modelName);

    await this._postprocessOnchange(root, model);

    let nameManager = new NameManager(model);

    // use a stack to recursively traverse the tree
    const stack: [Element, boolean][] = [[root, editable]]
    while (stack.length) {

      let editable: boolean;
      [node, editable] = stack.pop() ?? [];

      // compute default
      const nodeInfo = {
        'modifiers': {},
        'editable': editable && await this._editableNode(node, nameManager),
      }

      // tag-specific postprocessing
      const tag = node.tagName;
      const parent = node.parentNode;
      const postprocessor = this[`_postprocessTag_${tag}`];
      if (postprocessor != null) {
        await postprocessor.apply(this, [node, nameManager, nodeInfo]);
        if (node.parentNode != parent) {
          // the node has been removed, stop processing here
          continue;
        }
      }
      await this._applyGroups(node, nameManager, nodeInfo);
      transferNodeToModifiers(node, nodeInfo['modifiers'], this._context);
      transferModifiersToNode(nodeInfo['modifiers'], node);

      // if present, iterate on nodeInfo['children'] instead of node
      for (const child of Array.from<Element>(nodeInfo['children'] ?? node.childNodes ?? []).filter(c => isElement(c)).reverse()) {
        stack.push([child, nodeInfo['editable']]);
      }
    }
    await nameManager.updateAvailableFields();
    await this._postprocessAccessRights(root, await model.sudo(false));

    return nameManager;
  }

  /**
   * Add attribute onchange="1" on fields that are dependencies of
            computed fields on the same view.
   * @param arch 
   * @param model 
   */
  async _postprocessOnchange(arch: Element, model: any) {
    // map each field object to its corresponding nodes in arch
    const fieldNodes = new Map();
    const self = this;
    function collect(node: Element, model: ModelRecords) {
      if (node.tagName === 'field') {
        const field = model._fields.get(node.getAttribute('name'));
        if (field) {
          if (!fieldNodes.has(field)) {
            fieldNodes.set(field, []);
          }
          fieldNodes.get(field).push(node);
          if (field.relational) {
            model = self.env.items(field.comodelName);
          }
        }
      }
      for (const child of Array.from<any>(node.childNodes ?? []).filter(n => isElement(n))) {
        collect(child, model);
      }
    }

    collect(arch, model);

    for (const [field, nodes] of fieldNodes) {
      // if field should trigger an onchange, add onchange="1" on the
      // nodes referring to field
      model = this.env.items(field.modelName);
      if (await model._hasOnChange(field, fieldNodes)) {
        for (const node of nodes) {
          if (!node.getAttribute('onchange')) {
            node.setAttribute('onchange', '1');
          }
        }
      }
    }
  }

  /**
   * Compute and set on node access rights based on view type. Specific
    views can add additional specific rights like creating columns for
    many2one-based grouping views. 
   * @param node 
   * @param model 
   */
  async _postprocessAccessRights(node: Element, model: ModelRecords) {
    // testing ACL as real user
    const isBaseModel = (this.env.context['baseModelName'] ?? model._name) === model._name;

    if (['kanban', 'tree', 'form', 'activity', 'calendar'].includes(node.tagName)) {
      for (const [action, operation] of [['create', 'create'], ['delete', 'unlink'], ['edit', 'write']]) {
        if (!node.getAttribute(action) &&
          ! await model.checkAccessRights(operation, false) ||
          !(this._context[action] ?? true) && isBaseModel) {
          node.setAttribute(action, 'false');
        }
      }
    }

    if (node.tagName === 'kanban') {
      const groupbyName = node.getAttribute('defaultGroupby');
      const groupbyField = model._fields.get(groupbyName);
      if (groupbyField && groupbyField.type === 'many2one') {
        const groupbyModel = model.env.items(groupbyField.comodelName);
        for (const [action, operation] of [['groupCreate', 'create'], ['groupDelete', 'unlink'], ['groupEdit', 'write']]) {
          if (!node.getAttribute(action) &&
            ! await groupbyModel.checkAccessRights(operation, false) ||
            !(this._context[action] ?? true) && isBaseModel) {
            node.setAttribute(action, 'false');
          }
        }
      }
    }
  }

  //------------------------------------------------------
  // Specific node postprocessors
  //------------------------------------------------------
  async _postprocessTag_calendar(node: Element, nameManager: NameManager, nodeInfo) {
    for (const additionalField of ['dateStart', 'dateDelay', 'dateStop', 'color', 'allDay']) {
      if (node.getAttribute(additionalField)) {
        nameManager.addField(node.getAttribute(additionalField).split('.')[0]);
      }
    }
    for (const f of Array.from<any>(node.childNodes ?? []).filter(n => isElement(n))) {
      if (f.tagName === 'filter') {
        nameManager.addField(f.getAttribute('name'));
      }
    }
  }

  async _postprocessTag_field(node: Element, nameManager: NameManager, nodeInfo) {
    const name = node.getAttribute('name');
    if (name) {
      const attrs = Dict.from<any>({ 'id': node.getAttribute('id'), 'select': node.getAttribute('select') });
      const field = nameManager.model._fields.get(name);
      if (field) {
        // apply groups (no tested)
        if (field.groups && ! await this.userHasGroups(field.groups)) {
          node.parentNode.removeChild(node);
          // no point processing view-level ``groups`` anymore, return
          return;
        }
        const views = {};
        for (const child of childNodes(node, isElement)) {
          if (['form', 'tree', 'graph', 'kanban', 'calendar'].includes(child.tagName)) {
            node.removeChild(child);
            const subNameManager = await (await this.withContext({ baseModelName: nameManager.model._name }))
              ._postprocessView(child, field.comodelName, nodeInfo['editable']);
            const xarch = serializeXml(child).replace('\t', '');
            views[child.tagName] = {
              'arch': xarch,
              'fields': Dict.from(subNameManager.availableFields),
            }
          }
        }
        attrs['views'] = views;
        if (['many2one', 'many2many'].includes(field.type)) {
          const comodel = await this.env.items(field.comodelName).sudo(false);
          const canCreate = await comodel.checkAccessRights('create', false);
          const canWrite = await comodel.checkAccessRights('write', false);
          node.setAttribute('canCreate', canCreate ? 'true' : 'false')
          node.setAttribute('canWrite', canWrite ? 'true' : 'false');
        }
      }
      nameManager.addField(name, attrs);

      const fieldInfo = (await nameManager.fieldInfo())[name];
      if (bool(fieldInfo)) {
        transferFieldToModifiers(fieldInfo, nodeInfo['modifiers']);
      }
    }
  }

  async _postprocessTag_form(node: Element, nameManager: NameManager, nodeInfo) {
    const result = await nameManager.model.viewHeaderGet(false, node.tagName);
    if (result) {
      node.setAttribute('string', String(result));
    }
  }

  async _postprocessTag_groupby(node: Element, nameManager: NameManager, nodeInfo) {
    // groupby nodes should be considered as nested view because they may
    // contain fields on the comodel
    const name = node.getAttribute('name');
    const field = nameManager.model._fields.get(name);
    if (!field || !field.comodelName) {
      return;
    }
    // move all children nodes into a new node <groupby>
    const groupbyNode = E.withType('groupby');
    while (node.childNodes.length > 0) {
      groupbyNode.appendChild(node.childNodes[0]);
    }
    // post-process the node as a nested view, and associate it to the field
    const subNameManager = await (await this.withContext(
      { baseModelName: nameManager.model._name },
    ))._postprocessView(groupbyNode, field.comodelName, false);
    const xarch = serializeXml(groupbyNode).replace('\t', '');
    nameManager.addField(name, {
      'views': {
        'groupby': {
          'arch': xarch,
          'fields': Dict.from(subNameManager.availableFields),
        }
      }
    });
  }

  async _postprocessTag_label(node: Element, nameManager: NameManager, nodeInfo) {
    if (node.getAttribute('for')) {
      const field = nameManager.model._fields.get(node.getAttribute('for'));
      if (field && field.groups && ! await this.userHasGroups(field.groups)) {
        node.parentNode.removeChild(node);
      }
    }
  }

  async _postprocessTag_search(node: Element, nameManager: NameManager, nodeInfo) {
    const searchpanel = Array.from<any>(node.childNodes ?? []).filter(child => isElement(child) && child.tagName === 'searchpanel');
    if (searchpanel.length) {
      await (await this.withContext(
        { baseModelName: nameManager.model._name }
      ))._postprocessView(
        searchpanel[0], nameManager.model._name, false,
      );
      nodeInfo['children'] = Array.from<any>(node.childNodes ?? []).filter(child => isElement(child) && child.tagName === 'searchpanel');
    }
  }

  async _postprocessTag_tree(node: Element, nameManager: NameManager, nodeInfo) {
    // reuse form view post-processing
    await this._postprocessTag_form(node, nameManager, nodeInfo);
  }

  // view editability

  /**
   * Return whether the given node must be considered editable.
   * @param node 
   * @param nameManager 
   * @returns 
   */
  async _editableNode(node, nameManager) {
    const func = this[`_editableTag_${node.tagName}`];
    if (func != null) {
      return func(node, nameManager);
    }
    // by default views are non-editable
    return !this.cls.type.selection.map(item => item[0]).includes(node.tagName);
  }

  async _editableTag_form(node: Element, nameManager: NameManager) {
    return true;
  }

  async _editableTag_tree(node: Element, nameManager: NameManager) {
    return node.getAttribute('editable');
  }

  async _editableTag_field(node: Element, nameManager: NameManager) {
    const field = nameManager.model._fields.get(node.getAttribute('name'));
    return field == null || field.isEditable() && (
      !['1', 'true', 'true'].includes(node.getAttribute('readonly'))
      || len(getDictAsts(node.getAttribute('attrs') || "{}"))
    )
  }

  // view validation

  /**
   * Validate the given architecture node, and return its corresponding
    NameManager.

   * @param node the combined architecture as an etree
   * @param modelName the reference model name for the given architecture
   * @param editable whether the view is considered editable
   * @param full whether the whole view must be validated
   * @returns the combined architecture's NameManager
   */
  async _validateView(node: Element, modelName: string, editable: boolean = true, full: boolean = false) {
    this.ensureOne();

    if (!(modelName in this.env.models)) {
      await this._raiseViewError(await this._t('Model not found: %s', modelName), node);
    }

    // fieldsGet() optimization: validation does not require translations
    const model = await this.env.items(modelName).withContext({ lang: null });
    const nameManager = new NameManager(model);

    // use a stack to recursively traverse the tree
    const stack: [Element, boolean, any][] = [[node, editable, full]];
    while (stack.length) {
      let [node, editable, validate] = stack.pop();

      // compute default
      validate = validate || getAttribute(node, '__validate__', false);
      const nodeInfo = {
        'editable': editable && await this._editableNode(node, nameManager),
        'validate': validate,
      }

      // tag-specific validation
      const tag = node.tagName;
      const validator = this[`_validateTag_${tag}`];
      if (validator != null) {
        await validator.apply(this, [node, nameManager, nodeInfo]);
      }
      if (validate) {
        await this._validateAttrs(node, nameManager, nodeInfo);
      }

      for (const child of Array.from<any>(node.childNodes ?? []).filter(n => isElement(n)).reverse()) { // Todo: check text
        stack.push([child, nodeInfo['editable'], validate]);
      }
    }
    await nameManager.check(this);

    return nameManager;
  }

  //------------------------------------------------------
  // Node validator
  //------------------------------------------------------
  async _validateTag_form(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    // pass;
  }

  async _validateTag_tree(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    // reuse form view validation
    await this._validateTag_form(node, nameManager, nodeInfo);
    if (!nodeInfo['validate']) {
      return;
    }
    const allowedTags = ['field', 'button', 'control', 'groupby', 'widget', 'header'];
    for (const child of iterchildren(node)) {
      if (isElement(child) && !allowedTags.includes(child.tagName)) {
        const msg = await this._t(
          'Tree child can only have one of %s tag (not %s)',
          allowedTags.join(', '), child.tagName,
        );
        await this._raiseViewError(msg, child);
      }
    }
  }

  async _validateTag_graph(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (!nodeInfo['validate']) {
      return;
    }
    for (const child of iterchildren(node)) {
      if (isElement(child) && child.tagName !== 'field') {
        const msg = await this._t('A <graph> can only contains <field> nodes, found a <%s>', child.tagName);
        await this._raiseViewError(msg, child);
      }
    }
  }

  async _validateTag_calendar(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    for (const additionalField of ['dateStart', 'dateDelay', 'dateStop', 'color', 'allDay']) {
      if (node.getAttribute(additionalField)) {
        nameManager.addField(node.getAttribute(additionalField).split('.')[0]);
      }
    }
    for (const f of iterchildren(node, 'filter')) {
      nameManager.addField(f.getAttribute('name'))
    }
  }

  async _validateTag_search(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (nodeInfo['validate'] && !iterdescendants(node, "field").length) {
      // the field of the search view may be within a group node, which is why we must check
      // for all descendants containing a node with a field tag, if this is not the case
      // then a search is not possible.
      await this._logViewWarning('Search tag requires at least one field element', node);
    }
    const searchpanels = iterchildren(node, 'searchpanel');
    if (searchpanels.length) {
      if (searchpanels.length > 1) {
        await this._raiseViewError(await this._t('Search tag can only contain one search panel'), node);
      }
      node.removeChild(searchpanels[0]);
      await this._validateView(searchpanels[0], nameManager.model._name, false, nodeInfo['validate']);
    }
  }

  async _validateTag_field(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    const validate = nodeInfo['validate'];

    const name = node.getAttribute('name');
    if (!name) {
      await this._raiseViewError(await this._t("Field tag must have a \"name\" attribute defined"), node);
    }
    const field = nameManager.model._fields.get(name);
    if (field) {
      if (validate && field.relational) {
        const domain = node.getAttribute('domain')
          ?? (nodeInfo['editable'] && await field._descriptionDomain(field, this.env))
        if (typeof (domain) === 'string') {
          // dynamic domain: in [['foo', '=', bar]], field 'foo' must
          // exist on the comodel and field 'bar' must be in the view
          const desc = (node.getAttribute('domain') ? `domain of <field name="${name}">` : `domain of field '${name}'`);
          const [fnames, vnames] = await this._getDomainIdentifiers(node, domain, desc);
          await this._checkFieldPaths(node, fnames, field.comodelName, `${desc} (${domain})`);
          if (vnames) {
            nameManager.mustHaveFields(vnames, `${desc} (${domain})`);
          }
        }
      }
      else if (validate && node.getAttribute('domain')) {
        const msg = _format(
          await this._t('Domain on non-relational field "{name}" makes no sense (domain:{domain})'),
          { name: name, domain: node.getAttribute('domain') },
        )
        await this._raiseViewError(msg, node);
      }
      for (const child of iterchildren(node)) {
        if (!isElement(child)) {
          continue;
        }
        if (!['form', 'tree', 'graph', 'kanban', 'calendar'].includes(child.tagName)) {
          continue;
        }
        node.removeChild(child);
        const subManager = await this._validateView(child, field.comodelName, nodeInfo['editable'], validate);
        for (const [fname, use] of subManager.mandatoryParentFields.items()) {
          nameManager.mustHaveField(fname, use);
        }
      }
    }
    else if (validate && !(name in await nameManager.fieldInfo())) {
      const msg = _format(
        await this._t('Field "{fieldName}" does not exist in model "{modelName}"'),
        { fieldName: name, modelName: nameManager.model._name },
      )
      await this._raiseViewError(msg, node);
    }
    nameManager.addField(name, { 'id': node.getAttribute('id'), 'select': node.getAttribute('select') })

    if (validate) {
      for (const attribute of ['invisible', 'readonly', 'required']) {
        const value = node.getAttribute(attribute);
        if (value) {
          const result = quickEval(value, { 'context': this._context });
          if (![1, 0, true, false, null].includes(result)) {
            const msg = _format(
              await this._t('Attribute "{attribute}" evaluation expects a boolean, got "{value}"="{result}".\n'),
              { attribute: attribute, value: value, result: result },
            );
            await this._raiseViewError(msg, node);
          }
        }
      }
    }
  }

  async _validateTag_filter(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (!nodeInfo['validate']) {
      return;
    }
    const domain = node.getAttribute('domain');
    if (domain) {
      const name = node.getAttribute('name');
      const desc = name ? 'domain of <filter name="{name}">' : 'domain of <filter>';
      const [fnames, vnames] = await this._getDomainIdentifiers(node, domain, desc);
      await this._checkFieldPaths(node, fnames, nameManager.model._name, `${desc} (${domain})`);
      if (vnames) {
        nameManager.mustHaveFields(vnames, `${desc} (${domain})`);
      }
    }
  }

  async _validateTag_button(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (!nodeInfo['validate']) {
      return;
    }
    const name = node.getAttribute('name');
    const special = node.getAttribute('special');
    const type = node.getAttribute('type');
    if (special) {
      if (!['cancel', 'save', 'add'].includes(special)) {
        await this._raiseViewError(_f(await this._t("Invalid special '{value}' in button"), { value: special }), node);
      }
    }
    else if (type) {
      if (type === 'edit') { // listRenderer, used in kanban view
        return;
      }
      else if (!name) {
        await this._raiseViewError(await this._t("Button must have a name"), node);
      }
      else if (type === 'object') {
        const func = nameManager.model[name];
        if (!func) {
          const msg = _f(await this._t(
            "{actionName} is not a valid action on {modelName}"),
            { actionName: name, modelName: nameManager.model._name }
          );
          await this._raiseViewError(msg, node);
        }
        try {
          checkMethodName(name);
        } catch (e) {
          if (isInstance(e, AccessError)) {
            const msg = _f(await this._t(
              "{method} on {model} is private and cannot be called from a button"),
              { method: name, model: nameManager.model._name },
            );
            await this._raiseViewError(msg, node);
          }
          throw e;
        }
        try {
          func.bind(nameManager.model);
        } catch (e) {
          if (isInstance(e, TypeError)) {
            const msg = "%s on %s has parameters and cannot be called from a button";
            await this._logViewWarning(f(msg, name, nameManager.model._name), node);
          }
        }
      }
      else if (type === 'action') {
        // logic mimics /web/action/load behaviour
        let model = 'ir.actions.actions';
        let actionId, action = false;
        try {
          actionId = parseInt(name, 10, true);
        } catch (e) {
          [model, actionId] = await this.env.items('ir.model.data')._xmlidToResModelResId(name, false);
          if (!bool(actionId)) {
            const msg = _f(await this._t("Invalid xmlid {xmlid} for button of type action."), { xmlid: name });
            await this._raiseViewError(msg, node);
          }
          if (!(model in ACTION_TYPES)) {
            const msg = _f(await this._t(
              "{xmlid} is of type {xmlidModel}, expected a subclass of ir.actions.actions"),
              { xmlid: name, xmlidModel: model },
            );
            await this._raiseViewError(msg, node);
          }
        }
        action = await (await this.env.items(model).browse(actionId)).exists();
        if (!bool(action)) {
          const msg = _f(await this._t(
            "Action {actionReference} (id: {actionId}) does not exist for button of type action."),
            { actionReference: name, actionId: actionId },
          );
          await this._raiseViewError(msg, node);
        }
      }
      nameManager.addAction(name);
    }
    else if (node.getAttribute('icon')) {
      const description = f('A button with icon attribute (%s)', node.getAttribute('icon'));
      await this._validateFaClassAccessibility(node, description);
    }
  }

  async _validateTag_groupby(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    // groupby nodes should be considered as nested view because they may contain fields on the comodel
    const name = node.getAttribute('name');
    if (!name) {
      return;
    }
    const field = nameManager.model._fields.get(name);
    if (field) {
      if (nodeInfo['validate']) {
        if (field.type !== 'many2one') {
          const msg = _f(await this._t(
            "Field '{name}' found in 'groupby' node can only be of type many2one, found {type}"),
            { name: field.name, type: field.type },
          );
          await this._raiseViewError(msg, node);
        }
        const domain = nodeInfo['editable'] && await field._descriptionDomain(this.env);
        if (typeof (domain) === 'string') {
          const desc = `domain of field '${name}'`;
          const [fnames, vnames] = await this._getDomainIdentifiers(node, domain, desc);
          await this._checkFieldPaths(node, fnames, field.comodelName, `${desc} (${domain})`);
          if (bool(vnames)) {
            nameManager.mustHaveFields(vnames, `${desc} (${domain})`);
          }
        }
      }
      // move all children nodes into a new node <groupby>
      const groupbyNode = E.withType('groupby');
      while (node.childNodes.length > 0) {
        groupbyNode.appendChild(node.childNodes[0]);
      }
      // validate the node as a nested view
      const subManager = await this._validateView(
        groupbyNode, field.comodelName, false, nodeInfo['validate'],
      );
      nameManager.addField(name);
      for (const [fname, use] of subManager.mandatoryParentFields.items()) {
        nameManager.mustHaveField(fname, use);
      }
    }
    else if (nodeInfo['validate']) {
      const msg = _f(await this._t(
        "Field '{field}' found in 'groupby' node does not exist in model {model}"),
        { field: name, model: nameManager.model._name },
      );
      await this._raiseViewError(msg, node);
    }
  }

  async _validateTag_searchpanel(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (!nodeInfo['validate']) {
      return;
    }
    for (const child of iterchildren(node, isElement)) {
      if (child.getAttribute('domain') && child.getAttribute('select') !== 'multi') {
        const msg = await this._t('Searchpanel item with select multi cannot have a domain.');
        await this._raiseViewError(msg, child);
      }
    }
  }

  async _validateTag_label(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (!nodeInfo['validate']) {
      return;
    }
    // replace return not arch.xpath('//label[not(@for) and not(descendant::input)]')
    const for_ = node.getAttribute('for');
    if (!for_) {
      const msg = await this._t(`Label tag must contain a "for". To match label style  without corresponding field or button, use \'class="o-form-label"\'.`);
      await this._raiseViewError(msg, node);
    }
    else {
      nameManager.mustHaveName(for_, '<label for="...">');
    }
  }

  async _validateTag_page(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (!nodeInfo['validate']) {
      return;
    }
    if (node.parentNode == null || (node.parentNode as Element).tagName !== 'notebook') {
      await this._raiseViewError(await this._t('Page direct ancestor must be notebook'), node);
    }
  }

  async _validateTag_img(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (nodeInfo['validate'] && !Array.from(attNames('alt')).some(alt => getAttribute(node, alt))) {
      await this._logViewWarning('<img> tag must contain an alt attribute', node);
    }
  }

  async _validateTag_a(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    //['calendar', 'form', 'graph', 'kanban', 'pivot', 'search', 'tree', 'activity']
    if (nodeInfo['validate'] && Array.from(attNames('class')).some(cl => getAttribute(node, cl, '').includes('btn'))) {
      if (node.getAttribute('role') !== 'button') {
        const msg = '"<a>" tag with "btn" class must have "button" role';
        await this._logViewWarning(msg, node);
      }
    }
  }

  async _validateTag_ul(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (nodeInfo['validate']) {
      // was applied to all nodes, but in practice only used on div and ul
      await this._checkDropdownMenu(node);
    }
  }

  async _validateTag_div(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    if (nodeInfo['validate']) {
      await this._checkDropdownMenu(node);
      await this._checkProgressBar(node);
    }
  }

  // Validation tools

  async _checkDropdownMenu(node: Element) {
    //['calendar', 'form', 'graph', 'kanban', 'pivot', 'search', 'tree', 'activity']
    if (Array.from(attNames('class')).some(cl => getAttribute(node, cl, '').includes('dropdown-menu'))) {
      if (node.getAttribute('role') !== 'menu') {
        const msg = 'dropdown-menu class must have menu role';
        await this._logViewWarning(msg, node);
      }
    }
  }

  async _checkProgressBar(node: Element) {
    if (Array.from(attNames('class')).some(cl => getAttribute(node, cl, '').includes('o-progressbar'))) {
      if (node.getAttribute('role') !== 'progressbar') {
        const msg = 'o-progressbar class must have progressbar role';
        await this._logViewWarning(msg, node);
      }
      if (!Array.from(attNames('aria-valuenow')).some(at => node.getAttribute(at))) {
        const msg = 'o-progressbar class must have aria-valuenow attribute';
        await this._logViewWarning(msg, node);
      }
      if (!Array.from(attNames('aria-valuemin')).some(at => node.getAttribute(at))) {
        const msg = 'o-progressbar class must have aria-valuemin attribute';
        await this._logViewWarning(msg, node);
      }
      if (!Array.from(attNames('aria-valuemax')).some(at => node.getAttribute(at))) {
        const msg = 'o-progressbar class must have aria-valuemax attribute';
        await this._logViewWarning(msg, node);
      }
    }
  }

  /**
   * Verify that a view is accessible by the current user based on the
    groups attribute. Views with no groups are considered private.
   * @returns 
   */
  async _checkViewAccess() {
    const self: any = this;
    const inheritId = await self.inheritId;
    const groupsId = await self.groupsId;
    if (bool(inheritId) && (await self.mode) !== 'primary') {
      return inheritId._checkViewAccess();
    }
    if (groupsId.ok & (await (await self.env.user()).groupsId).ok) {
      return true;
    }
    let error;
    if (groupsId.ok) {
      const groups = [];
      for (const g of groupsId) {
        groups.push(await g.label);
      }
      error = _f(
        await this._t("View '{label}' accessible only to groups {groups} "),
        { label: await self.key, groups: groups.join(", ") }
      );
    }
    else {
      error = _f(
        await this._t("View '{label}' is private"),
        { label: await self.key }
      );
    }
    throw new AccessError(error);
  }

  /**
   * Generic validation of node attrs.
   * @param node 
   * @param nameManager 
   * @param nodeInfo 
   */
  async _validateAttrs(node: Element, nameManager: NameManager, nodeInfo: {} = {}) {
    for (const attribute of Array.from(node.attributes)) {
      const [attr, expr] = [attribute.name, attribute.value];
      if (['class', 't-att-class', 't-attf-class'].includes(attr)) {
        await this._validateClasses(node, expr);
      }
      else if (attr === 'attrs') {
        for (const [key, valAst] of getDictAsts(expr).items()) {
          if (valAst.type === 'ArrayExpression') {
            // domains in attrs are used for readonly, invisible, ...
            // and thus are only executed client side
            // console.log('debug expr=', expr);
            const [fnames, vnames] = await this._getDomainIdentifiers(node, valAst, attr, expr);
            nameManager.mustHaveFields(_.intersection(fnames, vnames), `attrs (${expr})`);
          }
          else {
            const vnames = getVariableNames(valAst);
            if (vnames) {
              nameManager.mustHaveFields(vnames, `attrs (${expr})`)
            }
          }
        }
      }
      else if (attr === 'context') {
        for (const [key, valAst] of getDictAsts(expr).items()) {
          if (key === 'groupby') {  // only in context
            if (valAst.type !== 'Literal') {
              const msg = await this._t(
                '"groupby" value must be a string %s=%s',
                attr, expr,
              )
              await this._raiseViewError(msg, node);
            }
            const groupby = valAst.value;
            const fname = groupby.split(':')[0];
            if (!(fname in nameManager.model._fields)) {
              const msg = await this._t(
                'Unknown field "%s" in "groupby" value in %s=%s',
                fname, attr, expr,
              )
              await this._raiseViewError(msg, node);
            }
          }
          else {
            const vnames = getVariableNames(valAst);
            if (vnames.length) {
              nameManager.mustHaveFields(vnames, `context (${expr})`);
            }
          }
        }
      }
      else if (attr === 'groups') {
        for (const group of expr.replace('!', '').split(',')) {
          // further improvement: add all groups to nameManager in
          // order to batch check them at the end
          if (! await this.env.items('ir.model.data')._xmlidToResId(group.trim(), false)) {
            const msg = "The group %s defined in view does not exist!";
            await this._logViewWarning(format(msg, group), node);
          }
        }
      }
      else if (['col', 'colspan'].includes(attr)) {
        // col check is mainly there for the tag 'group', but previous
        // check was generic in view form
        if (!isDigit(expr)) {
          await this._raiseViewError(
            await this._t('%s value must be an integer (%s)', attr, expr),
            node,
          );
        }
      }
      else if (attr.startsWith('decoration-')) {
        const vnames = getVariableNames(expr);
        if (vnames) {
          nameManager.mustHaveFields(vnames, `${attr}=${expr}`);
        }
      }
      else if (attr === 'data-toggle' && expr === 'tab') {
        if (node.getAttribute('role') !== 'tab') {
          const msg = 'tab link (data-toggle="tab") must have "tab" role';
          await this._logViewWarning(msg, node);
        }
        const ariaControl = node.getAttribute('aria-controls') || node.getAttribute('t-att-aria-controls');
        if (!ariaControl && !node.getAttribute('t-attf-aria-controls')) {
          const msg = 'tab link (data-toggle="tab") must have "ariaControl" defined';
          await this._logViewWarning(msg, node);
        }
        if (ariaControl && ariaControl.includes('#')) {
          const msg = 'aria-controls in tablink cannot contains "#"';
          await this._logViewWarning(msg, node);
        }
      }
      else if (attr === "role" && ['presentation', 'none'].includes(expr)) {
        const msg = ("A role cannot be `none` or `presentation`. \nAll your elements must be accessible with screen readers, describe it.");
        await this._logViewWarning(msg, node);
      }
      else if (attr === 'group') {
        const msg = "attribute 'group' is not valid.  Did you mean 'groups'?";
        await this._logViewWarning(msg, node);
      }
    }
  }

  /**
   * Validate the classes present on node.
   * @param node 
   * @param expr 
   */
  async _validateClasses(node: Element, expr: string) {
    const classes = expr.trim().split(' ');
    // Be careful: not always true if it is an expression
    // example: <div t-attf-class="{{!selectionMode ? 'oe-kanban-color-' + kanbanGetcolor(record.color.rawValue) : ''}} oe-kanban-card oe-kanban-global-click oe_applicant_kanban oe_semantic_html_override">
    if (classes.includes('modal') && node.getAttribute('role') !== 'dialog') {
      const msg = '"modal" class should only be used with "dialog" role';
      await this._logViewWarning(msg, node);
    }

    if (classes.includes('modal-header') && node.tagName !== 'header') {
      const msg = '"modal-header" class should only be used in "header" tag'
      await this._logViewWarning(msg, node)
    }

    if (classes.includes('modal-body') && node.tagName !== 'main') {
      const msg = '"modal-body" class should only be used in "main" tag'
      await this._logViewWarning(msg, node)
    }

    if (classes.includes('modal-footer') && node.tagName !== 'footer') {
      const msg = '"modal-footer" class should only be used in "footer" tag'
      await this._logViewWarning(msg, node)
    }

    if (classes.includes('tab-pane') && node.getAttribute('role') !== 'tabpanel') {
      const msg = '"tab-pane" class should only be used with "tabpanel" role'
      await this._logViewWarning(msg, node)
    }

    if (classes.includes('nav-tabs') && node.getAttribute('role') !== 'tablist') {
      const msg = 'A tab list with class nav-tabs must have role="tablist"'
      await this._logViewWarning(msg, node)
    }

    if (classes.some(klass => klass.startsWith('alert-'))) {
      if (!['alert', 'alertdialog', 'status'].includes(node.getAttribute('role'))
        && !classes.includes('alert-link')) {
        const msg = (`An alert (class alert-*) must have an alert, alertdialog or 
                  status role or an alert-link class. Please use alert and 
                  alertdialog only for what expects to stop any activity to 
                  be read immediately.`)
        await this._logViewWarning(msg, node)
      }
    }
    if (classes.some(klass => klass.startsWith('fa-'))) {
      const description = format('A <%s> with fa class (%s)', node.tagName, expr);
      await this._validateFaClassAccessibility(node, description);
    }

    if (classes.some(klass => klass.startsWith('btn'))) {
      if (['a', 'button', 'select'].includes(node.tagName)) {
        // pass
      }
      else if (node.tagName === 'input' && ['button', 'submit', 'reset'].includes(node.getAttribute('type'))) {
        // pass
      }
      else if (classes.some(klass => ['btn-group', 'btn-toolbar', 'btn-ship'].includes(klass))) {
        // pass
      }
      else {
        const msg = (`A simili button must be in tag a/button/select or tag 'input'
                with type button/submit/reset or have class in 
                btn-group/btn-toolbar/btn-ship`)
        await this._logViewWarning(msg, node)
      }
    }
  }

  async _validateFaClassAccessibility(node: Element, description: string) {
    const validAriaAttrs = [
      ...attNames('title'), ...attNames('aria-label'), ...attNames('aria-labelledby'),
    ]
    const validTAttrs = ['t-value', 't-raw', 't-field', 't-esc']

    // Following or preceding text
    if ((isText(node.previousSibling) && node.previousSibling.textContent || '').trim() || (isText(node.nextSibling) && node.nextSibling.textContent || '').trim()) {
      // text<i class="fa-..."/> or <i class="fa-..."/>text or
      return;
    }
    // Following or preceding text in span
    function hasText(elem: any) {
      if (elem == null) {
        return false;
      }
      if (elem.tagName === 'span' && (elem.textContent || isText(elem.firstChild))) {
        return true;
      }
      if (elem.tagName === 't' && (elem.getAttribute('t-esc') || elem.getAttribute('t-raw'))) {
        return true;
      }
      return false;
    }

    if (hasText(node.nextSibling) || hasText(node.previousSibling)) {
      return;
    }

    // Aria label can be on ancestors
    function hasTitleOrAriaLabel(node) {
      return validAriaAttrs.some(attr => getAttribute(node, attr));
    }

    let parent = node.parentNode;
    while (parent != null) {
      if (hasTitleOrAriaLabel(parent)) {
        return
      }
      parent = parent.parentNode;
    }

    // And we ignore all elements with describing in children
    function containsDescription(node, depth: number = 0) {
      if (depth > 2)
        console.warn('excessive depth in fa');
      if (validTAttrs.some(attr => node.getAttribute(attr)))
        return true;
      if (hasTitleOrAriaLabel(node))
        return true;
      if (['label', 'field'].includes(node.tagName))
        return true;
      if (node.tagName === 'button' && node.getAttribute('string'))
        return true;
      if (node.textContent)  // not sure, does it match *[text()]
        return true;
      return Array.from(node.childNodes ?? []).some(child => isElement(child) && containsDescription(child, depth + 1));
    }

    if (containsDescription(node)) {
      return;
    }
    // Show warning
    const msg = ('%s must have title in its tag, parents, descendants or have text');
    await this._logViewWarning(format(msg, description), node);
  }

  async _getDomainIdentifiers(node: Element, domain: any, use: string, expr?: string) {
    try {
      const res = getDomainIdentifiers(domain);
      return res;
    } catch (e) {
      console.log(e.message);
      const msg = _f(await this._t("Invalid domain format {expr} in {use}"), { expr: expr || domain, use: use });
      await this._raiseViewError(msg, node);
    }
  }

  /**
   * Check whether the given field paths (dot-separated field names)
    correspond to actual sequences of fields on the given model.
   * @param node 
   * @param fieldPaths 
   * @param modelName 
   * @param use 
   */
  async _checkFieldPaths(node: Element, fieldPaths: string[], modelName: string, use: string) {
    for (const fieldPath of fieldPaths) {
      const names = fieldPath.split('.');
      let model = this.pool.models[modelName];
      for (const [index, name] of enumerate(names)) {
        if (Model == null) {
          const msg = _f(
            await this._t('Non-relational field {field} in path {field_path} in {use})'),
            { field: names[index - 1], fieldPath: fieldPath, use: use },
          )
          await this._raiseViewError(msg, node);
        }
        const field = model._fields[name];
        if (!field) {
          const msg = _f(
            await this._t('Unknown field "{model}.{field}" in {use})'),
            { model: model._name, field: name, use: use },
          );
          await this._raiseViewError(msg, node);
        }
        if (!field._descriptionSearchable) {
          const msg = _f(
            await this._t('Unsearchable field {field} in path {fieldPath} in {use})'),
            { field: name, fieldPath: fieldPath, use: use },
          );
          await this._raiseViewError(msg, node);
        }
        model = this.pool.models[field.comodelName];
      }
    }
  }

  // QWeb template views

  /**
   * Return the list of context keys to use for caching ``_readTemplate``.
   * @returns 
   */
  _readTemplateKeys() {
    return ['lang', 'inheritBranding', 'editable', 'translatable', 'editTranslations'];
  }

  @api.model()
  @tools.conditional(
    !tools.config.options['devMode'].includes('xml'),
    tools.ormcache('(await (await self.env.user()).groupsId).ids', 'viewId', 'self._readTemplateKeys().map(k => self._context[k])'),
  )
  async _readTemplate(viewId) {
    const archTree = await this.browse(viewId)._getCombinedArch();
    this.distributeBranding(archTree);
    return serializeHtml(archTree, 'unicode');
  }

  _containsBranded(node: Element) {
    return node.tagName == 't'
      || node.hasAttribute('t-raw')
      || node.hasAttribute('t-call')
      || iterdescendants(node).some(child => this.isNodeBranded(child));
  }

  _popViewBranding(element) {
    const distributedBranding = Object.fromEntries(
      MOVABLE_BRANDING.filter(attr => element.getAttribute(attr)).map(attr => [attr, popAttribute(element, attr)])
    )
    return distributedBranding;
  }

  distributeBranding(e: Element, branding?: any, parentXpath: string = '', indexMap: any = constantMapping(1)) {
    if (e.getAttribute('t-ignore') || e.tagName === 'head') {
      // remove any view branding possibly injected by inheritance
      const attrs = MOVABLE_BRANDING;
      for (const descendant of iterdescendants(e, isElement)) {
        if (!_.intersection(attrs, Array.from<Attr>(descendant.attributes).map(attr => attr.name)).length) {
          continue;
        }
        this._popViewBranding(descendant);
      }
      // Remove the processing instructions indicating where nodes were
      // removed (see applyInheritanceSpecs)
      for (const descendant of iterdescendants(e, isProcessingInstruction)) {
        if (descendant.target === 'apply-inheritance-specs-node-removal') {
          descendant.parentNode.removeChild(descendant);
        }
      }
      return;
    }

    let nodePath = getAttribute(e, 'data-oe-xpath', null);
    if (nodePath == null) {
      nodePath = f("%s/%s[%s]", parentXpath, e.tagName, indexMap[e.tagName]);
    }
    if (bool(branding)) {
      if (e.getAttribute('t-field')) {
        e.setAttribute('data-oe-xpath', nodePath);
      }
      else if (!e.getAttribute('data-oe-model')) {
        for (const attr of Object.entries(branding)) {
          e.setAttribute(attr[0], String(attr[1]));
        }
        e.setAttribute('data-oe-xpath', nodePath);
      }
    }
    if (!e.getAttribute('data-oe-model')) {
      return;
    }

    if (_.intersection(['t-esc', 't-raw', 't-out'], Array.from<Attr>(e.attributes).map(attr => attr.name)).length) {
      // nodes which fully generate their content and have no reason to
      // be branded because they can not sensibly be edited
      this._popViewBranding(e);
    }
    else if (this._containsBranded(e)) {
      // if a branded element contains branded elements distribute own
      // branding to children unless it's t-raw, then just remove branding
      // on current element
      const distributedBranding = this._popViewBranding(e);

      if (!e.hasAttribute('t-raw')) {
        // TODO: collections.Counter if remove p2.6 compat
        // running index by tag type, for XPath query generation
        const indexes = new DefaultDict2(() => 0);
        for (const child of iterchildren(e, (n) => isElement(n) || isProcessingInstruction(n))) {
          if (child.getAttribute('data-oe-xpath')) {
            // injected by view inheritance, skip otherwise
            // generated xpath is incorrect
            this.distributeBranding(child);
          }
          else if (isProcessingInstruction(child)) {
            // If a node is known to have been replaced during
            // applying an inheritance, increment its index to
            // compute an accurate xpath for subsequent nodes
            if (child.target === 'apply-inheritance-specs-node-removal') {
              indexes[child.nodeValue] = indexes[child.nodeValue] || 0;
              indexes[child.nodeValue] += 1;
              e.removeChild(child);
            }
          }
          else {
            indexes[child.tagName] = indexes[child.tagName] || 0;
            indexes[child.tagName] += 1;
            this.distributeBranding(
              child, distributedBranding,
              nodePath, indexes);
          }
        }
      }
    }
  }

  /**
   * Finds out whether a node is branded or qweb-active (bears a
    @data-oe-model or a @t-* *which is not t-field* as t-field does not
    section out views)

    @param node an etree-compatible element to test
   */
  isNodeBranded(node) {
    return getAttributes(node.attributes).some(attr => ['data-oe-model', 'groups'].includes(attr.name) || attr.name.startsWith('t-')
    ) || (
        isProcessingInstruction(node) && node.target === 'apply-inheritance-specs-node-removal'
      )
  }


  /**
   * Open a view for editing the translations of field 'archDb'. 
   * @returns 
   */
  async openTranslations() {
    return this.env.items('ir.translation').translateFields('ir.ui.view', this.id, 'archDb');
  }


  /**
   * Validate architecture of custom views (= without xml id) for a given model.
            This method is called at the end of registry update.
   * @param model 
   */
  async _validateCustomViews(modelName: string) {
    const query = `SELECT max(v.id)
                            FROM "irUiView" v
                      LEFT JOIN "irModelData" md ON (md."model" = 'ir.ui.view' AND md."resId" = v."id")
                          WHERE md."module" IN (SELECT "label" FROM "irModuleModule") IS NOT TRUE
                            AND v."model" = '${modelName}'
                            AND v."active" = true
                        GROUP BY coalesce(v."inheritId", v."id")`
    const res = await this._cr.execute(query);

    let rec: any = this.browse(res.map(it => it['id']));
    rec = await rec.withContext({ 'loadAllViews': true });
    return rec._checkXml();
  }

  /**
   * To be overriden and have specific view behaviour on create
   * @param modules 
   */
  async _createAllSpecificViews(modules) {
    // pass
  }

  /**
   * Given a view, return a record set containing all the specific views for that view's key.
   * @returns 
   */
  async _getSpecificViews() {
    this.ensureOne();
    // Only qweb views have a specific conterpart
    if (await this['type'] !== 'qweb') {
      return this.env.items('ir.ui.view');
    }
    // A specific view can have a xmlid if exported/imported but it will not be equals to it's key (only generic view will).
    return (await (await this.withContext({ activeTest: false })).search([['key', '=', await this['key']]])).filtered(async (r) => ! await r.xmlid === r.key);
  }

  /**
   * During module update, when updating a generic view, we should also update its specific views (COW'd). Note that we will only update unmodified fields. That will mimic the noupdate behavior on views having an ir.model.data.
   * @param values 
   */
  async _loadRecordsWrite(values) {
    if (await this['type'] === 'qweb') {
      for (const cowView of await this._getSpecificViews()) {
        const authorizedVals = {};
        for (const key of Object.keys(values)) {
          if (key !== 'inheritId' && await cowView[key] === await this[key]) {
            authorizedVals[key] = values[key];
          }
        }
        // if inheritId update, replicate change on cow view but
        // only if that cow view inheritId wasn't manually changed
        const inheritId = values['inheritId'];
        if (inheritId && (await this['inheritId']).id !== inheritId && await (await cowView.inheritId).key === await (await this['inheritId']).key) {
          await this._loadRecordsWriteOnCow(cowView, inheritId, authorizedVals);
        }
        else {
          await (await cowView.withContext({ noCow: true })).write(authorizedVals);
        }
      }
    }
    await _super(View, this)._loadRecordsWrite(values);
  }

  async _loadRecordsWriteOnCow(cowView, inheritId, values) {
    // for modules updated before `website`, we need to
    // store the change to replay later on cow views
    if (!hasattr(this.pool, 'websiteViewsToAdapt')) {
      setattr(this.pool, 'websiteViewsToAdapt', []);
    }
    getattr(this.pool, 'websiteViewsToAdapt').push([
      cowView.id,
      inheritId,
      values,
    ]);
  }

}

/**
 * A wizard to compare and reset views architecture.
 */
@MetaModel.define()
class ResetViewArchWizard extends TransientModel {
  static _module = module;
  static _name = "reset.view.arch.wizard";
  static _description = "Reset View Architecture Wizard";

  static viewId = Fields.Many2one('ir.ui.view', { string: 'View' });
  static viewName = Fields.Char({ related: 'viewId.label', string: 'View Name' });
  static hasDiff = Fields.Boolean({ compute: '_computeArchDiff' });
  static archDiff = Fields.Html({ string: 'Architecture Diff', readonly: true, compute: '_computeArchDiff', sanitizeTags: false });
  static resetMode = Fields.Selection([
    ['soft', 'Restore previous version (soft reset).'],
    ['hard', 'Reset to file version (hard reset).'],
    ['otherView', 'Reset to another view.']],
    { string: 'Reset Mode', default: 'soft', required: true });
  static compareViewId = Fields.Many2one('ir.ui.view', { string: 'Compare To View' });
  static archToCompare = Fields.Text('Arch To Compare To', { compute: '_computeArchDiff' });

  @api.model()
  async defaultGet(fields) {
    const viewIds = (this._context['activeModel'] === 'ir.ui.view' && this._context['activeIds']) || [];
    if (len(viewIds) > 2) {
      throw new ValidationError(await this._t("Can't compare more than two views."));
    }
    const result = await _super(ResetViewArchWizard, this).defaultGet(fields);
    result['viewId'] = viewIds && viewIds[0];
    if (len(viewIds) == 2) {
      result['resetMode'] = 'otherView';
      result['compareViewId'] = viewIds[1];
    }
    return result;
  }

  /**
   * Depending of `resetMode`, return the differences between the
      current view arch and either its previous arch, its initial arch or another view arch.
   * @returns 
   */
  @api.depends('resetMode', 'viewId', 'compareViewId')
  async _computeArchDiff() {
    async function getTableName(viewId) {
      let name = await viewId.displayName;
      if (await viewId.key || await viewId.xmlid) {
        const span = '<span class="ml-1 font-weight-normal small">(%s)</span>';
        name += f(span, await viewId.key || await viewId.xmlid);
      }
      return name;
    }

    for (const view of this) {
      let diffTo = false;
      let diffToName: any = false;
      if (await view.resetMode === 'soft') {
        diffTo = await (await view.viewId).archPrev;
        diffToName = await this._t("Previous Arch");
      }
      else if (await view.resetMode === 'otherView') {
        diffTo = await (await (await view.compareViewId).withContext({ lang: null })).arch;
        diffToName = await getTableName(await view.compareViewId);
      }
      else if (await view.resetMode === 'hard' && await (await view.viewId).archFs) {
        diffTo = await (await (await view.viewId).withContext({ readArchFromFile: true, lang: null })).arch;
        diffToName = await this._t("File Arch");
      }
      await view.set('archToCompare', diffTo);

      if (!diffTo) {
        await view.set('archDiff', false);
        await view.set('hasDiff', false);
      }
      else {
        const viewArch = await (await (await view.viewId).withContext({ lang: null })).arch;
        await view.set('archDiff', getDiff(
          [viewArch, await view.resetMode == 'otherView' ? await getTableName(await view.viewId) : await this._t("Current Arch")],
          [diffTo, diffToName],
        ));
        await view.set('hasDiff', viewArch !== diffTo);
      }
    }
  }

  async resetViewButton() {
    this.ensureOne();
    if (await this['resetMode'] === 'otherView') {
      await (await this['viewId']).write({ 'archDb': await this['archToCompare'] });
    }
    else {
      await (await this['viewId']).resetArch(await this['resetMode']);
    }
    return { 'type': 'ir.actions.actwindow.close' }

  }
}

function transferFieldToModifiers(field: {}, modifiers) {
  const defaultValues = {};
  const stateExceptions = {};
  for (const attr of ['invisible', 'readonly', 'required']) {
    stateExceptions[attr] = [];
    defaultValues[attr] = bool(field[attr]);
  }
  for (const [state, modifs] of Object.entries<any>(field["states"] ?? {})) {
    for (const modif of modifs) {
      if (defaultValues[modif[0]] !== modif[1]) {
        stateExceptions[modif[0]].push(state);
      }
    }
  }

  for (const [attr, defaultValue] of Object.entries<any>(defaultValues)) {
    if (bool(stateExceptions[attr])) {
      modifiers[attr] = [["state", defaultValue ? "not in" : "in", stateExceptions[attr]]];
    }
    else {
      modifiers[attr] = defaultValue;
    }
  }
}

function transferNodeToModifiers(node: Element, modifiers: {}, context: {}) {
  // Don't deal with groups, it is done by check_group().
  // Need the context to evaluate the invisible attribute on tree views.
  // For non-tree views, the context shouldn't be given.
  if (node.getAttribute('attrs')) {
    let attrs = node.getAttribute('attrs').trim();
    attrs = safeEval(attrs);
    Object.assign(modifiers, attrs);
  }

  if (node.getAttribute('states')) {
    if ('invisible' in modifiers && Array.isArray(modifiers['invisible'])) {
      // TODO combine with AND or OR, use implicit AND for now.
      modifiers['invisible'].push(['state', 'not in', node.getAttribute('states').split(',')]);
    }
    else {
      modifiers['invisible'] = [['state', 'not in', node.getAttribute('states').split(',')]];
    }
  }

  for (const attr of ['invisible', 'readonly', 'required']) {
    const valueStr = node.getAttribute(attr);
    if (valueStr) {
      const value = bool(quickEval(valueStr, { 'context': context ?? {} }));
      if (attr === 'invisible'
        && Array.from(iterancestors(node)).some(parent => parent.tagName === 'tree')
        && !Array.from(iterancestors(node)).some(parent => parent.tagName === 'header')) {
        // Invisible in a tree view has a specific meaning, make it a
        // new key in the modifiers attribute.
        modifiers['columnInvisible'] = value;
      }
      else if (value || (!(attr in modifiers) || !Array.isArray(modifiers[attr]))) {
        // Don't set the attribute to false if a dynamic value was
        // provided (i.e. a domain from attrs or states).
        modifiers[attr] = value;
      }
    }
  }
}

function simplifyModifiers(modifiers) {
  for (const a of ['invisible', 'readonly', 'required']) {
    if (a in modifiers && !modifiers[a]) {
      delete modifiers[a];
    }
  }
}

function transferModifiersToNode(modifiers, node: Element) {
  if (bool(modifiers)) {
    simplifyModifiers(modifiers);
    node.setAttribute('modifiers', stringify(modifiers));
  }
}

/**
 * An object that manages all the named elements in a view.
 */
class NameManager {
  availableFields: Dict<Dict<any>>;
  model: ModelRecords;
  availableActions: Set<any>;
  availableNames: Set<any>;
  mandatoryFields: Dict<any>;
  mandatoryParentFields: Dict<any>;
  mandatoryNames: Dict<any>;
  
  constructor(model: ModelRecords) {
    this.model = model;
    this.availableFields = new Dict();         // DefaultDict(Dict))   # {fieldName: fieldInfo}
    this.availableActions = new Set();
    this.availableNames = new Set();
    this.mandatoryFields = new Dict();         // {fieldName: use}
    this.mandatoryParentFields = new Dict();   // {fieldName: use}
    this.mandatoryNames = new Dict();          // {name: use}
  }

  @lazy.define()
  async fieldInfo() {
    return this.model.fieldsGet();
  }

  addField(name, info: {} = {}) {
    if (!(name in this.availableFields)) {
      this.availableFields[name] = new Dict<any>();
    }
    this.availableFields[name].updateFrom(info);
    this.availableNames.add(info['id'] || name);
  }

  addAction(name) {
    this.availableActions.add(name);
  }

  mustHaveField(name: string, use) {
    if (name.startsWith('parent.')) {
      this.mandatoryParentFields[name.slice(7)] = use
    }
    else {
      this.mandatoryFields[name] = use;
    }
  }

  mustHaveFields(names: string[] = [], use) {
    for (const name of names) {
      this.mustHaveField(name, use);
    }
  }

  mustHaveName(name: string, use) {
    this.mandatoryNames[name] = use;
  }

  async check(view) {
    for (const [name, use] of this.mandatoryNames.items()) {
      if (!this.availableActions.has(name) && !this.availableNames.has(name)) {
        const msg = await _t(view.env, `Label or id "${name}" in ${use} must be present in view but is missing.`);
        await view._raiseViewError(msg);
      }
    }
    for (const name of this.availableFields.keys()) {
      if (!(name in this.model._fields) && !(name in await this.fieldInfo())) {
        const msg = await _t(view.env, `Field "${name}" does not exist`);
        await view._raiseViewError(msg);
      }
    }

    for (const [name, use] of this.mandatoryFields.items()) {
      if (name === 'id')  // always available
        continue;
      if (name.includes('.')) {
        const msg = await _t(view.env, `Invalid composed field ${name} in ${use}`);
        await view._raiseViewError(msg);
      }
      const info = this.availableFields.get(name);
      if (info == null) {
        const msg = await _t(view.env, `Field ${name} used in ${use} must be present in view but is missing.`);
        await view._raiseViewError(msg);
      }
      if (info.get('select') === 'multi') { // mainly for searchpanel, but can be a generic behaviour.
        const msg = await _t(view.env, `Field ${name} used in ${use} is present in view but is in select multi.`);
        await view._raiseViewError(msg);
      }
    }
  }

  async updateAvailableFields() {
    for (const [name, info] of this.availableFields.items()) {
      info.updateFrom((await this.fieldInfo())[name] ?? []);
    }
  }
}