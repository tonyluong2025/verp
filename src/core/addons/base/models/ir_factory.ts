import _, { capitalize, difference, intersection, isEqual, range, zip } from "lodash";
import assert from "node:assert";
import { Command, Field, _Many2one, _Number, _One2many, api, tools } from "../../..";
import { Environment } from "../../../api";
import { attrgetter, setdefault } from "../../../api/func";
import { DefaultDict, Dict, OrderedDict, OrderedSet2 } from "../../../helper/collections";
import { AccessError, MissingError, UserError, ValueError } from "../../../helper/errors";
import { LRU } from "../../../helper/lru";
import { AbstractModel, BaseModel, LOG_ACCESS_COLUMNS, MAGIC_COLUMNS, MetaModel, NewId, VALID_AGGREGATE_FUNCTIONS, checkObjectName } from "../../../models";
import { expression } from "../../../osv";
import { Query } from "../../../osv/query";
import { bool } from "../../../tools/bool";
import { equal, isCallable, isInstance, partial } from "../../../tools/func";
import { CountingStream, chain, enumerate, extend, isList, islice, itemgetter, len, map, next, sorted, takewhile } from "../../../tools/iterable";
import { stringify } from "../../../tools/json";
import { cleanContext, groupby, partition, pop, repr, unique, update } from "../../../tools/misc";
import { UpCamelCase, _f, f } from "../../../tools/utils";
import { E, getrootXml, parseXml, serializeXml } from "../../../tools/xml";
import { MODULE_UNINSTALL_FLAG } from "./ir_model";
import { Cursor } from "../../../sql_db";

function raiseOnInvalidObjectName(name) {
  if (!checkObjectName(name)) {
    const msg = `The _name attribute ${name} is not valid.`;
    throw new ValueError(msg);
  }
}

/**
 * Fixes the id fields in import and exports, and splits field paths on '/'.

 * @param fieldname name of the field to import/export
 * @returns split field name
 */
function fixImportExportIdPaths(fieldname: string) {
  const fixedDbId = fieldname.replace(/([^/])\.id/g, '$1/id')
  const fixedExternalId = fixedDbId.replace(/([^/]):id/g, '$1/id');
  return fixedExternalId.split('/')
}

/**
 * Almost methods can be overrides by the children classes to support specially
 */
@MetaModel.define()
class IrFactory extends AbstractModel {
  static _module = module;
  static _parents = 'base';
  static _description = 'base methods factory';

  __init__(pool, cr) { } // after setupBase()

  /**
   * This method is called after method `~._autoInit`, and may be
    overridden to create or modify a model's database schema.
   */
  async init(force?: boolean): Promise<void> { }

  /**
   * Override this method to do specific things when a form view is
    opened. This method is invoked by method `~defaultGet`.
    * @param fieldsList 
    * @returns 
    */
  @api.model()
  async viewInit(fieldsList: string[]): Promise<void> {
  }

  /**
     * Initialize the database schema of ``this``:
      - create the corresponding table,
      - create/update the necessary columns/tables for fields,
      - initialize new columns on existing rows,
      - add the SQL constraints given on the model,
      - add the indexes on indexed fields,
  
      Also prepare post-init stuff to:
      - add foreign key constraints,
      - reflect models, fields, relations and constraints,
      - mark fields to recompute on existing records.
  
      Note: you should not override this method. Instead, you can modify
      the model's database schema by overriding method method `~.init`,
      which is called right after this one.
     */
  async _autoInit(): Promise<void> {
    const cls: any = this.constructor;
    raiseOnInvalidObjectName(cls._name);

    let self = await this.withContext({ prefetchFields: false })

    const cr = self._cr;
    // for debug
    // await cr.commit()
    // await cr.reset()
    // for debug
    const updateCutomFields = self._context['updateCustomFields'] ?? false;
    const mustCreateTable = !(await tools.tableExists(cr, cls._table));
    let parentPathCompute = false;
    if (cls._auto) {
      const values = {}
      values['id'] = {
        type: 'INTEGER',
        autoIncrement: true,
        primaryKey: true
      };
      for (const [name, field] of cls._fields.items()) {
        if (name !== 'id' && field.store && field.columnType) {
          values[name] = {
            type: field.columnType[1]
          }
          if (field.required) values[name]['allowNull'] = false;
          if (field.string != null) values[name]['comment'] = field.string;
          if (field.default != null) values[name]['defaultValue'] = field.default;
        }
      }

      if (mustCreateTable) {
        const query = cr._obj.getQueryInterface();
        await query.createTable(cls._table, values, {
          transaction: cr.objTransaction
        });
        // console.debug('Created table %s.%s', cls._moduleName, cls._table);
      }

      const columns = await tools.tableColumns(cr, cls._table) ?? {};

      if (cls._parentStore) {
        if (!('parentPath' in columns)) {
          await self._createParentColumns();
          parentPathCompute = true;
        }
      }

      if (!mustCreateTable) {
        await self._checkRemovedColums(false);
      }

      const fieldsToCompute = []
      for (const field of cls._fields.values()) {
        if (!field.store) {
          continue;
        }
        if (field.manual && !updateCutomFields) {
          continue;
        }
        const _new = await field.updateDb(self, columns);

        if (_new && field.compute) {
          fieldsToCompute.push(field.name);
        }
      }

      if (fieldsToCompute.length) {
        cls.pool.postInit(async (self, cls) => {
          const recs = await (await self.withContext({ activeTest: false })).search([], { order: 'id' });
          if (!recs.ok) {
            return;
          }
          for (const field of fieldsToCompute) {
            await self.env.addToCompute(cls._fields[field], recs);
          }
        }, self, cls);
      }
    }
    // for debug
    // await cr.clear();
    // for debug
    if (cls._auto) {
      await self._addSqlConstraints();
    }

    if (mustCreateTable) {
      await self._executeSql();
    }

    if (parentPathCompute) {
      await self._parentStoreCompute();
    }
  }

  async _registerHook(): Promise<void> { }

  async _unregisterHook(): Promise<void> { }

  @api.model()
  async _inheritsCheck(): Promise<void> {
    const cls: any = this.constructor;
    for (const [table, fieldName] of Object.entries<string>(cls._inherits ?? {})) {
      let field = cls._fields.get(fieldName);
      if (!field) {
        console.log('Missing many2one field definition for _inherits reference "%s" in "%s", using default one.', fieldName, cls._name);

        const fields = require('./fields');
        field = fields.Fields.Many2one(table, { string: `Automatically created field to link to parent ${table}`, required: true, ondelete: 'CASCADE' });
        this._addField(fieldName, field);
      } else if (!(field.required && ['CASCADE', 'RESTRICT'].includes((field.ondelete || '').toUpperCase()))) {
        console.log(`Field definition for _inherits reference "${fieldName}" in "${cls._name}" must be marked as "required" with ondelete="CASCADE" or 'RESTRICT', forcing it to required + CASCADE.`);
        field.required = true;
        field.ondelete = 'CASCADE';
      }
      field.delegate = true;
    }

    for (const field of Object.values<Field>(cls._fields ?? {})) {
      if (field.type === 'many2one' && !field.related && field.delegate) {
        if (!field.required) {
          console.log("Field %s with delegate=true must be required.", field);
          field.required = true;
        }
        if (!['CASCADE', 'RESTRICT'].includes(field.ondelete.toUpperCase())) {
          field.ondelete = 'CASCADE';
        }
        cls._inherits = { ...(cls._inherits ?? {}), [field.comodelName]: field.name };
        const model = cls.pool.models[field.comodelName];
        if (!model) {
          console.log(field.modelName, field.comodelName, field.toString());
        }
        cls.pool.models[field.comodelName]._inheritsChildren.add(cls._name);
      }
    }
  }

  _validFieldParameter(field: Field, name: string): boolean {
    return ['relatedSudo', 'modelField'].includes(name);
  }

  async tableQuery() {
    if (typeof (this.cls._tableQuery) === 'function') {
      return this.cls._tableQuery(this);
    } else {
      return this.cls._tableQuery;
    }
  }

  @api.model()
  async viewHeaderGet(viewId, viewType = 'form') {
    return false;
  }

  @api.model()
  async new(values = {}, options: { origin?: any, ref?: any }={}) {
    values = values ?? {};
    let origin = options.origin;
    if (origin != null) {
      origin = origin.id;
    }
    const record = this.browse([new NewId(origin, options.ref)]);
    await record._updateCache(values, false);
    return record;
  }

  @api.model()
  async _create(dataList = []) {
    const cr = this.env.cr;
    const quote = (x) => `"${x}"`;
    const ids = [];
    const otherFields = new OrderedSet2();
    const translatedFields = new OrderedSet2();
    for (const data of dataList) {
      const stored = data['stored'];
      const columnId = ['id', `nextval('"${this.cls._sequence}"'::regclass)`, this.cls._sequence];
      const columns = [];
      for (const [name, val] of sorted(Object.entries(stored))) {
        const field = this._fields[name];
        assert(field.store);
        if (field.columnType) {
          const colVal = await field.convertToColumn(val, this, stored);
          columns.push([name, field.columnFormat, colVal]);
          if (field.translate === true) {
            translatedFields.add(field);
          }
        }
        else {
          otherFields.add(field);
        }
      }
      let query = f(`INSERT INTO %s (${columnId[0]}, %s) VALUES (${columnId[1]}, %s) RETURNING id`,
        quote(this.cls._table),
        columns.map(([name]) => quote(name)).join(", "),
        columns.map(([name, fmt], index) => `$${index + 1}`).join(", ")
      );
      const params = columns.map(([name, fmt, val]) => val);
      const res = await cr.execute(query, { bind: params });
      ids.push(res[0]['id']);
    }
    const cacheToClear = [];
    const records = this.browse(ids);
    const inversesUpdate = new DefaultDict<any, any>();
    for (const [data, record] of zip(dataList, [...records])) {
      data['record'] = record;
      const vals = new Dict();
      for (const d of Object.values(data['inherited'])) {
        for (const [k, v] of Object.entries(d)) {
          vals[k] = v;
        }
      }
      vals.updateFrom(data['stored']);
      const setVals = Object.keys(vals).concat(LOG_ACCESS_COLUMNS).concat([this.cls.CONCURRENCY_CHECK_FIELD, 'id', 'parentPath']);
      for (const field of Object.values(this._fields)) {
        if (['one2many', 'many2many'].includes(field.type)) {
          this.env.cache.set(record, field, [])
        }
        else if (field.related && !field.columnType) {
          this.env.cache.set(record, field, await field.convertToCache(null, record))
        }
        else if (!(setVals.includes(field.name)) && !field.compute) {
          this.env.cache.set(record, field, await field.convertToCache(null, record));
        }
      }
      for (const [fname, value] of Object.entries(vals)) {
        const field = this._fields[fname];
        if (['one2many', 'many2many'].includes(field.type)) {
          cacheToClear.push([record, field]);
        }
        else {
          const cacheValue = await field.convertToCache(value, record);
          this.env.cache.set(record, field, cacheValue);
          if (['many2one', 'many2oneReference'].includes(field.type) && this.pool.fieldInverses.get(field).length) {
            const key = `${[field, cacheValue]}`;
            let res = inversesUpdate.get(key);
            if (!res) {
              res = [];
              res[0] = field;
              res[1] = cacheValue;
              res[2] = [];
              inversesUpdate.set(key, res);
            }
            res[2].push(record.id);
          }
        }
      }
    }
    for (const [key, [field, value, recordIds]] of inversesUpdate) {
      await field._updateInverses(this.browse(recordIds), value)
    }

    await records._parentStoreCreate();

    const _protected = dataList.map((data) => [data['protected'], data['record']]);

    await this.env.protecting(_protected, null, async () => {
      await records.modified(this._fields, true);

      if (otherFields.length) {
        const others = await records.withContext(cleanContext(this._context));
        for (const field of sorted(otherFields, (field) => field['_sequence'])) {
          const res = [];
          for (const [other, data] of zip([...others], dataList)) {
            if (field.name in data['stored']) {
              res.push([other, data['stored'][field.name]]);
            }
          }
          await field.create(res);
        }
        const fnames = [];
        otherFields.forEach(field => fnames.push(field.name));
        await records.modified(fnames, true);
      }
      for (const [record, field] of cacheToClear) {
        if (this.env.cache.contains(record, field) && !this.env.cache.get(record, field)) {
          this.env.cache.remove(record, field);
        }
      }
    });

    // check constraints for stored fields
    const names = dataList.reduce((result, data) => result.concat(Object.keys(data['stored'])), []);
    await records._validateFields(names);
    await records.checkAccessRule('create');

    // add translations
    if (this.env.lang && this.env.lang !== 'en_US') {
      const Translations = this.env.items('ir.translation');
      for (const field of translatedFields) {
        const tname = `${field.modelName},${field.name}`;
        for (const data in dataList) {
          if (field.name in data['stored']) {
            const record = data['record'];
            const val = data['stored'][field.name]
            await Translations._setIds(tname, 'model', this.env.lang, record.ids, val, val);
          }
        }
      }
    }
    return records;
  }

