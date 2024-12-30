import _ from 'lodash';
import { DateTime } from 'luxon';
import assert from 'node:assert';
import { api, models, tools } from '../../..';
import { getattr, hasattr } from '../../../api';
import { AccessError, Dict, KeyError, UserError, ValidationError, ValueError } from '../../../helper';
import { BaseModel, LOG_ACCESS_COLUMNS, MAGIC_COLUMNS, MetaModel, Model, TransientModel, checkTableName } from '../../../models';
import { expression } from '../../../osv';
import { Query } from '../../../osv/query';
import { Cursor } from '../../../sql_db';
import { _convert$, _f, _format, bool, enumerate, extend, f, isInstance, itemgetter, len, quote, quoteDouble, quoteList, sorted, split, tableExists, tableKind, toText } from '../../../tools';
import { literalEval } from '../../../tools/ast';
import { groupby, unique } from "../../../tools/misc";
import { Command, Field, Fields } from './../../../fields';
import { DefaultDict, OrderedSet2 } from './../../../helper/collections';
import { ModelRecords, _super, fieldXmlid, isDefinitionClass, modelXmlid, selectionXmlid } from './../../../models';
import { safeEval } from './../../../tools/save_eval';

export const MODULE_UNINSTALL_FLAG = '_forceUnlink';

const RE_ORDER_FIELDS = /"?(\w+)"?\s*(?:asc|desc)?/gi;

@MetaModel.define()
class Base extends BaseModel {
  static _module = module;
  static __doc__ = 'The base model, which is implicitly inherited by all models.';
  static _name = 'base';
  static _description = 'Base';
}

@MetaModel.define()
class Unknown extends BaseModel {
  static _module = module;
  protected static __doc__ = 'Abstract model used as a substitute for relational fields with an unknown comodel.'
  protected static _name = 'unknown'
  protected static _description = 'Unknown'
}

@MetaModel.define()
class IrModel extends Model {
  static _module = module;
  protected static _name = 'ir.model';
  protected static _description = 'Models';
  protected static _order = 'model';

  protected _defaultFieldId() {
    if (this.env.context['installMode']) {
      return []                   // no default field when importing
    }
    return [Command.create({ 'label': 'xLabel', 'fieldDescription': 'Label', 'ttype': 'char', 'copied': true })]
  }

  static label = Fields.Char({ string: 'Model Description', translate: true, required: true });
  static model = Fields.Char({ default: 'x', required: true, index: true });
  static order = Fields.Char('Order', { default: 'id', required: true, help: 'SQL expression for ordering records in the model; e.g. "xSequence asc, id desc"' });
  static info = Fields.Text({ string: 'Information' });
  static fieldId = Fields.One2many('ir.model.fields', 'modelId', { string: 'Fields', required: true, copy: true, default: self => self._defaultFieldId() });
  static inheritedModelIds = Fields.Many2many('ir.model', { compute: '_inheritedModels', string: "Inherited models", help: "The list of models that extends the current model." });
  static state = Fields.Selection([['manual', 'Custom Object'], ['base', 'Base Object']], { string: 'Type', default: 'manual', readonly: true });
  static accessIds = Fields.One2many('ir.model.access', 'modelId', { string: 'Access' });
  static ruleIds = Fields.One2many('ir.rule', 'modelId', { string: 'Record Rules' });
  static transient = Fields.Boolean({ string: "Transient Model" });
  static modules = Fields.Char({ compute: '_inModules', string: 'In Apps', help: 'List of modules in which the object is defined or inherited' });
  static viewIds = Fields.One2many('ir.ui.view', { compute: '_viewIds', string: 'Views' });
  static count = Fields.Integer({ compute: '_computeCount', string: "Count (Incl. Archived)", help: "Total number of records in this model" });

  static _sqlConstraints = [
    ['objName_uniq', 'unique (model)', 'Each model must have a unique name.'],
  ]

  @api.constrains('model')
  async _checkModelName() {
    for (const model of this) {
      if (await model.state === 'manual') {
        if (!(await model.model).startsWith('x')) {
          throw new ValidationError(await this._t("The model name must start with 'x'."));
        }
      }
      if (!models.checkObjectName(await model.model)) {
        throw new ValidationError(await this._t("The model name can only contain lowercase characters, digits, underscores and dots."))
      }
    }
  }

  @api.constrains('order', 'fieldId')
  async _checkOrder() {
    for (const model of this) {
      try {
        await model._checkQorder(await model.order);  // regex check for the whole clause ('is it valid sql?')
      } catch (e) {
        if (isInstance(e, UserError)) {
          throw new ValidationError(e.stack);
        } else {
          throw e;
        }
      }
      // add MAGIC_COLUMNS to 'stored_fields' in case 'model' has not been
      // initialized yet, or 'field_id' is not up-to-date in cache
      const storedFields = new Set(
        (await (await (await model.fieldId).filtered('store')).mapped('label')).concat(MAGIC_COLUMNS)
      );
      const orderFields = (await model.order).matchAll(RE_ORDER_FIELDS);
      for (const [, field] of orderFields) {
        if (!storedFields.has(field)) {
          throw new ValidationError(await this._t("Unable to order by %s: fields used for ordering must be present on the model and stored.", field));
        }
      }
    }
  }

  @api.depends()
  async _inheritedModels() {
    await this.set('inheritedModelIds', false);
    for (const model of this) {
      const parentNames = Object.keys(this.env.models[await model.model]._inherits);
      if (parentNames.length) {
        await model.set('inheritedModelIds', await this.search([['model', 'in', parentNames]]));
      }
      else {
        await model.set('inheritedModelIds', false);
      }
    }
  }

  @api.depends()
  async _inModules() {
    const installedModules = await this.env.items('ir.module.module').search([['state', '=', 'installed']]);
    const installedNames = await installedModules.mapped('label');
    const xmlids = await this._getExternalIds();
    for (const model of this) {
      const moduleNames = xmlids[model.id].map(xmlid => xmlid.split('.')[0]);
      await model.set('modules', _.intersection(installedNames, moduleNames).sort().join(', '));
    }
  }

  @api.depends()
  async _viewIds() {
    for (const model of this) {
      await model.set('viewIds', await this.env.items('ir.ui.view').search([['model', '=', await model.model]]));
    }
  }

  @api.depends()
  async _computeCount() {
    const cr: Cursor = this.env.cr;
    await this.set('count', 0);
    for (const model of this) {
      const cls = this.env.models[await model.model];
      if (!cls._abstract && !cls._auto) {
        const res = await cr.execute(`SELECT COUNT(*)::int FROM ${cr._gen.quoteIdentifiers(cls._table)}`);
        await model.set('count', res[0]);
      }
    }
  }

  @api.model()
  async create(vals: any): Promise<any> {
    const res = await _super(IrModel, this).create(vals);
    if (vals.get('state', 'manual') === 'manual') {
      // setup models; this automatically adds model in registry
      await this.flush();
      await this.pool.setupModels(this._cr);
      // update database schema
      await this.pool.initModels(this._cr, [vals['model']], this._context, true);
    }
    return res;
  }

  async write(vals: {}): Promise<any> {
    let self: any = this;
    if ('__lastUpdate' in self._context) {
      const dict = {};
      for (const [k, v] of Object.entries(self._context)) {
        if (k !== '__lastUpdate') {
          dict[k] = v;
        }
      }
      self = await self.withContext(dict);
    }
    if ('model' in vals && (await self.mapped('model')).some(model => model !== vals['model'])) {
      throw new UserError(await this._t('Field "Model" cannot be modified on models.'));
    }
    if ('state' in vals && (await self.mapped('state')).some(state => state !== vals['state'])) {
      throw new UserError(await this._t('Field "Type" cannot be modified on models.'));
    }
    if ('transient' in vals && (await self.mapped('transient')).some(transient => transient !== vals['transient'])) {
      throw new UserError(await this._t('Field "Transient Model" cannot be modified on models.'));
    }
    // Filter out operations 4 from field id, because the web client always
    // writes [4,id,false] even for non dirty items.
    if ('fieldId' in vals) {
      vals['fieldId'] = (vals['fieldId'] as []).filter(op => op[0] != 4);
    }
    const res = await _super(IrModel, self).write(vals);
    // ordering has been changed, reload registry to reflect update + signaling
    if ('order' in vals) {
      await self.flush();  // setup_models need to fetch the updated values from the db
      await self.pool.setupModels(self._cr);
    }
    return res;
  }

  async unlink(): Promise<boolean> {
    // prevent screwing up fields that depend on these models' fields
    await (await this['fieldId'])._prepareUpdate();

    // delete fields whose comodel is being removed
    await (await this.env.items('ir.model.fields').search([['relation', 'in', await this.mapped('model')]])).unlink();

    await this._dropTable();
    const res = await _super(IrModel, this).unlink();

    // Reload registry for normal unlink only. For module uninstall, the reload is done independently in core.modules.loading.
    if (!this._context[MODULE_UNINSTALL_FLAG]) {
      // setup models; this automatically removes model from registry
      await this.flush();
      await this.pool.setupModels(this._cr);
    }

    return res;
  }

  async _dropTable() {
    for (const model of this) {
      const modelName = await model.model;
      const currentModel = this.env.models[modelName];
      if (currentModel != null) {
        const table = currentModel._table;
        const kind = await tableKind(this._cr, table);
        if (kind === 'v') {
          await this._cr.execute('DROP VIEW "%s"', [table]);
          console.info('Dropped view %s', table);
        }
        else if (kind === 'r') {
          await this._cr.execute('DROP TABLE "%s" CASCADE', [table]);
          console.info('Dropped table %s', table);
          // discard all translations for this model
          await this._cr.execute(`
                    DELETE FROM "irTranslation"
                    WHERE type IN ('model', 'modelTerms') AND label LIKE '%s'
                `, [modelName + ',%']);
        }
      }
      else {
        console.log('The model %s could not be dropped because it did not exist in the registry.', modelName);
      }
    }
    return true;
  }

  @api.ondelete(false)
  async _unlinkIfManual() {
    // Prevent manual deletion of module tables
    for (const model of this) {
      if (await model.state !== 'manual') {
        throw new UserError(await this._t("Model '%s' contains module data and cannot be removed.", await model.label));
      }
    }
  }

  @api.model()
  async nameCreate(name: string): Promise<any> {
    const vals = {
      'label': name,
      'model': 'x' + _.capitalize(name).replace(' ', '')
    }
    return (await (await this.create(vals)).nameGet())[0];
  }

  @api.model()
  async _nameSearch(name: string = '', args?: any, operator = 'ilike', { limit = 100, nameGetUid = false } = {}): Promise<number | Query | any[]> {
    if (args == null) {
      args = [];
    }
    const domain = args.concat(['|', ['model', operator, name], ['label', operator, name]]);
    return this._search(domain, { limit, accessRightsUid: nameGetUid });
  }

  /**
   * Return the (sudoed) `ir.model` record with the given name. The result may be an empty recordset if the model is not found.
   * @param name 
   * @returns 
   */
  async _get(label: string) {
    const modelId = label ? await this._getId(label) : false;
    return (await this.sudo()).browse(modelId);
  }

  @tools.ormcache('label')
  async _getId(label: string) {
    const res = await this.env.cr.execute(`SELECT id FROM "irModel" WHERE "model"='${label}'`);
    return res.length && res[0]['id'];
  }

  /**
   * Return the values to write to the database for the given model.
   * @param cls 
   * @returns 
   */
  _reflectModelParams(cls: any): {} {
    return {
      'model': cls._name,
      'label': cls._description,
      'order': cls._order,
      'info': cls.__doc__ ?? cls._description,
      'state': cls._custom ? 'manual' : 'base',
      'transient': cls._transient,
    }
  }

