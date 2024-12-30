import { DOMImplementation } from '@xmldom/xmldom';
import assert from 'assert';
import fs from "fs/promises";
import _ from "lodash";
import { DateTime } from 'luxon';
import path from "path";
import xpath from "xpath/xpath";
import { Command, release } from "..";
import { callKw, getattr } from "../api/func";
import { Dict } from "../helper/collections";
import { ParseError, ValidationError, ValueError } from "../helper/errors";
import { ModelRecords } from '../models';
import { getModulePath } from '../modules';
import * as tools from '../tools';
import { Environment } from './../api/api';
import { bool } from "./bool";
import { toText } from "./compat";
import { config } from "./config";
import { len } from "./iterable";
import { safeEval, unsafeAsync } from "./save_eval";
import { E, SKIPPED_ELEMENT_TYPES, getrootXml, isElement, isText, iterchildren, parseXml, serializeHtml, serializeXml } from './xml';
import { filePath, processFileCsv } from '../tools';
import * as date_utils from './date_utils';
import { stringify } from './json';

export const ACTION_TYPES = {
  'ir.actions.server': 'Server Actions',
  'ir.actions.client': 'Client Actions',
  'ir.actions.actwindow': 'Window Actions',
  'ir.actions.acturl': 'URL Actions',
  'ir.actions.report': 'Report Actions'
}

export async function convertFile(env: Environment, module: string, filename: string, idref: {}, mode: string, noupdate: boolean, kind?: string, pathname?: string) {
  if (!pathname) {
    pathname = path.join(getModulePath(module), filename);
  }
  const ext = path.parse(filename).ext.toLowerCase();
  if (ext === '.csv') {
    await convertCvsImport(env, module, pathname, idref, mode, noupdate);
  } else if (ext === '.sql') {
    await convertSqlImport(env, pathname);
  } else if (ext === '.xml') {
    await convertXmlImport(env, module, pathname, idref, mode, noupdate);
  } else if (ext === '.json') {
    await convertJsonImport(env, module, pathname, idref, mode, noupdate);
  } else {
    throw new ValueError("Can't load unknown file type %s.", filename);
  }
}

async function convertSqlImport(env: Environment, pathname: string) {
  const data = await fs.readFile(filePath(pathname));
  console.log('Not implemented convertSqlImport SQL: %s', data);
}

async function convertJsonImport(env: Environment, module: string, pathname: string, idref: {}, mode: string, noupdate?: boolean) {
  try {
    const rawdata = await fs.readFile(filePath(pathname), 'utf8');
    const conf = JSON.parse(rawdata);
    const dict = {};
    for (const [key, value] of Object.entries<any>(conf)) {
      if (!key.startsWith('//')) {
        dict[_.camelCase(key)] = value;
      }
    }
  } catch (e) {
    console.log('Can not load data: %s', pathname);
  }
}