  /**
   * create(valsList) -> records

        Creates new records for the model.

        The new records are initialized using the values from the list of dicts
        ``valsList``, and if necessary those from method `~.defaultGet`.

    @param valsList list[dict] or dict
        values for the model's fields, as a list of dictionaries::

            [{'fieldName': fieldValue, ...}, ...]

        For backward compatibility, ``valsList`` may be a dictionary.
        It is treated as a singleton list ``[vals]``, and a single record
        is returned.

        see method `~.write` for details

    @return the created records
    @throws AccessError if user has no create rights on the requested object
                        or if user tries to bypass access rules for create on the requested object
    @throws ValidationError if user tries to enter invalid value for a field that is not in selection
    @throws UserError if a loop would be created in a hierarchy of objects a result of the operation (such as setting an object as its own parent)
   */
  @api.modelCreateMulti()
  @api.returns('self', (value) => value.id)
  async create(valsList): Promise<any> {
    if (!len(valsList)) {
      return this.browse();
    }
    const self = this.browse();
    await self.checkAccessRights('create');

    let badNames = ['id', 'parentPath'];
    if (self.cls._logAccess) {
      // the superuser can set log_access fields while loading registry
      if (!(self.env.uid === global.SUPERUSER_ID && !self.pool.ready)) {
        badNames = badNames.concat(LOG_ACCESS_COLUMNS);
      }
    }

    // classify fields for each record
    const dataList = [];
    const inversedFields = new Set();

    for (let vals of valsList) {
      // add missing defaults
      vals = await self._addMissingDefaultValues(vals) ?? new Dict<any>();

      // set magic fields
      for (const name of badNames) {
        vals.pop(name);
      }
      if (self.cls._logAccess) {
        const now = await self.env.cr.now();
        vals.setdefault('createdUid', self.env.uid);
        vals.setdefault('createdAt', now);
        vals.setdefault('updatedUid', self.env.uid);
        vals.setdefault('updatedAt', now);
      }
      // distribute fields into sets for various purposes
      const data = {};
      const stored = data['stored'] = {};
      const inversed = data['inversed'] = {};
      const inherited = data['inherited'] = new DefaultDict<any, any>();
      const _protected = data['protected'] = new Set();
      for (const [key, val] of vals.items()) {
        const field = self._fields[key];
        if (!field) {
          console.error('[%s: %s] in vals: %s', key, val, stringify(vals));
          throw new ValueError("Invalid field %s on model %s", key, self._name);
        }
        if (field.companyDependent) {
          const irpropDef = await self.env.items('ir.property')._get(key, self._name);
          const cachedDef = await field.convertToCache(irpropDef, self);
          const cachedVal = await field.convertToCache(val, self);
          if (cachedVal === cachedDef) {
            // val is the same as the default value defined in
            // 'ir.property'; by design, 'ir.property' will not
            // create entries specific to these records; skipping the
            // field inverse saves 4 SQL queries
            continue;
          }
        }
        if (field.store) {
          stored[key] = val;
        }
        if (field.inherited) {
          inherited[field.relatedField.modelName] = inherited[field.relatedField.modelName] ?? {};
          inherited[field.relatedField.modelName][key] = val;
        } else if (field.inverse) {
          inversed[key] = val;
          inversedFields.add(field);
        }
        // protect non-readonly computed fields against (re)computation
        if (field.compute && !field.readonly) {
          self.pool.fieldComputed.get(field, [field]).forEach(item => _protected.add(item));
        }
      }
      dataList.push(data);
    }

    // create or update parent records
    for (const [modelName, parentName] of Object.entries<any>(self.cls._inherits)) {
      const parentDataList = [];
      for (const data of dataList) {
        if (!data['stored'][parentName]) {
          parentDataList.push(data);
        }
        else if (data['inherited'][modelName]) {
          const parent = self.env.items(modelName).browse(data['stored'][parentName]);
          await parent.write(data['inherited'][modelName]);
        }
      }
      if (parentDataList.length) {
        const list = parentDataList.filter((data) => len(data['inherited'][modelName])).map((data) => data['inherited'][modelName]);
        if (list.length) {
          const parents = await self.env.items(modelName).create(list);
          for (const [parent, data] of zip([...parents], parentDataList)) {
            data['stored'][parentName] = parent.id;
          }
        }
      }
    }

    // create records with stored fields
    const records = await self._create(dataList);

    // protect fields being written against recomputation
    const _protected = dataList.map((data) => [data['protected'], data['record']]);
    await self.env.protecting(_protected, null, async () => {
      const fieldGroups = groupby(inversedFields, attrgetter('inverse'));
      for (const [_inv, fields] of fieldGroups) {
        // determine which records to inverse for those fields
        const invNames = fields.map((field) => field.name);
        const recVals = [];
        for (const data of dataList) {
          if (intersection(invNames, Object.keys(data['inversed'])).length) {
            recVals.push([
              data['record'],
              Object.fromEntries(invNames.filter(name => name in data['inversed']).map(name => [name, data['inversed'][name]]))
            ]);
          }
        }
        // If a field is not stored, its inverse method will probably
        // write on its dependencies, which will invalidate the field on
        // all records. We therefore inverse the field record by record.
        let batches;
        if (fields.every((field) => field.store || field.companyDependent)) {
          batches = [recVals];
        } else {
          batches = recVals.map((recData) => [recData]);
        }
        for (const batch of batches) {
          for (const [record, vals] of batch) {
            await record._updateCache(vals);
          }
          const batchRecs = self.concat(batch.map(([record]) => record));
          await fields[0].determineInverse(batchRecs);
        }
      }
    });

    for (const data of dataList) {
      await data['record']._validateFields(Object.keys(data['inversed']), Object.keys(data['stored']));
    }

    if (self.cls._checkCompanyAuto) {
      await records._checkCompany();
    }
    return records;
  }


  async _write(values) {
    if (this.nok) {
      return true;
    }
    await this._checkConcurrency();
    const cr = this._cr;

    const parentRecords = await this._parentStoreUpdatePrepare(values);

    if (this.cls._logAccess) {
      values = new Dict(values);
      values.setdefault('updatedUid', this.env.uid);
      values.setdefault('updatedAt', await this.env.cr.now());
    }

    const columns = [];

    for (const [name, val] of sorted(Object.entries(values))) {
      if (this.cls._logAccess && LOG_ACCESS_COLUMNS.includes(name) && val == undefined) {
        continue;
      }
      const field = this._fields[name];
      assert(field.store);

      if (field.deprecated) {
        console.log('Field %s is deprecated: %s', field, field.deprecated);
      }

      assert(field.columnType, `Error field.columnType ${field.columnType} of field ${field}`);
      const colVal = await field.convertToColumn(val, this);
      columns.push([name, field.columnFormat, colVal]);
    }

    if (columns.length) {
      const query = `UPDATE "${this.cls._table}" SET ${columns.map((column, index) => `"${column[0]}"=$${index + 1}`)} WHERE id IN (%s) RETURNING id`;
      let params = columns.map(column => column[2]);
      for (const subIds of cr.splitForInConditions(this.ids)) {
        try {
          // for debug, if not commit, database is not writen now
          // await cr.commit();
          // await cr.reset();
          // for debug
          const res = await cr.execute(query, { params: [String(subIds) || 'NULL'], bind: params });
          if (res.length != len(subIds)) {
            throw new MissingError(
              await this._t('One of the records you are trying to modify has already been deleted (Document type: %s).', this.cls._description)
              + f('\n\n(%s %s, %s %s)', await this._t('Records:'), subIds.slice(0, 6), await this._t('User:'), this._uid)
            );
          }
        } catch (e) {
          throw e;
        }
      }
    }

    if (parentRecords._length) {
      await parentRecords._parentStoreUpdate();
    }
    return true;
  }

  /**
   * write(vals)

    Updates all records in the current set with the provided values.

    @param vals fields to update and the value to set on them e.g

        {'foo': 1, 'bar': "Qux"}

        will set the field ``foo`` to ``1`` and the field ``bar`` to
        ``"Qux"`` if those are valid (otherwise it will trigger an error).

    @throws AccessError if user has no write rights on the requested object or if user tries to bypass access rules for write on the requested object
    @throws ValidationError if user tries to enter invalid value for a field that is not in selection
    @throws UserError if a loop would be created in a hierarchy of objects a result of the operation (such as setting an object as its own parent)

    * For numeric fields (class `~verp.fields.Integer`,
      class `~verp.fields.Float`) the value should be of the
      corresponding type
    * For class `~verp.fields.Boolean`, the value should be a
      class `boolean`
    * For class `~verp.fields.Selection`, the value should match the
      selection values (generally `string`, sometimes
      `number`)
    * For class `~verp.fields.Many2one`, the value should be the
      database identifier of the record to set
    * Other non-relational fields use a string for value

      .. danger::

          for historical and compatibility reasons,
          class `~verp.fields.Date` and
          class `~verp.fields.Datetime` fields use strings as values
          (written and read) rather than class `~Date` or. These date strings are
          UTC-only and formatted according to
          const `verp.tools.misc.DEFAULT_SERVER_DATE_FORMAT` and
          const `verp.tools.misc.DEFAULT_SERVER_DATETIME_FORMAT`
    * .. _openerp/models/relationals/format:

      The expected value of a class `~verp.fields.One2many` or
      class `~verp.fields.Many2many` relational field is a list of
      class `~verp.fields.Command` that manipulate the relation the
      implement. There are a total of 7 commands:
      method `~verp.fields.Command.create`,
      method `~verp.fields.Command.update`,
      method `~verp.fields.Command.delete`,
      method `~verp.fields.Command.unlink`,
      method `~verp.fields.Command.link`,
      method `~verp.fields.Command.clear`, and
      method `~verp.fields.Command.set`.
   */
  async write(values = {}): Promise<boolean> {
    if (this.nok) {
      return;
    }
    const cls = this.cls;

    await this.checkAccessRights('write');
    await this.checkFieldAccessRights('write', Object.keys(values))
    await this.checkAccessRule('write');
    let badNames = ['id', 'parentPath'];
    if (this.cls._logAccess) {
      if (!(this.env.uid === global.SUPERUSER_ID && !this.pool.ready)) {
        badNames = [...badNames, ...LOG_ACCESS_COLUMNS];
      }
    }
    const vals = new Dict();
    Object.entries(values).forEach(([key, val]) => {
      if (!badNames.includes(key)) {
        vals[key] = val;
      }
    });
    if (cls._logAccess) {
      vals.setdefault('updatedUid', this.env.uid);
      vals.setdefault('updatedAt', await this.env.cr.now());
    }
    const fieldValues = [];                    // [[field, value]]
    const determineInverses = new Dict<any>(); // {inverse: fields}
    const recordsToInverse = {};               // {field: records}
    const relationalNames = [];
    let _protected = new Set<Field>();
    let checkCompany = false;

    for (const [fname, value] of vals.items()) {
      const field = cls._fields[fname];
      if (!field) {
        throw new ValueError("Invalid field %s on model %s", fname, cls._name);
      }
      fieldValues.push([field, value]);
      if (field.inverse) {
        if (['one2many', 'many2many'].includes(field.type)) {
          this[fname];
        }
        determineInverses[field.inverse] = determineInverses[field.inverse] || [];
        determineInverses[field.inverse].push(field);
        recordsToInverse[field] = await this.filtered('id');
      }
      if (field.relational || this.pool.fieldInverses.get(field).length) {
        relationalNames.push(fname);
      }
      if (field.inverse || (field.compute && !field.readonly)) {
        if (field.store || !['one2many', 'many2many'].includes(field.type)) {
          _protected = new Set([..._protected, ...this.pool.fieldComputed.get(field, [field])]);
        }
      }
      if (fname === 'companyId' || (field.relational && field.checkCompany)) {
        checkCompany = true;
      }
    }

    const tocompute = [..._protected].filter(field => field.compute && !vals.includes(field.name)).map((field) => field.name);
    if (tocompute.length) {
      await this.recompute(tocompute, this);
    }

    await this.env.protecting(_protected, this, async () => {
      await this.modified(relationalNames, false, true);
      const realRecs = await this.filtered('id');
      for (const [field, value] of sorted(fieldValues, (item) => item[0].writeSequence)) {
        await field.write(this, value);
      }
      await this.modified(vals);
      if (this.cls._parentStore && vals.includes(this.cls._parentName)) {
        await this.flush([this.cls._parentName]);
      }
      const inverseFields = []
      for (const fs of determineInverses.values()) {
        for (const f of fs) {
          inverseFields.push(f.name);
        }
      }
      await realRecs._validateFields(Object.keys(vals), inverseFields);

      for (const fields of determineInverses.values()) {
        for (const field of fields) {
          if (!field.store && Array.from(this.env.cache.getMissingIds(realRecs, field)).some((e) => bool(e))) {
            await field.write(realRecs, vals[field.name]);
          }
        }
        try {
          await fields[0].determineInverse(realRecs);
        } catch (e) {
          if (isInstance(e, AccessError)) {
            if (fields[0].inherited) {
              const description = (await this.env.items('ir.model')._get(this._name)).label;
              throw new AccessError(
                _f(await this._t("{previousMessage}\n\nImplicitly accessed through '{documentKind}' ({documentModel})."), {
                  'previousMessage': e.message,
                  'documentKind': description,
                  'documentModel': this._name,
                })
              )
            }
            throw e;
          }
          else {
            throw e;
          }
        }
      }
    });
    if (checkCompany && this.cls._checkCompanyAuto) {
      await this._checkCompany();
    }
    return true;
  }