  async _reflectModels(modelNames: string[] = []) {
    const cr = this.env.cr;

    let rows = modelNames.map((name) => this._reflectModelParams(this.env.models[name]))
    const cols = unique(['model'].concat(Object.keys(rows[0])));
    const expected = rows.map(row => cols.map(col => row[col])); // all without 'id'

    const query = `SELECT ${cols.map(c => `"${c}"`)}, id FROM "irModel" WHERE model IN (${quoteList(modelNames)})`;
    const res = await cr.execute(query);
    const modelIds = {};
    const existing = {};
    for (let row of res) {
      modelIds[row['model']] = row['id'];
      existing[row['model']] = cols.map(col => row[col]);
    }

    // create or update rows
    rows = expected.filter((row) => !_.isEqual(existing[row[0]], row));
    if (rows.length) {
      const ids = await upsert(cr, this.cls._table, cols, rows, ['model']);
      for (const [row, id] of _.zip<{}, any>(rows, ids)) {
        modelIds[row[0]] = typeof id === 'number' ? id : id.id
      }
      this.pool.postInit(markModified, this.browse(ids), cols.slice(1))
    }

    // update their XML id
    const module = this._context['module'];
    if (!module) {
      return;
    }

    const dataList = [];
    for (const [modelName, modelId] of Object.entries<number>(modelIds)) {
      const model = this.env.models[modelName];
      if (model?._moduleName === module) {
        // model._moduleName is the name of the module that last extended model
        const xmlid = modelXmlid(module, modelName);
        const record = this.browse(modelId);
        dataList.push({ 'xmlid': xmlid, 'record': record });
      }
    }
    await this.env.items('ir.model.data')._updateXmlids(dataList);
  }

  _instanciate(modelData) {
    @MetaModel.define()
    class CustomModel extends models.Model {
      static _module = module;
      static _name = toText(modelData['model']);
      static _description = modelData['label'];
      static _moduleName = null;
      static _custom = true;
      static _transient = Boolean(modelData['transient']);
      static _order = modelData['order']
      static __doc__ = modelData['info']
    }
    return CustomModel;
  }

  async _addManualModels() {
    for (const [name, model] of Object.entries<any>(this.pool.models)) {
      if (model._custom) {
        delete this.pool.models[name];
        for (const parent of model.__bases) {
          if (hasattr(parent, 'pool')) {
            parent._parentsChildren.discard(name);
          }
        }
      }
    }
    const cr = this.env.cr as Cursor;
    const res = await cr.execute(`SELECT * FROM "irModel" WHERE state='%s'`, ['manual']);
    for (const modelData of res) {
      const ModelClass = this._instanciate(modelData);
      const model = ModelClass.buildModel(ModelClass, this.pool, cr);
      if (['r', null].includes(await tools.tableKind(cr, model._table))) {
        // not a regular table, so disable schema upgrades
        model._auto = false;
        const result = await cr._obj.getQueryInterface().describeTable(model._table) ?? {};
        const columns = Object.keys(result);
        model._logAccess = models.LOG_ACCESS_COLUMNS.filter(e => columns.indexOf(e) < 0).length == 0;
      }
    }
  }
}

const FIELD_TYPES = Fields.MetaField.byType.keys().map((key) => [key, key]);

@MetaModel.define()
class IrModelFields extends Model {
  static _module = module;
  static _name = 'ir.model.fields';
  static _description = "Fields";
  static _order = "label";
  static _recName = 'fieldDescription';

  static label = Fields.Char({ string: 'Field Name', default: 'x', required: true, index: true });
  static completeName = Fields.Char({ index: true });
  static model = Fields.Char({ string: 'Model Name', required: true, index: true, help: "The technical name of the model this field belongs to" });
  static relation = Fields.Char({ string: 'Related Model', help: "For relationship fields, the technical name of the target model" });
  static relationField = Fields.Char({ help: "For one2many fields, the field on the target model that implement the opposite many2one relationship" });
  static relationFieldId = Fields.Many2one('ir.model.fields', { compute: '_computeRelationFieldId', store: true, ondelete: 'CASCADE', string: 'Relation field' });
  static modelId = Fields.Many2one('ir.model', { string: 'Model', required: true, index: true, ondelete: 'CASCADE', help: "The model this field belongs to" });
  static fieldDescription = Fields.Char({ string: 'Field Label', default: '', required: true, translate: true });
  static help = Fields.Text({ string: 'Field Help', translate: true });
  static ttype = Fields.Selection(FIELD_TYPES, { string: 'Field Type', required: true });
  static selectionIds = Fields.One2many("ir.model.fields.selection", "fieldId", { string: "Selection Options", copy: true });
  static copied = Fields.Boolean({ string: 'Copied', compute: '_computeCopied', store: true, readonly: false, help: "Whether the value is copied when duplicating a record." });
  static related = Fields.Char({ string: 'Related Field', help: "The corresponding related field, if any. This must be a dot-separated list of field names." });
  static relatedFieldId = Fields.Many2one('ir.model.fields', { compute: '_computeRelatedFieldId', store: true, string: "Related field", ondelete: 'CASCADE' });
  static required = Fields.Boolean();
  static readonly = Fields.Boolean();
  static index = Fields.Boolean({ string: 'Indexed' });
  static translate = Fields.Boolean({ string: 'Translatable', help: "Whether values for this field can be translated (enables the translation mechanism for that field)" });
  static len = Fields.Integer();
  static state = Fields.Selection([['manual', 'Custom Field'], ['base', 'Base Field']], { string: 'Type', default: 'manual', required: true, readonly: true, index: true });
  static ondelete = Fields.Selection([['CASCADE', 'CASCADE'], ['SET NULL', 'SET NULL'], ['RESTRICT', 'RESTRICT']], { string: 'On Delete', default: 'SET NULL', help: 'On delete property for many2one fields' });
  static domain = Fields.Char({ default: "[]", help: "The optional domain to restrict possible values for relationship fields, specified as a Javascript expression defining a list of triplets. For example: [['color','=','red']]" });
  static groups = Fields.Many2many('res.groups', { relation: 'irModelFieldsGroupRel', column1: 'fieldId', column2: 'groupId' });
  static groupExpand = Fields.Boolean({
    string: "Expand Groups", help: `If checked, all the records of the target model will be included\n
  in a grouped result (e.g. 'Group By' filters, Kanban columns, etc.).\n
  Note that it can significantly reduce performance if the target model\n
  of the field contains a lot of records; usually used on models with\n
  few records (e.g. Stages, Job Positions, Event Types, etc.).`});
  static selectable = Fields.Boolean({ default: true });
  static modules = Fields.Char({ compute: '_inModules', string: 'In Apps', help: 'List of modules in which the field is defined' });
  static relationTable = Fields.Char({ help: "Used for custom many2many fields to define a custom relation table name" });
  static column1 = Fields.Char({ string: 'Column 1', help: "Column referring to the record in the model table" });
  static column2 = Fields.Char({ string: "Column 2", help: "Column referring to the record in the comodel table" });
  static compute = Fields.Text({
    help: `Code to compute the value of the field.\n
  Iterate on the recordset 'self' and assign the field's value:\n\n
  for (const record of this) {\n
    await record.set('len', record.label.length);\n
  }\n
  Modules time, datetime, dateutil are available.`});
  static depends = Fields.Char({ string: 'Dependencies', help: `Dependencies of compute method; a list of comma-separated field names, like\n\n"name, partnerId.name` });
  static store = Fields.Boolean({ string: 'Stored', default: true, help: "Whether the value is stored in the database." });

  static _sqlConstraints = [
    ['label_unique', 'UNIQUE(model, label)', "Field names must be unique per model."],
    ['len_gt_zero', 'CHECK (len>=0)', 'Length of the field cannot be negative.'],
  ]

  /**
   * Return the parameters for a field instance for ``fieldData``.
   * @param fieldData 
   * @returns 
   */
  async _instanciateAttrs(fieldData: {}) {
    const self: any = this;
    const attrs = {
      'manual': true,
      'string': fieldData['fieldDescription'],
      'help': fieldData['help'],
      'index': Boolean(fieldData['index']),
      'copy': Boolean(fieldData['copied']),
      'related': fieldData['related'],
      'required': Boolean(fieldData['required']),
      'readonly': Boolean(fieldData['readonly']),
      'store': Boolean(fieldData['store']),
    }
    if (['char', 'text', 'html'].includes(fieldData['ttype'])) {
      attrs['translate'] = Boolean(fieldData['translate']);
      if (fieldData['ttype'] === 'char') {
        attrs['len'] = fieldData['len'] ?? null;
      }
    }
    else if (['selection', 'reference'].includes(fieldData['ttype'])) {
      attrs['selection'] = self.env.items('ir.model.fields.selection')._getSelectionData(fieldData['id'])
      if (fieldData['ttype'] === 'selection') {
        attrs['groupExpand'] = fieldData['groupExpand'];
      }
    }
    else if (fieldData['ttype'] === 'many2one') {
      if (!self.pool.loaded && !(self.env.models[fieldData['relation']])) {
        return;
      }
      attrs['comodelName'] = fieldData['relation'];
      attrs['ondelete'] = fieldData['ondelete'];
      attrs['domain'] = safeEval(fieldData['domain'] ?? '[]');
      attrs['groupExpand'] = fieldData['groupExpand'] ? '_readGroupExpandFull' : null;
    }
    else if (fieldData['ttype'] === 'one2many') {
      if (!self.pool.loaded && !(
        (self.env.models[fieldData['relation']]) && (
          (self.env.models[fieldData['relation']]._fields.has(fieldData['relationField'])) ||
          (await self._getManualFieldData(fieldData['relation'])).has(fieldData['relationField'])// in 
        )
      )) {
        return;
      }
      attrs['comodelName'] = fieldData['relation'];
      attrs['relationField'] = fieldData['relationField'];
      attrs['domain'] = safeEval(fieldData['domain'] || '[]');
    }
    else if (fieldData['ttype'] === 'many2many') {
      if (!self.pool.loaded && !(self.env.models[fieldData['relation']])) {
        return;
      }
      attrs['comodelName'] = fieldData['relation'];
      const [rel, col1, col2] = self._customMany2manyNames(fieldData['model'], fieldData['relation']);
      attrs['relation'] = fieldData['relationTable'] ?? rel;
      attrs['column1'] = fieldData['column1'] ?? col1;
      attrs['column2'] = fieldData['column2'] ?? col2;
      attrs['domain'] = safeEval(fieldData['domain'] ?? '[]');
    }
    else if (fieldData['ttype'] === 'monetary' && !self.pool.loaded) {
      return;
    }
    // add compute function if given
    if (fieldData['compute']) {
      attrs['compute'] = makeCompute(fieldData['compute'], fieldData['depends']);
    }
    return attrs;
  }

  /**
   * Return a field instance corresponding to parameters ``fieldData``.
   * @param self 
   * @param fieldData 
   * @returns 
   */
  async _instanciate(fieldData: {}) {
    const attrs = await this._instanciateAttrs(fieldData);
    if (attrs) {
      return Fields.MetaField.byType[fieldData['ttype']](attrs);
    }
  }

  @tools.ormcache('modelName')
  async _getIds(modelName) {
    const cr = this.env.cr;
    const res = await cr.execute(`SELECT "label", "id" FROM "irModelFields" WHERE "model"='${modelName}'`)
    const dict = {}
    for (const { label, id } of res) {
      dict[label] = id;
    }
    return dict;
  }

  @api.depends('relation', 'relationField')
  async _computeRelationFieldId() {
    for (const rec of this) {
      if (await rec.state === 'manual' && await rec.relationField) {
        await rec.set('relationFieldId', await this._get(await rec.relation, await rec.relationField));
      }
      else {
        await rec.set('relationFieldId', false)
      }
    }
  }