async function _evalXml(self: XmlImport, node: Element, env: any): Promise<any> {
  /**
   * replace 'refId()' => 'await refId()'
   * @param aEval 
   * @returns 
   */
  function _changeAwaitRefId(aEval: string): string {
    // Todo must check nested functions
    return aEval.replace(/(await)?(\s)*?((refId)\(([^()]*)\))/gm, (...args) => 'await '+ args[3]);
  }

  if (['field', 'value'].includes(node.tagName)) {
    const t = node.getAttribute('type') || 'char';
    const fModel = node.getAttribute('model');
    if (node.getAttribute('search')) {
      const fSearch = node.getAttribute("search")
      const fUse = node.getAttribute("use") || 'id';
      const fName = node.getAttribute('name') || node.getAttribute("label");
      let idref2 = {}
      if (fSearch) {
        idref2 = _getIdref(self, env, fModel, self.idref);
      }
      const q = await unsafeAsync(fSearch, idref2);
      let ids = (await env.items(fModel).search(q)).ids
      if (fUse !== 'id') {
        const _ids = await env.items(fModel).browse(ids).read([fUse]);
        ids = _ids.map(x => x[fUse]);
      }
      const _fields = env.models[fModel]._fields;
      if ((fName in _fields) && _fields[fName].type === 'many2many') {
        return ids;
      }
      let fVal: any = false;
      if (ids.length) {
        fVal = ids[0];
        if (Array.isArray(fVal)) {
          fVal = fVal[0];
        }
      }
      return fVal;
    }
    let aEval = node.getAttribute('eval');
    if (aEval) {
      const idref2 = _getIdref(self, env, fModel, self.idref);
      try {
        const newEval = _changeAwaitRefId(aEval);
        const res = await unsafeAsync(newEval, idref2);
        return res;
      } catch (e) {
        throw new Error(`Could not eval("${aEval}") for "${node.getAttribute('name')}" in ${stringify(env.context)}\n${e}`);
      }
    }

    function escapeRegExp(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
    }

    // for example: str = '%(base.model_irActionsServer)s'
    async function _process(str: string) {
      const matches = str.matchAll(/[^%]%\((.*?)\)[ds]/g);

      const done = new Set();
      for (const m of matches) {
        const found = m[0].slice(1);
        if (done.has(found)) {
          continue;
        }
        done.add(found);
        let idStr = m[1]; // 'base.model_irActionsServer'
        let [resModel, resId] = await self.modelIdGet(idStr);
        self.idref[idStr] = resId;
        if (resModel in ACTION_TYPES) {
          resId = (await self.env.items(resModel).browse(resId).actionId).id; // get baseActionId
        }
        str = str.replace(new RegExp(escapeRegExp(found), 'g'), String(resId));
      }
      str = str.replace('%%', '%');
      return str;
    }

    if (t === 'xml') {
      node = _fixMultipleRoots(node);
      let res = '';
      for (const child of Array.from(node.childNodes)) {
        res = res + serializeXml(child)
      }
      return `<?xml version="1.0"?>\n` + await _process(res);
    }
    if (t === 'html') {
      let res = '';
      for (const child of Array.from(node.childNodes)) {
        res = res + serializeHtml(child)
      }
      return _process(res);
    }

    let data: any = node.textContent;
    if (node.getAttribute('file')) {
      const filename = node.getAttribute('file');
      data = await fs.readFile(filePath(filename));
      /*{ Testing for binary image file
        data = binary b'?PNG...
        => [137, 80, 78, 71, 13, 10,...

        base64Source = Buffer.from(data.toString('base64')); b'iVB
        => [105, 86, 66, 79, 82, 119, 48,...

        data = Buffer.from(base64Source.toString(), 'base64'); b'?PNG
        => [137, 80, 78, 71, 13, 10,...

        // Check
        const str64 = data.toString('base64');
        const dataOut =  Buffer.from(str64, 'base64');
        const name = 'test_new.png';
        fs.writeFileSync(name, dataOut);
        console.log('Compare from data:', tools.sameContent(data, name));
        console.log('Compare from base64:', tools.sameContent(dataOut, name));
      }*/
    }

    if (t === 'base64') {
      return tools.b64encode(data); // => Uint8Array
    }

    // after that, only text content makes sense
    data = toText(data);
    if (t === 'file') {
      const module = require('../modules');
      const _path = data.trim();
      if (!module.getResourcePath(this.module, _path)) {
        throw new Error(`No such file or directory: '${_path}' in ${self.module}`);
      }
      return `${self.module},${_path}`;
    }
    if (t === 'char') {
      return data;
    }
    if (t === 'int') {
      const d = data.trim();
      if (d === 'null') {
        return null;
      }
      return parseInt(d);
    }
    if (t === 'float') {
      return parseFloat(data.trim());
    }
    if (['list', 'tuple'].includes(t)) {
      const res = [];
      const nodes: any[] = xpath.select('//[@value]', node) ?? [];
      for (const n of nodes) {
        res.push(await _evalXml(self, n, env));
      }
      return res
    }
  }
  else if (node.tagName === 'function') {
    const modelStr = node.getAttribute('model');
    const model = env.items(modelStr);
    const methodName = node.getAttribute('name');
    // determine arguments
    let args = [];
    const kwargs = {};
    let aEval = node.getAttribute('eval');

    if (aEval) {
      const idref2 = _getIdref(self, env, modelStr, self.idref);
      try {
        const newEval = _changeAwaitRefId(aEval);
        args = await unsafeAsync(newEval, idref2);
      } catch (e) {
        throw new Error(`Could not eval("${aEval}") for "${node.getAttribute('name')}" in ${stringify(env.context)}.\n${e}`);
      }
    }
    for (const child of iterchildren(node, isElement)) {
      if (child.tagName === 'value' && child.getAttribute('name')) {
        kwargs[child.getAttribute('name')] = await _evalXml(self, child, env);
      }
      else {
        args.push(await _evalXml(self, child, env));
      }
    }
    // merge current context with context in kwargs
    kwargs['context'] = { ...env.context, ...(kwargs['context'] ?? {}) };
    // invoke method
    return callKw(model, methodName, args, kwargs);
  }
  else if (node.tagName === 'test') {
    return node.textContent;
  }
}

function str2bool(value: string) {
  return !['0', 'false', 'off'].includes(value.toLowerCase());
}

function nodeattr2bool(node: Element, attr: string, defaultValue = false) {
  if (!node.getAttribute(attr)) {
    return defaultValue;
  }
  const val = node.getAttribute(attr)?.trim();
  if (!val) {
    return defaultValue;
  }
  return str2bool(val);
}

