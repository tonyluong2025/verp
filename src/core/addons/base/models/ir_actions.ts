import assert from "assert";
import _ from "lodash";
import { DateTime } from "luxon";
import * as xpath from 'xpath';
import { api, tools } from "../../..";
import { setdefault } from "../../../api/func";
import { Command, Fields } from "../../../fields";
import { Dict } from "../../../helper/collections";
import { AccessError, MissingError, UserError, ValidationError, ValueError, Warning } from "../../../helper/errors";
import { AbstractModel, MetaModel, Model, _super } from "../../../models";
import { expression } from "../../../osv";
import { UpCamelCase, b64decode, b64encode, bool, doWith, extend, f, floatCompare, isInstance, len, objectToText, partial, pop, repr, sorted, update } from "../../../tools";
import { safeEval, testRawExpr, unsafeAsync } from "../../../tools/save_eval";

export const ACTION_TYPES = {
  'ir.actions.server': 'Server Actions',
  'ir.actions.client': 'Client Actions',
  'ir.actions.actwindow': 'Window Actions',
  'ir.actions.acturl': 'URL Actions',
  'ir.actions.report': 'Report Actions'
}

@MetaModel.define()
class IrActions extends Model {
  static _module = module;
  static _name = 'ir.actions.actions';
  static _description = 'Actions';
  static _table = 'irActions';
  static _order = 'label';

  static label = Fields.Char({ required: true });
  static type = Fields.Char({ string: 'Action Type', required: true });
  static xmlid = Fields.Char({ compute: '_computeXmlid', string: "External ID" });
  static help = Fields.Html({ string: 'Action Description', help: 'Optional help text for the users with a description of the target view, such as its usage and purpose.', translate: true });
  static bindingModelId = Fields.Many2one('ir.model', { ondelete: 'CASCADE', help: "Setting a value makes this action available in the sidebar for the given model." });
  static bindingType = Fields.Selection([['action', 'Action'], ['report', 'Report']], { required: true, default: 'action' });
  static bindingViewTypes = Fields.Char({ default: 'list,form' });

  async _computeXmlid() {
    const res = await this.getExternalId();
    for (const record of this) {
      await record.set('xmlid', res[record.id]);
    }
  }

  async _createAction(type: string, vals) {
    return this.env.items('ir.actions.actions').create({
      'label': vals['label'],
      'type': type,
      'help': vals['help'],
      'bindingModelId': vals['bindingModelId'],
      'bindingType': 'action',
      'bindingViewTypes': vals['bindingViewTypes']
    });
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const res = await _super(IrActions, this).create(valsList);
    this.clearCaches();
    return res;
  }

  async write(vals) {
    const res = await _super(IrActions, this).write(vals);
    this.clearCaches();
    return res;
  }

  /**
   * unlink ir.action.todo which are related to actions which will be deleted.
        NOTE: ondelete CASCADE will not work on ir.actions.actions so we will need to do it manually.
   * @returns 
   */
  async unlink() {
    const todos = await this.env.items('ir.actions.todo').search([['actionId', 'in', this.ids]]);
    await todos.unlink();
    const res = await _super(IrActions, this).unlink();
    return res;
  }

  @api.ondelete(true)
  async _unlinkCheckHomeAction() {
    await (await (await (await this.env.items('res.users').withContext({ activeTest: false })).search([['actionId', 'in', this.ids]])).sudo()).write({ 'actionId': null });
  }

  @api.model()
  async getBindings(modelName, kw: { req?: any } = {}) {
    return this._getBindings(modelName, kw.req && kw.req.session.debug);
  }

  /**
   * Retrieve the list of actions bound to the given model.

   * @param modelName 
   * @param debug 
   * @returns a dict mapping binding types to a list of dict describing
                actions, where the latter is given by calling the method
                ``read`` on the action record.
   */
  @tools.ormcache('(await (await self.env.user()).groupsId).ids', 'modelName', 'debug')
  async _getBindings(modelName, debug: boolean = false) {
    const cr = this.env.cr;
    const IrModelAccess = this.env.items('ir.model.access');

    // discard unauthorized actions, and read action definitions
    const result = new Dict();
    let userGroups = await (await this.env.user()).groupsId;
    if (!debug) {
      userGroups = userGroups.sub(await this.env.ref('base.groupNoOne'));
    }
    userGroups = userGroups.ids;

    await this.flush();
    const res = await cr.execute(`
      SELECT a.id, a.type, a."bindingType"
        FROM "irActions" a
        JOIN "irModel" m ON a."bindingModelId" = m.id
        WHERE m.model = '%s'
      ORDER BY a.id
    `, [modelName]);
    for (const action of res) {
      try {
        let [actModel, bindingType] = [action['type'], action['bindingType']];
        const act = (await this.env.items(actModel).sudo()).browse(action['id']);
        const actGroups = (await act.groupsId).ids ?? [];
        actModel = await act.resModel ?? false;
        if (len(actGroups) && !_.intersection(actGroups, userGroups).length) {
          // the user may not perform this action
          continue;
        }
        if (actModel && ! await IrModelAccess.check(actModel, 'read', false)) {
          // the user won't be able to read records
          continue
        }
        const fields = ['label', 'bindingViewTypes'];
        if ('sequence' in act._fields) {
          fields.push('sequence');
        }
        result[bindingType] = result[bindingType] ?? [];
        result[bindingType].push(await act.readOne(fields));
      } catch (e) {
        if (isInstance(e, AccessError, MissingError)) {
          continue;
        }
        else {
          throw e;
        }
      }
    }
    // sort actions by their sequence if sequence available
    if (result['action']) {
      result['action'] = sorted(result['action'], (vals) => vals['sequence'] || 0);
    }
    return result;
  }