  @api.depends('related')
  async _computeRelatedFieldId() {
    for (const rec of this) {
      if (await rec.state === 'manual' && await rec.related) {
        const field = await rec._relatedField();
        await rec.set('relatedFieldId', await this._get(field.modelName, field.name));
      }
      else {
        await rec.set('relatedFieldId', false);
      }
    }
  }

  @api.depends('selectionIds')
  async _computeselection() {
    for (const rec of this) {
      if (['selection', 'reference'].includes(await rec.ttype)) {
        await rec.set('selection', String(await this.env.items('ir.model.fields.selection')._getSelection(rec.id)));
      }
      else {
        await rec.set('selection', false);
      }
    }
  }

  async _inverseSelection() {
    for (const rec of this) {
      const selection = literalEval(await rec.selection || "[]");
      await this.env.items('ir.model.fields.selection')._updateSelection(await rec.model, await rec.label, selection);
    }
  }

  @api.depends('ttype', 'related', 'compute')
  async _computeCopied() {
    for (const rec of this) {
      await rec.set('copied', (await rec.ttype !== 'one2many') && !(await rec.related || await rec.compute));
    }
  }

  @api.constrains('domain')
  async _checkDomain() {
    for (const field of this) {
      safeEval(await field.domain || '[]');
    }
  }

  @api.constrains('label', 'state')
  async _checkName() {
    for (const field of this) {
      if (await field.state === 'manual' && !(await field.label).startsWith('x')) {
        throw new ValidationError(await this._t("Custom fields must have a name that starts with 'x' !"));
      }
      try {
        checkTableName(await field.label);
      } catch (e) {
        if (isInstance(e, ValidationError)) {
          const msg = await this._t("Field names can only contain characters, digits and underscores (up to 63).")
          throw new ValidationError(msg);
        } else {
          throw e;
        }
      }
    }
  }

  @api.constrains('related')
  async _checkRelated() {
    for (const rec of this) {
      if (await rec.state === 'manual' && await rec.related) {
        const field: Field = await rec._relatedField();
        if (field.type !== await rec.ttype) {
          throw new ValidationError(await this._t("Related field '%s' does not have type '%s'", await rec.related, await rec.ttype));
        }
        if (field.relational && field.comodelName != await rec.relation) {
          throw new ValidationError(await this._t("Related field '%s' does not have comodel '%s'", await rec.related, await rec.relation));
        }
      }
    }
  }

  @api.onchange('related')
  async _onchangeRelated() {
    if (await this['related']) {
      let field: Field;
      try {
        field = await this._relatedField();
      } catch (e) {
        return { 'warning': { 'title': await this._t("Warning"), 'message': e } }
      }
      this.update({
        ttype: field.type,
        relation: field.comodelName,
        readonly: true
      });
    }
  }

  /**
   * Check whether all fields in dependencies are valid.
   */
  @api.constrains('depends')
  async _checkDepends() {
    for (const record of this) {
      const depends = await record.depends;
      if (!depends) {
        continue;
      }
      for (const seq of depends.split(",")) {
        if (!seq.trim()) {
          throw new UserError(await this._t("Empty dependency in %s", depends));
        }
        let model = this.env.items(await record.model);
        const names = seq.trim().split(".");
        const last = len(names) - 1;
        for (const [index, name] of enumerate(names)) {
          if (name == 'id') {
            throw new UserError(await this._t("Compute method cannot depend on field 'id'"));
          }
          const field: Field = model._fields.get(name);
          if (field == null) {
            throw new UserError(await this._t("Unknown field %s in dependency %s", name, seq.trim()));
          }
          if (index < last && !field.relational) {
            throw new UserError(await this._t("Non-relational field %s in dependency %s", name, seq.trim()));
          }
          model = await model[name];
        }
      }
    }
  }

  @api.onchange('compute')
  async _onchangeCompute() {
    if (await this['compute']) {
      await this.set('readonly', true);
    }
  }

  @api.constrains('relationTable')
  async _checkRelationTable() {
    for (const rec of this) {
      if (await rec.relationTable) {
        checkTableName(await rec.relationTable);
      }
    }
  }

  /**
   * Return default names for the table and columns of a custom many2many field.
   * @param modelName 
   * @param comodelName 
   * @returns 
   */
  @api.model()
  async _customMany2manyNames(modelName, comodelName) {
    const rel1 = this.env.models[modelName]._table;
    const rel2 = this.env.models[comodelName]._table;
    const table = f('x%s%sRel', _.upperFirst(rel1), _.upperFirst(rel2)); // sort
    if (rel1 === rel2) {
      return [table, 'id1', 'id2'];
    }
    else {
      return [table, f('%sId', rel1), f('%sId', rel2)];
    }
  }

  @api.onchange('ttype', 'modelId', 'relation')
  async _onchangeTtype() {
    const [relation, modelId] = await this('relation', 'modelId');
    if (await this['ttype'] === 'many2many' && bool(modelId) && relation) {
      if (!(relation in this.env.models)) {
        return {
          'warning': {
            'title': await this._t('Model %s does not exist', relation),
            'message': await this._t('Please specify a valid model for the object relation'),
          }
        }
      }
      const names = await this._customMany2manyNames(await modelId.model, relation);
      await this.update({
        relationTable: names[0],
        column1: names[1],
        column2: names[2]
      });
    }
    else {
      await this.update({
        relationTable: false,
        column1: false,
        column2: false
      });
    }
  }

  @api.onchange('relationTable')
  async _onchangeRelationTable() {
    const [relation, model, relationTable] = await this('relation', 'model', 'relationTable');
    if (relationTable) {
      // check whether other fields use the same table
      const others = await this.search([['ttype', '=', 'many2many'],
      ['relationTable', '=', relationTable],
      ['id', 'not in', this.ids]]);
      if (bool(others)) {
        for (const other of others) {
          if (await other.model === relation && await other.relation === model) {
            // other is a candidate inverse field
            await this.set('column1', await other.column2);
            await this.set('column2', await other.column1);
            return;
          }
        }
        return {
          'warning': {
            'title': await this._t("Warning"),
            'message': await this._t("The table %s if used for other, possibly incompatible fields.", relationTable),
          }
        }
      }
    }
  }

  @api.onchange('required', 'ttype', 'ondelete')
  async _onchangeRequired() {
    for (const rec of this) {
      if (await rec.ttype === 'many2one' && await rec.required && await rec.ondelete === 'SET NULL') {
        return {
          'warning': {
            'title': await this._t("Warning"),
            'message': await this._t(
              "The m2o field %s is required but declares its ondelete policy " +
              "as being 'SET NULL'. Only 'RESTRICT' and 'CASCADE' make sense.", await rec.label,
            )
          }
        }
      }
    }
  }

  /**
   * Return the (sudoed) `ir.model.fields` record with the given model and name.
    The result may be an empty recordset if the model is not found.
   * @param modelName 
   * @param name 
   * @returns 
   */
  async _get(modelName: string, name: string) {
    const fieldId = modelName && name && await (await this._getIds(modelName))[name];
    return (await this.sudo()).browse(fieldId);
  }


  @api.depends('selectionIds')
  async _computeSelection() {
    for (const rec of this) {
      if (['selection', 'reference'].includes(await rec.ttype)) {
        await rec.set('selection', `${await this.env.items('ir.model.fields.selection')._getSelection(rec.id)}`);
      }
      else {
        await rec.set('selection', false);
      }
    }
  }

  @api.depends()
  async _inModules() {
    const installedModules = await this.env.items('ir.module.module').search([['state', '=', 'installed']]);
    const installedNames = await installedModules.mapped('label');
    const xmlids = await this._getExternalIds();
    for (const field of this) {
      const moduleNames = xmlids[field.id].map(xmlid => xmlid.split('.')[0]);
      await field.set('modules', _.intersection(installedNames, moduleNames).sort().join(', '));
    }
  }

  /**
   * Return the given model's existing field data.
   * @param modelName 
   * @returns 
   */
  @tools.ormcache('modelName')
  async _existingFieldData(modelName) {
    const cr = this._cr;
    const res = await cr.execute(`SELECT * FROM "irModelFields" WHERE model='%s'`, [modelName]);
    return Object.fromEntries(res.map(row => [row['label'], row]));
  }

  /**
   * Return the values to write to the database for the given field.
   * @param self 
   * @param field 
   * @param modelId 
   */
  async _reflectFieldParams(field: Field, modelId: number) {
    return {
      'modelId': modelId,
      'model': field.modelName,
      'label': field.name,
      'fieldDescription': field.string || '',
      'help': field.help ?? null,
      'ttype': field.type,
      'state': field.manual ? 'manual' : 'base',
      'relation': field.comodelName ?? null,
      'index': bool(field.index),
      'store': bool(field.store),
      'copied': bool(field.copy),
      'ondelete': field.type === 'many2one' ? field.ondelete : null,
      'related': field.related ?? null,
      'readonly': bool(field.readonly),
      'required': bool(field.required),
      'selectable': bool(field.search ?? field.store),
      'len': field.size ?? null,
      'translate': bool(field.translate),
      'relationField': field.type === 'one2many' ? field.relationField : null,
      'relationTable': field.type === 'many2many' ? field.relation : null,
      'column1': field.type === 'many2many' ? field.column1 : null,
      'column2': field.type === 'many2many' ? field.column2 : null,
    }
  }

  async _reflectFields(modelNames) {
    const cr = this.env.cr;

    for (const modelName of modelNames) {
      const model = this.env.models[modelName];
      const byLabel = {};
      for (const field of model._fields.values()) {
        if (field.string) {
          if (field.string in byLabel) {
            console.warn(`Two fields (${field.name}, ${byLabel[field.string]}) of ${modelName} have the same label: ${field.string}.`);
          }
          else {
            byLabel[field.string] = field.name;
          }
        }
      }
    }

    let rows = [];
    for (const modelName of modelNames) {
      const modelId = await this.env.items('ir.model')._getId(modelName);
      for (const field of this.env.models[modelName]._fields.values()) {
        rows.push(await this._reflectFieldParams(field, modelId));
      }
    }
    if (!rows.length) {
      return;
    }
    const cols = unique(['model', 'label', ...Object.keys(rows[0])]);
    const expected = rows.map(row => cols.map(col => row[col])); // all without 'id'
    const query = `SELECT ${cols.map(c => `"${c}"`)}, id FROM "irModelFields" WHERE model IN (${quoteList(modelNames)})`
    const res = await cr.execute(query);
    const fieldIds = {};
    const existing = {};
    for (let row of res) {
      const key = `${[row['model'], row['label']]}`;
      fieldIds[key] = row['id']; // id
      existing[key] = cols.map(col => row[col]); // all - id
    }

    rows = expected.filter(row => !_.isEqual(existing[`${row.slice(0, 2)}`], row));
    if (rows.length) {
      const ids = await upsert(cr, this.cls._table, cols, rows, ['model', 'label']);
      for (const [row, id] of _.zip(rows, ids)) {
        fieldIds[`${row.slice(0, 2)}`] = id;
      }
      this.pool.postInit(markModified, this.browse(ids), cols.slice(2));
    }

    const modul = this._context['module'];
    if (!modul) {
      return;
    }

    const dataList = [];
    const dataSet = new Set();
    for (const [key, fieldId] of Object.entries(fieldIds)) {
      const [fieldModel, fieldName] = split(key, ',');
      const model = this.env.models[fieldModel];
      const field = model._fields.get(fieldName);

      if (field && (
        modul === model._originalModule
        || field._modules?.includes(modul)
        || Object.entries(model._parentsModule)
          .filter(([x, parentModule]) => modul === parentModule)
          .some(([parent, y]) => fieldName in this.env.models[parent]._fields)
      )) {
        const xmlid = fieldXmlid(modul, fieldModel, fieldName);
        const record = this.browse(fieldId);
        if (!dataSet.has(xmlid)) {
          dataSet.add(xmlid);
          dataList.push({ 'xmlid': xmlid, 'record': record });
        }
      }
    }
    await this.env.items('ir.model.data')._updateXmlids(dataList);
  }