function _getIdref(self, env, modelStr, idref) {
  const idref2 = Object.assign(idref, {
    Command: Command,
    DateTime: DateTime,
    timedelta: {},      // dummy for convert
    relativedelta: {},  // dummy for convert
    version: release.majorVersion,
    date_utils: date_utils,
    now: () => new Date(),
    today: function () {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      return date;
    },
    time: () => DateTime.now(), // luxon DateTime != Date
    subDate: date_utils.subDate,
    addDate: date_utils.addDate,
    toFormat: date_utils.toFormat,
    refId: (str: string, raiseIfNotFound = true) => idGet(self, str, raiseIfNotFound),
  });
  if (modelStr) {
    idref2['obj'] = env.items(modelStr).browse();
  }
  return idref2;
}

async function idGet(obj: XmlImport, idStr: string, raiseIfNotFound = true) {
  let result = obj.idref[idStr];
  if (!result) {
    if (!idStr.includes('.')) {
      idStr = `${obj.module}.${idStr}`;
    } else {
      if (idStr.split('.')[0] === obj.module) {
        idStr = idStr.split('.')[1];
      }
    }
    result = obj.idref[idStr];
  }
  if (!result) {
    result = await obj.idGet(idStr, false);
  }
  if (!result && raiseIfNotFound) {
    throw new ValueError('idGet external ID not found in the system: "%s"', idStr);
  }
  return result;
}

function idSet(self, idStr, value) {
  if (!(idStr in self.idref)) {
    if (!idStr.includes('.')) {
      idStr = `${self.module}.${idStr}`;
    }
    self.idref[idStr] = value;
  }
  return value;
}

export class CvsImport {
  env: Environment;
  mode: string;
  module: string;
  pathname: string;
  noupdate: boolean;
  idref: {};

  constructor(env: Environment, module: string, pathname: string, idref: {}, mode: string, noupdate = false) {
    this.env = env;
    this.mode = mode;
    this.module = module;
    this.noupdate = noupdate;
    this.idref = idref ? idref : {};
    this.pathname = pathname;
  }

  idSet(idStr, value) {
    return idSet(this, idStr, value);
  }

  async parse() {
    const { name } = path.parse(this.pathname);
    const model = name.split('-')[0];

    const [fields, dataList, badLines] = await processFileCsv(this.pathname);
    if (!(this.mode === 'init' || fields.includes('id'))) {
      throw new ValueError("Import specification does not contain 'id' and we are in init mode, Cannot continue.");
    }
    if (badLines.length) {
      console.warn(`Has ${badLines.length} error lines\n`);
    }
    // const used = process.memoryUsage().heapUsed / 1024 / 1024;
    // console.log(`The script uses heap memory approximately ${Math.round(used * 100) / 100} MB`);

    const context = {
      'mode': this.mode,
      'module': this.module,
      'installModule': this.module,
      'installFilename': this.pathname,
      'noupdate': this.noupdate
    }
    const env = await this.env.clone({ user: global.SUPERUSER_ID, context: context });
    const result = await env.items(model).load(fields, dataList);
    for (const data of (result['idref'] ?? [])) {
      idSet(this, data['xmlid'], data['id']);
    }
    if (result['messages'].some((msg: any) => msg['type'] === 'error')) {
      const warnMsg = result['messages'].map((msg) => msg['message']).join('\n');
      if (warnMsg.trim()) {
        console.log(warnMsg);
      }
    }
  }
}

export async function convertCvsImport(env: Environment, module: string, xmlfile: string | path.ParsedPath, idref: {}, mode = 'init', noupdate = false, report?: any) {
  const pathname = typeof xmlfile === 'string' ? xmlfile : xmlfile.name;

  const cvsImport = new CvsImport(env, module, pathname, idref, mode, noupdate);
  await cvsImport.parse();
}

export class XmlImport {
  DATA_ROOTS = ['verp', 'data'];

  mode: string;
  module: string;
  envs: Environment[];
  idref: {};
  xmlFilename: string;
  _noupdate: boolean[];
  _tags: Record<string, Function>;

  private constructor() { }

  private async _init(env: Environment, module: string, idref: {}, mode: string, noupdate = false, xmlFilename: string) {
    this.mode = mode;
    this.module = module;
    this.idref = idref ? idref : {};
    this._noupdate = [noupdate];
    this.xmlFilename = xmlFilename;
    this._tags = {
      'record': this._tagRecord,
      'delete': this._tagDelete,
      'function': this._tagFunction,
      'menuitem': this._tagMenuitem,
      'template': this._tagTemplate,
      'report': this._tagReport,
      'actwindow': this._tagActwindow,
      ...Dict.fromKeys(this.DATA_ROOTS, this._tagRoot)
    }
    this.envs = [await env.clone({ user: global.SUPERUSER_ID })];
  }