  /**
   * Returns the action content for the provided xmlid

   * @param fullXmlid the namespace-less id of the action (the @id
                    attribute from the XML file)
   * @returns A read() view of the ir.actions.action safe for web use
   */
  @api.model()
  async _forXmlid(fullXmlid) {
    const record = await this.env.ref(fullXmlid);
    assert(record, `Not found ref of ${fullXmlid}`);
    assert(record.cls._parents.includes('ir.actions.mixin'), `Model ${record._name} not instance of class ${this._name} with ref "'${fullXmlid}'`);
    const action = await (await record.sudo()).readOne();
    const readableFields = record._getReadableFields();
    return Object.fromEntries(Object.entries(action).filter(([field]) => readableFields.includes(field)));
  }
}

@MetaModel.define()
class IrActionMixin extends AbstractModel {
  static _module = module;
  static _name = 'ir.actions.mixin';
  static _description = 'Actions Mixin';

  static xmlid = Fields.Char({ compute: '_computeXmlid', string: "External ID" });

  async _computeXmlid() {
    const res = await this.getExternalId();
    for (const record of this) {
      await record.set('xmlid', res[record.id]);
    }
  }

  /**
 * return the list of fields that are safe to read

  Fetched via /web/action/load or _forXmlid method
  Only fields used by the web client should included
  Accessing content useful for the server-side must
  be done manually with superuser
  * @returns 
  */
  _getReadableFields() {
    return [
      "bindingModelId", "bindingType", "bindingViewTypes",
      "displayName", "help", "id", "label", "type", "xmlid",
    ];
  }

  /**
   * evaluation context to pass to safe_eval
   * @param action 
   * @returns 
   */
  @api.model()
  async _getEvalContext(action) {
    return {
      'uid': this._uid,
      'user': await this.env.user(),
      'time': DateTime,
      'datetime': DateTime,
      'floatCompare': floatCompare,
      'b64encode': b64encode,
      'b64decode': b64decode,
      'Command': Command,
    }
  }

  @api.model()
  async create(vals) {
    this.clearCaches();
    if (!vals['label'] && vals['resModel']) {
      vals['label'] = this.env.models[vals['resModel']]._description;
    }
    const action = await _super(IrActionMixin, this).create(vals);
    const baseAction = await action.actionId;
    await baseAction.write({ 'label': vals['label'], 'type': action._name });
    return action;
  }

  async write(vals) {
    const result = await _super(IrActionMixin, this).write(vals);
    if (vals['label']) {
      const baseAction = await this['actionId'];
      await baseAction.write({ 'label': vals['label'] });
    }
    return result;
  }

  async unlink() {
    this.clearCaches();
    return _super(IrActionMixin, this).unlink();
  }
}

@MetaModel.define()
class IrActionsActwindow extends Model {
  static _module = module;
  static _name = 'ir.actions.actwindow';
  static _description = 'Action Window';
  static _table = 'irActwindow';
  static _parents = 'ir.actions.mixin';
  static _inherits = { 'ir.actions.actions': 'actionId' };
  static _order = 'label';

  static actionId = Fields.Many2one('ir.actions.actions', { string: 'Action', autojoin: true, index: true, ondelete: "CASCADE", required: true });
  static label = Fields.Char({ string: 'Action Name', translate: true });
  static type = Fields.Char({ default: "ir.actions.actwindow" });
  static viewId = Fields.Many2one('ir.ui.view', { string: 'View Ref.', ondelete: 'SET NULL' });
  static domain = Fields.Char({ string: 'Domain Value', help: "Optional domain filtering of the destination data, as a Javascript expression" });
  static context = Fields.Char({ string: 'Context Value', default: '{}', required: true, help: "Context dictionary as Javascript expression, empty by default (Default: {})" });
  static resId = Fields.Integer({ string: 'Record ID', help: "Database ID of record to open in form view, when 'viewMode' is set to 'form' only" });
  static resModel = Fields.Char({ string: 'Destination Model', required: true, help: "Model name of the object to open in the view window" });
  static target = Fields.Selection([['current', 'Current Window'], ['new', 'New Window'], ['inline', 'Inline Edit'], ['fullscreen', 'Full Screen'], ['main', 'Main action of Current Window']], { default: "current", string: 'Target Window' });
  static viewMode = Fields.Char({ required: true, default: 'tree,form', help: "Comma-separated list of allowed view modes, such as 'form', 'tree', 'calendar', etc. (Default: tree,form)" });
  static usage = Fields.Char({ string: 'Action Usage', help: "Used to filter menu and home actions from the user form." });
  static viewIds = Fields.One2many('ir.actions.actwindow.view', 'actwindowId', { string: 'No of Views' });
  static views = Fields.Binary({ compute: '_computeViews', help: "This function field computes the ordered list of views that should be enabled when displaying the result of an action, federating view mode, views and reference view. The result is returned as an ordered list of pairs (viewId,viewMode)." });
  static limit = Fields.Integer({ default: 80, help: 'Default limit for the list view' });
  static groupsId = Fields.Many2many('res.groups', { relation: 'irActwindowGroupRel', column1: 'actId', column2: 'gid', string: 'Groups' });
  static searchViewId = Fields.Many2one('ir.ui.view', { string: 'Search View Ref.' });
  static filter = Fields.Boolean();
  static searchView = Fields.Text({ compute: '_computeSearchView' });