  /**
   * Return the ``Field`` instance corresponding to ``this.related``.
   * @param model 
   */
  async _relatedField(): Promise<Field> {
    const names = this.cls.related.split(".");
    const last = names.length - 1;
    let model = this.env.models[await this['model'] || await (await this['modelId']).model];
    let field: Field;
    for (const [index, name] of Object.entries<any>(names)) {
      field = model._fields.get(name);
      if (!field) {
        throw new UserError(_format(await this._t(`Unknown field name '{name}' in related field '{field}'`), { name: name, field: this.cls.related }));
      }
      if (Number(index) < last && !field.relational) {
        throw new UserError(_format(await this._t(`Non-relational field name '{name}' in related field '{field}'`), { name: name, field: this.cls.related }));
      }
      model = model[name];
    }
    return field;
  }

  @tools.ormcache()
  async _allManualFieldData(): Promise<Dict<any>> {
    const cr = this._cr as Cursor;
    const res = await cr.execute(`SELECT * FROM "irModelFields" WHERE state = 'manual'`);
    const result = new Dict<Dict<any>>();
    for (const row of res) {
      result[row['model']] = new Dict<any>();
      result[row['model']][row['label']] = row;
    }
    return result;
  }

  /**
   * Return the given model's manual field data.
   * @param modelName 
   * @returns 
   */
  async _getManualFieldData(modelName): Promise<Dict<any>> {
    const res = await this._allManualFieldData();
    return res.get(modelName, new Dict<any>());
  }

  /**
   * Add extra fields on model.
   * @param model 
   */
  async _addManualFields(model: any) {
    const fieldsData = await this._getManualFieldData(model._name);
    for (const [name, fieldData] of Object.entries<any>(fieldsData)) {
      if (!(name in model._fields) && fieldData['state'] === 'manual') {
        try {
          const field = await this._instanciate(fieldData);
          if (field) {
            await model._addField(name, field);
          }
        } catch (e) {
          console.log("Failed to load field %s.%s: skipped", model._name, fieldData['label']);
        }
      }
    }
  }

  /**
   * Check whether the fields in ``self`` may be modified or removed.
    This method prevents the modification/deletion of many2one fields
    that have an inverse one2many, for instance.
   * @returns 
   */
  async _prepareUpdate() {
    const uninstalling = this._context[MODULE_UNINSTALL_FLAG];
    if (!uninstalling && await this.some(async (record) => await record.state !== 'manual')) {
      throw new UserError(await this._t("This column contains module data and cannot be removed!"));
    }

    let records = this;                 // all the records to delete
    const fields_ = new OrderedSet2();  // all the fields corresponding to 'records'
    const failedDependencies = [];      // list of broken [field, dependentField]
    let model;
    for (const record of this) {
      if (!(await record.model in this.env.models)) {
        continue;
      }
      model = this.env.items(await record.model);
      const field = model._fields.get(await record.label);
      if (field == null) {
        continue;
      }
      fields_.add(field);
      for (const dep of model._dependentFields(field)) {
        if (dep.manual) {
          failedDependencies.push([field, dep]);
        }
        else if (dep.inherited) {
          fields_.add(dep);
          records = records.or(await this._get(dep.modelName, dep.name));
        }
      }
    }
    for (const field of fields_) {
      for (const inverse of model.pool.fieldInverses.get(field)) {
        if (inverse.manual && inverse.type === 'one2many') {
          failedDependencies.push([field, inverse]);
        }
      }
    }
    let self = records;

    if (failedDependencies.length) {
      if (!uninstalling) {
        const [field, dep] = failedDependencies[0];
        throw new UserError(await self._t(
          "The field '%s' cannot be removed because the field '%s' depends on it.",
          field, dep,
        ));
      }
      else {
        self = self.union(
          await Promise.all(failedDependencies.map(([field, dep]) => self._get(dep.modelName, dep.name)))
        );
      }
    }
    records = await self.filtered(async (record) => await record.state === 'manual');
    if (!records.ok) {
      return self;
    }

    // remove pending write of this field
    // if there are pending towrite of the field we currently try to unlink, pop them out from the towrite queue
    // test `test_unlink_with_dependant`
    for (const record of records) {
      for (const recordValues of self.env.all.towrite[await record.model].values()) {
        recordValues.pop(await record.label, null);
      }
    }
    // remove fields from registry, and check that views are not broken
    const fields = await records.map(async (record) => self.env.items(await record.model)._popField(await record.label));
    const domain = expression.OR(await records.map(async (record) => [['archDb', 'like', await record.label]]));
    const views = await self.env.items('ir.ui.view').search(domain);
    let view;
    try {
      for (view of views) {
        await view._checkXml();
      }
    } catch (e) {
      if (!uninstalling) {
        throw new UserError([
          await self._t("Cannot rename/delete fields that are still present in views:"),
          await self._t("Fields: %s", fields.map(f => String(f)).join(', ')),
          await self._t("View: %s", await view.label),
        ].join('\n'));
      }
      else {
        // uninstall mode
        console.warn("The following fields were force-deleted to prevent a registry crash "
          + fields.map(f => String(f)).join(', ')
          + f(" the following view might be broken %s", await view.label)
        );
      }
    } finally {
      if (!uninstalling) {
        // the registry has been modified, restore it
        await self.pool.setupModels(self._cr);
      }
    }

    return self;
  }

  async unlink() {
    if (!this.ok) {
      return true;
    }

    // prevent screwing up fields that depend on these fields
    const self = await this._prepareUpdate();

    // determine registry fields corresponding to self
    const fields = new OrderedSet2();
    for (const record of self) {
      const [model, label] = await record('model', 'label');
      try {
        fields.add(self.pool.models[model]._fields[label]);
      } catch (e) {
        if (!isInstance(e, KeyError)) {
          throw e;
        }
      }
    }

    // clean the registry from the fields to remove
    self.pool.registryInvalidated = true;

    // discard the removed fields from field triggers
    function discardFields(tree: Map<any, any>) {
      // discard fields from the tree's root node
      for (const field of tree.get(null) ?? []) {
        if (!fields.includes(field)) { 
          fields.push(field);
        }
      }
      // discard subtrees labelled with any of the fields
      for (const field of fields) {
        tree.delete(field);
      }
      // discard fields from remaining subtrees
      for (const [field, subtree] of tree) {
        if (field != null) {
          discardFields(subtree);
        }
      }
    }

    discardFields(self.pool.fieldTriggers);

    // discard the removed fields from field inverses
    self.pool.fieldInverses.discardKeysAndValues(fields);

    // discard the removed fields from fields to compute
    for (const field of fields) {
      self.env.all.tocompute.pop(field, null);
    }

    const modelNames = await self.mapped('model');
    await self._dropColumn();
    const res = await _super(IrModelFields, self).unlink();

    // The field we just deleted might be inherited, and the registry is inconsistent in this case; therefore we reload the registry.
    if (!self._context[MODULE_UNINSTALL_FLAG]) {
      // setup models; this re-initializes models in registry
      await self.flush();
      await self.pool.setupModels(self._cr);
      // update database schema of model and its descendant models
      const models = Array.from(self.pool.descendants(modelNames, '_inherits'));
      await self.pool.initModels(self._cr, models, Object.assign({}, self._context), true);
    }

    return res;
  }

  async _dropColumn() {
    const tablesToDrop = new Set<any>();
    for (const field of this) {
      const [label, model, store, ttype, state, relationTable, translate] = await field(['label', 'model', 'store', 'ttype', 'state', 'relationTable', 'translate']);
      if (models.MAGIC_COLUMNS.includes(label)) {
        continue;
      }
      const obj = this.env.items(model);
      const isModel = obj != null;
      if (store) {
        if (isModel && await tools.columnExists(this._cr, obj.cls._table, label) &&
          await tools.tableKind(this._cr, obj.cls._table) === 'r') {
          await this._cr.execute('ALTER TABLE "%s" DROP COLUMN "%s" CASCADE', [obj.cls._table, label]);
        }
        if (state === 'manual' && ttype === 'many2many') {
          const relName = relationTable || (isModel && obj._fields[label].relation);
          tablesToDrop.add(relName);
        }
      }
      if (state === 'manual' && isModel) {
        obj._popField(label);
      }
      if (translate) {
        // discard all translations for this field
        await this._cr.execute(`
          DELETE FROM "irTranslation"
          WHERE "type" IN ('model', 'modelTerms') AND "label"='${model},${label}'
        `);
      }
    }

    if (tablesToDrop.size) {
      // drop the relation tables that are not used by other fields
      const res = await this._cr.execute(`SELECT "relationTable" FROM "irModelFields"
                          WHERE "relationTable" IN (${[...tablesToDrop].join(', ')}) AND id NOT IN (${String(this.ids) || 'NULL'})`);
      const tablesToKeep = res.map(row => row['relationTable']);
      for (const relName of _.difference([...tablesToDrop], tablesToKeep)) {
        await this._cr.execute(`DROP TABLE ${quote(relName)}`);
      }
    }

    return true;
  }

  @api.model()
  async create(vals) {
    if ('modelId' in vals) {
      const modelData = this.env.items('ir.model').browse(vals['modelId']);
      vals['model'] = await modelData.model;
    }
    this.clearCaches();

    const res = await _super(IrModelFields, this).create(vals);

    if (vals.get('state', 'manual') === 'manual') {
      const model = await this.env.items('ir.model').search([['model', '=', vals['relation']]]);
      if (vals.get('relation') && !len(model)) {
        throw new UserError(await this._t("Model %s does not exist!", vals['relation']));
      }

      if (vals.get('ttype') === 'one2many') {
        if (!len(await this.search([['modelId', '=', vals['relation']], ['label', '=', vals['relationField']], ['ttype', '=', 'many2one']]))) {
          throw new UserError(await this._t("Many2one %s on model %s does not exist!", vals['relationField'], vals['relation']));
        }
      }

      this.clearCaches();                 // for _existingFieldData()

      if (vals['model'] in this.pool.models) {
        // setup models; this re-initializes model in registry
        await this.flush();
        await this.pool.setupModels(this._cr);
        // update database schema of model and its descendant models
        const models = this.pool.descendants([vals['model']], '_inherits');
        await this.pool.initModels(this._cr, Array.from(models), this._context, true);
      }
    }
    return res;
  }