  static async new(env: Environment, module: string, idref: {}, mode: string, noupdate = false, xmlFilename: string) {
    const obj = new XmlImport();
    await obj._init(env, module, idref, mode, noupdate, xmlFilename);
    return obj;
  }

  async getEnv(el: Element, evalContext = {}) {
    const uid = el.getAttribute('uid');
    let context = el.getAttribute('context');
    if (uid || context) {
      return this.env.change({
        user: uid && await this.idGet(uid),
        context: context == null ? context : {
          ...this.env.context,
          ...safeEval(context, {
            'obj': this,
            'refId': idGet,
            ...evalContext
          })
        }
      });
    }
    return this.env;
  }

  makeXmlid(xmlid: string | undefined) {
    if (!xmlid || xmlid.includes('.'))
      return xmlid;
    return `${this.module}.${xmlid}`;
  }

  async _testXmlid(xmlid: string | undefined) {
    if (xmlid && xmlid.includes('.')) {
      const index = xmlid.indexOf('.');
      const [module, id] = [xmlid.slice(0, index), xmlid.slice(index + 1, xmlid.length)];
      // assert(id.includes('.') != true, `The ID reference "${xmlid}" must contain maximum one dot. They are used to refer to other modules ID, in the form: module.recordId`);
      if (module !== this.module) {
        const modcnt = await this.env.items('ir.module.module').searchCount([['label', '=', module], ['state', '=', 'installed']]);
        assert(modcnt == 1, `The ID "${xmlid}" refers to an uninstalled module`);
      }
    }
  }

  async _tagDelete(el: Element) {
    const dModel = el.getAttribute("model");
    let records = this.env.items(dModel);

    const dSearch = el.getAttribute("search");
    if (dSearch) {
      const idref = _getIdref(this, this.env, dModel, {});
      try {
        records = await records.search(safeEval(dSearch, idref));
      } catch (e) {
        console.warn('Skipping deletion for failed search `%s`', dSearch);
      }
    }
    const dId = el.getAttribute("id");
    if (dId) {
      try {
        records = records.add(records.browse(await this.idGet(dId)));
      } catch (e) {
        // dId cannot be found. doesn't matter in this case
        console.warn('Skipping deletion for missing XML ID `%s`', dId);
      }
    }
    if (bool(records)) {
      await records.unlink();
    }
  }

  async _tagReport(el: Element) {
    const res = {};
    for (const [field, dest] of [['string', 'label'], ['model', 'model'], ['label', 'reportName']]) {
      res[dest] = el.getAttribute(field);
      assert(res[dest], `Attribute ${field} of report is empty !`);
    }
    for (const [field, dest] of [['attachment', 'attachment'],
    ['attachmentUse', 'attachmentUse'],
    ['usage', 'usage'],
    ['file', 'reportFile'],
    ['reportType', 'reportType'],
    ['parser', 'parser'],
    ['printReportName', 'printReportName']]) {
      if (el.getAttribute(field)) {
        res[dest] = el.getAttribute(field);
      }
    }
    if (el.getAttribute('auto')) {
      res['auto'] = safeEval(el.getAttribute('auto') || 'false');
    }
    if (el.getAttribute('header')) {
      res['header'] = safeEval(el.getAttribute('header') || 'false');
    }

    res['multi'] = el.getAttribute('multi') && safeEval(el.getAttribute('multi') || 'false');

    const xmlid = el.getAttribute('id') || '';
    await this._testXmlid(xmlid);
    console.warn("The <report> tag is deprecated, use a <record> tag for {xmlid!}.");

    if (el.getAttribute('groups')) {
      const gNames = (el.getAttribute('groups') || '').split(',');
      const groupsValue = [];
      for (const group of gNames) {
        if (group.startsWith('-')) {
          const groupId = await this.idGet(group.slice(1));
          groupsValue.push(Command.unlink(groupId));
        }
        else {
          const groupId = await this.idGet(group);
          groupsValue.push(Command.link(groupId));
        }
      }
      res['groupsId'] = groupsValue;
    }
    if (el.getAttribute('paperformat')) {
      const pfName = el.getAttribute('paperformat');
      const pfId = await this.idGet(pfName);
      res['paperformatId'] = pfId;
    }

    const xid = this.makeXmlid(xmlid);
    const data = { xmlid: xid, values: res, noupdate: this.noupdate };
    // console.log('load xmlid=%s, data=%s', xmlid);
    const report = await this.env.items('ir.actions.report')._loadRecords([data], this.mode === 'update');
    this.idSet(xmlid, report.id);

    if (!el.getAttribute('menu') || safeEval(el.getAttribute('menu') || 'false')) {
      await report.createAction();
    }
    else if (this.mode === 'update' && safeEval(el.getAttribute('menu') || 'false') === false) {
      // Special check for report having attribute menu=false on update
      await report.unlinkAction();
    }
    return report.id;
  }