  /**
   * Compute an ordered list of the specific view modes that should be
      enabled when displaying the result of this action, along with the
      ID of the specific view to use for each mode, if any were required.

      This function hides the logic of determining the precedence between
      the view_modes string, the viewIds o2m, and the viewId m2o that
      can be set on the action.
   */
  @api.depends('viewIds.viewMode', 'viewMode', 'viewId.type')
  async _computeViews() {
    for (const act of this) {
      const actViewId = await act.viewId;
      const actViewIds = await act.viewIds;
      const views = [];
      const gotModes = [];
      for (const view of actViewIds) {
        const viewId = await view.viewId;
        const viewMode = await view.viewMode;
        views.push([viewId.id, viewMode]);
        gotModes.push(viewMode);
      }
      const allModes = (await act.viewMode).split(',');
      const missingModes = allModes.filter(mode => !gotModes.includes(mode)) as string[];
      if (missingModes.length) {
        const type = await actViewId.type;
        if (missingModes.includes(type)) {
          // reorder missing modes to put viewId first if present
          missingModes.splice(missingModes.indexOf(type), 1);
          views.push([actViewId.id, type]);
        }
        extend(views, missingModes.map(mode => [false, mode]));
      }
      await act.set('views', views);
    }
  }

  @api.depends('resModel', 'searchViewId')
  async _computeSearchView() {
    for (const act of this) {
      const searchViewId = await act.searchViewId;
      const fvg = await this.env.items(await act.resModel).fieldsViewGet(searchViewId.id, 'search');
      pop(fvg, 'dom'); // Not convert dom
      const str = objectToText(fvg);
      await act.set('searchView', str);
    }
  }

  /**
   * call the method getEmptyListHelp of the model and set the window action help message
   * @param fields 
   * @param load 
   * @returns 
   */
  async read(fields?: string[], load = '_classicRead'): Promise<Dict<any>[]> {
    const result = await _super(IrActionsActwindow, this).read(fields, load);
    if (!bool(fields) || 'help' in fields) {
      for (const values of result) {
        const model = values['resModel'];
        if (model in this.env.models) {
          const evalCtx = Object.assign({}, this.env.context);
          let ctx;
          try {
            ctx = safeEval(values['context'] || '{}', evalCtx);
          } catch (e) {
            ctx = {};
          }
          values['help'] = await (await this.withContext(ctx)).env.items(model).getEmptyListHelp(values['help'] || '')
        }
      }
    }
    return result;
  }

  async exists() {
    const ids = await this._existing();
    const existing = await this.filtered(async (rec) => ids.has(rec.id));
    return existing;
  }

  @api.model()
  @tools.ormcache()
  async _existing() {
    const res = await this._cr.execute(`SELECT id FROM "${this.cls._table}"`);
    return new Set(res.map(rec => rec['id']));
  }

  _getReadableFields() {
    return _.union(_super(IrActionsActwindow, this)._getReadableFields(), [
      "context", "domain", "filter", "groupsId", "limit", "resId",
      "resModel", "searchView", "searchViewId", "target", "viewId",
      "viewMode", "views",
      // `flags` is not a real field of ir.actions.actwindow but is used to give the parameters to generate the action
      "flags"
    ]);
  }
}

const VIEW_TYPES = [
  ['tree', 'Tree'],
  ['form', 'Form'],
  ['graph', 'Graph'],
  ['pivot', 'Pivot'],
  ['calendar', 'Calendar'],
  ['gantt', 'Gantt'],
  ['kanban', 'Kanban'],
]

@MetaModel.define()
class IrActionsActwindowView extends Model {
  static _module = module;
  static _name = 'ir.actions.actwindow.view';
  static _description = 'Action Window View';
  static _table = 'irActwindowView';
  static _recName = 'viewId';
  static _order = 'sequence,id';