  /**
   * Deletes the records of the current set
    @throws AccessError if user has no unlink rights on the requested object
                       or if user tries to bypass access rules for unlink on the requested object
    @throws UserError if the record is default property for other records
   */
  async unlink(): Promise<boolean> {
    if (!this.ok) {
      return true;
    }

    await this.checkAccessRights('unlink');
    await this.checkAccessRule('unlink');
    await this._checkConcurrency();

    for (const func of this.cls._ondeleteMethods()) {
      // func._ondelete is true if it should be called during uninstallation
      if (func['_ondelete'] || !this._context[MODULE_UNINSTALL_FLAG]) {
        await func.call(this);
      }
    }

    // mark fields that depend on 'self' to recompute them after 'self' has
    // been deleted (like updating a sum of lines after deleting one line)
    await this.flush();
    await this.modified(this._fields, false, true);

    // with (this.env.norecompute()) 
    {
      const cr = this._cr;
      const Data = await (await this.env.items('ir.model.data').sudo()).withContext({});
      const Defaults = await this.env.items('ir.default').sudo();
      const Property = await this.env.items('ir.property').sudo();
      const Attachment = await this.env.items('ir.attachment').sudo();
      let irModelDataUnlink = Data;
      let irAttachmentUnlink = Attachment;

      // TOFIX: this avoids an infinite loop when trying to recompute a
      // field, which triggers the recomputation of another field using the
      // same compute function, which then triggers again the computation
      // of those two fields
      for (const field of Object.values<Field>(this.cls._fields)) {
        this.env.removeToCompute(field, this);
      }

      for (const subIds of cr.splitForInConditions(this.ids)) {
        // Check if the records are used as default properties.
        const refs = subIds.map(i => `${this._name},${i}`);
        if (bool(await Property.search([['resId', '=', false], ['valueReference', 'in', refs]], { limit: 1 }))) {
          throw new UserError(await this._t('Unable to delete this document because it is used as a default property'));
        }

        // Delete the records' properties.
        await (await Property.search([['resId', 'in', refs]])).unlink();

        let query = `DELETE FROM "${this.cls._table}" WHERE id IN (${subIds})`;
        await cr.execute(query);

        // Removing the ir_model_data reference if the record being deleted
        // is a record created by xml/csv file, as these are not connected
        // with real database foreign keys, and would be dangling references.
        //
        // Note: the following steps are performed as superuser to avoid
        // access rights restrictions, and with no context to avoid possible
        // side-effects during admin calls.
        const data = await Data.search([['model', '=', this._name], ['resId', 'in', subIds]]);
        if (data.ok) {
          irModelDataUnlink = irModelDataUnlink.or(data);
        }
        // For the same reason, remove the defaults having some of the
        // records as value
        await Defaults.discardRecords(this.browse(subIds));

        // For the same reason, remove the relevant records in ir_attachment
        // (the search is performed with sql as the search method of
        // ir_attachment is overridden to hide attachments of deleted
        // records)
        query = `SELECT id FROM "irAttachment" WHERE "resModel"='${this.cls._name}' AND "resId" IN (${subIds})`;
        const res = await cr.execute(query);
        const attachments = Attachment.browse(res.map(row => row['id']));
        if (attachments.ok) {
          irAttachmentUnlink = irAttachmentUnlink.or(await attachments.sudo());
        }
      }
      // invalidate the *whole* cache, since the orm does not handle all
      // changes made in the database, like cascading delete!
      this.invalidateCache();
      if (irModelDataUnlink.ok) {
        await irModelDataUnlink.unlink();
      }
      if (irAttachmentUnlink) {
        await irAttachmentUnlink.unlink();
      }
      await this.flush();
    }
    // auditing: deletions are infrequent and leave no trace in the database
    // console.debug('User #%s deleted records %s ids [%s]', this._uid, this._name, String(sorted(this.ids)));
    return true;
  }


  /**
   * copy(default=None)

    Duplicate record ``self`` updating it with default values

    @param defaultValue dictionary of field values to override in the
            original values of the copied record, e.g: ``{'fieldName': overriddenValue, ...}``
    @returns new record

   */
  @api.returns('self', (value) => value.id)
  async copy(defaultValue) {
    this.ensureOne();
    const vals = (await (await this.withContext({ activeTest: false })).copyData(defaultValue))[0];
    // To avoid to create a translation in the lang of the user, copy_translation will do it
    const newObj = (await (await this.withContext({ lang: null })).create(vals)).withEnv(this.env);
    await (await this.withContext({ fromCopyTranslation: true })).copyTranslations(newObj, defaultValue || {});
    return newObj;
  }

  /**
   * Copy given record's data with all its fields values
 
    @param defaultValue field values to override in the original values of the copied record
    @returns list with a dictionary containing all the field values
   */
  @api.returns(null, (value) => value[0])
  async copyData(defaultValue: {} = {}) {
    // In the old API, this method took a single id and return a dict. When  invoked with the new API, it returned a list of dicts.
    this.ensureOne();

    // avoid recursion through already copied records in case of circular relationship
    let self = this;
    if (!('__copyDataSeen' in self._context)) {
      self = await self.withContext({ __copyDataSeen: new Dict() });
    }
    const seenMap = self._context['__copyDataSeen'];
    seenMap[self._name] = seenMap[self._name] ?? new Set();
    if (self.id in seenMap[self._name]) {
      return;
    }
    seenMap[self._name].add(self.id);

    defaultValue = Object.assign({}, defaultValue);

    // build a black list of fields that should not be copied
    const blacklist = new Set(MAGIC_COLUMNS.concat(['parentPath']));
    const whitelist = new Set(self._fields.items().filter(([_, field]) => !field.inherited).map(([name]) => name));

    (function blacklistGivenFields(model) {
      // blacklist the fields that are given by inheritance
      for (const [parentModel, parentField] of Object.entries<any>(model.cls._inherits)) {
        blacklist.add(parentField);
        if (parentField in defaultValue) {
          // all the fields of 'parent_model' are given by the record:
          // default[parentField], except the ones redefined in self
          difference(self.env.models[parentModel]._fields.keys(), [...whitelist]).forEach((value) => { if (!blacklist.has(value)) blacklist.add(value) });
        }
        else {
          blacklistGivenFields(self.env.items(parentModel));
        }
      }
      // blacklist deprecated fields
      for (const [name, field] of model._fields.items()) {
        if (field.deprecated) {
          blacklist.add(name);
        }
      }
    })(self);

    const fieldsToCopy = new Dict<Field>();
    for (const [name, field] of self._fields.items()) {
      if (field.copy && !(name in defaultValue) && !blacklist.has(name)) {
        fieldsToCopy[name] = field;
      }
    }

    for (const [name, field] of fieldsToCopy.items()) {
      if (field.type === 'one2many') {
        // duplicate following the order of the ids because we'll rely on it later for copying translations in copy_translation()!
        const lines = [];
        for (const rec of await (await self[name]).sorted('id')) {
          lines.push((await rec.copyData())[0]);
        }
        // the lines are duplicated using the wrong (old) parent, but then are
        // reassigned to the correct one thanks to the (Command.CREATE, 0, ...)
        defaultValue[name] = lines.filter(line => line.ok).map(line => Command.create(line));
      }
      else if (field.type === 'many2many') {
        defaultValue[name] = [Command.set((await self[name]).ids)];
      }
      else {
        defaultValue[name] = await field.convertToWrite(await self[name], self);
      }
    }

    return [defaultValue];
  }

  async _computeFieldValue(field: Field) {
    if (typeof field.compute === 'string') {
      let func = this[field.compute];
      if (isCallable(func)) {
        await func.call(this);
      }
    } else {
      if (isCallable(field.compute)) {
        await field.compute.call(field, this);
      }
    }
    if (field.store && this._ids.some(id => bool(id))) {
      const fnames = this.pool.fieldComputed.get(field, []).map((f) => f.name);
      await (await this.filtered('id'))._validateFields(fnames);
    }
  }