  async _tagFunction(el: Element) {
    if (this.noupdate && this.mode !== 'init') {
      return;
    }
    const env = await this.getEnv(el);
    await _evalXml(this, el, env);
  }

  async _tagActwindow(el: Element) {
    const label = el.getAttribute('label');
    const xmlid = el.getAttribute('id') || '';
    await this._testXmlid(xmlid);
    console.warn("The <actwindow> tag is deprecated, use a <record> for {xmlid!}.");
    let viewId: any = false;
    if (el.getAttribute('viewId')) {
      viewId = await this.idGet(el.getAttribute('viewId'));
    }
    let domain = el.getAttribute('domain') || '[]';
    const resModel = el.getAttribute('resModel');
    const bindingModel = el.getAttribute('bindingMdel');
    const viewMode = el.getAttribute('viewMode') || 'tree,form';
    const usage = el.getAttribute('usage');
    const limit = el.getAttribute('limit');
    const uid = (await this.env.user()).id;

    /* Actwindow's 'domain' and 'context' contain mostly literals
      but they can also refer to the variables provided below
      in eval_context, so we need to eval() them before storing.
      Among the context variables, 'activeId' refers to
      the currently selected items in a list view, and only
      takes meaning at runtime on the client side. For this
      reason it must remain a bare variable in domain and context,
      even after eval() at server-side. We use the special 'unquote'
      class to achieve this effect: a string which has itself, unquoted,
      as representation.
    */
    const activeId = unquote("activeId")
    const activeIds = unquote("activeIds")
    const activeModel = unquote("activeModel")

    // Include all locals() in evalContext, for backwards compatibility
    const evalContext = {
      'label': label,
      'xmlid': xmlid,
      'type': 'ir.actions.actwindow',
      'viewId': viewId,
      'domain': domain,
      'resModel': resModel,
      'srcModel': bindingModel,
      'viewMode': viewMode,
      'usage': usage,
      'limit': limit,
      'uid': uid,
      'activeId': activeId,
      'activeIds': activeIds,
      'activeModel': activeModel,
    }
    const context = (await this.getEnv(el, evalContext)).context;

    try {
      domain = safeEval(domain, evalContext);
    } catch (e) {
      // except (ValueError, NameError):
      // Some domains contain references that are only valid at runtime at
      // client-side, so in that case we keep the original domain string
      // as it is. We also log it, just in case.
      console.debug(`Domain value (%s) for element with id "%s" does not parse 
        at server-side, keeping original string, in case it's meant for client side only',
        domain, xmlid or 'NaN'`);
    }
    const res = {
      'label': label,
      'type': 'ir.actions.actwindow',
      'viewId': viewId,
      'domain': domain,
      'context': context,
      'resModel': resModel,
      'viewMode': viewMode,
      'usage': usage,
      'limit': limit,
    }

    if (el.getAttribute('groups')) {
      const gNames = (el.getAttribute('groups') || '').split(',');
      const groupsValue = [];
      for (const group of gNames) {
        if (group.startsWith('-')) {
          const groupId = await this.idGet(group.slice(1));
          groupsValue.push(Command.unlink(groupId));
        }
        else {
          const groupId = await this.idGet(group);
          groupsValue.push(Command.link(groupId));
        }
      }
      res['groupsId'] = groupsValue;
    }
    if (el.getAttribute('target')) {
      res['target'] = el.getAttribute('target') || '';
    }
    if (bindingModel) {
      res['bindingModelId'] = (await this.env.items['ir.model']._get(bindingModel)).id;
      res['bindingType'] = el.getAttribute('bindingType') || 'action';
      const views = el.getAttribute('bindingViews');
      if (views != null) {
        res['bindingViewTypes'] = views;
      }
    }
    const xid = this.makeXmlid(xmlid);
    const data = { xmlid: xid, values: res, noupdate: this.noupdate };
    // console.log('load xmlid=%s, data=%s', xmlid);
    await this.env.items('ir.actions.actwindow')._loadRecords([data], this.mode === 'update');
  }