  static sequence = Fields.Integer();
  static viewId = Fields.Many2one('ir.ui.view', { string: 'View' });
  static viewMode = Fields.Selection(VIEW_TYPES, { string: 'View Type', required: true });
  static actwindowId = Fields.Many2one('ir.actions.actwindow', { string: 'Action', ondelete: 'CASCADE' });
  static multi = Fields.Boolean({ string: 'On Multiple Doc.', help: "If set to true, the action will not be displayed on the right toolbar of a form view." });

  async _autoInit() {
    const res = await _super(IrActionsActwindowView, this)._autoInit();
    await tools.createUniqueIndex(this._cr, 'actwindowView_unique_modePerAction', this.cls._table, ['"actwindowId"', '"viewMode"']);
    return res;
  }
}

@MetaModel.define()
class IrActionsActwindowClose extends Model {
  static _module = module;
  static _name = 'ir.actions.actwindow.close'
  static _description = 'Action Window Close'
  static _parents = 'ir.actions.mixin'
  static _table = 'irActions'

  static type = Fields.Char({ default: 'ir.actions.actwindow.close' });

  _getReadableFields() {
    return _.union(_super(IrActionsActwindowClose, this)._getReadableFields(), [
      // 'effect' is not a real field of ir.actions.actwindow.close but is used to display the rainbowman
      "effect"
    ]);
  }
}

@MetaModel.define()
class IrActionsActurl extends Model {
  static _module = module;
  static _name = 'ir.actions.acturl'
  static _description = 'Action URL'
  static _table = 'irActionsUrl'
  static _parents = 'ir.actions.mixin';
  static _inherits = { 'ir.actions.actions': 'actionId' }
  static _order = 'label'

  static actionId = Fields.Many2one('ir.actions.actions', { string: 'Action', autojoin: true, index: true, ondelete: "CASCADE", required: true });
  static label = Fields.Char({ string: 'Action Name', translate: true })
  static type = Fields.Char({ default: 'ir.actions.acturl' })
  static url = Fields.Text({ string: 'Action URL', required: true })
  static target = Fields.Selection([['new', 'New Window'], ['self', 'This Window']], { string: 'Action Target', default: 'new', required: true })

  _getReadableFields() {
    return _.union(_super(IrActionsActurl, this)._getReadableFields(), ["target", "url"]);
  }
}

const DEFAULT_JAVASCRIPT_CODE = `// Available variables:
//  - env: Verp Environment on which the action is triggered
//  - model: Verp Model of the record on which the action is triggered; is a void recordset
//  - record: record on which the action is triggered; may be void
//  - records: recordset of all records on which the action is triggered in multi-mode; may be void
//  - time, datetime, dateutil, timeZone: useful Javascript libraries
//  - float_compare: Verp function to compare floats based on specific precisions
//  - log: log(message, level='info' { logging function to record debug information in ir.logging table
//  - UserError: Warning Exception to use with raise
//  - Command: x2Many commands namespace
// To return an action, assign: action = {...}\n\n\n\n`

/**
 * Server actions model. Server action work on a base model and offer various
  type of actions that can be executed automatically, for example using base
  action rules, of manually, by adding the action in the 'More' contextual
  menu.

  Since Verp 8.0 a button 'Create Menu Action' button is available on the
  action form view. It creates an entry in the More menu of the base model.
  This allows to create server actions and run them in mass mode easily through
  the interface.

  The available actions are :

  - 'Execute Javascript Code': a block of javascript code that will be executed
  - 'Create a new Record': create a new record with new values
  - 'Write on a Record': update the values of a record
  - 'Execute several actions': define an action that triggers several other
    server actions
 */
@MetaModel.define()
class IrActionsServer extends Model {
  static _module = module;
  static _name = 'ir.actions.server'
  static _description = 'Server Actions'
  static _table = 'irActionsServer'
  static _parents = 'ir.actions.mixin';
  static _inherits = { 'ir.actions.actions': 'actionId' }
  static _order = 'sequence,label'