  async write(vals) {
    // if set, *one* column can be renamed here
    let columnRename = null;

    // names of the models to patch
    const patchedModels = new Set<any>();
    const self: any = this;
    if (len(vals) && self.ok) {
      for (const item of self) {
        const [state, modelId, ttype, label, model, index, store] = await item(['state', 'modelId', 'ttype', 'label', 'model', 'index', 'store']);
        if (state !== 'manual') {
          throw new UserError(await this._t('Properties of base fields cannot be altered in this manner! Please modify them through Javascript code, preferably through a custom addon!'));
        }
        if (vals.get('modelId', modelId.id) != modelId.id) {
          throw new UserError(await await this._t("Changing the model of a field is forbidden!"));
        }

        if (vals.get('ttype', ttype) !== ttype) {
          throw new UserError(await this._t("Changing the type of a field is not yet supported. Please drop it and create it again!"));
        }

        const obj = this.pool.models[model];
        const field = (obj._fields ?? {})[label];

        if (vals.get('label', label) !== label) {
          // We need to rename the field
          item._prepareUpdate()
          if (['one2many', 'many2many', 'binary'].includes(ttype)) {
            // those field names are not explicit in the database!
            //pass
          }
          else {
            if (columnRename) {
              throw new UserError(await this._t('Can only rename one field at a time!'));
            }
            columnRename = [obj.cls._table, label, vals['label'], index, store];
          }
        }
        // We don't check the 'state', because it might come from the context
        // (thus be set for multiple fields) and will be ignored anyway.
        if (obj != null && field != null) {
          patchedModels.add(obj.cls._name);
        }
      }
    }
    // These shall never be written (modified)
    for (const columnName of ['modelId', 'model', 'state']) {
      if (columnName in vals) {
        delete vals[columnName];
      }
    }

    const res = await _super(IrModelFields, self).write(vals);

    await this.flush();
    this.clearCaches();                         // for _existingFieldData()

    if (columnRename) {
      // rename column in database, and its corresponding index if present
      const [table, oldlabel, newlabel, index, stored] = columnRename;
      if (stored) {
        await this._cr.execute(
          `ALTER TABLE $1 RENAME COLUMN $2 TO $3`,
          {
            bind: [
              table,
              oldlabel,
              newlabel
            ]
          }
        );
        if (index) {
          await this._cr.execute(
            'ALTER INDEX $1 RENAME TO $2',
            {
              bind: [
                `${table}_${oldlabel}_index`,
                `${table}_${newlabel}_index`,
              ]
            }
          );
        }
      }
    }

    if (columnRename || len(patchedModels)) {
      // setup models, this will reload all manual fields in registry
      await this.flush();
      await this.pool.setupModels(this._cr);
    }

    if (len(patchedModels)) {
      // update the database schema of the models to patch
      const models = this.pool.descendants([...patchedModels], '_inherits');
      await this.pool.initModels(this._cr, [...models], this._context, true);
    }

    return res;
  }

  async nameGet() {
    const res = [];
    for (const field of this) {
      res.push([field.id, `${await field.fieldDescription} (${await field.model})`]);
    }
    return res
  }
}

@MetaModel.define()
class IrModelSelection extends Model {
  static _module = module;
  static _name = 'ir.model.fields.selection';
  static _order = 'sequence, id';
  static _description = "Fields Selection";

  static fieldId = Fields.Many2one("ir.model.fields", { required: true, ondelete: "CASCADE", index: true, domain: [['ttype', 'in', ['selection', 'reference']]] });
  static value = Fields.Char({ required: true });
  static label = Fields.Char({ translate: true, required: true });
  static sequence = Fields.Integer({ default: 1000 });

  static _sqlConstraints = [
    ['selectionField_uniq', 'unique ("fieldId", value)',
      'Selections values must be unique per field'],
  ]

  /**
   * Return the given field's selection as a list of pairs (value, string).
   * @param fieldId 
   * @returns 
   */
  async _getSelection(fieldId) {
    this.flush(['value', 'label', 'fieldId', 'sequence'])
    return this._getSelectionData(fieldId);
  }

  async _getSelectionData(fieldId) {
    const res = await this._cr.execute(`
        SELECT "value", "label"
        FROM "irModelFieldsSelection"
        WHERE "fieldId"=${fieldId}
        ORDER BY "sequence", "id"
    `);
    return res;
  }

  /**
   * Reflect the selections of the fields of the given models.
   * @param modelNames 
   */
  async _reflectSelections(modelNames: string[]) {
    const cr = this.env.cr;

    const fields: Field[] = [];
    for (const modelName of modelNames) {
      for (const field of this.env.models[modelName]._fields.values()) {
        if (['selection', 'reference'].includes(field.type)) {
          if (Array.isArray(field.selection)) {
            fields.push(field);
          }
        }
      }
    }
    if (!fields.length) {
      return;
    }

    const IMF = this.env.items('ir.model.fields');
    const expected = {};
    for (const field of fields) {
      let res = (await IMF._getIds(field.modelName))[field.name];
      res = res ? [res] : [];
      for (const fieldId of res) {
        for (const [index, [value, label]] of Object.entries<any>(field.selection)) {
          expected[`${[fieldId, value]}`] = [label, parseInt(index)];
        }
      }
    }

    const cols = ['fieldId', 'value', 'label', 'sequence'];
    let query = `
      SELECT ${cols.map(c => `s."${c}"`)}
      FROM "irModelFieldsSelection" s, "irModelFields" f
      WHERE s."fieldId" = f.id AND f.model IN (${quoteList(modelNames)})
    `
    let res = await cr.execute(query);
    const existing = {};
    for (let row of res) {
      existing[`${[row['fieldId'], row['value']]}`] = [row['label'], row['sequence']];
    }

    const rows = [];
    for (const [key, val] of Object.entries<any>(expected)) {
      if (!_.isEqual(existing[key], val)) {
        rows.push([...split(key, ','), ...val]);
      }
    }
    if (rows.length) {
      const ids = await upsert(cr, this.cls._table, cols, rows, ['fieldId', 'value']);
      this.pool.postInit(markModified, this.browse(ids), cols.slice(2));
    }

    const module = this._context['module'];
    if (!module) {
      return;
    }

    query = `
      SELECT f."model", f."label", s."value", s."id"
      FROM "irModelFieldsSelection" s, "irModelFields" f
      WHERE s."fieldId" = f."id" AND f."model" IN (${quoteList(modelNames)})
    `;
    res = await cr.execute(query);
    const selectionIds = {};
    for (let row of res) {
      selectionIds[`${[row['model'], row['label'], row['value']]}`] = row['id'];
    }

    const dataList = [];
    for (const field of fields) {
      const model = this.env.items(field.modelName);
      for (const [value, modules] of Object.entries<any>(field._selectionModules(model))) {
        if (modules.has(module)) {
          const xmlid = selectionXmlid(module, field.modelName, field.name, value);
          const ids = selectionIds[`${[field.modelName, field.name, value]}`];
          const record = this.browse(ids);
          dataList.push({ 'xmlid': xmlid, 'record': record });
        }
      }
    }
    await this.env.items('ir.model.data')._updateXmlids(dataList);
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const fieldIds = new Set(valsList.map(vals => vals['fieldId']));
    for (const field of this.env.items('ir.model.fields').browse(fieldIds)) {
      if (await field.state !== 'manual') {
        throw new UserError(await this._t('Properties of base fields cannot be altered in this manner! Please modify them through Javascript code, preferably through a custom addon!'));
      }
    }
    const recs = await _super(IrModelSelection, this).create(valsList);

    // setup models; this re-initializes model in registry
    await this.flush();
    await this.pool.setupModels(this._cr);

    return recs;
  }

  async write(vals) {
    if (! await (await this.env.user())._isAdmin() &&
      await this.some(async (record) => await (await record.fieldId).state !== 'manual')
    ) {
      throw new UserError(await this._t('Properties of base fields cannot be altered in this manner! Please modify them through Javascript code, preferably through a custom addon!'))
    }
    if ('value' in vals) {
      for (const selection of this) {
        const value = await selection.value;
        if (value === vals['value'])
          continue

        const fieldId = await selection.fieldId;
        if (await fieldId.store) {
          // replace the value by the new one in the field's corresponding column
          const query = _format(`UPDATE "{table}" SET "{field}"=%s WHERE "{field}"=%s`, {
            table: this.env.models[await fieldId.model]._table,
            field: await fieldId.label,
          });
          await this.env.cr.execute(query, { bind: [vals['value'], value] });
        }
      }
    }

    const result = await _super(IrModelSelection, this).write(vals);

    // setup models; this re-initializes model in registry
    await this.flush();
    await this.pool.setupModels(this._cr);

    return result;
  }

  async unlink() {
    await this._processOndelete();
    const result = await _super(IrModelSelection, this).unlink();

    // Reload registry for normal unlink only. For module uninstall, the reload is done independently in core.modules.loading.
    if (!this._context[MODULE_UNINSTALL_FLAG]) {
      // setup models; this re-initializes model in registry
      await this.flush();
      await this.pool.setupModels(this._cr);
    }
    return result
  }


  @api.ondelete(false)
  async _unlinkIfManual() {
    // Prevent manual deletion of module columns
    if (
      this.pool.ready
      && await this.some(async (selection) => await (await selection.fieldId).state != 'manual')
    ) {
      throw new UserError(await this._t('Properties of base fields cannot be altered in this manner! ' +
        'Please modify them through Javascript code, preferably through a custom addon!'));
    }
  }


  _processOndelete() {
    throw new Error('Method not implemented.');
  }

  /**
   * Return the records having `this` as a value.
   * @returns 
   */
  async _getRecords() {
    this.ensureOne();
    const model = await this.env.items(await (await this['fieldId']).model);
    const query = _f('SELECT id FROM "{table}" WHERE "{field}"=$1', {
      table: model.cls._table, field: await (await this['fieldId']).label,
    });
    const res = await this.env.cr.execute(query, { bind: [await this['value']] });
    return model.browse(res.map(r => r['id']));
  }

}

@MetaModel.define()
class IrModelConstraint extends Model {
  static _module = module;
  static _name = 'ir.model.constraint';
  static _description = 'Model Constraint';

  static label = Fields.Char({ string: 'Constraint', required: true, index: true, help: "PostgreSQL constraint or foreign key name." });
  static definition = Fields.Char({ help: "PostgreSQL constraint definition" });
  static message = Fields.Char({ help: "Error message returned when the constraint is violated.", translate: true });
  static model = Fields.Many2one('ir.model', { required: true, ondelete: "CASCADE", index: true });
  static module = Fields.Many2one('ir.module.module', { required: true, index: true, ondelete: 'CASCADE' });
  static type = Fields.Char({ string: 'Constraint Type', required: true, size: 1, index: true, help: "Type of the constraint: `f` for a foreign key, `u` for other constraints." });
  static updatedAt = Fields.Datetime();
  static createdAt = Fields.Datetime();

  static _sqlConstraints = [
    ['moduleLabel_uniq', 'unique(label, module)',
      'Constraints with the same name are unique per module.'],
  ]

  /**
   * Delete DBMS foreign keys and constraints tracked by this model.
   */
  async _moduleDataUninstall() {
    if (! await this.env.isSystem()) {
      throw new AccessError(await this._t('Administrator access is required to uninstall a module'));
    }


    for (const data of sorted(this, item => item.id, true)) {
      const name = tools.ustr(await data.label);
      const model = await (await data.model).model;
      let table;
      if (model in this.env.models) {
        table = this.env.models[model]._table;
      }
      else {
        table = _.camelCase(model.replace('.', '_'));
      }
      const typ = await data.type;

      // double-check we are really going to delete all the owners of this schema element
      const res = await this._cr.execute(`SELECT id from "irModelConstraint" where label='%s'`, [await data.label,]);
      const externalIds = res.map(r => r['id']);
      if (_.difference(externalIds, this.ids).length) {
        // as installed modules have defined this element we must not delete it!
        continue;
      }
      if (typ === 'f') {
        // test if FK exists on this table (it could be on a related m2m table, in which case we ignore it)
        const res = await this._cr.execute(`SELECT 1 from pg_constraint cs JOIN pg_class cl ON (cs.conrelid = cl.oid)
                              WHERE cs.contype='%s' and cs.conname='%s' and cl.relname='%s'`,
          ['f', name, table]);
        if (res.length) {
          await this._cr.execute(
            `ALTER TABLE "%s" DROP CONSTRAINT "%s"`,
            [table, name.slice(0, 63)]
          );
          console.debug('Dropped FK CONSTRAINT of %s: %s', table, name);
        }
      }
      if (typ === 'u') {
        // test if constraint exists
        // Since type='u' means any "other" constraint, to avoid issues we limit to
        // 'c' -> check, 'u' -> unique, 'x' -> exclude constraints, effective leaving
        // out 'p' -> primary key and 'f' -> foreign key, constraints.
        // See: https://www.postgresql.org/docs/9.5/catalog-pg-constraint.html
        const res = await this._cr.execute(`SELECT 1 from pg_constraint cs JOIN pg_class cl ON (cs.conrelid = cl.oid)
                              WHERE cs.contype in ('c', 'u', 'x') and cs.conname='%s' and cl.relname='%s'`,
          [name.slice(0, 63), table]);
        if (res.length) {
          await this._cr.execute(`ALTER TABLE "%s" DROP CONSTRAINT "%s"`,
            [table, name.slice(0, 63)]);
          console.info('Dropped CONSTRAINT of %s: %s', table, name);
        }
      }
    }
    await this.unlink();
  }