  async _tagMenuitem(el: Element, parent?: any) {
    const recId = el.getAttribute("id");
    await this._testXmlid(recId);

    // The parent attribute was specified, if non-empty determine its ID, otherwise
    // explicitly make a top-level menu
    const values = {
      'parentId': false as any,
      'active': nodeattr2bool(el, 'active', true),
    }

    if (el.getAttribute('sequence')) {
      values['sequence'] = tools.parseInt(el.getAttribute('sequence'));
    }
    if (parent != null) {
      values['parentId'] = parent;
    }
    else if (el.getAttribute('parent')) {
      values['parentId'] = await this.idGet(el.getAttribute('parent'));
    }
    else if (el.getAttribute('webIcon')) {
      values['webIcon'] = el.getAttribute('webIcon');
    }

    const name = el.getAttribute('name');
    if (name) {
      values['label'] = name;
    }

    if (el.getAttribute('action')) {
      let action = el.getAttribute('action');

      if (!action.includes('.')) {
        action = `${this.module}.${action}`;
      }
      const act = await (await this.env.ref(action)).sudo();
      const [label, type, baseAction] = await act('label', 'type', 'actionId');
      values['action'] = `${act._name},${act.id}`
      if (!values['label'] && ['actwindow', 'wizard', 'url', 'client', 'server'].some(t => type.endsWith(t)) && label) {
        values['label'] = label;
      }
    }
    if (!values['label']) {
      values['label'] = recId || '?';
    }

    const groups = [];
    for (const group of (el.getAttribute('groups') || '').split(',')) {
      if (group.startsWith('-')) {
        const groupId = await this.idGet(group.slice(1));
        groups.push(Command.unlink(groupId));
      }
      else if (group) {
        const groupId = await this.idGet(group);
        groups.push(Command.link(groupId));
      }
    }
    if (len(groups)) {
      values['groupsId'] = groups;
    }

    const data = {
      'xmlid': this.makeXmlid(recId),
      'values': values,
      'noupdate': this.noupdate,
    }
    // console.log('load recId=%s, data=%s', recId);
    const menu = await this.env.items('ir.ui.menu')._loadRecords([data], this.mode === 'update');
    const nodes: any[] = xpath.select('./menuitem', el) ?? [];
    for (const child of nodes) {
      await this._tagMenuitem(child, parent = menu.id);
    }
  }

  async _tagRecord(el: any, extraVals?: {}) {
    const recModel = el.getAttribute("model");
    const env = await this.getEnv(el);
    const recId = el.getAttribute("id") || '';

    let model: ModelRecords = env.items(recModel);

    if (this.xmlFilename && recId) {
      model = await model.withContext({
        installModule: this.module,
        installFilename: this.xmlFilename,
        installXmlid: recId,
      });
    }

    await this._testXmlid(recId);
    const xid = this.makeXmlid(recId);

    if (this.noupdate && this.mode !== 'init') {
      if (!recId) {
        return null;
      }
      const record = await env.items('ir.model.data')._loadXmlid(xid);
      if (bool(record)) {
        this.idSet(recId, record.id);
        return null;
      }
      else if (nodeattr2bool(el, 'forcecreate', true)) {
        return null;
      }
    }

    if (bool(xid) && xid.split('.')[0] !== this.module) {
      const record = await this.env.items('ir.model.data')._loadXmlid(xid);
      if (!bool(record)) {
        if (this.noupdate && !nodeattr2bool(el, 'forcecreate', true)) {
          return null;
        }
        throw new Error(`Cannot update missing record ${xid}`);
      }
    }

    const res = {}
    const subRecords: any[] = [];
    const nodes: any[] = xpath.select('./field', el) ?? [];
    for (const field of nodes) {
      const fName = field.getAttribute('name') || field.getAttribute("label");
      const fRef = field.getAttribute("ref");
      const fSearch = field.getAttribute("search");
      let fModel = field.getAttribute("model");
      if (!fModel && fName in model._fields) {
        fModel = model._fields[fName].comodelName;
      }
      const fUse = field.getAttribute('use') ? field.getAttribute('use') : 'id';
      let fVal: any = false;

      if (fSearch) {
        const idref2 = _getIdref(this, env, fModel, this.idref);
        const q = safeEval(fSearch, idref2);
        assert(fModel, 'Define an attribute model="..." in your .XML file !');
        // browse the objects searched
        const s = await env.items(fModel).search(q);
        // column definitions of the "local" object
        const _fields = env.models[recModel]._fields;
        // if the current field is many2many
        if ((fName in _fields) && _fields[fName].type === 'many2many') {
          const fUses = [];
          for (const r of s) {
            fUses.push(await r[fUse]);
          }
          fVal = [Command.set(fUses)]
        }
        else if (s._length) {
          // otherwise (we are probably in a many2one field),
          // take the first element of the search
          fVal = await s(0)[fUse];
        }
      }
      else if (fRef) {
        if (fName in model._fields && model._fields[fName].type === 'reference') {
          const val = await this.modelIdGet(fRef);
          fVal = val[0] + ',' + String(val[1])
        }
        else {
          fVal = await this.idGet(fRef, nodeattr2bool(el, 'forcecreate', true));
          if (!fVal) {
            console.warn("Skipping creation of %s because %s=%s could not be resolved", xid, fName, fRef);
            return null;
          }
        }
      }
      else {
        fVal = await _evalXml(this, field, env);
        if (fName in model._fields) {
          let fieldType = model._fields[fName].type;
          if (fieldType === 'many2one') {
            fVal = fVal ? tools.int(fVal) : false
          }
          else if (fieldType === 'integer') {
            fVal = parseInt(fVal);
          }
          else if (['float', 'monetary'].includes(fieldType)) {
            fVal = parseFloat(fVal);
          }
          else if (fieldType === 'boolean' && typeof fVal === 'string') {
            fVal = str2bool(fVal);
          }
          else if (fieldType === 'one2many') {
            const nodes: any[] = xpath.select('./record', field) ?? [];
            for (const child of nodes) {
              subRecords.push([child, model._fields[fName].relationField])
            }
            if (typeof fVal === 'string') {
              // We do not want to write on the field since we will write
              // on the childrens' parents later
              continue
            }
          }
          else if (fieldType === 'html') {
            if (field.getAttribute('type') === 'xml') {
              console.warn('HTML field "%s" is declared as type="xml"', fName);
            }
          }
        }
      }
      res[fName] = fVal;
    }
    if (extraVals) {
      Object.assign(res, extraVals);
    }

    const data = { xmlid: xid, values: Dict.from(res), noupdate: this.noupdate };
    let record;
    try {
      record = await model._loadRecords([data], this.mode === 'update');
      // console.log("loaded record '%s' = %s(%s)", xid, record._name, record.id);
    } catch (e) {
      console.error(`Error: XmlImport loadRecords '%s' xmlid=%s`, model._name, xid);
      throw e;
    }

    if (recId) {
      this.idSet(recId, record.id);
    }
    if (config.get('importPartial')) {
      await env.cr.commit();
      await env.cr.reset();
    }
    for (const [childRec, relationField] of subRecords) {
      await this._tagRecord(childRec, { [relationField]: record.id });
    }
    return [recModel, record.id];
  }