  static actionId = Fields.Many2one('ir.actions.actions', { string: 'Action', autojoin: true, index: true, ondelete: "CASCADE", required: true });
  static label = Fields.Char({ string: 'Action Name', translate: true })
  static type = Fields.Char({ default: 'ir.actions.server' })
  static usage = Fields.Selection([
    ['irActionsServer', 'Server Action'],
    ['irCron', 'Scheduled Action']], { string: 'Usage', default: 'irActionsServer', required: true })
  static state = Fields.Selection([
    ['code', 'Execute Javascript Code'],
    ['objectCreate', 'Create a new Record'],
    ['objectWrite', 'Update the Record'],
    ['multi', 'Execute several actions']], {
    string: 'Action To Do', default: 'objectWrite', required: true, copy: true, help: `Type of server action. The following values are available:\n
      - 'Execute Javascript Code': a block of javascript code that will be executed\n
      - 'Create': create a new record with new values\n
      - 'Update a Record': update the values of a record\n
      - 'Execute several actions': define an action that triggers several other server actions\n
      - 'Send Email': automatically send an email (Discuss)\n
      - 'Add Followers': add followers to a record (Discuss)\n
      - 'Create Next Activity': create an activity (Discuss)`})
  // Generic
  static sequence = Fields.Integer({ default: 5, help: "When dealing with multiple actions, the execution order is based on the sequence. Low number means high priority." })
  static modelId = Fields.Many2one('ir.model', { string: 'Model', required: true, ondelete: 'CASCADE', help: "Model on which the server action runs." })
  static modelName = Fields.Char({ related: 'modelId.model', string: 'Model Name', readonly: true, store: true })
  // Javascript code
  static code = Fields.Text({ string: 'Javascript Code', groups: 'base.groupSystem', default: DEFAULT_JAVASCRIPT_CODE, help: "Write Javascript code that the action will execute. Some variables are available for use; help about Javascript expression is given in the help tab." })
  // Multi
  static childIds = Fields.Many2many('ir.actions.server', { relation: 'relServerActions', column1: 'serverId', column2: 'actionId', string: 'Child Actions', help: 'Child server actions that will be executed. Note that the last return returned action value will be used as global return value.' })
  // Create
  static crudModelId = Fields.Many2one('ir.model', { string: 'Target Model', help: "Model for record creation / update. Set this field only to specify a different model than the base model." })
  static crudModelName = Fields.Char({ related: 'crudModelId.model', string: 'Target Model Name', readonly: true })
  static linkFieldId = Fields.Many2one('ir.model.fields', { string: 'Link Field', help: "Provide the field used to link the newly created record on the record used by the server action." })
  static fieldsLines = Fields.One2many('ir.server.object.lines', 'serverId', { string: 'Value Mapping', copy: true })
  static groupsId = Fields.Many2many('res.groups', { relation: 'irActionsServerGroupRel', column1: 'actId', column2: 'gid', string: 'Groups' });

  @api.constrains('code')
  async _checkRawCode(): Promise<boolean> {
    for (const action of await (await this.sudo()).filtered('code')) {
      const msg = testRawExpr((await action.code).trim(), "exec")
      if (msg) {
        throw new ValidationError(msg);
      }
    }
    return true;
  }

  @api.constrains('childIds')
  async _checkRecursion(): Promise<boolean> {
    if (! await this._checkM2mRecursion('childIds')) {
      throw new ValidationError(await this._t('Recursion found in child server actions'));
    }
    return true;
  }

  _getReadableFields() {
    return _.union(_super(IrActionsServer, this)._getReadableFields(), ["groupsId", "modelName",]);
  }

  _getRunner(state: string) {
    const UpCaseState = UpCamelCase(state);
    let multi = true;
    let fn = this[`_runAction${UpCaseState}Multi`] || this[`runAction${UpCaseState}Multi`];
    if (!fn) {
      multi = false;
      fn = this[`_runAction${UpCaseState}`] || this[`runAction${UpCaseState}`];
    }
    if (fn && fn.name.startsWith('runAction')) {
      fn = partial(fn, this);
    }
    return [fn, multi];
  }

  async _registerHook() {
    await _super(IrActionsServer, this)._registerHook();

    for (const cls of this.cls.mro()) {
      for (const symbol of Object.keys(cls.prototype)) {
        if (symbol.startsWith('runAction')) {
          console.warn(
            "RPC-public action methods are deprecated, found %r (in class %s.%s)",
            symbol, cls._moduleName, cls._name
          )
        }
      }
    }
  }

  @api.onchange('crudModelId')
  async _onchangeCrudModelId() {
    await this.set('linkFieldId', false);
  }

  /**
   * Create a contextual action for each server action.
   * @returns 
   */
  async createAction() {
    for (const action of this) {
      await action.write({
        'bindingModelId': (await action.modelId).id,
        'bindingType': 'action'
      });
    }
    return true;
  }

  /**
   * Remove the contextual actions created for the server actions.
   * @returns 
   */
  async unlinkAction() {
    await this.checkAccessRights('write', true);
    await (await this.filtered('bindingModelId')).write({ 'bindingModelId': false });
    return true;
  }

  async _runActionCodeMulti(evalContext) {
    const code = await this['code'] || '';
    const action = await unsafeAsync(code, evalContext, { mode: "exec" });  // nocopy allows to return 'action'
    evalContext['action'] = action;
    return action;
  }

  async _runActionMulti(evalContext?: any) {
    let res = false;
    for (const act of await (await this['childIds']).sorted()) {
      res = await act.run() || res;
    }
    return res;
  }

  /**
   * Apply specified write changes to activeId.
   * @param evalContext 
   */
  async _runActionObjectWrite(evalContext?: any) {
    const fieldsLines = await this['fieldsLines'];
    const vals = await fieldsLines.evalValue(evalContext);
    const res = Object.fromEntries(fieldsLines.map(async (line) => [await (await line.col1).label, vals[line.id]]));

    if (this._context['onchangeSelf']) {
      const recordCached = this._context['onchangeSelf'];
      for (const [field, newValue] of Object.entries(res)) {
        recordCached[field] = newValue;
      }
    }
    else {
      await this.env.items(await (await this['modelId']).model).browse(this._context['activeId']).write(res);
    }
  }