  async copy(defaultValue: {} = {}) {
    defaultValue['label'] = await this['label'] + '_copy';
    return _super(IrModelConstraint, this).copy(defaultValue);
  }

  /**
   * Reflect the SQL constraints of the given models.
   * @param model 
   */
  async _reflectConstraints(modelNames: string[]) {
    for (const modelName of modelNames) {
      await this._reflectModel(this.env.models[modelName])
    }
  }

  /**
   * Reflect the given constraint, and return its corresponding record.
    The reflection makes it possible to remove a constraint when its
    corresponding module is uninstalled. ``type`` is either 'f' or 'u'
    depending on the constraint being a foreign key or not.
   * @param model 
   * @param conname 
   * @param type 
   * @param definition 
   * @param module 
   * @param message 
   */
  async _reflectConstraint(cls, conname, type, definition, module, message?: any) {
    if (!module) {
      return;
    }
    assert(['f', 'u'].includes(type));
    const cr = this._cr;
    let query = `SELECT c."id", "type", "definition", "message"
      FROM "irModelConstraint" c, "irModuleModule" m
      WHERE c."module"=m."id" AND c."label"=${quote(conname)} AND m."label"=${quote(module)}`;
    let cons = await cr.execute(query);
    if (!cons.length) {
      query = `INSERT INTO "irModelConstraint"
                ("label", "createdAt", "updatedAt", "createdUid", "updatedUid", "module", "model", "type", "definition", "message")
              VALUES ($1,
                    now() AT TIME ZONE 'UTC',
                    now() AT TIME ZONE 'UTC',
                    $2, $3,
                    (SELECT id FROM "irModuleModule" WHERE "label"=$4),
                    (SELECT id FROM "irModel" WHERE "model"=$5),
                    $6, $7, $8)
              RETURNING id`;
      const res = await cr.execute(query,
        { bind: [conname, this.env.uid, this.env.uid, module, cls._name, type, definition, message] }
      );
      return this.browse(res[0]['id']);
    }
    cons = cons[0];
    const consId = cons['id'];
    if (cons['type'] !== type && cons['definition'] !== definition && cons['message'] !== message) {
      query = `UPDATE "irModelConstraint"
                SET "updatedAt"=now() AT TIME ZONE 'UTC',
                    "updatedUid"=$1, "type"=$2, "definition"=$3, "message"=$4
                WHERE id=$5`;
      await cr.execute(query, { bind: [this.env.uid, type, definition, message, consId] });
    }
    return this.browse(consId);
  }

  /**
   * Reflect the _sqlConstraints of the given model.
   * @param model 
   * @returns 
   */
  async _reflectModel(model: any) {
    function consText(txt: string) {
      return txt.toLowerCase().replace(', ', ',').replace(' (', '(');
    }

    // map each constraint on the name of the module where it is defined
    const constraintModule = new Map();
    const mro = model.mro();
    for (let i = mro.length - 1; i >= 0; i--) {
      const cls = mro[i];
      if (isDefinitionClass(cls)) {
        for (const constraint of getattr(cls, '_localSqlConstraints', [])) {
          constraintModule.set(constraint[0], cls._moduleName);
        }
      }
    }

    const dataList = [];
    for (const [key, definition, message] of model._sqlConstraints) {
      const conname = `${model._table}_${key}`;
      const module = constraintModule.get(key);
      // console.log('+++', model._name, conname, definition, module, message);
      const record = await this._reflectConstraint(model, conname, 'u', consText(definition), module, message);
      if (record._length) {
        const xmlid = `${module}.constraint_${conname}`;
        dataList.push({ 'xmlid': xmlid, 'record': record });
      }
    }
    await this.env.items('ir.model.data')._updateXmlids(dataList);
  }
}

/**
 * This model tracks PostgreSQL tables used to implement Verp many2many
  relations.
 */
@MetaModel.define()
class IrModelRelation extends Model {
  static _module = module;
  static _name = 'ir.model.relation';
  static _description = 'Relation Model';

  static label = Fields.Char({ string: 'Relation Name', required: true, index: true, help: "PostgreSQL table name implementing a many2many relation." });
  static model = Fields.Many2one('ir.model', { required: true, index: true, ondelete: 'CASCADE' });
  static module = Fields.Many2one('ir.module.module', { required: true, index: true, ondelete: 'CASCADE' });
  static updatedAt = Fields.Datetime();
  static createdAt = Fields.Datetime();

  /**
   *   Delete PostgreSQL many2many relations tracked by this model.
   */
  async _moduleDataUninstall() {
    if (! await this.env.isSystem()) {
      throw new AccessError(await this._t('Administrator access is required to uninstall a module'));
    }

    const idsSet = new Set(this.ids);
    const toDrop = new OrderedSet2();
    for (const data of sorted(this, item => item.id, true)) {
      const name = tools.ustr(await data.label);

      // double-check we are really going to delete all the owners of this schema element
      const res = await this._cr.execute(`SELECT id from "irModelRelation" where label = '%s'`, [await data.label]);
      const externalIds = new Set(res.map(r => r['id']));
      if (_.difference(Array.from(externalIds), Array.from(idsSet)).length) {
        // as installed modules have defined this element we must not delete it!
        continue;
      }

      if (await tableExists(this._cr, name)) {
        toDrop.add(name);
      }
    }
    await this.unlink();

    // drop m2m relation tables
    for (const table of toDrop) {
      await this._cr.execute('DROP TABLE "%s" CASCADE', [table]);
      console.info('Dropped table %s', table);
    }
  }

  /**
   * Reflect the table of a many2many field for the given model, to make it possible to delete it later when the module is uninstalled.
   * @param self 
   * @param model 
   * @param table 
   * @param module 
   */
  async _reflectRelation(self: ModelRecords, model: ModelRecords, table: string, module: string) {
    const cr = self._cr;
    const query = `SELECT 1 FROM "irModelRelation" r, "irModuleModule" m
                WHERE r."module"=m."id" AND r."label"='${table}' AND m."label"='${module}'`
    const res = await cr.execute(query);
    if (!res.length) {
      const query = `INSERT INTO "irModelRelation"
                      ("label", "createdAt", "updatedAt", "createdUid", "updatedUid", "module", "model")
                  VALUES ('${table}',
                          now() AT TIME ZONE 'UTC',
                          now() AT TIME ZONE 'UTC',
                          ${self.env.uid}, ${self.env.uid},
                          (SELECT id FROM "irModuleModule" WHERE "label"='${module}'),
                          (SELECT id FROM "irModel" WHERE "model"='${model.cls._name}'))`
      await cr.execute(query);
      self.invalidateCache();
    }
  }
}

/**
 * Holds external identifier keys for records in the database.
    This has two main uses:
  * allows easy data integration with third-party systems,
    making import/export/sync of data possible, as records
    can be uniquely identified across multiple systems
  * allows tracking the origin of data installed by Verp
    modules themselves, thus making it possible to later
    update them seamlessly.
 */
@MetaModel.define()
class IrModelData extends Model {
  static _module = module;
  static _name = 'ir.model.data';
  static _description = 'Model Data';
  static _order = 'module, model, label';

  static label = Fields.Char({ string: 'External Identifier', required: true, help: "External Key/Identifier that can be used for data integration with third-party systems" });
  static completeName = Fields.Char({ compute: '_computeCompleteName', string: 'Complete ID' });
  static model = Fields.Char({ string: 'Model Name', required: true });
  static module = Fields.Char({ default: '', required: true });
  static resId = Fields.Many2oneReference({ string: 'Record ID', help: "ID of the target record in the database", modelField: 'model' });
  static noupdate = Fields.Boolean({ string: 'Non Updatable', default: false });
  static reference = Fields.Char({ string: 'Reference', compute: '_computeReference', readonly: true, store: false });

  static _sqlConstraints = [
    ['nameNospaces', "check (label NOT LIKE '% %')",
      "External IDs cannot contain spaces"],
  ]

  @api.depends('module', 'label')
  async _computeCompleteName() {
    for (const res of this) {
      await res.set('completeName', [await res.module, await res.label].filter(n => !!n).join('.'));
    }
  }

  @api.depends('model', 'resId')
  async _computeReference() {
    for (const res of this) {
      await res.set('reference', `${await res.model},${await res.resId}`);
    }
  }

  _checkDoubleXmlid(dataList) {
    const list = dataList.map(data => data['xmlid']);
    const set = new Set(list);
    if (list.length !== set.size) {
      console.warn(`dataList has ${set.size}/${list.length} items`);
    }
  }

  /**
   * Create or update the given XML ids.

    @param dataList list of dicts with keys `xmlid` (XMLID to
        assign), `noupdate` (flag on XMLID), `record` (target record).
    @param update should be ``true`` when upgrading a module
   */
  @api.model()
  async _updateXmlids(dataList: { xmlid: string, record: ModelRecords }[], update = false) {
    if (!dataList.length) {
      return;
    }

    const rows = new OrderedSet2();
    for (const data of dataList) {
      const index = data['xmlid'].indexOf('.');
      const module = data['xmlid'].substring(0, index);
      const label = data['xmlid'].substring(index + 1);
      const record = data['record'];
      const noupdate = bool(data['noupdate']);
      rows.add([module, label, record._name, record.id, noupdate]);
    }

    let res, sql;
    let i = 1;
    for (const subRows of this.env.cr.splitForInConditions(rows)) {
      try {
        res = [];
        for (const row of subRows) {
          res = res.concat(row);
        }
        sql = this._buildUpdateXmlidsQuery(subRows, update);
        sql = _convert$(sql);
        await this.env.cr.execute(sql, { bind: res });
      } catch (e) {
        console.log(`Failed to insert irModelData\n${subRows.map(row => `${row}`).join('\n')}`);
        throw e;
      }
    }
    for (const row of rows) {
      this.pool.loadedXmlids.add(`${row[0]}.${row[1]}`);
    }
  }

  // NOTE: this method is overriden in web_studio; if you need to make another
  // override, make sure it is compatible with the one that is there.
  _buildUpdateXmlidsQuery(rows, update) {
    const rowf = "(%s, %s, %s, %s, %s)"
    return `
      INSERT INTO "irModelData" ("module", "label", "model", "resId", "noupdate")
      VALUES ${_.fill(Array(rows.length), rowf).join(', ')}
      ON CONFLICT ("module", "label")
      DO UPDATE SET ("model", "resId", "updatedAt") =
          (EXCLUDED."model", EXCLUDED."resId", now() at time zone 'UTC')
          ${update ? 'WHERE NOT "irModelData"."noupdate"' : ''}
    `;
  }