  _convertTag(el: Element, tag: string) {
    const dd = new DOMImplementation();
    const doc = dd.createDocument(null, null);
    let elem: Element = doc.createElement(tag);
    // Copy the children
    while (el.firstChild) {
      elem.appendChild(el.firstChild); // *Moves* the child
    }
    // Copy the attributes
    for (let index = el.attributes.length - 1; index >= 0; --index) {
      elem.attributes.setNamedItem(el.attributes[index].cloneNode(true) as any);
    }
    el.parentNode.replaceChild(elem, el);
    return elem;
  }

  async _tagTemplate(el: Element) {
    // This helper transforms a <template> element into a <record> and forwards it
    const tplId = el.getAttribute('id') || el.getAttribute('t-name');
    let fullTplId = tplId;
    if (!fullTplId.includes('.')) {
      fullTplId = `${this.module}.${tplId}`;
    }
    // set the full template name for qweb <module>.<id>
    if (!el.getAttribute('inheritId')) {
      el.setAttribute('t-name', fullTplId);
      el = this._convertTag(el, 't');
    }
    else {
      el = this._convertTag(el, 'data');
    }
    el.removeAttribute('id')

    const model = this.module.startsWith('theme_') ? 'theme.ir.ui.view': 'ir.ui.view';
    const recordAttrs = {
      'id': tplId,
      'model': model,
    }
    for (const att of ['forcecreate', 'context'])
      if (el.getAttribute(att)) {
        recordAttrs[att] = el.getAttribute(att);
        el.removeAttribute(att);
      }

    const Field = E.field;
    const label = el.getAttribute('name') || tplId;

    const record = E.record(recordAttrs);
    record.appendChild(Field(label, { name: 'label' }));
    record.appendChild(Field(fullTplId, { name: 'key' }));
    record.appendChild(Field("qweb", { name: 'type' }));

    if (el.getAttribute('track')) {
      record.appendChild(Field(el.getAttribute('track'), { name: 'track' }));
    }
    if (el.getAttribute('priority')) {
      record.appendChild(Field(el.getAttribute('priority'), { name: 'priority' }));
    }
    if (el.getAttribute('inheritId')) {
      record.appendChild(Field({ name: 'inheritId', ref: el.getAttribute('inheritId') }));
    }
    if (el.getAttribute('websiteId')) {
      record.appendChild(Field({ name: 'websiteId', ref: el.getAttribute('websiteId') }));
    }
    if (el.getAttribute('key')) {
      record.appendChild(Field(el.getAttribute('key'), { name: 'key' }));
    }
    if (["true", "false"].includes(el.getAttribute('active'))) {
      const viewId = await this.idGet(tplId, false);
      if (this.mode !== "update" || !viewId) {
        record.appendChild(Field({ name: 'active', eval: el.getAttribute('active') }));
      }
    }
    if (["true", "false"].includes(el.getAttribute('customizeShow'))) {
      record.appendChild(Field({ name: 'customizeShow', eval: el.getAttribute('customizeShow') }));
    }
    const groups = el.getAttribute('groups');
    el.removeAttribute('groups');
    if (groups) {
      const grpList = groups.split(',').map(x => `refId('${x}')`);
      record.appendChild(Field({ name: "groupsId", eval: "[Command.set([" + grpList.join(', ') + "])]" }));
    }
    if (el.getAttribute('primary') === 'true') {
      // Pseudo clone mode, we'll set the t-name to the full canonical xmlid
      el.appendChild(
        E.xpath({ expr: ".", position: "attributes" }, [E.attribute(fullTplId, { name: 't-name' })])
      )
      record.appendChild(Field('primary', { name: 'mode' }));
    }
    // inject complete <template> element (after changing node name) into
    // the `arch` field
    const arch = Field({ name: "arch", type: "xml" });
    arch.appendChild(el);
    record.appendChild(arch);
    return this._tagRecord(record);
  }