  /**
   * 
   * @param evalContext 
   */
  async _runActionObjectCreate(evalContext) {
    const [fieldsLines, crudModelId, linkFieldId] = await this('fieldsLines', 'crudModelId', 'linkFieldId');
    const vals = await fieldsLines.evalValue(evalContext);
    let res = Object.fromEntries(fieldsLines.map(async (line) => [await (await line.col1).label, vals[line.id]]));

    res = await this.env.items(await crudModelId.model).create(res);

    if (linkFieldId.ok) {
      const record = this.env.items(await (await this['modelId']).model).browse(this._context['activeId']);
      if (['one2many', 'many2many'].includes(await linkFieldId.ttype)) {
        await record.write({ [await linkFieldId.label]: [Command.link(res.id)] });
      }
      else {
        await record.write({ [await linkFieldId.label]: res.id });
      }
    }
  }

  /**
   * Prepare the context used when evaluating javascript code, like the
      javascript formulas or code server actions.

      @param action the current server action
      @returns: dict -- evaluation context given to (safe_)safeEval
   */
  async _getEvalContext(action?: any) {
    const self = this;
    async function log(message, level = "info") {
      const cr = self.pool.cursor();
      await doWith(cr, async () => {
        await cr.execute(`
              INSERT INTO "irLogging"("createdAt", "createdUid", type, "dbName", label, level, message, path, line, func)
              VALUES (NOW() at time zone 'UTC', $1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, { bind: [self.env.uid, 'server', self._cr.dbName, module.filename, level, message, "action", action.id, await action.label] });
      });
    }

    const evalContext = await _super(IrActionsServer, this)._getEvalContext(action);
    const modelName = await (await (await action.modelId).sudo()).model;
    const model = this.env.items(modelName);
    let record, records;
    if (this._context['activeModel'] === modelName && this._context['activeId']) {
      record = model.browse(this._context['activeId']);
    }
    if (this._context['activeModel'] === modelName && this._context['activeIds']) {
      records = model.browse(this._context['activeIds']);
    }
    if (this._context['onchangeSelf']) {
      record = this._context['onchangeSelf'];
    }
    update(evalContext, {
      // orm
      'env': this.env,
      'model': model,
      // Exceptions
      'Warning': Warning,
      'UserError': UserError,
      // record
      'record': record,
      'records': records,
      // helpers
      'log': log,
    })
    return evalContext;
  }

  /**
   * Runs the server action. For each server action, the
      :samp:`_runAction_{TYPE}[_multi]` method is called. This allows easy
      overriding of the server actions.

      The `_multi` suffix means the runner can operate on multiple records,
      otherwise if there are multiple records the runner will be called once
      for each

    * @param context context should contain following keys

          - activeId: id of the current object (single mode)
          - active_model: current model that should equal the action's model

          The following keys are optional:

          - activeIds: ids of the current records (mass mode). If activeIds
            and activeId are present, activeIds is given precedence.

    * @returns an actionId to be executed, or false is finished correctly without
               return action
   */
  async run() {
    let res;
    for (let action of await this.sudo()) {
      const [label, state, actionGroups, modelName] = await action('label', 'state', 'groupsId', 'modelName');
      if (actionGroups.ok) {
        if (!bool(actionGroups.and(await (await this.env.user()).groupsId))) {
          throw new AccessError(await this._t("You don't have enough access rights to run this action."));
        }
      }
      else {
        try {
          await this.env.items(modelName).checkAccessRights("write");
        } catch (e) {
          if (isInstance(e, AccessError)) {
            console.warn("Forbidden server action %s executed while the user %s does not have access to %s.",
              label, await (await this.env.user()).login, modelName,
            )
          }
          throw e;
        }
      }

      const evalContext = await this._getEvalContext(action);
      let records = evalContext['record'] ?? evalContext['model'];
      records = records.or(evalContext['records'] ?? evalContext['model']);
      if (bool(records)) {
        try {
          await records.checkAccessRule('write');
        } catch (e) {
          if (isInstance(e, AccessError)) {
            console.warn("Forbidden server action %s executed while the user %s does not have access to %s.",
              label, await (await this.env.user()).login, records,
            )
          }
          throw e;
        }
      }
      const [runner, multi] = action._getRunner(state);
      if (runner && multi) {
        // call the multi method
        const runSelf = await action.withContext(evalContext['env'].context);
        res = await runSelf[runner.name].call(runSelf, evalContext);
      }
      else if (runner) {
        let activeId = this._context['activeId'];
        if (!activeId && this._context['onchangeSelf']) {
          activeId = this._context['onchangeSelf']._origin.id
          if (!activeId) {  // onchange on new record
            res = await action[runner.name].call(action, evalContext);
          }
        }
        const activeIds = this._context['activeIds'] ?? activeId ? [activeId] : [];
        for (const activeId of activeIds) {
          // run context dedicated to a particular activeId
          const runSelf = await action.withContext({ activeIds: [activeId], activeId: activeId });
          evalContext["env"].context = runSelf._context;
          res = await runSelf[runner.name].call(runSelf, evalContext);
        }
      }
      else {
        console.warn(
          `Found no way to execute server action %s of type %s, ignoring it. Verify that the type is correct or add a method called '_runAction<type>' or '_runAction<type>Multi'.`,
          label, state
        );
      }
    }
    return res || false;
  }
}

@MetaModel.define()
class IrServerObjectLines extends Model {
  static _module = module;
  static _name = 'ir.server.object.lines'
  static _description = 'Server Action value mapping'

  static serverId = Fields.Many2one('ir.actions.server', { string: 'Related Server Action', ondelete: 'CASCADE' })
  static col1 = Fields.Many2one('ir.model.fields', { string: 'Field', required: true, ondelete: 'CASCADE' })
  static value = Fields.Text({ required: true, help: "Expression containing a value specification. \nWhen Formula type is selected, this field may be a Javascript expression that can use the same values as for the code field on the server action.\nIf Value type is selected, the value will be used directly without evaluation." })
  static evaluationType = Fields.Selection([
    ['value', 'Value'],
    ['reference', 'Reference'],
    ['equation', 'Javascript expression']
  ], { string: 'Evaluation Type', default: 'value', required: true, changeDefault: true })
  static resourceRef = Fields.Reference('_selectionTargetModel', { string: 'Record', compute: '_computeResourceRef', inverse: '_setResourceRef' });

  @api.model()
  async _selectionTargetModel() {
    return (await (await this.env.items('ir.model').sudo()).search([])).map(model => model('model', 'label'));
  }

  @api.depends('col1.relation', 'value', 'evaluationType')
  async _computeResourceRef() {
    for (const line of this) {
      const [evaluationType, col1] = await line('evaluationType', 'col1');
      const relation = col1.ok ? await col1.relation : false;
      if (['reference', 'value'].includes(evaluationType) && relation) {
        let value = await line.value || '';
        try {
          value = tools.parseInt(value);
          if (!bool(await this.env.items(relation).browse(value).exists())) {
            const record = [...(await this.env.items(relation)._search([], { limit: 1 }))];
            value = len(record) ? record[0] : 0;
          }
        } catch (e) {
          if (isInstance(e, ValueError)) {
            const record = [...(await this.env.items(relation)._search([], { limit: 1 }))];
            value = len(record) ? record[0] : 0;
          } else {
            throw e;
          }
        }
        await line.set('resourceRef', f('%s,%s', relation, value));
      }
      else {
        await line.set('resourceRef', false);
      }
    }
  }

  @api.constrains('col1', 'evaluationType')
  async _raiseMany2manyError() {
    if (bool(await this.filtered(async (line) => await (await line.col1).ttype === 'many2many' && await line.evaluationType === 'reference'))) {
      throw new ValidationError(await this._t('many2many fields cannot be evaluated by reference'));
    }
  }

  @api.onchange('resourceRef')
  async _setResourceRef() {
    for (const line of await this.filtered(async (line) => await line.evaluationType === 'reference')) {
      if (await line.resourceRef) {
        await line.set('value', String((await line.resourceRef).id));
      }
    }
  }

  async evalValue(evalContext?: any) {
    const result = {};
    for (const line of this) {
      const [value, col1, evaluationType] = await line('value', 'col1', 'evaluationType');
      let expr = value;
      if (evaluationType === 'equation') {
        expr = safeEval(value, evalContext);
      }
      else if (['many2one', 'integer'].includes(await col1.ttype)) {
        try {
          expr = parseInt(value);
        } catch (e) {
          // pass
        }
      }
      result[line.id] = expr;
    }
    return result;
  }
}

@MetaModel.define()
class IrActionsActClient extends Model {
  static _module = module;
  static _name = 'ir.actions.client';
  static _description = 'Client Action';
  static _parents = 'ir.actions.mixin';
  static _inherits = { 'ir.actions.actions': 'actionId' };
  static _table = 'irActClient';
  static _order = 'label';

  static actionId = Fields.Many2one('ir.actions.actions', { string: 'Action', autojoin: true, index: true, ondelete: "CASCADE", required: true });
  static label = Fields.Char({ string: 'Action Name', translate: true })
  static type = Fields.Char({ default: 'ir.actions.client' })

  static tag = Fields.Char({ string: 'Client action tag', required: true, help: "An arbitrary string, interpreted by the client according to its own needs and wishes. There is no central tag repository across clients." })
  static target = Fields.Selection([['current', 'Current Window'], ['new', 'New Window'], ['fullscreen', 'Full Screen'], ['main', 'Main action of Current Window']], { default: "current", string: 'Target Window' })
  static resModel = Fields.Char({ string: 'Destination Model', help: "Optional model, mostly used for needactions." })
  static context = Fields.Char({ string: 'Context Value', default: "{}", required: true, help: "Context dictionary as Javascript expression, empty by default (Default: {})" })
  static params = Fields.Binary({ compute: '_computeParams', inverse: '_inverseParams', string: 'Supplementary arguments', help: "Arguments sent to the client along with  view tag" })
  static paramsStore = Fields.Binary({ string: 'Params storage', readonly: true, attachment: false });

  @api.depends('paramsStore')
  async _computeParams() {
    const selfBin = await this.withContext({ binSize: false, binSizeParamsStore: false });
    for (const [record, recordBin] of _.zip([...this], [...selfBin])) {
      const paramsStore = await recordBin.paramsStore;
      await record.set('params', paramsStore && safeEval(paramsStore, { 'uid': this._uid }));
    }
  }

  async _inverseParams() {
    for (const record of this) {
      const params = await record.params;
      await record.set('paramsStore', typeof (params) === 'object' ? repr(params) : params);
    }
  }

  _getDefaultFormView(): Element {
    const doc = _super(IrActionsActClient, this)._getDefaultFormView();
    const params: any[] = xpath.select('.//field[@name="params"]', doc);
    if (params && params[0]) {
      params[0].parentNode.removeChild(params[0]);
      const paramsStore: any[] = xpath.select('.//field[@name="paramsStore"]', doc);
      if (paramsStore && paramsStore[0]) {
        paramsStore[0].parentNode.removeChild(paramsStore);
      }
    }
    return doc;
  }

  _getReadableFields() {
    return _.union(_super(IrActionsActClient, this)._getReadableFields(), [
      "context", "params", "resModel", "tag", "target",
    ]);
  }
}

@MetaModel.define()
class IrActionsTodo extends Model {
  static _module = module;
  static _name = 'ir.actions.todo';
  static _description = "Configuration Wizards";
  static _order = "sequence, id";

  static actionId = Fields.Many2one('ir.actions.actions', { string: 'Action', required: true, index: true });
  static sequence = Fields.Integer({ default: 10 });
  static state = Fields.Selection([['open', 'To Do'], ['done', 'Done']], { string: 'Status', default: 'open', required: true });
  static label = Fields.Char();

  @api.modelCreateMulti()
  async create(valsList) {
    const todos = await _super(IrActionsTodo, this).create(valsList);
    for (const todo of todos) {
      if (await todo.state === "open") {
        await this.ensureOneOpenTodo();
      }
    }
    return todos;
  }

  async write(vals) {
    const res = await _super(IrActionsTodo, this).write(vals);
    if ((vals['state'] || '') === 'open') {
      this.ensureOneOpenTodo();
    }
    return res;
  }

  @api.model()
  async ensureOneOpenTodo() {
    const openTodo = await this.search([['state', '=', 'open']], { order: 'sequence asc, id desc', offset: 1 });
    if (openTodo.ok) {
      await openTodo.write({ 'state': 'done' });
    }
  }

  async nameGet() {
    const res = [];
    for (const record of this) {
      res.push([record.id, await (await record.actionId).label]);
    }
    return res;
  }

  async unlink() {
    let self: any = this;
    if (this.ok) {
      try {
        const todoOpenMenu = await this.env.ref('base.openMenu');
        // don't remove base.openMenu todo but set its original action
        if (this.contains(todoOpenMenu)) {
          await todoOpenMenu.set('actionId', (await (await this.env.ref('base.actionClientBaseMenu')).actionId).id);
          self = self.sub(todoOpenMenu);
        }
      } catch (e) {
        if (!isInstance(e, ValueError))
          throw e;
      }
    }
    return _super(IrActionsTodo, self).unlink();
  }

  @api.model()
  async _nameSearch(name: string, args?: any, operator = 'ilike', { limit=100, nameGetUid=null } = {}) {
    args = args || [];
    if (name) {
      return this._search(expression.AND([[['actionId', operator, name]], args]), {limit, accessRightsUid: nameGetUid});
    }
    return _super(IrActionsTodo, this)._nameSearch(name, args, operator, {limit, nameGetUid});
  }

  /**
   * Launch Action of Wizard
   * @returns 
   */
  async actionLaunch() {
    this.ensureOne();

    await this.write({ 'state': 'done' });

    // Load action
    const actionId = await (this as any).actionId;
    const actionType = await actionId.type;
    const result = (await this.env.items(actionType).searchRead([['actionId', '=', actionId.id]]))[0];
    if (actionType !== 'ir.actions.actwindow') {
      return result;
    }
    setdefault(result, 'context', '{}');

    // Open a specific record when resId is provided in the context
    const ctx = safeEval(result['context'], { 'user': await this.env.user() });
    if (ctx['resId']) {
      result['resId'] = pop(ctx, 'resId');
    }

    // disable log for automatic wizards
    ctx['disableLog'] = true;

    result['context'] = ctx;

    return result;
  }

  /**
   * Sets configuration wizard in TODO state
   * @returns 
   */
  async actionOpen() {
    return this.write({ 'state': 'open' });
  }
}