  /**
   * Low level xmlid lookup
    Return {id, resModel, resId} or raise ValueError if not found
   * @param xmlid 
   * @returns 
   */
  @api.model()
  @tools.ormcache('xmlid')
  async _xmlidLookup(xmlid: string): Promise<any> {
    const index = xmlid.indexOf('.');
    const module = xmlid.substring(0, index);
    const name = xmlid.substring(index + 1);
    const query = `SELECT id, model, "resId" FROM "irModelData" WHERE module='${module}' AND label='${name}'`;
    const res = await this.env.cr.execute(query);
    const result = res[0];
    if (!(result && result['resId'])) {
      throw new ValueError('xmlidLookup external ID not found in the system: %s', xmlid);
    }
    return result;
  }

  /**
   * Returns resId | false
   * @param xmlid 
   * @param raiseIfNotFound 
   * @returns 
   */
  @api.model()
  async _xmlidToResId(xmlid: string, raiseIfNotFound = false): Promise<number | boolean> {
    return (await this._xmlidToResModelResId(xmlid, raiseIfNotFound))[1];
  }

  /**
   * Returns [model, resId] corresponding to a given module and xmlid (cached), if and only if the user has the necessary access rights to see that object, otherwise raise a ValueError if raiseOnAccessError is True or returns a tuple [model found, false]
   * @param module 
   * @param xmlid 
   * @param raiseOnAccessError 
   * @returns 
   */
  @api.model()
  async checkObjectReference(module, xmlid, raiseOnAccessError = false) {
    const { model, resId } = await this._xmlidLookup(f("%s.%s", module, xmlid));
    //search on id found in result to check if current user has read access right
    if (bool(await this.env.items(model).search([['id', '=', resId]]))) {
      return [model, resId];
    }
    if (raiseOnAccessError) {
      throw new AccessError(await this._t('Not enough access rights on the external ID:') + f(' %s.%s', module, xmlid));
    }
    return [model, false];
  }

  /**
   * return record
   * @param xmlid 
   * @returns 
   */
  @api.model()
  async _loadXmlid(xmlid: string) {
    const record = await this.env.ref(xmlid, false);
    if (bool(record)) {
      this.pool.loadedXmlids.add(xmlid);
    }
    return record;
  }

  /**
   * Return [resModel, resId] or [false, false]
   * @param xmlid 
   * @param raiseIfNotFound 
   * @returns 
   */
  @api.model()
  async _xmlidToResModelResId(xmlid: string, raiseIfNotFound = false): Promise<[string | boolean, number | boolean]> {
    try {
      xmlid = await this._xmlidLookup(xmlid);
      return [xmlid['model'], xmlid['resId']];
    } catch (e) {
      if (isInstance(e, ValueError)) {
        if (raiseIfNotFound) {
          throw new Error(e);
        }
      }
      return [false, false];
    }
  }

  async _autoInit() {
    await _super(IrModelData, this)._autoInit();
    await tools.createUniqueIndex(this._cr, 'irModelDataModuleLabelUniqIndex', this.cls._table, ['"module"', '"label"']);
    await tools.createIndex(this._cr, 'irModelDataModelResIdIndex', this.cls._table, ['"model"', '"resId"']);
  }

  /**
   * Deletes all the records referenced by the ir.model.data entries
      ``ids`` along with their corresponding database backed (including
      dropping tables, columns, FKs, etc, as long as there is no other
      ir.model.data entry holding a reference to them (which indicates that
      they are still owned by another module).
      Attempts to perform the deletion in an appropriate order to maximize
      the chance of gracefully deleting all records.
      This step is performed as part of the full uninstallation of a module.
   * @param modulesToRemove 
   */
  @api.model()
  async _moduleDataUninstall(modulesToRemove) {
    if (! await this.env.isSystem()) {
      throw new AccessError(await this._t('Administrator access is required to uninstall a module'));
    }

    // enable model/field deletion
    // we deactivate prefetching to not try to read a column that has been deleted
    let self = await this.withContext({ [MODULE_UNINSTALL_FLAG]: true, 'prefetchFields': false });

    // determine records to unlink
    const recordsItems = [],              // [[model, id]]
      modelIds = [],
      fieldIds = [],
      selectionIds = [],
      constraintIds = [];

    let moduleData = await self.search([['module', 'in', modulesToRemove]], { order: 'id DESC' });
    for (const data of moduleData) {
      const [model, resId] = await data('model', 'resId');
      if (model === 'ir.model') {
        modelIds.push(resId);
      }
      else if (model === 'ir.model.fields') {
        fieldIds.push(resId);
      }
      else if (model === 'ir.model.fields.selection') {
        selectionIds.push(resId);
      }
      else if (model === 'ir.model.constraint') {
        constraintIds.push(resId);
      }
      else {
        recordsItems.push([model, resId]);
      }
    }
    // avoid prefetching fields that are going to be deleted: during uninstall, it is
    // possible to perform a recompute (via flush) after the database columns have been
    // deleted but before the new registry has been created, meaning the recompute will
    // be executed on a stale registry, and if some of the data for executing the compute
    // methods is not in cache it will be fetched, and fields that exist in the registry but not
    // in the database will be prefetched, this will of course fail and prevent the uninstall.
    for (const irField of self.env.items('ir.model.fields').browse(fieldIds)) {
      const model = self.pool.models[await irField.model];
      if (model != null) {
        const field: Field = model._fields.get(await irField.label);
        if (field != null) {
          field.prefetch = false;
        }
      }
    }
    // to collect external ids of records that cannot be deleted
    const undeletableIds = [];

    async function remove(records) {
      // do not delete records that have other external ids (and thus do
      // not belong to the modules being installed)
      const refData = await self.search([
        ['model', '=', records._name],
        ['resId', 'in', records.ids],
      ]);
      records = records.sub(records.browse(await (refData.sub(moduleData)).mapped('resId')));
      if (!records.ok) {
        return;
      }

      // special case for ir.model.fields
      if (records._name === 'ir.model.fields') {
        const missing = records.sub(await records.exists());
        if (missing.ok) {
          // delete orphan external ids right now;
          // an orphan ir.model.data can happen if the ir.model.field is deleted via
          // an ONDELETE CASCADE, in which case we must verify that the records we're
          // processing exist in the database otherwise a MissingError will be raised
          const orphans = await refData.filtered(async (r) => missing._ids.includes(await r.resId));
          console.info('Deleting orphan irModelData %s', orphans);
          await orphans.unlink();
          // /!\ this must go before any field accesses on `records`
          records = records.sub(missing);
        }
        // do not remove LOG_ACCESS_COLUMNS unless _logAccess is False
        // on the model
        records = records.sub(await records.filtered(async (f) => {
          const [label, model] = await f('label', 'model');
          return label === 'id' || (
            LOG_ACCESS_COLUMNS.includes(label) &&
            model in self.env.models && self.env.models[model]._logAccess
          );
        }));
      }
      // now delete the records
      try {
        await self._cr.savepoint(async () => {
          await records.unlink();
        });
      } catch (e) {
        if (len(records) <= 1) {
          extend(undeletableIds, refData._ids);
        }
        else {
          // divide the batch in two, and recursively delete them
          const halfSize = Math.round(len(records) / 2);
          await remove(records.slice(0, halfSize));
          await remove(records.slice(halfSize));
        }
      }
    }
    // remove non-model records first, grouped by batches of the same model
    for (const [model, items] of groupby(unique(recordsItems), itemgetter([0]))) {
      await remove(self.env.items(model).browse(items.map(item => item[1])));
    }
    // Remove copied views. This must happen after removing all records from
    // the modules to remove, otherwise ondelete='restrict' may prevent the
    // deletion of some view. This must also happen before cleaning up the
    // database schema, otherwise some dependent fields may no longer exist
    // in database.
    const modules = await self.env.items('ir.module.module').search([['label', 'in', modulesToRemove]]);
    await modules._removeCopiedViews();

    // remove constraints
    const constraints = await self.env.items('ir.model.constraint').search([['module', 'in', modules.ids]]);
    await constraints._moduleDataUninstall();
    await remove(self.env.items('ir.model.constraint').browse(unique(constraintIds)));

    // If we delete a selection field, and some of its values have ondelete='cascade',
    // we expect the records with that value to be deleted. If we delete the field first,
    // the column is dropped and the selection is gone, and thus the records above will not
    // be deleted.
    await remove(await self.env.items('ir.model.fields.selection').browse(unique(selectionIds)).exists());
    await remove(self.env.items('ir.model.fields').browse(unique(fieldIds)));
    const relations = await self.env.items('ir.model.relation').search([['module', 'in', modules.ids]]);
    await relations._moduleDataUninstall();

    // remove models
    await remove(self.env.items('ir.model').browse(unique(modelIds)));

    // log undeletable ids
    console.info("ir.model.data could not be deleted (%s)", undeletableIds);

    // sort out which undeletable model data may have become deletable again because
    // of records being cascade-deleted or tables being dropped just above
    for (const data of await self.browse(undeletableIds).exists()) {
      const record = self.env.items(await data.model).browse(await data.resId);
      try {
        // with self.env.cr.savepoint():
        if (bool(await record.exists())) {
          // record exists therefore the data is still undeletable,
          // remove it from module_data
          moduleData = moduleData.sub(data);
          continue;
        }
      } catch (e) {
        // This most likely means that the record does not exist, since record.exists()
        // is rougly equivalent to `SELECT id FROM table WHERE id=record.id` and it may raise
        // a ProgrammingError because the table no longer exists (and so does the
        // record), also applies to ir.model.fields, constraints, etc.
        // pass
      }
    }
    // remove remaining module data records
    await moduleData.unlink();
  }

  async _processEnd(modules: string[]) {
    if (!modules || tools.config.get('importPartial')) {
      return true;
    }

    const badImdIds = [];
    const self = await this.withContext({ MODULE_UNINSTALL_FLAG: true });
    const loadedXmlids = self.pool.loadedXmlids;
    const query = `SELECT id, ("module" || '.' || "label") as "xmlid", "model", "resId" FROM "irModelData"
      WHERE "module" IN (${quoteList(modules)}) AND "resId" IS NOT NULL AND COALESCE(noupdate, false) != true ORDER BY id DESC
    `;
    const res = await self._cr.execute(query);
    for (const rec of res) {
      const [id, xmlid, model, resId] = [res['id'], res['xmlid'], res['model'], res['resId']];
      if (loadedXmlids.has(xmlid)) {
        continue;
      }
      const Model = self.env.models[model];
      if (!Model) {
        continue;
      }
      let keep = false;
      for (const inheriting of Object.values<string>(Model._inheritsChildren).map(m => self.env.models[m])) {
        if (inheriting._abstract) {
          continue;
        }
        const parentField = inheriting._inherits[model];
        const children = await (await inheriting.withContext({ activeTest: false })).search([[parentField, '=', resId]]);
        const childrenXids = new Set<any>();
        for (const xids of Object.values<[]>(await children._getExternalIds())) {
          for (const xid of xids) {
            childrenXids.add(xid);
          }
        }
        if (childrenXids.size && loadedXmlids.size) {
          keep = true;
          break;
        }
      }
      if (keep) {
        continue;
      }
      if ((await self.searchCount([
        ["model", "=", model],
        ["resId", "=", resId],
        ["id", "!=", id],
        ["id", "not in", badImdIds],
      ]))) {
        badImdIds.push(id);
        continue;
      }
      console.info('Deleting %s@%s (%s)', resId, model._name, xmlid);
      let record = self.env.items(model).browse(resId);
      if (bool(await record.exists())) {
        const module = xmlid.split('.')[0];
        record = await record.withContext({ module: module });
        await self._processEndUnlinkRecord(record);
      }
      else {
        badImdIds.push(id);
      }
    }
    if (badImdIds.length) {
      await self.browse(badImdIds).unlink();
    }
    await self.env.items('ir.ui.view')._createAllSpecificViews(modules);

    loadedXmlids.clear();
  }