  async _tagRoot(el) {
    for (const rec of iterchildren(el, isElement)) {
      let f = this._tags[rec.tagName];
      if (!f) {
        continue;
      }

      this.envs.push(await this.getEnv(el));
      this._noupdate.push(nodeattr2bool(el, 'noupdate', this.noupdate));
      try {
        await f.call(this, rec);
      } catch (e) {
        if (tools.isInstance(e, ParseError)) {
          throw e;
        }
        else if (tools.isInstance(e, ValidationError)) {
          const msg = tools._f("while parsing {file}.\n\t{err}\n\t{viewline}\n\tView context: {context}", {
            file: this.xmlFilename,
            err: e.message,
            viewline: tools.ellipsis(rec.toString(), 200),
            context: stringify(getattr(e, 'context', null) || '-no context-'),
          });
          console.debug(msg);
          throw new ParseError(e);
        }
        else {
          throw new ParseError(tools._f('while parsing {file}.\n\t{err}\n\t{viewline}\nstack: {stack}', {
            file: this.xmlFilename,
            err: e.message,
            viewline: tools.ellipsis(rec.toString(), 200),
            stack: e.stack
          }));
        }
      } finally {
        this._noupdate.pop();
        this.envs.pop();
      }
    }
  }

  async idGet(idStr, raiseIfNotFound = true): Promise<number> {
    if (!(idStr in this.idref)) {
      if (!idStr.includes('.')) {
        idStr = `${this.module}.${idStr}`;
      }
      const [, resId] = await this.modelIdGet(idStr, raiseIfNotFound);
      this.idref[idStr] = resId;
    }
    return this.idref[idStr];
  }

  idSet(idStr, value) {
    return idSet(this, idStr, value);
  }

  async modelIdGet(idStr: string, raiseIfNotFound = true): Promise<[string, number]> {
    if (!idStr.includes('.')) {
      idStr = `${this.module}.${idStr}`;
    }
    return this.env.items('ir.model.data')._xmlidToResModelResId(idStr, raiseIfNotFound);
  }

  get env(): Environment {
    return this.envs[this.envs.length - 1];
  }

  get noupdate() {
    return this._noupdate[this._noupdate.length - 1];
  }

  async parse(de: Element) {
    assert(this.DATA_ROOTS.includes(de.tagName), "Root xml tag must be <verp> or <data>.");
    await this._tagRoot(de);
  }
}

export async function convertXmlImport(env: Environment, module: string, xmlfile: string | path.ParsedPath, idref: {}, mode = 'init', noupdate = false, report?: any) {
  const xmlFilename = typeof xmlfile === 'string' ? xmlfile : xmlfile.name;
  const data = await fs.readFile(filePath(xmlFilename), 'utf8');
  const doc = parseXml(data);

  const xmlImport = await XmlImport.new(env, module, idref, mode, noupdate, xmlFilename);
  await xmlImport.parse(getrootXml(doc));
}

export function _fixMultipleRoots(node: Element) {
  const realNodes = []
  Object.values(node.childNodes).forEach((x) => {
    if (x.nodeType && !SKIPPED_ELEMENT_TYPES.includes(x.nodeType)) {
      if (!isText(x) || (isText(x) && x.textContent.trim().length)) {
        realNodes.push(x);
      }
    }
  })

  if (realNodes.length > 1) {
    const dd = new DOMImplementation();
    const doc = dd.createDocument(null, null);
    const dataNode = doc.createElement('data');
    while (node.firstChild) {
      dataNode.appendChild(node.firstChild); // *Moves* the child
    }
    node.appendChild(dataNode);
  }
  return node;
}

function unquote(arg: string) {
  return arg;
}