  /**
   * Private implementation of search() method, allowing specifying the uid to use for the access right check.
    This is useful for example when filling in the selection list for a drop-down and avoiding access rights errors,
    by specifying ``accessRightsUid=1`` to bypass access rights check, but not ir.rules!
    This is ok at the security level because this method is private and not isCallable through XML-RPC.

    @param accessRightsUid optional user ID to use when checking access rights
                              (not for ir.rules, this is only for ir.model.access)
    @returns a list of record ids or an integer (if count is true)
   */
  @api.model()
  async _search(args: any, options: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean, isQuery?: boolean } = {}): Promise<number | Query | any[]> {
    const model = options.accessRightsUid ? await this.withUser(options.accessRightsUid) : this;
    await model.checkAccessRights('read');

    if (expression.isFalse(this, args)) {
      return options.count ? 0 : []
    }

    await this._flushSearch(args, { order: options.order })

    const query = await this._whereCalc(args);
    await this._applyIrRules(query, 'read');

    if (options.count) {
      const [sql, params] = query.select('COUNT(1)::int');
      const res = await this._cr.execute(tools._convert$(sql), { bind: params });
      return tools.parseInt(res[0]['count']);
    }
    query.order = (await this._generateOrderBy(options.order, query)).replace('ORDER BY ', '');
    query.limit = options.limit;
    query.offset = options.offset;

    return options.isQuery ? query : query.getIds();
  }

  /**
   * Perform a method `search` followed by a method `read`.

    @param domain Search domain, see ``args`` parameter in method `search`.
        Defaults to an empty domain that will match all records.
    @param fields List of fields to read, see ``fields`` parameter in method `read`.
        Defaults to all fields.
    @param offset Number of records to skip, see ``offset`` parameter in method `search`.
        Defaults to 0.
    @param limit Maximum number of records to return, see ``limit`` parameter in method `search`.
        Defaults to no limit.
    @param order Columns to sort result, see ``order`` parameter in method `search`.
        Defaults to no sort.
    @param options All read keywords arguments used to call read(..., options) method
        E.g. you can use searchRead({..., load: ''}) in order to avoid computing nameGet
    @returns List of dictionaries containing the asked fields.
   */
  @api.model()
  async searchRead(domain?: any[], fields?: any[], options: { offset?: any, limit?: any, order?: any } = {}): Promise<Dict<any>[]> {
    if (!Array.isArray(domain)) {
      options = domain ?? {};
      domain = pop(options, 'domain');
      fields = pop(options, 'fields');
    }
    let records = await this.search(domain || [], options);
    if (!records.ok) {
      return [];
    }

    if (fields && isEqual(fields, ['id'])) {
      // shortcut read if we only want the ids
      const res = [];
      for (const record of records) {
        res.push({ 'id': record.id });
      }
      return res;
    }

    // read() ignores activeTest, but it would forward it to any downstream search call
    // (e.g. for x2m or function fields), and this is not the desired behavior, the flag
    // was presumably only meant for the main search().
    // TODO: Move this to read() directly?
    if ('activeTest' in this._context) {
      const context = Object.assign({}, this._context);
      delete context['activeTest'];
      records = await records.withContext(context);
    }

    const result = await records.read(fields, options['load']);
    if (len(result) <= 1) {
      return result;
    }

    // reorder read
    const index = new Dict();;
    for (const vals of result) {
      index[vals['id']] = vals;
    }

    const res = [];
    for (const record of records) {
      if (record.id in index) {
        res.push(index[record.id])
      }
    }
    return res;
  }

  /**
   * _nameSearch(name='', args=None, operator='ilike', {limit=100, nameGetUid=None}) -> ids

      Private implementation of nameSearch, allows passing a dedicated user
      for the nameGet part to solve some access rights issues.
   * @param name 
   * @param args 
   * @param operator 
   * @param options 
   */
  @api.model()
  async _nameSearch(name: string = '', args: any[], operator: string = 'ilike', { limit = 100, nameGetUid = false } = {}): Promise<number | any[] | Query> {
    args = args || [];
    // optimize out the default criterion of ``ilike ''`` that matches everything
    if (!this.cls._recName) {
      console.warn("Cannot execute nameSearch, no _recName defined on %s", this.cls._name);
    }
    else if (!(name === '' && operator === 'ilike')) {
      args = args.concat([[this.cls._recName, operator, name]]);
    }
    return this._search(args, { limit, accessRightsUid: nameGetUid });
  }

  /**
   * Inverse the value of the field ``(x)active`` on the records in ``this``. 
   */
  async toggleActive() {
    const activeName = this.cls._activeName;
    const activeRecs = await this.filtered(activeName);
    await activeRecs.set(activeName, false);
    await this.sub(activeRecs).set(activeName, true);
  }

  /**
   * Set (x)active=false on a recordset, by calling toggleActive to take the corresponding actions according to the model
   * @returns 
   */
  async actionArchive() {
    const activeName = this.cls._activeName;
    return (await this.filtered(async (record) => bool(await record[activeName]))).toggleActive();
  }

  /**
   * Set (x)active=true on a recordset, by calling toggle_active to take the corresponding actions according to the model
   * @returns 
   */
  async actionUnarchive() {
    const activeName = this.cls._activeName;
    return (await this.filtered(async (record) => !bool(record[activeName]))).toggleActive();
  }

  /**
   * Compute the value of the `displayName` field.

      In general `displayName` is equal to calling `nameGet()[0][1]`.

      In that case, it is recommended to use `displayName` to uniformize the
      code and to potentially take advantage of prefetch when applicable.

      However some models might override this method. For them, the behavior
      might differ, and it is important to select which of `displayName` or
      `nameGet()[0][1]` to call depending on the desired result.
   */
  @api.depends((self) => self.cls._recName ? [self.cls._recName,] : [])
  async _computeDisplayName() {
    const names = Dict.from(await this.nameGet());
    for (const record of this) {
      await record.set('displayName', names.get(record.id, false));
    }
  }

  /**
   * Returns rooturl for a specific given record.

      By default, it return the ir.config.parameter of base_url
      but it can be overridden by model.

      @returns the base url for this record
   */
  async getBaseUrl() {
    if (this._length > 1) {
      throw new ValueError("Expected singleton or no record: %s", this);
    }
    return (await this.env.items('ir.config.parameter').sudo()).getParam('web.base.url');
  }

  async _processEndUnlinkRecord(record) {
    // child implement;
  }


  /**
   * Returns the fieldsViews of given views, along with the fields of
        the current model, and optionally its filters for the given action.

    @param views list of [viewId, viewType]
    @param options.toolbar true to include contextual actions when loading fieldsViews
    @param options.loadFilters true to return the model's filters
    @param options.actionId id of the action to get the filters
    @returns dictionary with fieldsViews, fields and optionally filters
    */
  @api.model()
  async loadViews(kw: { views?: any, options?: any } = {}) {
    const views = kw.views ?? [];
    const options = kw.options ?? {};
    const result = {};

    const toolbar = options['toolbar'];
    result['fieldsViews'] = {};
    for (const [vId, vType] of views) {
      const res = await this.fieldsViewGet(vId, vType !== 'list' ? vType : 'tree', vType !== 'search' ? toolbar : false);
      pop(res, 'dom'); // Not use dom
      result['fieldsViews'][vType] = res;
    }
    result['fields'] = await this.fieldsGet();

    if (options['loadFilters']) {
      result['filters'] = await this.env.items('ir.filters').getFilters(this._name, options['actionId']);
    }

    return result;
  }

  /**
   * Check the companies of the values of the given field names.

      @param fnames names of relational fields to check
      @throws UserError if the `companyId` of the value of any field is not in `[false, self.companyId]` (or `self` if class `~verp.addons.base.models.resCompany`).

      For class `~verp.addons.base.models.resUsers` relational fields, verifies record company is in `companyIds` fields.

      User with main company A, having access to company A and B, could be assigned or linked to records in company B.
   * @param fnames 
   */
  async _checkCompany(fnames?: Dict<Field>) {
    if (fnames == null) {
      fnames = this._fields;
    }
    const regularFields = [];
    const propertyFields = [];
    for (const name of fnames.keys()) {
      const field = this._fields[name];
      if (field.relational && field.checkCompany && 'companyId' in this.env.models[field.comodelName]._fields) {
        if (!field.companyDependent) {
          regularFields.push(name);
        }
        else {
          propertyFields.push(name);
        }
      }
    }
    if (!(regularFields.length || propertyFields.length)) {
      return;
    }

    const inconsistencies = [];
    for (const record of this) {
      let company = record._name !== 'res.company' ? await record.companyId : record;
      // The first part of the check verifies that all records linked via relation fields are compatible with the company of the origin document, i.e. `self.accountId.companyId == self.companyId`
      const recordSudo = await record.sudo();
      for (const name of regularFields) {
        const corecord = await recordSudo[name];
        // Special case with `res.users` since an user can belong to multiple companies.
        if (corecord._name === 'res.users' && bool(await corecord.companyIds)) {
          if (!company.le(await corecord.companyIds)) {
            inconsistencies.push([record, name, corecord]);
          }
        }
        else if (!(await corecord.companyId).le(company)) {
          inconsistencies.push([record, name, corecord]);
        }
      }
      // The second part of the check (for property / company-dependent fields) verifies that the records linked via those relation fields are compatible with the company that owns the property value, i.e. the company for which the value is being assigned, 
      // i.e: `await (await this.propertyAccountPayableId).set('companyId', await this.env.company())`
      company = await this.env.company();
      for (const name of propertyFields) {
        // Special case with `res.users` since an user can belong to multiple companies.
        const corecord = await recordSudo[name];
        if (corecord._name === 'res.users' && bool(await corecord.companyIds)) {
          if (!company.le(await corecord.companyIds)) {
            inconsistencies.push([record, name, corecord]);
          }
        }
        else if (!(await corecord.companyId).le(company)) {
          inconsistencies.push([record, name, corecord]);
        }
      }
    }
    if (inconsistencies.length) {
      const lines = [await this._t("Incompatible companies on records:")];
      const companyMsg = await this._t("- Record is company {company} and {field} ({fname}: {values}) belongs to another company.");
      const recordMsg = await this._t("- {record} belongs to company {company} and {field} ({fname}: {values}) belongs to another company.");
      for (const [record, name, corecords] of inconsistencies.slice(0, 5)) {
        let msg, company;
        if (record._name === 'res.company') {
          [msg, company] = [companyMsg, record];
        }
        else {
          [msg, company] = [recordMsg, await record.companyId];
        }
        const field = this.env.items('ir.model.fields')._get(this._name, name);
        const values = [];
        for (const rec of corecords) {
          values.push(repr(await rec.displayName));
        }
        lines.push(tools._f(msg, {
          'record': await record.displayName,
          'company': await company.displayName,
          'field': field.fieldDescription,
          'fname': field.name,
          'values': values.join(", "),
        }));
      }
      throw new UserError(lines.join('\n'));
    }
  }

  /**
   * nameGet() -> [[id, label], ...]

    Returns a textual representation for the records in ``this``.
    By default this is the value of the ``displayName`` field.

    @returns list of pairs ``[id, textRepr]`` for each records
   */
  async nameGet(): Promise<any[]> {
    const result = [];
    const name = this.cls._recName;
    if (name in this._fields) {
      const convert = this._fields[name].convertToDisplayName;
      for (const record of this) {
        result.push([record.id, await convert(await record[name], record)]);
      }
    }
    else {
      for (const record of this) {
        result.push([record.id, `${record.cls._name},${record.id}`]);
      }
    }
    return result;
  }

  /**
   * nameCreate(name) -> record
    Create a new record by calling method `~.create` with only one value
    provided: the display name of the new record.

    The new record will be initialized with any default values
    applicable to this model, or provided through the context. The usual
    behavior of method `~.create` applies.

    @param name display name of the record to create
    @returns the method `~.nameGet` pair value of the created record
   */
  @api.model()
  async nameCreate(name): Promise<any> {
    if (this.cls._recName) {
      const record = await this.create({ [this.cls._recName]: name });
      return (await record.nameGet())[0];
    }
    else {
      console.warn("Cannot execute nameCreate, no _recName defined on %s", this.cls._name);
      return false
    }
  }

  /**
   * Read the given fields of the records in ``this`` from the database,
    and store them in cache. Access errors are also stored in cache.
    Skip fields that are not stored.

    @param fieldNames list of column names of model ``this``; all those
        fields are guaranteed to be read
    @param inheritedFieldNames list of column names from parent
        models; some of those fields may not be read
   */
  async _read(fields: string[] = []) {
    const cls = this.cls;
    if (!bool(this)) {
      return;
    }
    await this.checkAccessRights('read');
    await this.flush(fields, this);
    const fieldNames = [];
    const inheritedFieldNames = [];
    for (const name of fields) {
      const field = this._fields.get(name);
      if (field) {
        if (field.store) {
          fieldNames.push(name);
        } else if (field.baseField.store) {
          inheritedFieldNames.push(name);
        }
      } else {
        console.warn("%s.read() with unknown field '%s'", cls._name, name);
      }
    }

    const fieldsPre = fieldNames.concat(inheritedFieldNames).map(name => this._fields[name])
      .filter(field => field.name !== 'id'
        && (field.baseField.store && field.baseField.columnType)
        && !(field.inherited && isCallable(field.baseField.translate))
      )

    let result = [];
    let cr, user, context, su;
    if (fieldsPre.length) {
      const self = this;
      const env = this.env;
      [cr, user, context, su] = env.args;

      const query = new Query(this.env.cr, cls._table, await this.tableQuery());
      await this._applyIrRules(query, 'read');

      async function quality(field) {
        const col = field.name;
        let res = await self._inheritsJoinCals(cls._table, col, query);
        if (field.type === 'binary' && (context['binSize'] || context['binSize' + UpCamelCase(col)])) {
          res = `pg_size_pretty(length(${res})::bigint)`;
        }
        return `${res} as "${col}"`;
      }

      const qualNames = [];
      for (const name of [this._fields['id'], ...fieldsPre]) {
        qualNames.push(await quality(name));
      }

      query.addWhere(`"${cls._table}".id IN (%%s)`);
      let [queryStr, params] = query.select(...qualNames);
      for (const subIds of cr.splitForInConditions(this.ids)) {
        let str = queryStr.replace('%%s', subIds.toString());
        str = tools._convert$(str);
        const res = await cr.execute(str, { bind: params });
        for (const r of res) {
          result.push(Object.values(r));
        }
      }
    }
    else {
      await this.checkAccessRights('read');
      result = this.ids.map(id => [id]);
    }
    let fetched = this.browse();
    if (result.length) {
      const cols: any = zip<any>(...result)[Symbol.iterator]();
      const ids = next(cols);
      fetched = this.browse(ids);

      for (const field of fieldsPre) {
        let values = next(cols);
        if (context['lang'] && !field.inherited && isCallable(field.translate)) {
          if (values.every(v => v != undefined)) {
            const translate = await field.getTransFunc(fetched);
            for (const index of range(0, ids.length)) {
              values[index] = await translate(ids[index], values[index]);
            }
          }
        }
        if (field.type === 'date' || field.type === 'datetime' || field instanceof _Number) { 
          // need convert date/datetime/_Number because returned as string from db/sequelize without Z, ex: 2024-10-22 05:06:25.989
          // ==> add 'Z' at the end
          values = await Promise.all(values.map(async val => field.convertFromColumn(val, this)));
        }
        this.env.cache.update(fetched, field, values);
      }

      for (const name of fieldNames) {
        const field = this._fields[name];
        if (!field.columnType) {
          await field.read.call(field, fetched);
        }
        if (field.deprecated) {
          console.warn(`Field ${field} id deprecated: ${field.deprecated}`);
        }
      }
    }

    const missing = this.sub(fetched);
    if (bool(missing)) {
      const extras = fetched.sub(this);
      if (bool(extras)) {
        throw new AccessError(await this._t(`Database fetch misses ids (${missing._ids}) and has extra ids (${extras._ids}), may be caused by a type incoherence in a previous request`));
      }
      const forbidden = await missing.exists();
      if (bool(forbidden)) {
        throw await this.env.items('ir.rule')._makeAccessError('read', forbidden);
      }
    }

    return result;
  }

  /**
   * read([fields])
    Reads the requested fields for the records in ``this``, low-level/RPC method. In JS code, prefer method `~.browse`.
   * @param fields list of field names to return (default is all fields)
   * @param load 
   * @returns a list of dictionaries mapping field names to their values, with one dictionary per record
   * @throws AccessError if user has no read rights on some of the given records
   */
  async read(fields, load = '_classicRead') {
    fields = await this.checkFieldAccessRights('read', fields);

    // fetch stored fields from the database to the cache
    const storedFields = new Set<string>();
    for (const name of fields) {
      const field = this._fields.get(name);
      if (!field) {
        throw new ValueError("Invalid field %s on model %s", name, this.cls._name);
      }
      if (field.store) {
        storedFields.add(name);
      }
      else if (field.compute) {
        // optimization: prefetch direct field dependencies
        for (const dotname of this.pool.fieldDepends.get(field)) {
          const f = this._fields[dotname.split('.')[0]];
          if (f.prefetch && (!f.groups || await this.userHasGroups(f.groups))) {
            storedFields.add(f.name);
          }
        }
      }
    }
    await this._read(Array.from<string>(storedFields));

    return this._readFormat(fields, typeof load === 'string' ? load : load['load']);
  }

  @api.model()
  async readGroup(domain, fields, groupby, options = {}) {
    if (!Array.isArray(domain)) {
      options = domain;
      domain = pop(options, 'domain');
      fields = pop(options, 'fields');
      groupby = pop(options, 'groupby');
    }
    tools.setOptions(options, { offset: 0, limit: null, orderby: null, lazy: true });
    const result = await this._readGroupRaw(domain, fields, groupby, options);

    groupby = typeof groupby === 'string' ? [groupby] : new OrderedSet2(groupby);
    const dt = groupby.filter(f => ['date', 'datetime'].includes(this._fields[f.split(':')[0]].type));
    for (const group of result) {
      for (const [k, v] of Object.entries(group)) {
        const field = this._fields[k];
        if (field instanceof _Number) {
          group[k] = await this._fields[k].convertToRead(v, this);
        }
      }
      if (len(dt)) {
        group["__range"] = {};
      }
      for (const df of dt) {
        // could group on a date(time) field which is empty in some
        // records, in which case as with m2o the _raw value will be
        // `false` instead of a (value, label) pair. In that case,
        // leave the `false` value alone
        const fieldName = df.split(':')[0];
        if (group[df]) {
          const [rangeFrom, rangeTo] = group[df][0].split('/');
          // /!\ could break if DEFAULT_SERVER_DATE_FORMAT allows '/' characters
          group["__range"][fieldName] = {
            "from": rangeFrom,
            "to": rangeTo
          }
          group[df] = group[df][1];
        }
        else {
          group["__range"][fieldName] = false;
        }
      }
    }
    return result;
  }

  @api.model()
  async _readGroupRaw(domain, fields, groupby, options: { offset?: number, limit?: number, orderby?: string, lazy?: boolean } = {}) {
    tools.setOptions(options, { offset: 0, limit: null, orderby: false, lazy: true })
    await this.checkAccessRights('read');
    let query: any = await this._whereCalc(domain);
    fields = fields ?? this._fields.values().map(f => f.name).filter(f => f.store);

    groupby = typeof groupby === 'string' ? [groupby] : new OrderedSet2(groupby);
    const groupbyList = options.lazy ? groupby.slice(0, 1) : groupby;
    const annotatedGroupbys = [];
    for (const gb of groupbyList) {
      annotatedGroupbys.push(await this._readGroupProcessGroupby(gb, query));
    }
    const groupbyFields = annotatedGroupbys.map(g => g['field']);
    const order = options.orderby || groupbyList.join(',');
    const groupbyDict = {}
    for (const gb of annotatedGroupbys) {
      groupbyDict[gb['groupby']] = gb;
    }

    await this._applyIrRules(query, 'read');
    for (const gb of groupbyFields) {
      if (!(gb in this._fields)) {
        throw new UserError(await this._t("Unknown field %s in 'groupby'", gb));
      }
      if (!this._fields[gb].baseField.groupable) {
        throw new UserError(await this._t(
          "Field %s is not a stored field, only stored fields (regular or many2many) are valid for the 'groupby' parameter", this._fields[gb]
        ));
      }
    }
    const aggregatedFields = [];
    const selectTerms = [];
    const fnames = [];                     // list of fields to flush
    const regexFieldAgg = /(\w+)(?:\:(\w+)(?:\((\w+)\))?)?/g;
    for (const fspec of fields) {
      if (fspec === 'sequence') {
        continue;
      }
      if (fspec === '__count') {
        // the web client sometimes adds this pseudo-field in the list
        continue;
      }
      // const matches = regexFieldAgg.exec(fspec);
      const [matches] = fspec.matchAll(regexFieldAgg);
      if (!matches) {
        throw new UserError(await this._t("Invalid field specification %s.", fspec));
      }
      let [match, name, func, fname] = matches;
      if (func) {
        // we have either 'name:func' or 'name:func(fname)'
        fname = fname ?? name;
        const field = this._fields[fname];
        if (!field) {
          throw new ValueError("Invalid field %s on model %s", fname, this.cls._name);
        }
        if (!(field.baseField.store && field.baseField.columnType)) {
          throw new UserError(await this._t("Cannot aggregate field %s.", fname));
        }
        if (!VALID_AGGREGATE_FUNCTIONS.includes(func)) {
          throw new UserError(await this._t("Invalid aggregation function %s.", func));
        }
      }
      else {
        // we have 'label', retrieve the aggregator on the field
        const field = this._fields[name];
        if (!field) {
          throw new ValueError("Invalid field %s on model %s", name, this.cls._name);
        }
        if (!(field.baseField.store && field.baseField.columnType && field.groupOperator)) {
          continue;
        }
        [func, fname] = [field.groupOperator, name];
      }
      fnames.push(fname);

      if (groupbyFields.includes(fname)) {
        continue;
      }
      if (aggregatedFields.includes(name)) {
        throw new UserError(await this._t("Output name %s is used twice.", name));
      }
      aggregatedFields.push(name);

      const expr = await this._inheritsJoinCalc(this.cls._table, fname, query);
      let term;
      if (func.toLowerCase() === 'count_distinct') {
        term = `COUNT(DISTINCT ${expr})::int AS "${name}}"`;
      }
      else {
        term = `${func}(${expr}) AS "${name}"`;
      }
      selectTerms.push(term);
    }
    for (const gb of annotatedGroupbys) {
      selectTerms.push(`${gb['qualifiedField']} as "${gb['groupby']}" `);
    }
    await this._flushSearch(domain, { fields: fnames.concat(groupbyFields) });

    const [groupbyTerms, orderbyTerms] = await this._readGroupPrepare(order, aggregatedFields, annotatedGroupbys, query);
    const [fromClause, whereClause, whereClauseParams] = query.getSql();
    let countField;
    if (options.lazy && (len(groupbyFields) >= 2 || !this._context['groupbyNoLeaf'])) {
      countField = len(groupbyFields) >= 1 ? groupbyFields[0] : '_';
    }
    else {
      countField = '_';
    }
    countField += '_count';

    const prefixTerms = (prefix, terms) => terms.length ? (prefix + " " + terms.join(",")) : '';
    const prefixTerm = (prefix, term) => term ? `${prefix} ${term}` : '';

    query = _f(`
        SELECT min("{table}".id) AS id, COUNT("{table}".id)::int AS "{countField}" {extraFields}
        FROM {from}
        {where}
        {groupby}
        {orderby}
        {limit}
        {offset}
    `, {
      'table': this.cls._table,
      'countField': countField,
      'extraFields': prefixTerms(',', selectTerms),
      'from': fromClause,
      'where': prefixTerm('WHERE', whereClause),
      'groupby': prefixTerms('GROUP BY', groupbyTerms),
      'orderby': prefixTerms('ORDER BY', orderbyTerms),
      'limit': prefixTerm('LIMIT', options.limit ? tools.parseInt(options.limit) : null),
      'offset': prefixTerm('OFFSET', options.offset ? tools.parseInt(options.offset) : null),
    });
    query = tools._convert$(query);
    const fetchedData = await this._cr.execute(query, { bind: whereClauseParams });
    if (!len(groupbyFields)) {
      return fetchedData;
    }

    await this._readGroupResolveMany2xFields(fetchedData, annotatedGroupbys);

    let data = []
    for (const r of fetchedData) {
      const vals = {};
      for (const [k, v] of Object.entries(r)) {
        vals[k] = await this._readGroupPrepareData(k, v, groupbyDict);
      }
      data.push(vals);
    }

    let fillTemporal = this.env.context['fillTemporal'];
    if ((bool(data) && fillTemporal) || isInstance(fillTemporal, Object)) {
      // fillTemporal = {} is equivalent to fillTemporal = true
      // if fillTemporal is a dictionary and there is no data, there is a chance that we
      // want to display empty columns anyway, so we should apply the fillTemporal logic
      if (!isInstance(fillTemporal, Object)) {
        fillTemporal = {}
      }
      data = await this._readGroupFillTemporal(data, groupby, aggregatedFields, annotatedGroupbys, fillTemporal);
    }
    let result = [];
    for (const d of data) {
      result.push(await this._readGroupFormatResult(d, annotatedGroupbys, groupby, domain));
    }

    if (options.lazy) {
      // Right now, readGroup only fill results in lazy mode (by default).
      // If you need to have the empty groups in 'eager' mode, then the
      // method _readGroupFillResults need to be completely reimplemented
      // in a sane way
      result = await this._readGroupFillResults(
        domain, groupbyFields[0], groupby.slice(len(annotatedGroupbys)),
        aggregatedFields, countField, result, order,
      )
    }
    return result;
  }

  /**
   * defaultGet(fieldsList) -> defaultValues

    Return default values for the fields in ``fieldsList``. Default
    values are determined by the context, user defaults, and the model
    itself.

    @param fieldsList names of field whose default is requested
    @returns a dictionary mapping field names to their corresponding default values,
        if they have a default value.

      .. note::

        Unrequested defaults won't be considered, there is no need to return a
        value for fields whose names are not in `fieldsList`.
   * @param fieldsList 
   */
  @api.model()
  async defaultGet(fieldsList: any[]): Promise<Dict<any>> {
    // trigger view init hook
    await this.viewInit(fieldsList);

    const defaults = new Dict<any>();
    const parentFields = new Dict<any>();
    const irDefaults = await this.env.items('ir.default').getModelDefaults(this.cls._name);
    let field: Field;
    for (const name of fieldsList) {
      // 1. look up context
      const key = 'default_' + name;
      if (key in this._context) {
        defaults[name] = this._context[key];
        continue;
      }

      // 2. look up ir.default
      if (name in irDefaults) {
        defaults[name] = irDefaults[name];
        continue;
      }

      field = this._fields.get(name);

      // 3. look up field.default
      if (field && field.default) {
        defaults[name] = await field.default.call(field, this);
        continue;
      }

      // 4. delegate to parent model
      if (field && field.inherited) {
        field = field.relatedField;
        parentFields[field.modelName] = parentFields[field.modelName] || [];
        parentFields[field.modelName].push(field.name);
      }
    }
    // convert default values to the right format
    // 
    // we explicitly avoid using _convertToWrite() for x2many fields,
    // because the latter leaves values like [[Command.LINK, 2],
    // [Command.LINK, 3]], which are not supported by the web client as
    // default values; stepping through the cache allows to normalize
    // such a list to [[Command.SET, 0, [2, 3]]], which is properly
    // supported by the web client
    for (const [fname, value] of defaults.items()) {
      if (fname in this._fields) {
        field = this._fields[fname];
        const _value = await field.convertToCache(value, this, false);
        defaults[fname] = await field.convertToWrite(_value, this);
      }
    }

    // add default values for inherited fields
    for (const [model, names] of parentFields.items()) {
      defaults.updateFrom(await this.env.items(model).defaultGet(names));
    }

    return defaults;
  }

  /**
   * fieldsGet([fields][, attributes])

    Return the definition of each field.

    The returned value is a dictionary (indexed by field name) of
    dictionaries. The _inherits'd fields are included. The string, help,
    and selection (if present) attributes are translated.

    @param allfields list of fields to document, all if empty or not provided
    @param attributes list of description attributes to return for each field, all if empty or not provided
   */
  @api.model()
  async fieldsGet(allfields?: any, attributes?: any): Promise<{}> {
    if (allfields && !Array.isArray(allfields)) {
      allfields = Object.keys(allfields);
    }
    if (attributes && !Array.isArray(attributes)) {
      attributes = Object.keys(attributes);
    }
    const readonly = !(await this.checkAccessRights('write', false) || await this.checkAccessRights('create', false))

    const res = {};
    for (const [fname, field] of this._fields.items()) {
      if (bool(allfields) && !allfields.includes(fname)) {
        continue;
      }
      if (field.groups && !this.env.su && !await this.userHasGroups(field.groups)) {
        continue;
      }

      let description = await field.getDescription(this.env);
      description['name'] = fname;
      if (readonly) {
        description['readonly'] = true;
        description['states'] = {};
      }
      if (bool(attributes)) {
        description = Object.fromEntries(Object.entries(description).filter(([key, val]) => attributes.includes(key)));
      }
      res[fname] = description;
    }
    return res;
  }

  @api.model()
  async _fieldsViewGet(viewId, viewType = 'form', toolbar = false, submenu = false): Promise<{}> {
    const View = await this.env.items('ir.ui.view').sudo();
    const result = {
      'model': this._name,
      'fieldParent': false,
    };

    // try to find a viewId if none provided
    if (!viewId) {
      // <viewType>ViewRef in context can be used to override the default view
      const viewRefKey = viewType + 'ViewRef';
      let viewRef = this._context[viewRefKey];
      if (viewRef) {
        if (viewRef.includes('.')) {
          let modul;
          [modul, viewRef] = viewRef.split('.', 1)
          const query = `SELECT "resId" FROM "irModelData" WHERE model='ir.ui.view' AND module='%s' AND label='%s'`
          const res = await this._cr.execute(query, [modul, viewRef]);
          const viewRefRes = res && res[0];
          if (viewRefRes) {
            viewId = viewRefRes['resId'];
          }
        }
        else {
          console.warn('%s requires a fully-qualified external id (got: %s for model %s). \nPlease use the complete `module.viewId` form instead.', viewRefKey, viewRef, this._name);
        }
      }
      if (!viewId) {
        // otherwise try to find the lowest priority matching ir.ui.view
        viewId = await View.defaultView(this._name, viewType);
      }
    }
    if (viewId) {
      // read the view with inherited views applied
      const view = View.browse(viewId);
      const [dom, arch] = await view.getCombinedArch();
      result['dom'] = dom;
      result['arch'] = arch;
      result['label'] = await view.label;
      result['type'] = await view.type;
      result['viewId'] = view.id;
      result['fieldParent'] = await view.fieldParent;
      result['baseModel'] = await view.model;
    }
    else {
      // fallback on default views methods if no ir.ui.view could be found
      try {
        const func = this[`_getDefault${capitalize(viewType)}View`];
        const dom = await func.apply(this);
        result['dom'] = dom;
        result['arch'] = serializeXml(dom);
        result['type'] = viewType;
        result['label'] = 'default';
      } catch (e) {
        throw new UserError(await this._t("No default view of type '%s' could be found !", viewType));
      }
    }
    return result;
  }

  /**
   * fieldsViewGet([viewId | viewType='form'])

    Get the detailed composition of the requested view like fields, model, view architecture

    @param viewId id of the view or None
    @param viewType type of the view to return if viewId is None ('form', 'tree', ...)
    @param toolbar true to include contextual actions
    @param submenu deprecated
    @returns composition of the requested view (including inherited views and extensions)
    @throws AttributeError
            * if the inherited view has unknown position to work with other than 'before', 'after', 'inside', 'replace'
            * if some tag other than 'position' is found in parent view
    @throws InvalidArchitectureError if there is view type other than form, tree, calendar, search etc defined on the structure
   */
  @api.model()
  async fieldsViewGet(viewId?: number, viewType = 'form', toolbar = false, submenu = false): Promise<{}> {
    await this.checkAccessRights('read');
    let view = (await this.env.items('ir.ui.view').sudo()).browse(viewId);

    // Get the view arch and all other attributes describing the composition of the view
    const result = await this._fieldsViewGet(viewId, viewType, toolbar, submenu);

    // Override context for postprocessing
    if (viewId && (result['baseModel'] || this._name) !== this._name) {
      view = await view.withContext({ baseModelName: result['baseModel'] });
    }

    // Apply post processing, groups and modifiers etc...
    const [dom, xarch, xfields] = await view.postprocessAndFields(result['dom'], this._name);
    result['dom'] = dom;
    result['arch'] = xarch;
    result['fields'] = xfields;

    // Add related action information if asked
    if (toolbar) {
      const vt = viewType === 'tree' ? 'list' : viewType;
      const bindings = await this.env.items('ir.actions.actions').getBindings(this._name);
      const resReport = bindings['report']?.filter(action => (action['bindingViewTypes'] || vt).split(',').includes(vt));
      const resAction = bindings['action']?.filter(action => (action['bindingViewTypes'] || vt).split(',').includes(vt));

      result['toolbar'] = {
        'print': resReport,
        'action': resAction,
      }
    }
    return result;
  }

  async _loadRecordsWrite(values) {
    await this.write(values);
  }

  async _loadRecordsCreate(values) {
    return this.create(values);
  }


  /**
   * Create or update records of this model, and assign XMLIDs.
    @param dataList list of dicts with keys `xmlid` (XMLID to
        assign), `noupdate` (flag on XMLID), `values` (field values)
    @param update should be ``true`` when upgrading a module
    @returns the records corresponding to ``dataList``
   */
  async _loadRecords(dataList, update = false) {
    const originalSelf = this.browse();
    const self = await this.withContext({ installMode: true });
    const imd = await self.env.items('ir.model.data').sudo();

    const xmlids = dataList.filter(data => data['xmlid']).map(data => data['xmlid']);
    const existing = {};
    for (const row of await imd._lookupXmlids(xmlids, self)) {
      existing[`${row['module']}.${row['label']}`] = row;
    }
    const toCreate = [];
    const toUpdate = [];
    const imdDataList = [];

    for (const data of dataList) {
      const xmlid = data['xmlid'];
      if (!xmlid) {
        const vals = data['values'];
        if (vals['id']) {
          data['record'] = self.browse(vals['id']);
          toUpdate.push(data);
        }
        else if (!update) {
          toCreate.push(data);
        }
        continue;
      }
      const row = existing[xmlid];
      if (!row) {
        toCreate.push(data);
        continue;
      }
      // const [dId, dModule, dLabel, dModel, dResId, dNoupdate, rId] = Object.values(row);
      // const d = row;
      if (self.cls._name !== row.model) {
        console.warn(
          f(`For external id %s 
            when trying to create/update a record of model %s 
            found record of different model %s (%s)
            \nUpdating record %s of target model %s`,
            xmlid, self.cls._name, row.model, row.id, row.id, self.cls._name)
        )
      }
      const record = self.browse(row.resId);
      if (row.resId) {
        data['record'] = record;
        imdDataList.push(data);
        if (!(update && row.noupdate)) {
          toUpdate.push(data);
        }
      }
      else {
        await imd.browse(row.id).unlink();
        toCreate.push(data);
      }
    }

    for (const data of toUpdate) {
      await data['record']._loadRecordsWrite(data['values']);
    }

    const module = self.env.context['installModule'];
    if (module) {
      const prefix = module + ".";
      for (const data of toCreate) {
        if (data['xmlid'] && !data['xmlid'].startsWith(prefix)) {
          console.warn("Creating record %s in module %s.", data['xmlid'], module);
        }
      }
    }

    const records = await self._loadRecordsCreate(toCreate.map(data => data['values']));
    const list = records ? zip(toCreate, [...records]) : [];
    for (const [data, record] of list) {
      data['record'] = record;
      if (data['xmlid']) {
        // add XML ids for parent records that have just been created
        for (const [parentModel, parentField] of Object.entries<string>(self.cls._inherits)) {
          if (!data['values'][parentField]) {
            imdDataList.push({
              'xmlid': `${data['xmlid']}_${_.camelCase(parentModel.replace('.', '_'))}`,
              'record': await record[parentField],
              'noupdate': data['noupdate'] ?? false,
            });
          }
        }
        imdDataList.push(data);
      }
    }

    await imd._updateXmlids(imdDataList, update);

    return originalSelf.concat(dataList.map(data => data['record']));
  }

  /**
   * Generates record dicts from the data sequence.
    The result is a generator of dicts mapping field names to raw
    (unconverted, unvalidated) values.

    For relational fields, if sub-fields were provided the value will be
    a list of sub-records

    The following sub-fields may be set on the record (by key):
    * None is the nameGet for the record (to use with nameCreate/nameSearch)
    * "id" is the External ID for the record
    * ".id" is the Database ID for the record
   * @param fields 
   * @param data 
   * @param options 
   */
  async *_extractRecords(fields: any[], data: any[], log?: any, limit?: number) {
    let _fields = new Dict(this._fields);
    _fields = this._addFakeFields(_fields);
    const isRelational = (field) => _fields[field].relational;
    let getO2mValues: any = [];
    let getNonO2mValues: any = [];
    let index1 = 0;
    let index2 = 0;
    for (const fnames of fields) {
      if (_fields[fnames[0]].type === 'one2many') {
        getO2mValues.push(index1);
        index1 += 1;
      }
      else {
        getNonO2mValues.push(index2);
        index2 += 1;
      }
    }
    getO2mValues = itemgetter(getO2mValues);
    getNonO2mValues = itemgetter(getNonO2mValues);

    function onlyO2mValues(row) {
      return getO2mValues(row).some(e => bool(e)) && !getNonO2mValues(row).some(e => bool(e));
    }

    let index = 0;
    limit = limit ?? Number.MAX_SAFE_INTEGER;
    while (index < data.length && index < limit) {
      const row = data[index];
      const res = {};
      const list = zip(fields, row);
      for (const [fnames, value] of list) {
        res[fnames[0]] = value;
      }
      let recordSpan: any = takewhile(onlyO2mValues, islice(data, index + 1));
      recordSpan = Array.from(chain([row], ...recordSpan));
      const relFields = new Set();
      for (const fnames of fields) {
        const relField = fnames[0];
        if (isRelational(relField)) {
          if (relFields.has(relField)) {
            continue;
          }
          relFields.add(relField);
          const comodel = this.env.items(_fields[relField].comodelName);
          const enumFields = [];
          for (const [index, fnames] of enumerate(fields)) {
            if (fnames[0] === relField) {
              enumFields.push([index, fnames.slice(1) ?? [null]]);
            }
          }
          const [indices, subFields] = zip(...enumFields);
          const relFieldData = [];
          const list = map(recordSpan, items => itemgetter(indices)(items));

          for (const it of list) {
            if (it.some(e => bool(e))) {
              relFieldData.push(it);
            }
          }
          res[relField] = [];
          for await (const [subrecord] of comodel._extractRecords(subFields, relFieldData, log)) {
            res[relField].push(subrecord);
          }
        }
      }
      yield [res, {
        'rows': {
          'from': index,
          'to': index + recordSpan.length - 1,
        }
      }];
      index += recordSpan.length;
    }
  }

  /**
   * Converts records from the source iterable (recursive dicts of
    strings) into forms which can be written to the database (via
    this.create or (ir.model.data)._update)
 
    @returns a list of triplets of (id, xid, record)
    @type [[number|null, string|null, Dict]]
   */
  @api.model()
  async *_convertRecords(records, log: Function = (x) => null) {
    const fieldNames = new Dict();
    for (const [name, field] of Object.entries(this._fields)) {
      fieldNames[name] = field.string;
    }
    if (await this.env.lang) {
      fieldNames.updateFrom(await this.env.items('ir.translation').getFieldString(this.cls._name));
    }

    const convert = await this.env.items('ir.fields.converter').forModel(this);

    function _log(base, record, field, exception) {
      const type = isInstance(exception, Error) ? 'error' : 'warning';
      // logs the logical (not human-readable) field name for automated
      // processing of response, but injects human readable in message
      const fieldName = fieldNames[field];
      const excVals = Object.assign({}, base, { record: record, field: fieldName });
      record = Object.assign({}, base, {
        type: type, record: record, field: field,
        message: f(String(exception.message), excVals)
      });
      if (len(exception.args) > 1) {
        let info = {}
        if (exception.args[1] && typeof (exception.args[1]) === 'object') {
          info = exception.args[1];
        }
        // ensure fieldName is added to the exception. Used in import to
        // concatenate multiple errors in the same block
        info['fieldName'] = fieldName;
        update(record, info);
      }
      log(record);
    }

    const stream = new CountingStream(records);
    let item = await stream.nextAsync();
    while (!item.done) {
      const [record, extras] = item.value;
      const xid = record['id'] ?? false;
      let dbid: any = false;
      if ('.id' in record) {
        try {
          dbid = parseInt(record['.id']);
        } catch (e) {
          dbid = record['.id'];
        }
        const rec = await this.search([['id', '=', dbid]]);
        if (!rec || !rec._length) {
          console.log("Unknown database identifier '%s'", dbid);
          dbid = false;
        }
      }
      const converted = await convert(record, partial(_log, extras, stream.index));

      yield [dbid, xid, converted, { ...extras, record: stream.index }];

      item = await stream.nextAsync();
    }
  }

  @api.model()
  async load(fields, data) {
    await this.flush();

    const mode = this._context['mode'] ?? 'init';
    const currentModule = this._context['module'] ?? '__import__';
    const noupdate = this._context['noupdate'] ?? false;

    const self = await this.withContext({ _importCurrentModule: currentModule });
    const cr: Cursor = self._cr;

    if (!cr.objTransaction) {
      await cr.reset();
    }
    await cr.execute('SAVEPOINT modelLoad');

    fields = fields.map((f) => fixImportExportIdPaths(f));
    const fg = await self.fieldsGet();
    const messages = [];

    const returnList = [];
    let batch = [];
    let batchXmlids = new Set();
    const creatableModels = new Set([self.cls._name]);
    for (const fieldPath of fields) {
      if ([null, 'id', '.id'].includes(fieldPath[0])) {
        continue;
      }
      let modelFields = self._fields;
      if (isInstance(modelFields[fieldPath[0]], _Many2one)) {
        if (fieldPath[0] in (self.env.context['nameCreateEnabledFields'] ?? {})) {
          creatableModels.add(modelFields[fieldPath[0]].comodelName);
        }
      }
      for (const fieldName of fieldPath) {
        if ([null, 'id', '.id'].includes(fieldName)) {
          break;
        }
        if (isInstance(modelFields[fieldName], _One2many)) {
          const comodel = modelFields[fieldName].comodelName;
          creatableModels.add(comodel);
          modelFields = self.env.models[comodel]._fields;
        }
      }
    }

    async function _flush(kwargs: { xmlid?: string, model?: string } = {}) {
      if (!batch.length) {
        return;
      }
      const xmlid = kwargs.xmlid;
      const model = kwargs.model;
      assert((!(xmlid && model)), 'flush can specify *either* an external id or a model, not both');
      if (xmlid && !batchXmlids.has(xmlid)) {
        if (self.env.models[xmlid]) {
          return;
        }
      }
      if (model && !creatableModels.has(model)) {
        return;
      }

      const dataList = [];
      for (const [xid, vals, info] of batch) {
        dataList.push({ xmlid: xid, values: vals, info: info, noupdate: noupdate });
      }
      batch = [];
      batchXmlids = new Set();
      // For debug
      // await cr.commit();
      // await cr.reset();
      // For debug
      // try to create in batch
      try {
        await cr.savepoint(true, async () => {
          const recs = await self._loadRecords(dataList, mode == 'update');
          extend(returnList, dataList.map(data => { return { xmlid: data['xmlid'], id: data['record'].id } }));
        });
        return;
      } catch (e) {
        if (e['name'] !== 'SequelizeDatabaseError') {
          // broken transaction, exit and hope the source error was already logged
          if (!(messages.some(message => message['type'] === 'error'))) {
            const info = dataList[0]['info'];
            messages.push({ ...info, type: 'error', message: await this._t("Unknown database error: '%s'", e) })
          }
          return;
        }
      }

      console.log('try again, this time record by record');
      let errors = 0;
      let i = 0;
      for (const data of dataList) {
        try {
          await cr.savepoint(true, async () => {
            const rec = await self._loadRecords([data], mode === 'update');
            returnList.push({ xmlid: data['xmlid'], id: data['record'].id });
          });
          i += 1;
        } catch (e) {
          // Failed to write, log to messages, rollback savepoint (to avoid broken transaction) and keep going
          errors += 1;
          console.warn('Error while loading record', data);
          console.log(e, e.sql ? '\nSQL: ' + e.sql : '');
        }
        if (errors >= 10 && (errors >= i / 10)) {
          messages.push({
            'type': 'warning',
            'message': await this._t("Found more than 10 errors and more than one error per 10 records, interrupted to avoid showing too many errors.")
          })
          break;
        }
      }
      return;
    }

    const flushSelf = await self.withContext({ importFlush: _flush, importCache: new LRU(1024) });

    // TODO: break load's API instead of smuggling via context?
    let limit = self._context['_importLimit'];
    if (limit == null) {
      limit = Number.MAX_SAFE_INTEGER;
    }
    const extracted = flushSelf._extractRecords(fields, data, messages.push.bind(messages), limit);
    const converted = flushSelf._convertRecords(extracted, messages.push.bind(messages));

    const info = { 'rows': { 'to': -1 } };
    for await (let [id, xid, record, info] of converted) {
      if (self.env.context['importFile'] && self.env.context['importSkipRecords']) {
        if ((self.env.context['importSkipRecords'] || []).some(field => record.get(field) == null)) {
          continue;
        }
      }
      if (xid) {
        xid = xid.includes('.') ? xid : `${currentModule}.${xid}`;
        batchXmlids.add(xid);
      }
      else if (id) {
        record['id'] = id;
      }
      batch.push([xid, record, info]);
    }

    await _flush();

    if (messages.some(message => message['type'] === 'error')) {
      await cr.execute('ROLLBACK TO SAVEPOINT modelLoad');
      returnList.length = 0;
      // cancel all changes done to the registry/ormcache
      await self.pool.resetChanges();
    }

    let nextrow = info['rows']['to'] + 1;
    if (nextrow < limit) {
      nextrow = 0;
    }
    return {
      'idref': returnList,
      'messages': messages,
      'nextrow': nextrow,
    }
  }

  @api.returns('self')
  async exists() {
    const [newIds, ids] = partition((i) => isInstance(i, NewId), this._ids);
    if (!bool(ids)) {
      return this;
    }
    const query = new Query(this.env.cr, this.cls._table, await this.tableQuery());
    query.addWhere(`"${this.cls._table}".id IN (${String(ids) || 'NULL'})`);
    const [queryStr, params] = query.select();
    const res = await this.env.cr.execute(queryStr, params);
    const validIds = [...res.map(r => r['id']), ...newIds];
    return this.browse(this._ids.filter(i => validIds.includes(i)));
  }

  /**
   * Verifies that there is no loop in a hierarchical structure of records,
    by following the parent relationship using the **parent** field until a
    loop is detected or until a top-level record is found.

    @param parent optional parent field name (default: ``this._parentName``)
    @returns **true** if no loop was found, **false** otherwise.
   */
  async _checkRecursion(parent) {
    if (!parent) {
      parent = this.cls._parentName;
    }

    // must ignore 'active' flag, ir.rules, etc. => direct SQL query
    const cr = this._cr;
    await this.flush([parent]);
    const query = f('SELECT "%s" AS id FROM "%s" WHERE id = $1', parent, this.cls._table);
    for (const id of this.ids) {
      let currentId = id;
      while (bool(currentId)) {
        const res = await cr.execute(query, { bind: [currentId] });
        currentId = res[0] ? res[0]['id'] : null;
        if (currentId == id) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Generates a default single-line form view using all fields
      of the current model.

      @returns a form view as an lxml document
   */
  @api.model()
  _getDefaultFormView() {
    const group = E.group({ col: "4" });
    for (const [fname, field] of this._fields.entries()) {
      if (field.automatic) {
        continue;
      }
      else if (['one2many', 'many2many', 'text', 'html'].includes(field.type)) {
        group.appendChild(E.newline());
        group.appendChild(E.field({ name: fname, colspan: "4" }));
        group.appendChild(E.newline());
      }
      else {
        group.appendChild(E.field({ name: fname }));
      }
    }
    group.appendChild(E.separator());
    return E.form([E.sheet([group], { string: this.cls._description })])
  }

  /**
   * Generates a single-field search view, based on _recName.
 
    @returns a tree view as an lxml document
   */
  @api.model()
  _getDefaultSearchView() {
    const element = E.field({ name: this._recNameFallback() });
    return E.search([element], { string: this.cls._description });
  }

  /**
   * Generates a single-field tree view, based on _recName.
 
    @returns a tree view as an lxml document
   */
  @api.model()
  _getDefaultTreeView() {
    const element = E.field({ name: this._recNameFallback() });
    return E.tree([element], { string: this.cls._description });
  }

  /**
   * Generates an empty pivot view.
 
    @returns a pivot view as an lxml document
   */
  @api.model()
  _getDefaultPivotView() {
    return E.pivot({ string: this.cls._description });
  }

  /**
   * Generates a single-field kanban view, based on _recName.
 
    @returns a kanban view as an lxml document
   */
  @api.model()
  _getDefaultKanbanView() {
    const field = E.field({ name: this._recNameFallback() });
    const contentDiv = E.div([field], { 'class': "o-kanban-card-content" });
    const cardDiv = E.div([contentDiv], { 't-attf-class': "oe-kanban-card oe-kanban-global-click" });
    const kanbanBox = E.withType('t', [cardDiv], { 't-name': "kanban-box" });
    const templates = E.withType('templates', [kanbanBox]);
    return E.kanban([templates], { string: this.cls._description });
  }

  /**
   * Generates a single-field graph view, based on _recName.
 
    @returns a graph view as an lxml document
   */
  @api.model()
  _getDefaultGraphView() {
    const element = E.field({ name: this._recNameFallback() });
    return E.graph([element], { string: this.cls._description });
  }

  /**
   * Generates a default calendar view by trying to infer
      calendar fields from a number of pre-set attribute names
 
    @returns a calendar view
   */
  @api.model()
  async _getDefaultCalendarView() {
    /**
     * Sets the first value of ``seq`` also found in ``fields`` to
      the ``to`` attribute of the ``view`` being closed over.
 
      Returns whether it's found a suitable value (and set it on
      the attribute) or not
     * @param seq 
     * @param fields 
     * @param to 
     * @returns 
     */
    function setFirstOf(seq, fields, to) {
      for (const item of seq) {
        if (item in fields) {
          view.setAttribute(to, item);
          return true;
        }
      }
      return false;
    }

    const view = E.calendar({ string: this.cls._description });
    view.appendChild(E.field({ name: this._recNameFallback() }));

    if (!setFirstOf([this.cls._dateName, 'date', 'dateStart', 'xDate', 'xDateStart'], this._fields, 'dateStart')) {
      throw new UserError(await this._t("Insufficient fields for Calendar View!"));
    }

    setFirstOf(["userId", "partnerId", "xUserId", "xPartnerId"], this._fields, 'color');

    if (!setFirstOf(["dateStop", "dateEnd", "xDateStop", "xDateEnd"], this._fields, 'dateStop')) {
      if (!setFirstOf(["dateDelay", "plannedHours", "xDateDelay", "xPlannedHours"], this._fields, 'dateDelay')) {
        throw new UserError(await this._t("Insufficient fields to generate a Calendar View for %s, missing a dateStop or a dateDelay", this._name))
      }
    }
    return view;
  }

  /**
   * Return an view id to open the document ``this`` with. This method is meant to be overridden in addons that want to give specific view ids for example.

    Optional accessUid holds the user that would access the form view id different from the current environment user.
   * @param accessUid 
   * @returns 
   */
  async getFormviewId(accessUid) {
    return false;
  }

  /**
   * Return an action to open the document ``this``. This method is meant to be overridden in addons that want to give specific view ids for example.
 
    An optional accessUid holds the user that will access the document that could be different from the current user. 
   * @param accessUid 
   * @returns 
   */
  async getFormviewAction(accessUid) {
    const viewId = await (await this.sudo()).getFormviewId(accessUid);
    return {
      'type': 'ir.actions.actwindow',
      'resModel': this._name,
      'viewType': 'form',
      'viewMode': 'form',
      'views': [[viewId, 'form']],
      'target': 'current',
      'resId': this.id,
      'context': new Dict(this._context),
    }
  }

  /**
   * Return an action to open the document. This method is meant to be
    overridden in addons that want to give specific access to the document. By default it opens the formview of the document.
 
    An optional access_uid holds the user that will access the document that could be different from the current user.
   * @param accessUid 
   * @returns 
   */
  async getAccessAction(accessUid) {
    return this(0).getFormviewAction(accessUid);
  }

  /**
   * Flush writing to the database
   * @param fnames 
   * @param records 
   * @returns 
   */
  @api.model()
  async flush(fnames?: string[], records?: any): Promise<void> {
    async function _process(model, idVals) {
      const updates = new Map();
      for (const [rid, vals] of idVals.items()) {
        let key = updates.get(vals);
        if (!key) {
          key = [];
          updates.set(vals, key);
        }
        key.push(parseInt(rid));
      }
      for (const [vals, ids] of updates) {
        const recs = model.browse(ids);
        try {
          await recs._write(vals);
        } catch (e) {
          if (isInstance(e, MissingError)) {
            await (await recs.exists())._write(vals);
          }
          else {
            throw e;
          }
        }
      }
    }

    let modelName, idVals;
    if (!bool(fnames)) {
      await this.recompute();
      while (this.env.all.towrite.length) {
        [modelName, idVals] = this.env.all.towrite.popitem();
        await _process(this.env.items(modelName), idVals);
      }
    } else {
      await this.recompute(fnames, records);

      if (records != null) {
        fnames = Array.from(fnames);
        const towrite = this.env.all.towrite[this.cls._name];
        if (!len(towrite)) {
          return;
        }
        let all = true;
        for (const record of records) {
          if (intersection(fnames, Object.keys(towrite[record.id] ?? {})).length) {
            all = false;
            break;
          }
        }
        if (all) {
          return;
        }
      }

      const modelFields = new Dict<Field[]>();
      for (const fname of fnames) {
        const field = this.cls._fields[fname];
        modelFields.setdefault(field.modelName, []);
        modelFields[field.modelName].push(field);
        if (field.relatedField) {
          modelFields.setdefault(field.relatedField.modelName, []);
          modelFields[field.relatedField.modelName].push(field.relatedField);
        }
      }
      const towrite = this.env.all.towrite;
      for (const [modelName, fields] of modelFields.items()) {
        let found;
        for (const vals of Object.values<any>(towrite[modelName] ?? {})) {
          found = fields.some(field => field.name in vals);
          if (found) {
            break;
          }
        }
        if (found) {
          idVals = towrite.pop(modelName);
          await _process(this.env.items(modelName), idVals);
        }
      }
      // missing for one2many fields, flush their inverse
      for (const fname of fnames) {
        const field = this.cls._fields[fname];
        if (field.type === 'one2many' && field.relationField) {
          await this.env.items(field.comodelName).flush([field.relationField]);
        }
      }
    }
  }

  /**
   * Initialize the value of the given column for existing rows. 
   * @param columnName 
   */
  async _initColumn(columnName: string): Promise<void> {
    const cls = this.cls;
    const field = cls._fields[columnName];

    let value;
    // get the default value; ideally, we should use defaultGet(), but it
    // fails due to ir.default not being ready
    if (field.default) {
      if (isCallable(field.default)) {
        value = await field.default.call(field, this);
      } else {
        value = field.default;
      }
      value = await field.convertToWrite(value, this);
      value = await field.convertToColumn(value, this);
    } else {
      value = null;
    }
    // Write value if non-NULL, except for booleans for which false means
    // the same as NULL - this saves us an expensive query on large tables.
    const necessary = field.type !== 'boolean' ? value != null : value;
    if (necessary) {
      const cr = this._cr;
      try {
        const sql = `UPDATE "${cls._table}" SET "${columnName}"=$1 WHERE "${columnName}" IS NULL`;
        await cr.query(sql, { bind: [value] });
        // for debug
        // if (columnName == 'useOpportunities') {
        //   await cr.commit();
        //   await cr.reset();
        // }
        // for debug
      } catch (e) {
        throw e;
      }
    }
  }

  /**
   * Returns the filename of the placeholder to use,
      set on web/static/img by default, or the
      complete path to access it (eg: module/path/to/image.png).

      If a falsy value is returned, "ir.http"._placeholder() will use
      the default placeholder 'web/static/img/placeholder.png'.
   * @param field 
   * @returns 
   */
  async _getPlaceholderFilename(field: Field): Promise<boolean> {
    return false;
  }

  /**
   * Perform an onchange on the given field.
    @param values dictionary mapping field names to values, giving the
        current state of modification
    @param fieldName name of the modified field, or list of field
        names (in view order), or false
    @param fieldOnchange dictionary mapping field names to their
        onchange attribute

    When ``fieldName`` is falsy, the method first adds default values
    to ``values``, computes the remaining fields, applies onchange
    methods to them, and return all the fields in ``fieldOnchange``.
   */
  async onchange(values, fieldName, fieldOnchange) {
    // this is for tests using `Form`
    await this.flush();

    const env: Environment = this.env;
    let names: string[];
    if (Array.isArray(fieldName)) {
      names = fieldName;
    }
    else if (fieldName) {
      names = [fieldName];
    }
    else {
      names = [];
    }

    const firstCall = names.length == 0;

    if (names.some(name => !(name in this._fields))) {
      return new Dict<any>();
    }

    /**
     * Return a prefix tree for sequences of field names.
     * @param model 
     * @param dotnames 
     * @returns 
     */
    async function prefixTree(model, dotnames: string[]) { // must check tree: invoiceLineIds, lineIds
      if (!bool(dotnames)) {
        return new Dict<any>();
      }
      // group dotnames by prefix
      const suffixes = new Dict<any>();
      for (const dotname of dotnames) {
        const names = tools.split(dotname, '.', 1);
        const name = names.shift();
        suffixes[name] = suffixes[name] ?? [];
        extend(suffixes[name], names);
      }
      // fill in prefix tree in fields order
      const tree = new OrderedDict<any>();
      for (const [name, field] of Object.entries<Field>(model._fields)) {
        if (name in suffixes) {
          tree[name] = await prefixTree(await model[name], suffixes[name]);
          let subtree = tree[name];
          if (bool(subtree) && field.type === 'one2many') {
            pop(subtree, field.relationField, null);
          }
        }
      }
      return tree;
    }

    /**
     * A dict with the values of a record, following a prefix tree.
     */
    class Snapshot extends Dict<any> {
      private constructor(record, tree) {
        // put record in dict to include it when comparing snapshots
        super({ '<record>': record, '<tree>': tree });
      }

      static async new(record, tree, fetch = true) {
        // put record in dict to include it when comparing snapshots
        const obj = new Snapshot(record, tree);
        if (fetch) {
          for (const name of Object.keys(tree)) {
            await obj.fetch(name);
          }
        }
        return obj;
      }

      /**
       * Set the value of field ``name`` from the record's value.
       * @param name 
       */
      async fetch(name) {
        const record = this['<record>'];
        const tree = this['<tree>'];
        const value = await record[name];
        if (['one2many', 'many2many'].includes(record._fields[name].type)) {
          // x2many fields are serialized as a list of line snapshots
          this[name] = [];
          for (const line of value) {
            this[name].push(await Snapshot.new(line, tree[name]));
          }
        }
        else {
          this[name] = value;
        }
      }

      /**
       * Return whether a field on record has changed.
       * @param name 
       * @returns 
       */
      async hasChanged(name) {
        if (!(name in this)) {
          return true;
        }
        const record = this['<record>'];
        if (!['one2many', 'many2many'].includes(record._fields[name].type)) {
          return !equal(this[name], await record[name]);
        }
        if (len(this[name]) != len(await record[name]) || difference(this[name].map(lineSnapshot => lineSnapshot["<record>"].id), await record[name]._ids).length) {
          return true;
        }
        const subnames = this['<tree>'][name];
        for (const subname of subnames) {
          for (const lineSnapshot of this[name]) {
            if (await lineSnapshot.hasChanged(subname)) {
              return true;
            }
          }
        }
        return false;
      }

      /**
       * Return the values in ``this`` that differ from ``other``.
            Requires record cache invalidation for correct output!
        * @param other 
        * @param force 
        */
      async diff(other, force = false) {
        const record = this['<record>'];
        const result = new Dict();
        for (const [name, subnames] of Object.entries(this['<tree>'])) {
          if (name === 'id') {
            continue;
          }
          const thisValue = this[name];
          const otherValue = other[name];
          if (!force) {
            if (isInstance(thisValue, BaseModel)) {
              if (thisValue.eq(otherValue)) {
                continue;
              }
            } else if (equal(thisValue, otherValue)) {
              continue;
            }
          }
          const field = record._fields[name];
          if (!['one2many', 'many2many'].includes(field.type)) {
            result[name] = await field.convertToOnchange(thisValue, record, {});
          }
          else {
            let commands;
            // x2many fields: serialize value as commands
            commands = result[name] = [Command.clear()];
            // The purpose of the following line is to enable the prefetching.
            // In the loop below, line._prefetchIds actually depends on the
            // value of record[name] in cache (see prefetchIds on x2many
            // fields).  But the cache has been invalidated before calling
            // diff(), therefore evaluating line._prefetch_ids with an empty
            // cache simply returns nothing, which discards the prefetching
            // optimization!
            record._cache.set(name, thisValue.map(lineSnapshot => lineSnapshot['<record>'].id));
            for (const lineSnapshot of thisValue) {
              let line = lineSnapshot['<record>'];
              line = bool(line._origin) ? line._origin : line;
              let lineDiff;
              if (!bool(line.id)) {
                // new line: send diff from scratch
                lineDiff = await lineSnapshot.diff({});
                commands.push([Command.CREATE, line.id.ref || 0, lineDiff]);
              }
              else {
                // existing line: check diff from database
                // (requires a clean record cache!)
                lineDiff = await lineSnapshot.diff(await Snapshot.new(line, subnames));
                if (bool(lineDiff)) {
                  // send all fields because the web client
                  // might need them to evaluate modifiers
                  lineDiff = await lineSnapshot.diff({});
                  commands.push(Command.update(line.id, lineDiff));
                }
                else {
                  commands.push(Command.link(line.id));
                }
              }
            }
          }
        }
        return result;
      }
    }
    const nametree = await prefixTree(this.browse(), Object.keys(fieldOnchange));

    if (firstCall) {
      names = Object.keys(values).filter(name => name !== 'id');
      const missingNames = Object.keys(nametree).filter(name => !(name in values));
      const defaults = await this.defaultGet(missingNames);
      for (const name of missingNames) {
        values[name] = defaults.get(name, false);
        if (name in defaults) {
          names.push(name);
        }
      }
    }
    // prefetch x2many lines: this speeds up the initial snapshot by avoiding
    // to compute fields on new records as much as possible, as that can be
    // costly and is not necessary at all
    for (const [name, subnames] of Object.entries(nametree)) {
      if (bool(subnames) && bool(values[name])) {
        // retrieve all line ids in commands
        const lineIds = new Set();
        for (const cmd of values[name]) {
          if ([Command.UPDATE, Command.LINK].includes(cmd[0])) {
            lineIds.add(cmd[1]);
          }
          else if (cmd[0] == Command.SET) {
            for (const id of cmd[2]) {
              if (!lineIds.has(id)) {
                lineIds.add(id);
              }
            }
          }
        }
        // prefetch stored fields on lines
        const lines = (await this[name]).browse(lineIds);
        const fnames = subnames.keys().filter(subname => lines._fields[subname].baseField.store);
        await lines._read(fnames);
        // copy the cache of lines to their corresponding new records;
        // this avoids computing computed stored fields on new_lines
        const newLines = lines.browse(Array.from<any>(lineIds).map(id => new NewId(id)));
        const cache = this.env.cache;
        for (const fname of fnames) {
          const field = lines._fields[fname];
          cache.update(newLines, field, await Promise.all(zip(cache.getValues(lines, field), [...newLines]).map(([value, newLine]) => field.convertToCache(value, newLine, false))));
        }
      }
    }

    // Isolate changed values, to handle inconsistent data sent from the
    // client side: when a form view contains two one2many fields that
    // overlap, the lines that appear in both fields may be sent with
    // different data. Consider, for instance:
    //
    //   fooIds: [line with value=1, ...]
    //   barIds: [line with value=1, ...]
    //
    // If value=2 is set on 'line' in 'barIds', the client sends
    //
    //   fooIds: [line with value=1, ...]
    //   barIds: [line with value=2, ...]
    //
    // The idea is to put 'fooIds' in cache first, so that the snapshot
    // contains value=1 for line in 'fooIds'. The snapshot is then updated
    // with the value of `barIds`, which will contain value=2 on line.
    //
    // The issue also occurs with other fields. For instance, an onchange on
    // a move line has a value for the field 'moveId' that contains the
    // values of the move, among which the one2many that contains the line
    // itself, with old values!
    //
    const changedValues = Dict.from(names.map(name => [name, values[name]]));
    // set changed values to null in initialValues; not setting them
    // triggers defaultGet() on the new record when creating snapshot0
    const initialValues = new Dict<any>(values);
    initialValues.updateFrom(Dict.fromKeys(names, false));

    // do not force delegate fields to false
    for (const parentName of Object.values<string>(this.cls._inherits)) {
      if (!initialValues.get(parentName, true)) {
        initialValues.pop(parentName);
      }
    }

    // create a new record with values
    const record = await this.new(initialValues, { origin: this });

    // make parent records match with the form values; this ensures that
    // computed fields on parent records have all their dependencies at
    // their expected value
    for (let key of Object.keys(initialValues)) {
      const field = this._fields.get(key);
      if (field && field.inherited) {
        const [parentName, name] = tools.split(field.related, '.', 1);
        await (await record[parentName])._updateCache({ [name]: await record[name] })
      }
    }

    // make a snapshot based on the initial values of record
    const snapshot0 = await Snapshot.new(record, nametree, !firstCall);

    // store changed values in cache; also trigger recomputations based on
    // subfields (e.g., line.a has been modified, line.b is computed stored
    // and depends on line.a, but line.b is not in the form view)
    await record._updateCache(changedValues, false);

    // update snapshot0 with changed values
    for (const name of names) {
      await snapshot0.fetch(name);
    }

    // Determine which field(s) should be triggered an onchange. On the first
    // call, 'names' only contains fields with a default. If 'self' is a new
    // line in a one2many field, 'names' also contains the one2many's inverse
    // field, and that field may not be in nametree.
    let todo = firstCall ? unique(chain(names, Object.keys(nametree))) : Array.from(names);
    const done = new Set<string>();

    // mark fields to do as modified to trigger recomputations
    const _protected = names.map(name => this._fields[name]);
    await this.env.protecting(_protected, record, async () => {
      await record.modified(todo);
      for (const name of todo) {
        const field = this._fields[name];
        if (field.inherited) {
          // modifying an inherited field should modify the parent
          // record accordingly; because we don't actually assign the
          // modified field on the record, the modification on the
          // parent record has to be done explicitly
          const parent = await record[field.related.split('.')[0]];
          await parent.set(name, await record[name]);
        }
      }
    });
    const result = { 'warnings': new OrderedSet2() }

    // process names in order
    while (todo.length) {
      // apply field-specific onchange methods
      for (const name of todo) {
        if (fieldOnchange[name]) {
          await record._onchangeEval(name, fieldOnchange[name], result);
        }
        done.add(name);
      }
      // determine which fields to process for the next pass
      todo = [];
      for (const name of Object.keys(nametree)) {
        if (!done.has(name) && await snapshot0.hasChanged(name)) {
          todo.push(name);
        }
      }

      if (!(env.context['recursiveOnchanges'] ?? true)) {
        todo = [];
      }
    }
    // make the snapshot with the final values of record
    const snapshot1 = await Snapshot.new(record, nametree);

    // determine values that have changed by comparing snapshots
    this.invalidateCache();
    result['value'] = await snapshot1.diff(snapshot0, firstCall);

    // format warnings
    const warnings = pop(result, 'warnings');
    let title, message, type;
    if (len(warnings) == 1) {
      [title, message, type] = warnings.pop();
      if (!type) {
        type = 'dialog';
      }
      result['warning'] = new Dict({ title: title, message: message, type: type });
    }
    else if (len(warnings) > 1) {
      // concatenate warning titles and messages
      title = await this._t("Warnings");
      message = warnings.map(([title, message, type]) => title + '\n\n' + message).join('\n\n')
      result['warning'] = new Dict({ title: title, message: message, type: 'dialog' });
    }
    return result;
  }


  /**
   * Return whether ``field`` should trigger an onchange event in the
        presence of ``otherFields``.
   * @param field 
   * @param otherFields 
   * @returns 
   */
  async _hasOnChange(field, otherFields = []) {
    const onchangeMethods = this.cls._onchangeMethods();
    let res = field.name in onchangeMethods;
    if (!res) {
      for (const dep of this._dependentFields(field.baseField)) {
        if (dep in otherFields) {
          return true;
        }
      }
    }
    return res;
  }

  /**
   * Return the onchange spec from a view description; if not given, the
          result of ``this.fieldsViewGet()`` is used.
   * @param {*} viewInfo 
   */
  @api.model()
  async _onchangeSpec(viewInfo) {
    const result = {};

    // for traversing the XML arch and populating result
    async function _process(node, info, prefix) {
      if (node.tagName === 'field') {
        const name = node.getAttribute('name');
        const names = prefix ? f("%s.%s", prefix, name) : name;
        if (!result[names]) {
          result[names] = node.getAttribute('onchange');
        }
        // traverse the subviews included in relational fields
        for (const subinfo of Object.values(info['fields'][name]['views'] ?? {})) {
          await _process(getrootXml(parseXml(subinfo['arch'])), subinfo, names);
        }
      }
      else {
        for (const child of Array.from<any>(node.childNodes ?? [])) {
          await _process(child, info, prefix);
        }
      }
    }

    if (viewInfo == null) {
      viewInfo = await this.fieldsViewGet();
    }
    await _process(getrootXml(parseXml(viewInfo['arch'])), viewInfo, '');
    return result;
  }

  /**
   * Apply onchange method(s) for field ``fieldName`` with spec ``onchange``
        on record ``this``. Value assignments are applied on ``this``, while
        domain and warning messages are put in dictionary ``result``.
   * @param fieldName 
   * @param onchange 
   * @param result 
   * @returns 
   */
  async _onchangeEval(fieldName, onchange, result) {
    onchange = onchange.trim();
    const self = this;
    async function _process(method, res) {
      if (!bool(res)) {
        return;
      }
      res = Dict.from(res);
      if (bool(res.get('value'))) {
        pop(res['value'], 'id', null);
        await self.update(Object.fromEntries(Object.entries(res['value']).filter(([key]) => key in self._fields)));
      }
      if (bool(res.get('domain'))) {
        console.warn(
          "onchange method %s returned a domain, this is deprecated",
          method.name
        )
        Object.assign(setdefault(result, 'domain', {}), res['domain'])
      }
      if (bool(res['warning'])) {
        result['warnings'].add([
          res['warning']['title'] || await this._t("Warning"),
          res['warning']['message'] || "",
          res['warning']['type'] || "",
        ]);
      }
    }

    if (["1", "true"].includes(onchange)) {
      for (const method of this.cls._onchangeMethods().get(fieldName, [])) {
        const methodRes = await method(this);
        await _process(method, methodRes);
      }
      return;
    }
  }
}