  async _processEndUnlinkRecord(record: ModelRecords) {
    record.unlink();
  }

  /**
   * Regular unlink method, but make sure to clear the caches.
   * @returns 
   */
  async unlink() {
    this.clearCaches();
    return _super(IrModelData, this).unlink();
  }

  /**
   * Look up the given XML ids of the given model.
   * @param xmlids 
   * @param model 
   * @returns 
   */
  async _lookupXmlids(xmlids, model) {
    if (!xmlids.length)
      return [];

    // group xmlIds by prefix
    const bymodule = new DefaultDict();
    for (const xmlid of xmlids) {
      const index = xmlid.indexOf('.');
      const prefix = xmlid.substring(0, index);
      const suffix = xmlid.substring(index + 1);
      bymodule[prefix] = bymodule[prefix] ?? new Set<any>();
      bymodule[prefix].add(suffix);
    }

    // query xmlIds by prefix
    const result = [];
    const cr = this.env.cr;
    for (const [prefix, suffixes] of Object.entries(bymodule)) {
      const query = `
          SELECT d."id", d."module", d."label", d."model", d."resId", d."noupdate", r.id as "rId"
          FROM "irModelData" d LEFT JOIN "${model.cls._table}" r on d."resId"=r.id
          WHERE d."module"='%s' AND d."label" IN (%s)`;
      for (const subsuffixes of cr.splitForInConditions(suffixes)) {
        const res = await cr.execute(query, [prefix, quoteList(subsuffixes) || 'NULL']);
        extend(result, res);
      }
    }
    return result;
  }

  /**
   * Toggle the noupdate flag on the external id of the record 
   * @param model 
   * @param resId 
   */
  @api.model()
  async toggleNoupdate(model, resId) {
    const record = this.env.items(model).browse(resId);
    if (await record.checkAccessRights('write')) {
      for (const xid of await this.search([['model', '=', model], ['resId', '=', resId]])) {
        await xid.set('noupdate', ! await xid.noupdate);
      }
    }
  }
}

@MetaModel.define()
class IrModelAccess extends Model {
  static _module = module;
  static _name = 'ir.model.access';
  static _description = 'Model Access';
  static _order = 'modelId,groupId,label,id';

  static label = Fields.Char({ required: true, index: true });
  static active = Fields.Boolean({ default: true, help: 'If you uncheck the active field, it will disable the ACL without deleting it (if you delete a native ACL, it will be re-created when you reload the module).' });
  static modelId = Fields.Many2one('ir.model', { string: 'Model', required: true, index: true, ondelete: 'CASCADE' });
  static groupId = Fields.Many2one('res.groups', { string: 'Group', ondelete: 'RESTRICT', index: true });
  static permRead = Fields.Boolean({ string: 'Read Access' });
  static permWrite = Fields.Boolean({ string: 'Write Access' });
  static permCreate = Fields.Boolean({ string: 'Create Access' });
  static permUnlink = Fields.Boolean({ string: 'Delete Access' });

  private static __cacheClearingMethods = new Set<any>();

  static registerCacheClearingMethod(model, method) {
    this.__cacheClearingMethods.add(`${model}/${method}`);
  }

  static unregisterCacheClearingMethod(model, method) {
    this.__cacheClearingMethods.delete(`${model}/${method}`);
  }

  @api.model()
  @tools.ormcacheContext('self.env.uid', 'self.env.su', 'model', 'mode', 'raiseException', ['lang'])
  async check(model, mode = 'read', raiseException = true): Promise<boolean> {
    if (this.env.su) {
      // User root have all accesses
      return true;
    }
    assert(typeof (model) === 'string', f('Not a model name: %s', model));
    assert(['read', 'write', 'create', 'unlink'].includes(mode), `Invalid access mode ${mode}`);

    // TransientModel records have no access rights, only an implicit access rule
    if (!(model in this.env.models)) {
      console.error('Missing model %s', model);
    }
    await this.flush(this._fields.keys());

    // We check if a specific rule exists
    const res = await this._cr.execute(_f(`SELECT MAX(CASE WHEN "perm{mode}" THEN 1 ELSE 0 END) AS val
                              FROM "irModelAccess" a
                              JOIN "irModel" m ON (m.id = a."modelId")
                              JOIN "resGroupsUsersRel" gu ON (gu.gid = a."groupId")
                             WHERE m.model = '%s'
                               AND gu.uid = %s
                               AND a.active IS TRUE`, { mode: _.upperFirst(mode) }), [model, this._uid,]);
    let r = res.length && res[0]['val'];
    if (!r) {
      // there is no specific rule. We check the generic rule
      const res = await this._cr.execute(_f(`SELECT MAX(CASE WHEN "perm{mode}" THEN 1 ELSE 0 END) AS val
                                  FROM "irModelAccess" a
                                  JOIN "irModel" m ON (m.id = a."modelId")
                                 WHERE a."groupId" IS NULL
                                   AND m.model = '%s'
                                   AND a.active IS TRUE`, { mode: _.upperFirst(mode) }), [model]);
      r = res.length && res[0]['val'];
    }
    if (!r && raiseException) {
      const groups = (await this.groupNamesWithAccess(model, mode)).map(g => f('\t- %s', g)).join('\n');
      const documentKind = await (await this.env.items('ir.model')._get(model)).label || model;
      const msgHeads = {
        // Messages are declared in extenso so they are properly exported in translation terms
        'read': _f(await this._t("You are not allowed to access '{documentKind}' ({documentModel}) records."), { documentKind, documentModel: model }),
        'write': _f(await this._t("You are not allowed to modify '{documentKind}' ({documentModel}) records."), { documentKind, documentModel: model }),
        'create': _f(await this._t("You are not allowed to create '{documentKind}' ({documentModel}) records."), { documentKind, documentModel: model }),
        'unlink': _f(await this._t("You are not allowed to delete '{documentKind}' ({documentModel}) records."), { documentKind, documentModel: model }),
      }
      const operationError = msgHeads[mode];
      let groupInfo;
      if (groups) {
        groupInfo = _f(await this._t("This operation is allowed for the following groups:\n{groupsList}"), { groupsList: groups });
      }
      else {
        groupInfo = await this._t("No group currently allows this operation.")
      }
      const resolutionInfo = await this._t("Contact your administrator to request access if necessary.");

      console.info('Access Denied by ACLs for operation: %s, uid: %s, model: %s', mode, this._uid, model);
      const msg = _f(`{operationError}

{groupInfo}

{resolutionInfo}`, { operationError, groupInfo, resolutionInfo });

      throw new AccessError(msg);
    }
    return bool(r);
  }

  /**
   * Return the names of visible groups which have been granted
          ``accessMode`` on the model ``modelName``.
   * @param modelName 
   * @param accessMode 
   * @returns 
   */
  @api.model()
  async groupNamesWithAccess(modelName, accessMode) {
    assert(['read', 'write', 'create', 'unlink'].includes(accessMode), 'Invalid access mode');
    const res = await this._cr.execute(`
          SELECT c.label AS clabel, g.label AS glabel
            FROM "irModelAccess" a
            JOIN "irModel" m ON (a."modelId" = m.id)
            JOIN "resGroups" g ON (a."groupId" = g.id)
       LEFT JOIN "irModuleCategory" c ON (c.id = g."categoryId")
           WHERE m.model = '%s'
             AND a.active = TRUE
             AND a."perm%s" = TRUE
        ORDER BY c.label, g.label NULLS LAST
      `, [modelName, _.upperFirst(accessMode)]);
    return res.map(x => x['clabel'] ? f('%s/%s', x['clabel'], x['glabel']) : x['glabel']);
  }

  @api.model()
  async callCacheClearingMethods() {
    this.invalidateCache();
    const check: any = this.check;
    check.clearCache(this);    // clear the cache of check function
    for (const item of this.cls.__cacheClearingMethods) {
      const [model, method] = [...item.split('/')];
      if (model in this.env.models) {
        await this.env.items(model)[method]();
      }
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    await this.callCacheClearingMethods()
    return _super(IrModelAccess, this).create(valsList);
  }

  async write(values) {
    await this.callCacheClearingMethods()
    return _super(IrModelAccess, this).write(values);
  }

  async unlink() {
    await this.callCacheClearingMethods()
    return _super(IrModelAccess, this).unlink();
  }
}

@MetaModel.define()
class WizardModelMenu extends TransientModel {
  static _module = module;
  static _name = 'wizard.ir.model.menu.create';
  static _description = 'Create Menu Wizard';

  static menuId = Fields.Many2one('ir.ui.menu', { string: 'Parent Menu', required: true, ondelete: 'CASCADE' });
  static label = Fields.Char({ string: 'Menu Name', required: true });

  async menuCreate() {
    for (const menu of this) {
      const model = this.env.items('ir.model').browse(this._context['modelId']);
      const vals = {
        'label': await menu.label,
        'resModel': await model.model,
        'viewMode': 'tree,form',
      }
      const actionId = this.env.items('ir.actions.actwindow').create(vals);
      this.env.items('ir.ui.menu').create({
        'label': await menu.label,
        'parentId': (await menu.menuId).id,
        'action': f('ir.actions.actwindow,%s', actionId,)
      })
    }
    return { 'type': 'ir.actions.actwindow.close' }
  }
}

/**
 * 
 * @param cr database cursor
 * @param table table name
 * @param cols list of column names
 * @param rows list of tuples, where each tuple value corresponds to a column name
 * @param conflict list of column names to put into the ON CONFLICT clause
 * @return the ids of the inserted or updated rows
 */
async function upsert(cr: Cursor, table: string, cols: string[], rows: any[], conflict: string[]): Promise<any> {
  const rowf = `(${quoteList(cols, () => '%s')})`;
  try {
    let query = _format(`
      INSERT INTO {table} ({cols}) VALUES {rows}
      ON CONFLICT ({conflict}) DO UPDATE SET ({cols}) = ({excluded})
      RETURNING id
    `,
      {
        table: quoteDouble(table),
        cols: quoteList(cols, quoteDouble),
        conflict: quoteList(conflict, quoteDouble),
        excluded: quoteList(cols, (col) => "EXCLUDED." + quoteDouble(col)),
      });
    const result = [];
    let sql, sublen;
    const size = Math.floor(10000 / cols.length);
    for (const subrows of cr.splitForInConditions(rows, size)) {
      if (sublen != subrows.length) {
        sublen = subrows.length;
        sql = _f(query, {
          rows: _.fill(Array(sublen), rowf).join(', '),
        });
        sql = _convert$(sql);
      }
      const res = await cr.execute(sql, { bind: subrows.flat() });
      for (const item of res) {
        result.push(item['id']);
      }
    }
    return result;
  } catch (e) {
    throw e;
  }
}

async function markModified(records: ModelRecords, fnames: string[]) {
  const fields = fnames.map((fname) => records._fields[fname]);
  await records.env.protecting(fields, records, async () => {
    await records.modified(fnames);
  });
}

const SAFE_EVAL_BASE = {
  'datetime': DateTime,
  'time': DateTime,
}

/**
 * Return a compute function from its code body and dependencies.
 * @param text 
 * @param deps 
 * @returns 
 */
function makeCompute(text, deps) {
  const func = (self) => safeEval(text, SAFE_EVAL_BASE, { 'self': self, mode: "exec" })
  deps = deps ? deps.split(",").map((arg: string) => arg.trim()) : []
  return api.depends(deps)(func);
}

// generic INSERT and UPDATE queries
// const INSERT_QUERY = "INSERT INTO {table} ({cols}) VALUES {rows} RETURNING id"
// const UPDATE_QUERY = "UPDATE {table} SET {assignment} WHERE {condition} RETURNING id"