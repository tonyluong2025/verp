import assert from "assert";
import _ from 'lodash';
import { DateTime } from "luxon";
import { encode } from "utf8";
import util from "util";

import { DefaultDict, OrderedSet2 } from './helper/collections';
import { KeyError, UserError } from './helper/errors';
import { Registry } from './modules/registry';
import { dbFactory } from './service/db';
import { Cursor } from './sql_db';
import * as func from "./tools/func";
import * as sql from './tools/sql';

import { Cache, CopyMode, Environment, Meta } from './api/api';
import { attrgetter, getattr, hasattr, setattr, setdefault } from "./api/func";
import { AccessError, CacheMiss, DefaultDict2, Dict, MissingError, NotImplementedError, ValueError } from "./helper";
import { BaseModel, ModelRecords, NewId, PREFETCH_MAX, checkObjectName, expandIds, isDefinitionClass, isRegistryClass, newId } from './models';

import { DEFAULT_SERVER_DATETIME_FORMAT as DATETIME_FORMAT, DEFAULT_SERVER_DATE_FORMAT as DATE_FORMAT, IterableGenerator, UpCamelCase, _convert$, _f, _t as _translate, b64decode, bool, chain, enumerate, extend, floatCompare, floatIsZero, floatRepr, floatRound, fromFormat, htmlSanitize, htmlTranslate, humanSize, imageProcess, isCallable, isInstance, isList, islice, len, markup, mergeSequences, pop, repeat, setOptions, sorted, toDate, toDatetime, toText, today, unique } from './tools';

export const NO_ACCESS = '.';

export const IR_MODELS = [
  'ir.model', 'ir.model.data', 'ir.model.fields', 'ir.model.fields.selection', 'ir.model.relation', 'ir.model.constraint', 'ir.module.module',
];

/**
 * Simple helper for calling a method given as a string or a function.
 * 
 * @param needle callable or name of method to call on `records`
 * @param records recordset to call `needle` on or with
 * @param args additional arguments to pass to the determinant
 * @returns the determined value if the determinant is a method name or callable
 * @throws TypeError: if `records` is not a recordset, or `needle` is not a callable or valid method name
 */
export async function determine(needle, records, ...args) {
  if (!isInstance(records, BaseModel)) {
    throw new TypeError("Determination requires a subject recordset");
  }
  if (typeof (needle) === 'string') {
    needle = records[needle];
    if (needle.name.indexOf('__')) {
      return needle.call(records, ...args);
    }
  }
  else if (isCallable(needle)) {
    if (needle.name.indexOf('__')) {
      return needle.call(records, ...args);
    }
  }

  throw new TypeError("Determination requires a callable or method name");
}

/**
 * Return the first record in `records`, with the same prefetching.
 * @param records 
 * @returns 
 */
function first(records: ModelRecords): ModelRecords {
  if (records._length > 1) {
    records = records(0); // next(iter(records));
  }
  return records;
}

function resolveMro(model: any, name: string, predicate: (obj: any) => boolean): any[] {
  const Default = {};
  const result = [];
  for (const cls of model.cls.mro()) {
    if (!(isRegistryClass(cls))) {
      const value = cls.prototype[name] ?? cls[name] ?? Default;
      if (value === Default) {
        continue;
      }
      if (!(predicate.call(model, value))) {
        break;
      }
      result.push(value);
    }
  }
  return result;
}

class Dummy { };
const dummy = new Dummy();

class MetaField {
  static byType = new Dict<Field>();

  static define = () => {
    return (target) => {
      const attrs = Object.assign({}, target);

      // Copy all parent properties and methods to child 
      Meta.copy(target, Object.getPrototypeOf(target), { mode: CopyMode.all });
      // Update owner attributes
      Object.assign(target, attrs);

      this.init(target);
    }
  }

  protected static init(cls: any, attrs: {} = {}) {
    if (!hasattr(cls, 'type')) {
      return;
    }

    if (cls.type && !MetaField.byType.has(cls.type)) {
      MetaField.byType[cls.type] = cls;
    }
    setattr(cls, 'relatedAttrs', []);
    setattr(cls, 'descriptionAttrs', []);
    const ownerPro = Object.getOwnPropertyNames(cls).sort();
    for (const attr of ownerPro) {
      if (attr.startsWith('_related')) {
        cls.relatedAttrs.push([_.camelCase(attr.slice(8)), attr]);
      } else if (attr.startsWith('_description')) {
        cls.descriptionAttrs.push([_.camelCase(attr.slice(12)), attr]);
      }
    }
  }
}

type FieldOptions = { name?: string, comodelName?: string, inverse?: string | Function, relationField?: string, related?: string | boolean, relation?: string, column1?: string, column2?: string, string?: string, required?: boolean, index?: boolean | number, default?: any, ondelete?: string | {}, onupdate?: string, help?: string, automatic?: boolean, compute?: string | boolean, autojoin?: boolean, copy?: boolean, readonly?: boolean | number, size?: number, selection?: string | any[] | Function | {}, store?: boolean, domain?: any[] | string | Function, modelField?: string, search?: string, translate?: boolean | Function, changeDefault?: boolean, digits?: number | string | [number, number], computeSudo?: boolean, recursive?: boolean, invisible?: boolean, companyDependent?: boolean, attachment?: boolean, groupOperator?: string, maxWidth?: number, maxHeight?: number, prefetch?: boolean, groups?: string, context?: {}, inherited?: boolean, trim?: boolean, validate?: boolean, delegate?: boolean, sanitizeTags?: string | boolean, configParameter?: string, impliedGroup?: boolean | string, sanitize?: boolean, selectionAdd?: [string, string][], renderEngine?: string, tracking?: number | boolean, sanitizeStyle?: boolean, depends?: string[] | string, groupExpand?: any, dependsContext?: string[], checkCompany?: boolean, relatedSudo?: boolean, states?: {}, currencyField?: string, sanitizeAttributes?: any, sanitizeForm?: any, deprecated?: any, provider?: string, defaultModel?: string };

export class Fields {
  static get MetaField() {
    return MetaField;
  }
  static Boolean(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Boolean(args, kwargs);
  }
  static Number(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Number(args, kwargs);
  }
  static Integer(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Integer(args, kwargs);
  }
  static Float(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Float(args, kwargs);
  }
  static Monetary(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Monetary(args, kwargs);
  }
  static Char(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Char(args, kwargs);
  }
  static Text(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Text(args, kwargs);
  }
  static Html(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Html(args, kwargs);
  }
  static Date(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Date(args, kwargs);
  }
  static Datetime(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Datetime(args, kwargs);
  }
  static Binary(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Binary(args, kwargs);
  }
  static Image(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Image(args, kwargs);
  }
  static Selection(selection: string | any[] | Function | FieldOptions, kwargs: FieldOptions = {}) {
    if (!(Array.isArray(selection) || typeof (selection) === 'string' || typeof (selection) === 'function')) {
      kwargs = selection as FieldOptions;
      selection = kwargs.selection;
    }
    return new _Selection(selection, kwargs);
  }
  static Reference(selection: string | any[] | Function | FieldOptions, kwargs: FieldOptions = {}) {
    if (!(Array.isArray(selection) || typeof (selection) === 'string' || typeof (selection) === 'function')) {
      kwargs = selection as FieldOptions;
      selection = kwargs.selection;
    }
    return new _Reference(selection, kwargs);
  }
  static Many2one(comodelName: string | FieldOptions, kwargs: FieldOptions = {}) {
    if (typeof (comodelName) === 'string') {
      kwargs = Object.assign(kwargs, { comodelName });
    } else {
      kwargs = comodelName;
    }
    return new _Many2one(kwargs);
  }
  static Many2oneReference(...args: any) {
    return new _Many2oneReference(...args);
  }
  static One2many(comodelName: string | FieldOptions, relationField?: string | FieldOptions, kwargs: FieldOptions = {}) {
    if (typeof (comodelName) === 'string') {
      if (typeof (relationField) === 'string') {
        kwargs = Object.assign(kwargs, { comodelName, relationField });
      } else {
        kwargs = Object.assign(relationField, { comodelName, relationField: pop(relationField, 'relationField') });
      }
    } else {
      kwargs = comodelName;
    }
    return new _One2many(kwargs);
  }
  static Many2many(comodelName: string | FieldOptions, kwargs: FieldOptions = {}) {
    if (typeof (comodelName) === 'string') {
      Object.assign(kwargs, { comodelName });
    } else {
      kwargs = comodelName;
    }
    return new _Many2many(kwargs);
  }
  static Id(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    return new _Id(args, kwargs);
  }
}

export class Field {
  [index: string | number | symbol]: any;

  static type: string | null;                // type of the field (string)

  static relational = false;                 // whether the field is a relational one
  static translate = false;                  // whether the field is translated

  static columnFormat = '%s';                // placeholder for value in queries
  static columnCastFrom: string[] = [];      // column types that may be cast to this
  static writeSequence = 0;                  // field ordering for write()
  static args = null                         // the parameters given to constructor()

  protected static _moduleName = null;       // the field's module name
  protected static _modules = null;          // modules that define this field
  protected static _setupDone = true;        // whether the field is completely set up
  protected static _sequence = null;         // absolute ordering of the field
  protected static _baseFields = [];         // the fields defining self, in override order
  protected static _extraKeys = [];          // unknown attributes set on the field
  protected static _direct = false;          // whether self may be used directly (shared)
  protected static _toplevel = false;        // whether self is on the model's registry class

  protected static _depends = null;          // collection of field dependencies
  protected static _dependsContext = null;   // collection of context key dependencies

  static automatic = false;                  // whether the field is automatically created ("magic" field)
  static inherited = false;                  // whether the field is inherited (_parents)
  static inheritedField = null;              // the corresponding inherited field

  static modelName = null;                   // name of the model of this field
  static comodelName = null;                 // name of the model of values (if relational)

  static store = true;                       // whether the field is stored in database
  static index = false;                      // whether the field is indexed in database
  static manual = false;                     // whether the field is a custom field
  static copy = true;                        // whether the field is copied over by BaseModel.copy()
  static recursive = false;                  // whether self depends on itself
  static compute = null;                     // compute(recs) computes field on recs
  static computeSudo = false;                // whether field should be recomputed as superuser
  static inverse = null;                     // inverse(recs) inverses field on recs
  static search = null;                      // search(recs, operator, value) searches on self
  static related = null;                     // sequence of field names, for related fields
  static companyDependent = false;           // whether 'this' is company-dependent (property field)
  static default = null;                     // default(recs) returns the default value

  static string: string | null = null;       // field label
  static help = null;                        // field tooltip
  static invisible = false;                  // whether the field is invisible
  static readonly = false;                   // whether the field is readonly
  static required = false;                   // whether the field is required
  static states = null;                      // set readonly and required depending on state
  static groups = null;                      // csv list of group xml ids
  static changeDefault = false;              // whether the field may trigger a "user-onchange"
  static deprecated = null;                  // whether the field is deprecated

  static relatedField = null;                // corresponding related field
  static groupOperator = null;               // operator for aggregating values
  static groupExpand = null;                 // name of method to expand groups in readGroup()
  static prefetch: boolean | null = true;    // whether the field is prefetched

  // properties used by setupRelated() to copy values from related field
  static get _relatedComodelName() { return attrgetter('comodelName') }
  static get _relatedString() { return attrgetter('string') }
  static get _relatedHelp() { return attrgetter('help') }
  static get _relatedGroups() { return attrgetter('groups') }
  static get _relatedGroupOperator() { return attrgetter('groupOperator') }

  static __instancecheck__(obj: any) {
    return isInstance(obj, Field);
  }

  /**
   * Return a dictionary that describes the field `this`.
   * @param env 
   * @returns 
   */
  async getDescription(env: Environment): Promise<{}> {
    const desc = { 'type': this.type }
    const list = sorted(this.descriptionAttrs);
    for (const [attr, prop] of list) {
      let value = this[prop];
      if (isCallable(value)) {
        value = await value(this, env);
      }
      if (value != null) {
        desc[attr] = value;
      }
    }
    return desc;
  }

  // properties used by getDescription()
  static get _descriptionStore() { return attrgetter('store') }
  static get _descriptionManual() { return attrgetter('manual') }
  static get _descriptionRelated() { return attrgetter('related') }
  static get _descriptionCompanyDependent() { return attrgetter('companyDependent') }
  static get _descriptionReadonly() { return attrgetter('readonly') }
  static get _descriptionRequired() { return attrgetter('required') }
  static get _descriptionStates() { return attrgetter('states') }
  static get _descriptionGroups() { return attrgetter('groups') }
  static get _descriptionChangeDefault() { return attrgetter('changeDefault') }
  static get _descriptionDeprecated() { return attrgetter('deprecated') }
  static get _descriptionGroupOperator() { return attrgetter('groupOperator') }

  static get _descriptionDepends() {
    return (self: Field, env: Environment) => env.registry.fieldDepends.get(self);
  }

  static get _descriptionSearchable() {
    return (self: Field) => Boolean(self.store || self.search);
  }

  static get _descriptionSortable() {
    return (self: Field) => (self.columnType && self.store) || (self.inherited && self._descriptionSortable(self.relatedField));
  }

  static get _descriptionString() {
    return async (self: Field, env: Environment) => {
      if (self.string && env.lang) {
        const modelName = self.baseField.modelName;
        const fieldString = await env.items('ir.translation').getFieldString(modelName);
        return fieldString[self.name] || self.string;
      }
      return self.string;
    }
  }

  static get _descriptionHelp() {
    return async (self: Field, env: Environment) => {
      if (self.help && env.lang) {
        const modelName = self.baseField.modelName;
        const fieldHelp = await env.items('ir.translation').getFieldHelp(modelName);
        return fieldHelp[self.name] ?? self.help;
      }
      return self.help;
    }
  }

  get columnType() { return null }

  _t = _translate;

  constructor(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    this.init(args, kwargs);
  }

  init(args: string | FieldOptions = null, kwargs: FieldOptions = {}) {
    Meta.copy(this, this.constructor, { mode: CopyMode.all });

    if (typeof args === 'string') {
      kwargs['string'] = args;
    } else {
      setOptions(kwargs, args);
    }
    if (kwargs['ondelete']) {
      kwargs['ondelete'] = typeof (kwargs['ondelete']) === 'string' ? kwargs['ondelete'].toUpperCase() : kwargs['ondelete'];
    }
    if (kwargs['onupdate']) {
      kwargs['onupdate'] = typeof (kwargs['onupdate']) === 'string' ? kwargs['onupdate'].toUpperCase() : kwargs['onupdate'];
    }
    // Update owner properties
    setOptions(this, kwargs);

    setdefault(this, 'args', {});
    if (getattr(this, '_sequence', null) == null) {
      setdefault(this, '_sequence', global.globalSeq++);
    }
    // Update static properties and methods of class to instance/prototype
    for (const [key, val] of Object.entries<any>(kwargs)) {
      if (!(val instanceof Dummy)) {
        this.args[key] = val;
      }
    }
  }

  /**
   * Return a field of the same type as `this`, with its own parameters.
   * @param kwargs 
   * @returns 
   */
  new(kwargs: {}) {
    const field: Field = Object.create(this);
    field.init(kwargs);
    return field;
  }

  /**
   * Return whether the field can be editable in a view.
   * @returns 
   */
  isEditable() {
    return !this.readonly || bool(this.states) && Object.values<any>(this.states).some(items => items.some(item => item.includes('readonly')));
  }

  __setName(owner: any, name: string) {
    assert(owner.prototype instanceof BaseModel);

    this.modelName = owner._name;
    setdefault(this, 'name', name);

    if (isDefinitionClass(owner)) {
      this._moduleName = owner._moduleName;
      owner._fieldDefinitions.push(this);
    }
    if (!this.args['related']) {
      this._direct = true;
    }
    if (this._direct || this._toplevel) {
      this._setupAttrs(owner, name);
      if (this._toplevel) {
        setattr(this, 'args', null);
        setattr(this, '_baseFields', null);
      }
    }
  }

  /**
   * Setup field parameter attributes
   * @param modelClass 
   * @param name 
   */
  protected _setupAttrs(modelClass: any, name: string) {
    const attrs = this._getAttrs(modelClass, name);
    const extraKeys = Object.keys(attrs).filter((key) => !hasattr(this, key));
    if (extraKeys.length) {
      attrs['_extraKeys'] = extraKeys;
    }
    Object.assign(this, attrs);
    if (!(this.store && this.columnType) || this.manual || this.deprecated) {
      this.prefetch = false;
    }
    if (!this.string && !this.related) {
      this.string = _.startCase(
        name.endsWith('Ids') ? name.slice(0, -3)
          : name.endsWith('Id') ? name.slice(0, -2) : name
      );
    }

    if (this.default != null && typeof this.default !== 'function') {
      const value = this.default;
      this.default = (model: any) => value;
    }
  }

  /**
   * Return the field parameter attributes as a dictionary.
   * @param modelClass 
   * @param name 
   * @returns 
   */
  protected _getAttrs(modelClass: any, name: string): Dict<any> {
    // determine all inherited field attributes
    let attrs = new Dict<any>();
    let modules = []
    for (const field of (this.args['_baseFields'] || [])) {
      if (!(this instanceof Field)) {
        // 'this' overrides 'field' and their types are not compatible;
        // so we ignore all the parameters collected so far
        attrs = new Dict();
        modules = [];
        continue;
      }
      Object.assign(attrs, field.args);
      if (field._moduleName) {
        modules.push(field._moduleName);
      }
    }
    Object.assign(attrs, this.args);
    if (this._moduleName) {
      modules.push(this._moduleName);
    }

    attrs['args'] = this.args
    attrs['modelName'] = modelClass._name
    attrs['name'] = name;
    attrs['_moduleName'] = modules.length ? modules[modules.length - 1] : undefined;
    attrs['_modules'] = Array.from(new Set(modules));

    // initialize 'this' with 'attrs'
    if (name === 'state') {
      // by default, 'state' fields should be reset on copy
      attrs['copy'] = attrs['copy'] ?? false;
    }
    let store: boolean;
    if (attrs['compute']) {
      // by default, computed fields are not stored, computed in superuser
      // mode if stored, not copied (unless stored and explicitly not
      // readonly), and readonly (unless inversible)
      attrs['store'] = store = attrs.get('store', false);
      attrs['computeSudo'] = attrs.get('computeSudo', store);
      if (!(attrs['store'] && !attrs.get('readonly', true))) {
        attrs['copy'] = attrs.get('copy', false);
      }
      attrs['readonly'] = attrs.get('readonly', !attrs.get('inverse'));
    }
    if (attrs.get('related')) {
      // by default, related fields are not stored, computed in superuser
      // mode, not copied and readonly
      attrs['store'] = store = attrs.get('store', false);
      attrs['computeSudo'] = attrs.get('computeSudo', attrs.get('relatedSudo', true));
      attrs['copy'] = attrs.get('copy', false)
      attrs['readonly'] = attrs.get('readonly', true)
    }
    if (attrs.get('companyDependent')) {
      // by default, company-dependent fields are not stored, not computed
      // in superuser mode and not copied
      attrs['store'] = false;
      attrs['computeSudo'] = attrs.get('computeSudo', false);
      attrs['copy'] = attrs.get('copy', false);
      attrs['default'] = attrs.get('default', this._defaultCompanyDependent.bind(this));
      attrs['compute'] = this._computeCompanyDependent.bind(this)
      if (!attrs.get('readonly')) {
        attrs['inverse'] = this._inverseCompanyDependent.bind(this);
      }
      attrs['search'] = this._searchCompanyDependent.bind(this);
      attrs['dependsContext'] = [...attrs.get('dependsContext', []), 'company'];
    }
    if (attrs.get('translate')) {
      // by default, translatable fields are context-dependent
      attrs['dependsContext'] = [...attrs.get('dependsContext', []), 'lang'];
    }

    // parameters 'depends' and 'dependsContext' are stored in attributes
    // '_depends' and '_dependsContext', respectively
    if (attrs.has('depends')) {
      attrs['_depends'] = Array.from(attrs.pop('depends'));
    }
    if (attrs.has('dependsContext')) {
      attrs['_dependsContext'] = Array.from(attrs.pop('dependsContext'));
    }
    return attrs;
  }

  async __get__(record: ModelRecords, ownerClass): Promise<any> {
    if (record == null) {
      return this; // the field is accessed through the owner class
    }
    let value;
    if (!bool(record._ids)) {
      // empty record -> return the null value for this field
      value = await this.convertToCache(false, record, false);
      return this.convertToRecord(value, record);
    }
    const env: Environment = record.env;
    // only a single record may be accessed
    record.ensureOne();

    if (this.compute && this.store) {
      await this.recompute(record);
    }

    try {
      value = env.cache.get(record, this);
    } catch (e) {
      if (isInstance(e, KeyError)) {// or MissingError
        /**
         *  behavior in case of cache miss:            
            on a real record:
                stored -> fetch from database (computation done above)
                not stored and computed -> compute
                not stored and not computed -> default
        
            on a new record w/ origin:
                stored and not (computed and readonly) -> fetch from origin
                stored and computed and readonly -> compute
                not stored and computed -> compute
                not stored and not computed -> default
        
            on a new record w/o origin:
                stored and computed -> compute
                stored and not computed -> new delegate or default
                not stored and computed -> compute
                not stored and not computed -> default
         */
        const thisName = this.name;

        if (this.store && bool(record.id)) {
          const recs = record._inCacheWithout(this);
          try {
            await recs._fetchField(this);
          } catch (e) {
            if (isInstance(e, AccessError)) {
              await record._fetchField(this);
            }
            else {
              throw e;
            }
          }
          if (!env.cache.contains(record, this)) {
            throw new MissingError(
              await this._t(env, "Record does not exist or has been deleted.") + "\n" +
              await this._t(env, "(Record: %s, User: %s)", record, '#' + env.uid),
            );
          }
          value = env.cache.get(record, this);
        }

        else if (this.store && bool(record._origin) && !(this.compute && this.readonly)) {
          value = await this.convertToCache(await record._origin[thisName], record);
          env.cache.set(record, this, value);
        }

        else if (this.compute) {
          if (env.isProtected(this, record)) {
            value = await this.convertToCache(false, record, false);
            env.cache.set(record, this, value);
          } else {
            const recs = this.recursive ? record : record._inCacheWithout(this);
            try {
              await this.computeValue(recs);
            } catch (e) { // AccessError, MissingError
              await this.computeValue(record);
            }
            try {
              value = env.cache.get(record, this);
            } catch (e) { // CacheMiss
              if (this.readonly && !this.store) {
                throw new ValueError("Failed get value %s.%s. Cause: %s", record, this.name, e.message);
              }
              value = await this.convertToCache(false, record, false);
              env.cache.set(record, this, value);
            }
          }
        }

        else if (this.type === 'many2one' && this.delegate && !bool(record.id)) {
          function isInheritField(name): boolean {
            const field = record._fields[name];
            return field.inherited && field.related.split('.')[0] === thisName;
          }

          const parent = await record.env.items(this.comodelName).new(
            Object.fromEntries(record._cache.items().filter(([name]) => isInheritField(name)))
          );
          await record._updateCache({ [thisName]: parent }, false);
          value = env.cache.get(record, this);
        }

        else {
          // non-stored field or stored field on new record: default value
          value = await this.convertToCache(false, record, false);
          env.cache.set(record, this, value);
          const defaults = await record.defaultGet([thisName]);
          if (thisName in defaults) {
            /**
             * The null value above is necessary to convert x2many field values. For instance, converting [[Command.LINK, id]] accesses the field's current value, then adds the given id. Without an initial value, the conversion ends up here to determine the field's value, and generates an infinite recursion.
             */
            value = await this.convertToCache(defaults[thisName], record);
            env.cache.set(record, this, value);
          }
        }
      }
      else {
        throw e;
      }
    }
    return this.convertToRecord(value, record);
  }

  async __set__(records, value) {
    const protectedIds = [];
    const newIds = [];
    const otherIds = [];
    for (const recordId of records._ids) {
      const _protected = records.env._protected.get(this, []);
      if (_protected.includes(recordId)) {
        protectedIds.push(recordId);
      } else if (!bool(recordId)) {
        newIds.push(recordId);
      } else {
        otherIds.push(recordId);
      }
    }
    if (protectedIds.length) {
      const protectedRecords = records.browse(protectedIds);
      await this.write(protectedRecords, value);
    }
    if (newIds.length) {
      const newRecords = records.browse(newIds);
      await records.env.protecting(records.pool.fieldComputed.get(this, [this]), records, async () => {
        if (this.relational) {
          await newRecords.modified([this.name], false, true);
        }
        await this.write(newRecords, value);
        await newRecords.modified([this.name])
      });
      if (this.inherited) {
        const parents = await records[this.related.split('.')[0]];
        const parentsFitered = await parents.filtered((r) => !bool(r.id));
        await parentsFitered.set(this.name, value);
      }
    }
    if (otherIds.length) {
      records = await records.browse(otherIds);
      const writeValue = await this.convertToWrite(value, records);
      await records.write({ [this.name]: writeValue })
    }
  }

  /**
   * No transformation by default, but allows override.
   * @param value 
   * @returns 
   */
  async _processRelated(value) {
    return value;
  }

  async computeValue(records: ModelRecords) {
    const env = records.env;
    if (this.computeSudo) {
      records = await records.sudo();
    }
    const fields = records.pool.fieldComputed.get(this, []);

    for (const field of fields) {
      if (field.store) {
        env.removeToCompute(field, records);
      }
    }
    try {
      await env.protecting(fields, records, async () => {
        await records._computeFieldValue(this);
      });
    } catch (e) {
      for (const field of fields) {
        if (field.store) {
          env.addToCompute(field, records)
        }
      }
      throw e;
    }
  }

  /**
   * Return the base field of an inherited field, or `this`.
   */
  get baseField(): Field {
    return this.inheritedField ? this.inheritedField.baseField : this;
  }

  /**
   * Return whether the field may be used for grouping in `~core.models.BaseModel.readGroup`.
   */
  get groupable(): boolean {
    return this.store && this.columnType;
  }

  async mapped(records) {
    if (this.name === 'id') {
      return Array.from(records._ids);
    }
    if (this.compute && this.store) {
      await this.recompute(records);
    }

    let vals: any[] = records.env.cache.getUntilMiss(records, this);
    while (vals.length < records._length) {
      const remaining = records._browse(records.env, records([vals.length])._ids, records._prefetchIds);
      await this.__get__(first(remaining), remaining.constructor)
      extend(vals, records.env.cache.getUntilMiss(remaining, this));
    }
    return this.convertToRecordMulti(vals, records);
  }

  static toString(value: any) {
    return value ? value : `${this.modelName}.${this.name}`;
  }

  repr() {
    if (!('__key' in this)) {
      this['__key'] = `${this.modelName}.${this.name}`;
    }
    return this['__key'];
  }

  protected async _defaultCompanyDependent(model) {
    return model.env.items('ir.property')._get(this.name, this.modelName);
  }

  protected async _computeCompanyDependent(records) {
    const Property = await records.env.items('ir.property').sudo();
    const values = await Property._getMulti(this.name, this.modelName, records.ids);
    for (const record of records) {
      await record.set(this.name, values[record.id]);
    }
  }

  protected async _inverseCompanyDependent(records) {
    const Property = await records.env.items('ir.property').sudo();
    const values = {}
    for (const record of records) {
      values[record.id] = await this.convertToWrite(await record[this.name], record);
    }
    await Property._setMulti(this.name, this.modelName, values);
  }

  protected async _searchCompanyDependent(records, operator, value) {
    const Property = await records.env.items('ir.property').sudo();
    return Property.searchMulti(this.name, this.modelName, operator, value);
  }

  async null(record) {
    return false;
  }

  /**
   * Convert `value` from the `write` format to the SQL format.
   * @param value 
   * @param record 
   * @param values 
   * @param validate 
   * @returns 
   */
  async convertToColumn(value, record, values?: any, validate = true): Promise<any> {
    if (value == null || value === false) {
      return null;
    }
    return toText(value);
  }

  /**
   * Convert `value` from the `write` format to the SQL format.
   * @param value 
   * @param record 
   * @param values 
   * @param validate 
   * @returns 
   */
  async convertFromColumn(value, record, values?: any, validate = true): Promise<any> {
    return value;
  }

  /**
   * Convert `value` to the cache format; `value` may come from an
    assignment, or have the format of methods `BaseModel.read` or
    `BaseModel.write`. If the value represents a recordset, it should
    be added for prefetching on `record`.
   * @param value 
   * @param record 
   * @param validate when true, field-specific validation of `value`
        will be performed
   * @returns 
   */
  async convertToCache(value, record, validate = true) {
    return value;
  }

  /**
   * Convert `value` from the cache format to the record format.
    If the value represents a recordset, it should share the prefetching of
    `record`.
   * @param value 
   * @param record 
   * @returns 
   */
  async convertToRecord(value, record) {
    return value == null ? false : value
  }

  /**
   * Convert a list of `values` from the cache format to the record format.
    Some field classes may override this method to add optimizations for
    batch processing.
   * @param values 
   * @param records 
   * @returns 
   */
  async convertToRecordMulti(values: any[], records) {
    // spare the method lookup overhead
    const convert = this.convertToRecord
    const res = [];
    for (const value of values) {
      res.push(await convert(value, records));
    }
    return res;
  }

  /**
   * Convert `value` from the record format to the format returned by method `BaseModel.read()`.
   * @param value 
   * @param record 
   * @param useNameGet when true, the value's display name will be computed using `BaseModel.nameGet()`, if relevant for the field
   * @returns 
   */
  async convertToRead(value, record, useNameGet = true) {
    return value == null ? false : value
  }

  /**
   * Convert `value` from any format to the format of method `BaseModel.write()`.
   * @param value 
   * @param record 
   * @returns 
   */
  async convertToWrite(value, record) {
    const cacheValue = await this.convertToCache(value, record, false)
    const recordValue = await this.convertToRecord(cacheValue, record)
    return this.convertToRead(recordValue, record)
  }

  /**
   * Convert `value` from the record format to the format returned by method `BaseModel.onchange()`.
   * @param value
   * @param record 
   * @param names a tree of field names (for relational fields only)
   * @returns 
   */
  async convertToOnchange(value, record, names) {
    return this.convertToRead(value, record);
  }

  /**
   * Convert `value` from the record format to the export format.
   * @param value 
   * @param record 
   * @returns 
   */
  async convertToExport(value, record) {
    if (!bool(value)) {
      return '';
    }
    return value;
  }

  /**
   * Convert `value` from the record format to a suitable display name.
   * @param value 
   * @param record 
   * @returns 
   */
  async convertToDisplayName(value, record) {
    return `${value}`;
  }

  /**
   * Update the database schema to implement this field. 
   * @param model an instance of the field's model
   * @param columns a dict mapping column names to their configuration in database
   * @returns 'true' if the field must be recomputed on existing rows
   */
  async updateDb(model, columns): Promise<boolean> {
    const self: any = this;
    if (!self.columnType) {
      return;
    }

    const column = columns[self.name];
    if (bool(column)) {
      column['name'] = self.name; // This 'name' used for Sequelize/Database
    }
    // create/update the column, not null constraint; the index will be
    // managed by registry.checkIndexes()
    await this.updateDbColumn(model, column);
    await this.updateDbNotnull(model, column);

    // optimization for computing simple related fields like 'foo_id.bar'
    if (
      !bool(column)
      && self.related && self.related.split('.').length == 2
      && self.relatedField.store && !self.relatedField.compute
      && !(self.relatedField.type === 'binary' && self.relatedField.attachment)
      && !(['one2many', 'many2many'].includes(self.relatedField.type))
    ) {
      const joinField = model._fields[self.related.split('.')[0]];
      if (
        joinField.type == 'many2one'
        && joinField.store && !joinField.compute
      ) {
        model.pool.postInit(self.updateDbRelated, self, model);
        // discard the "classical" computation
        return false;
      }
    }
    return !bool(column);
  }

  convertDataType(type: string) {
    return type;
  }

  /**
   * Create/update the column corresponding to `this`.
   * @param model an instance of the field's model
   * @param column the column's configuration (dict) if it exists, or `null`
   * @returns 
   */
  async updateDbColumn(model, column) {
    const self = this as any;
    const tableName = model.constructor._table;
    if (!bool(column)) {
      // the column does not exist, create it
      await sql.createColumn(model._cr, tableName, self.name, self.columnType[1], self.string);
      return;
    }
    const convertedType = self.convertDataType(column['type']);
    if (convertedType === self.columnType[0]) {
      return;
    }
    if (self.columnCastFrom.includes(convertedType)) {
      await sql.convertColumn(model._cr, tableName, self.name, self.columnType[1]);
    } else {
      const newname = self.name + '_moved%s';
      let i = 0;
      while (await sql.columnExists(model._cr, tableName, util.format(newname, i))) {
        i += 1;
      }
      if (column['allowNull'] === false) {
        await sql.dropNotNull(model._cr, tableName, self.name);
      }
      console.warn(`Rename column "${self}"<${column['type']}> on table "${tableName}" to "${util.format(newname, i)}"<${self.columnType[1]}>`);
      await sql.renameColumn(model._cr, tableName, self.name, util.format(newname, i));
      await sql.createColumn(model._cr, tableName, self.name, self.columnType[1], self.string);
    }
  }

  /**
   * Add or remove the NOT NULL constraint on `this`.
   * @param model: an instance of the field's model
   * @param column: the column's configuration (dict) if it exists, or `null`
   */
  async updateDbNotnull(model: any, column: {}) {
    const self = this as any;
    const hasNotnull = bool(column) && column['allowNull'] === false;

    if (!bool(column) || (self.required && hasNotnull)) {
      // the column is new or it becomes required; initialize its values
      if (await model._tableHasRows()) {
        await model._initColumn(self.name);
      }
    }

    if (self.required && hasNotnull) {
      model.pool.postInit(this._postInit, self, model);
    } else if (!self.required && !hasNotnull) {
      await sql.dropNotNull(model._cr, model.constructor._table, self.name);
    }
  }

  async _postInit(self, model: ModelRecords) {
    // flush values before adding NOT NULL constraint
    await model.flush([self.name]);
    await model.pool.postConstraint(applyRequired, model, self.name);
  }

  /**
   * Compute a stored related field directly in SQL.
   * @param self 
   * @param model 
   */
  async updateDbRelated(self, model: ModelRecords) {
    const comodel = model.env.models[self.relatedField.modelName];
    const [joinField, comodelField] = self.related.split('.');
    const cr: Cursor = model.env.cr;
    const query = `
                  UPDATE "${model.cls._table}" AS x
                  SET "${self.name}" = y."${comodelField}"
                  FROM "${comodel._table}" AS y
                  WHERE x."${joinField}" = y.id
                `;
    await cr.query(query);
  }

  *resolveDepends(registry: Registry) {
    const model0 = registry.models[this.modelName];
    const fieldDepends = registry.fieldDepends.get(this);
    for (const dotnames of fieldDepends) {
      const fieldSeq: Field[] = [];
      let modelName: string = this.modelName;
      if (!dotnames) {
        console.log('dotnames=="', dotnames, '"', modelName, this, 'fieldDepends:', fieldDepends);
      }
      for (const [index, fname] of enumerate(dotnames.split('.'))) {
        let field: Field;
        const model = registry.models[modelName];
        if (model0._transient && !model._transient) {
          break;
        }
        field = model._fields[fname];
        if (!field) {
          throw new ValueError(`Wrong @depends on '${this.compute}' (compute method of field ${this}). Dependency field '${fname}' not found in model ${modelName}.`);
        }
        if (field === this && index && !this.recursive) {
          this.recursive = true;
          console.warn(`Field ${this} should be declared with recursive=true`);
        }
        fieldSeq.push(field);

        if (!(field === this && !index)) {
          yield Array.from(fieldSeq);
        }

        if (['one2many', 'many2many'].includes(field.type)) {
          for (const invField of model.pool.fieldInverses.get(field)) {
            yield Array.from(fieldSeq).concat([invField]);
          }
        }
        modelName = field.comodelName;
      }
    }
  }

  async read(records: ModelRecords) {
    throw new NotImplementedError("Method read() undefined on %s", this)
  }

  async create(recordValues) {
    for (const [record, value] of Object.values<any>(recordValues)) {
      await this.write(record, value);
    }
  }

  /**
   * Write the value of `this` on `records`. This method must update the cache and prepare database updates.
   * @param records 
   * @param value a value in any format
   * @returns the subset of `records` that have been modified
   */
  async write(records, value) {
    records.env.removeToCompute(records);
    const cache = records.env.cache as Cache;
    const cacheValue = await this.convertToCache(value, records);
    records = cache.getRecordsDifferentFrom(records, this, cacheValue);
    if (!bool(records)) {
      return records;
    }
    cache.update(records, this, _.fill(Array(records._length), cacheValue));
    if (this.store) {
      records.env.all.towrite[this.modelName] = records.env.all.towrite[this.modelName] ?? new Dict<any>();
      const towrite = records.env.all.towrite[this.modelName];
      const record = records[0];
      const writeValue = await this.convertToWrite(cacheValue, record);
      const columnValue = await this.convertToColumn(writeValue, record);
      for (const record of await records.filtered('id')) {
        towrite[record.id] = towrite[record.id] ?? new Dict<any>();
        towrite[record.id][this.name] = columnValue;
      }
    }
    return records;
  }

  /**
   * Traverse the fields of the related field `this` except for the last
    one, and return it as a pair `[lastRecord, lastField]`. 
   * @param record 
   * @returns 
   */
  async traverseRelated(record?: ModelRecords) {
    for (const name of this.related.split('.').slice(0, -1)) {
      record = first(await record[name]);
    }
    return [record, this.relatedField];
  }

  /**
   * Compute the related field `this` on `records`.
    
    Traverse fields one by one for all records, in order to take advantage
    of prefetching for each field access. In order to clarify the impact
    of the algorithm, consider traversing 'foo.bar' for records a1 and a2,
    where 'foo' is already present in cache for a1, a2. Initially, both a1
    and a2 are marked for prefetching. As the commented code below shows,
    traversing all fields one record at a time will fetch 'bar' one record
    at a time.
          b1 = a1.foo         mark b1 for prefetching
          v1 = b1.bar         fetch/compute bar for b1
          b2 = a2.foo         mark b2 for prefetching
          v2 = b2.bar         fetch/compute bar for b2
    
    On the other hand, traversing all records one field at a time ensures
    maximal prefetching for each field access.
    
          b1 = a1.foo         mark b1 for prefetching
          b2 = a2.foo         mark b2 for prefetching
          v1 = b1.bar         fetch/compute bar for b1, b2
          v2 = b2.bar         value already in cache
    
    This difference has a major impact on performance, in particular in
    the case where 'bar' is a computed field that takes advantage of batch
    computation.
   * @param records 
   */
  protected async _computeRelated(records: ModelRecords) {
    let values = [...records];
    for (const name of this.related.split('.').slice(0, -1)) {
      try {
        const firsts = [];
        for (const value of values) {
          const val = await value[name];
          firsts.push(first(val));
        }
        values = firsts;
      }
      catch (e) {
        if (isInstance(e, AccessError)) {
          const description = await (await records.env.items('ir.model')._get(records._name)).label;
          throw new AccessError(
            _f(await this._t(records.env, "{previousMessage}\n\nImplicitly accessed through '{documentKind}' ({documentModel})."), {
              'previousMessage': e.message,
              'documentKind': description,
              'documentModel': records.cls._name,
            })
          );
        } else {
          throw e;
        }
      }
    }
    // assign final values to records
    for (const [record, value] of _.zip<ModelRecords, ModelRecords>([...records], values)) {
      await record.set(this.name, await this._processRelated(await value[this.relatedField.name]));
    }
  }

  protected async _inverseRelated(records) {
    const recordValue = new Map();
    for (const record of records) {
      recordValue.set(record, await record[this.name]);

      const [target, field] = await this.traverseRelated(record);
      // update 'target' only if 'record' and 'target' are both real or
      // both new (see `test_base_objects.js`, `testBasic`)
      if (target.ok && bool(target.id) === bool(record.id)) {
        await target.set(field.name, recordValue.get(record));
      }
    }
  }

  protected _searchRelated(records, operator, value) {
    return [[this.related, operator, value]];
  }

  /**
   * Process the pending computations of `this` on `records`. This
        should be called only if 'this' is computed and stored.
   * @param records 
   * @returns 
   */
  async recompute(records: ModelRecords) {
    const toComputeIds = records.env.all.tocompute.get(this, []);
    if (!toComputeIds.length) {
      return;
    }

    if (this.recursive) {
      for (const record of records) {
        if (toComputeIds.includes(record.id)) {
          await this.computeValue(record);
        }
      }
      return;
    }

    for (const record of records) {
      if (toComputeIds.includes(record.id)) {
        const ids = expandIds(record.id, toComputeIds);
        const recs = record.browse(islice(ids, PREFETCH_MAX));
        try {
          await this.computeValue(recs);
        } catch (e) {
          if (isInstance(e, AccessError, MissingError)) {
            await this.computeValue(record);
          }
          throw e;
        }
      }
    }
  }

  prepareSetup() {
    this._setupDone = false;
  }

  setup(model) {
    if (!this._setupDone) {
      for (const key of this._extraKeys) {
        if (!model._validFieldParameter(this, key)) {
          console.warn(
            `Field ${this}: unknown parameter '${key}', if this is an actual parameter you may want to override the method _validFieldParameter on the relevant model in order to allow it`
          )
        }
      }
      if (this.related) {
        this.setupRelated(model)
      } else {
        this.setupNonrelated(model)
      }
      this._setupDone = true;
    }
  }

  setupNonrelated(model: any) { }

  setupRelated(model: any) {
    assert(typeof this.related === 'string', this.related)

    let modelName = this.modelName;
    let field: Field;
    for (const name of this.related.split('.')) {
      field = model.pool.models[modelName]._fields.get(name);
      if (!field) {
        throw new KeyError(`Field '${modelName}.${name}' referenced in related field definition ${this} does not exist.`)
      }
      if (!field._setupDone) {
        field.setup(model.env.items(modelName))
      }
      modelName = field.comodelName;
    }

    this.relatedField = field;

    if (this.type !== field.type) {
      throw new TypeError(`Type of related field ${this} is inconsistent with ${field}`)
    }

    this.compute = this._computeRelated.bind(this);
    if (this.inherited || !(this.readonly || field.readonly)) {
      this.inverse = this._inverseRelated.bind(this);
    }
    if (field._descriptionSearchable) {
      this.search = this._searchRelated.bind(this);
    }

    if (this.default && this.readonly && !this.inverse) {
      console.log('Redundant default on %s', this);
    }

    for (const [attr, prop] of Object.values<any>(this.relatedAttrs)) {
      if (this[attr] == null) {
        let value = field[prop];
        if (isCallable(value)) {
          value = value(field);
        }
        setattr(this, attr, value);
      }
    }

    for (const attr of (field._extraKeys || [])) {
      if ((this[attr] == null) && model._validFieldParameter(this, attr)) {
        let value = field[attr];
        if (isCallable(value)) {
          value = value(field);
        }
        setattr(this, attr, value);
      }
    }

    if (this.inherited) {
      this.inheritedField = field;
      if (!len(this.states)) {
        this.states = field.states;
      }
      if (field.required) {
        this.required = true;
      }
      const delegateField = model._fields[this.related.split('.')[0]];
      const s = new Set();
      this._modules = this._modules ?? [];
      delegateField._modules?.forEach((e) => this._modules.push(e));
      field._modules?.forEach((e) => this._modules.push(e))
      this._modules = Array.from(new Set(this._modules));
    }
  }

  async getDepends(model) {
    if (this._depends != null) {
      return [this._depends, this._dependsContext || []];
    }
    let depends, dependsContext, relatedModel;
    if (this.related) {
      if (this._dependsContext != null) {
        dependsContext = this._dependsContext;
      } else {
        relatedModel = model.env.items(this.relatedField.modelName);
        [depends, dependsContext] = await this.relatedField.getDepends(relatedModel);
      }
      return [[this.related], dependsContext]
    }
    if (!this.compute) {
      return [[], this._dependsContext || []]
    }
    let funcs;
    if (typeof this.compute === 'string') {
      funcs = resolveMro(model, this.compute, isCallable);
    } else {
      funcs = [this.compute];
    }
    depends = [];
    dependsContext = this._dependsContext || [];
    for (const func of funcs) {
      const deps = getattr(func, '_depends', []);
      depends = extend(depends, typeof deps === 'function' ? await deps(model) : deps);
      dependsContext = extend(dependsContext, getattr(func, '_dependsContext', []));
    }
    const cls = model.constructor as any;
    if (this.automatic && this.name === 'displayName' && cls._recName) {
      if (cls._fields[cls._recName].baseField.translate) {
        if (dependsContext.includes('lang')) {
          dependsContext.push('lang');
        }
      }
    }

    return [Array.from(new Set(depends)), Array.from(new Set(dependsContext))];
  }

  /**
   * Given the value of `this` on `records`, inverse the computation.
   * @param records 
   */
  async determineInverse(records) {
    if (typeof (this.inverse) === 'string') {
      const func = records[this.inverse];
      if (isCallable(func)) {
        await func.call(records);
      }
    }
    else {
      await this.inverse.call(this, records);
    }
  }

  /**
   * Return a domain representing a condition on `this`.
   * @param records 
   * @param operator 
   * @param value 
   * @returns 
   */
  async determineDomain(records, operator, value) {
    if (typeof (this.search) === 'string') {
      const func = records[this.search];
      return func.call(records, operator, value);
    }
    else {
      return this.search.call(this, records, operator, value);
    }
  }
}

@MetaField.define()
class _Boolean extends Field {
  static type = 'boolean';
  get columnType() { return ['BOOLEAN', 'BOOLEAN'] }

  async convertToColumn(value, record, values?: any, validate = true) {
    return Boolean(value)
  }

  async convertToCache(value, record, validate = true) {
    return Boolean(value)
  }

  async convertToExport(value, record) {
    return value
  }
}

@MetaField.define()
export class _Number extends Field {
  static type = 'number';
  static groupOperator = 'sum';
  get columnType() { return ['NUMERIC', 'NUMERIC'] }

  async convertToRead(value, record, useNameGet = true) {
    return Number(value);
  }
}

@MetaField.define()
class _Integer extends _Number {
  static type = 'integer';
  static groupOperator = 'sum'
  get columnType() { return ['INTEGER', 'INTEGER'] }

  async convertToColumn(value, record, values?: any, validate = true): Promise<number> {
    return func.parseInt(bool(value) ? value : 0)
  }

  async convertToCache(value, record, validate = true) {
    if (isInstance(value, Object)) {
      // special case, when an integer field is used as inverse for a one2many
      return getattr(value, 'id', null);
    }
    return func.parseInt(bool(value) ? value : 0);
  }

  async convertToRecord(value, record) {
    return value || 0;
  }

  _update(records, value) {
    // special case, when an integer field is used as inverse for a one2many
    const cache = records.env.cache
    for (const record of records) {
      cache.set(record, this, bool(value.id) ? value.id : 0);
    }
  }

  async convertToExport(value, record) {
    if (bool(value) || value == 0) {
      return value;
    }
    return '';
  }
}

@MetaField.define()
export class _Float extends _Number {
  static type = 'float';
  static columnCastFrom = ['INTEGER', 'NUMERIC', 'FLOAT'];
  static digits = null // digits argument passed to class initializer
  static groupOperator = 'sum';

  static get _relatedDigits() { return attrgetter('digits'); }

  static get _descriptionDigits() {
    return (self: Field, env: Environment) => self.getDigits(env);
  }

  get columnType() { return this.digits != null ? ['NUMERIC', 'NUMERIC'] : ['FLOAT', 'FLOAT'] }

  async getDigits(env: Environment): Promise<[number, number]> {
    if (typeof this.digits === 'string') {
      const precision = await env.items('decimal.precision').precisionGet(this.digits);
      return [16, precision];
    } else {
      return this.digits;
    }
  }

  convertDataType(type: string) {
    return dbFactory.convertDataTypeFloat(type);
  }

  async convertToCache(value, record, validate = true) {
    // apply rounding here, otherwise value in cache may be wrong!
    value = func.parseFloat(value || 0.0);
    if (!validate) {
      return value;
    }
    const digits = await this.getDigits(record.env);
    return len(digits) == 2 ? floatRound(value, { precisionDigits: digits[1] }) : value;
  }

  async convertToColumn(value, record, values?: any, validate = true) {
    let result: any = func.parseFloat(value || 0.0);
    const digits = await this.getDigits(record.env);
    if (bool(digits)) {
      const [precision, scale] = digits;
      result = func.parseFloat(floatRepr(floatRound(result, { precisionDigits: scale }), scale));
    }
    return result;
  }

  async convertToRecord(value, record) {
    return value || 0.0;
  }

  static round = floatRound;
  static isZero = floatIsZero;
  static compare = floatCompare;
}

@MetaField.define()
class _Monetary extends _Number {
  static type = 'monetary';
  static writeSequence = 10;
  static columnCastFrom = ['FLOAT'];

  static currencyField = null;
  static groupOperator = 'sum';

  get columnType() { return ['NUMERIC', 'NUMERIC'] };

  static get _relatedTranslate() { return attrgetter('translate') };

  static get _descriptionCurrencyField() {
    return (self: Field, env: Environment) => self.getCurrencyField(env.items(self.modelName));
  }

  setupNonrelated(model) {
    super.setupNonrelated(model);
    assert(model._fields.has(this.getCurrencyField(model)), `Field ${this} with unknown currencyField ${this.getCurrencyField(model)}`);
  }

  setupRelated(model) {
    super.setupRelated(model);
    if (this.inherited) {
      this.currencyField = this.relatedField.getCurrencyField(model.env.items(this.relatedField.modelName));
    }
    assert(this.getCurrencyField(model) in model._fields,
      `Field ${this} with unknown currencyField ${this.getCurrencyField(model)}`)
  }

  async convertToColumn(value, record, values?: any, validate = true) {
    // retrieve currency from values or record
    let currency;
    const currencyFieldName = this.getCurrencyField(record);
    const currencyField = record._fields[currencyFieldName];
    if (values && currencyFieldName in values) {
      const dummy = await record.new({ [currencyFieldName]: values[currencyFieldName] });
      currency = await dummy[currencyFieldName];
    }
    else if (values && currencyField.related && currencyField.related.split('.')[0] in values) {
      const relatedFieldName = currencyField.related.split('.')[0];
      const dummy = await record.new({ [relatedFieldName]: values[relatedFieldName] });
      currency = await dummy[currencyFieldName];
    }
    else {
      // Note: this is wrong if 'record' is several records with different
      // currencies, which is functional nonsense and should not happen
      // BEWARE: do not prefetch other fields, because 'value' may be in
      // cache, and would be overridden by the value read from database!
      currency = await (await record([0, 1]).withContext({ prefetchFields: false }))[currencyFieldName];
    }
    value = func.parseFloat(value || 0.0);
    if (bool(currency)) {
      return func.parseFloat(floatRepr(await currency.round(value), await currency.decimalPlaces));
    }
    return value;
  }

  async convertToCache(value, record, validate = true) {
    // cache format: float
    value = func.parseFloat(value || 0.0);
    if (value && validate) {
      // BEWARE: do not prefetch other fields, because 'value' may be in
      // cache, and would be overridden by the value read from database!
      const currencyField = this.getCurrencyField(record);
      const currency = await (await (await record.sudo()).withContext({ prefetchFields: false }))[currencyField];
      if (len(currency) > 1) {
        throw new ValueError("Got multiple currencies while assigning values of monetary field %s", this);
      } else if (bool(currency)) {
        value = await currency.round(value);
      }
    }
    return value;
  }

  async convertToRecord(value, record) {
    return func.parseFloat(value || 0.0);
  }

  async convertToWrite(value, record) {
    return func.parseFloat(value);
  }

  /**
   * Return the name of the currency field.
   * @param model 
   * @returns 
   */
  getCurrencyField(model) {
    return this.currencyField ?? (
      'currencyId' in model._fields ? 'currencyId' :
        'xCurrencyId' in model._fields ? 'xCurrencyId' : null
    )
  }
}

@MetaField.define()
class _String extends Field {
  static translate = false                   // whether the field is translated
  static prefetch = null

  constructor(...args: any) {
    const kwargs = {};
    if (typeof args[0] === 'string') {
      kwargs['string'] = args[0];
      if (args.length > 1 && args[1] instanceof Object) {
        Object.assign(kwargs, args[1]);
      }
    } else {
      Object.assign(kwargs, args[0]);
    }

    // translate is either true, false, or a callable
    if ('translate' in kwargs && !isCallable(kwargs['translate'])) {
      kwargs['translate'] = Boolean(kwargs['translate'])
    }
    super(kwargs)
  }

  protected _setupAttrs(modelClass: any, name: string): void {
    super._setupAttrs(modelClass, name);
    if (!this.prefetch) {
      // do not prefetch complex translated fields by default
      this.prefetch = !isCallable(this.translate);
    }
  }

  static get _descriptionTranslate() {
    return (self: Field) => bool(self.translate);
  }

  /**
   * Return the sequence of terms to translate found in `value`. 
   * @param value 
   * @returns 
   */
  async getTransTerms(value) {
    if (!isCallable(this.translate)) {
      return value ? [value] : [];
    }
    const terms = [];
    await this.translate(terms.push, value);
    return terms;
  }

  /**
   * Return a translation function `translate` for `this` on the given records; the function call `translate(recordId, value)` translates the field value to the language given by the environment of `records`.
   * @param records 
   * @returns 
   */
  async getTransFunc(records) {
    let translate;
    if (isCallable(this.translate)) {
      const trans = records.env.items('ir.translation');
      const recSrcTrans = await trans._getTermsTranslations(this, records);

      translate = async (recordId, value) => {
        const srcTrans = Dict.from(recSrcTrans[recordId]);
        return this.translate(srcTrans.get, value);
      }
    }
    else {
      const recTrans = await records.env.items('ir.translation')._getIds(`${this.modelName}.${this.name}`, 'model', records.env.lang, records.ids);

      translate = async (recordId, value) => {
        return recTrans[recordId] ?? value;
      }
    }
    return translate;
  }

  async write(records: ModelRecords, value: any) {
    records.env.removeToCompute(this, records);
    const cache = records.env.cache;
    const cacheValue = await this.convertToCache(value, records);
    records = cache.getRecordsDifferentFrom(records, this, cacheValue);
    if (records.nok) {
      return records;
    }
    cache.update(records, this, _.fill(Array(records._length), cacheValue));

    if (!this.store) {
      return records;
    }

    const realRecs = await records.filtered('id');
    if (!realRecs.ids.length) {
      return records;
    }
    let updateColumn = true;
    let updateTrans = false;
    const singleLang = (await records.env.items('res.lang').getInstalled()) <= 1;
    let lang;
    if (this.translate) {
      lang = records.env.lang ?? null;
      if (singleLang) {
        updateTrans = true;
      }
      else if (isCallable(this.translate) || lang === 'en_US') {
        updateColumn = true;
        updateTrans = true;
      }
      else if (lang !== 'en_US' && lang != null) {
        updateColumn = !bool(cacheValue);
        updateTrans = true;
      }
    }
    if (updateColumn) {
      records.env.all.towrite[this.modelName] = records.env.all.towrite[this.modelName] ?? new Dict<any>();
      const towrite = records.env.all.towrite[this.modelName];
      for (const rid of realRecs._ids) {
        towrite[rid] = towrite[rid] ?? new Dict<any>();
        towrite[rid][this.name] = cacheValue;
      }
      if (this.translate === true && bool(cacheValue)) {
        const tname = `${records.cls._name},${this.name}`;
        await records.env.items('ir.translation')._setSource(tname, realRecs._ids, value);
      }
      if (this.translate) {
        cache.invalidate([[this, records.ids]]);
        cache.update(records, this, _.fill(Array(records._length), cacheValue))
      }
    }
    if (updateTrans) {
      if (isCallable(this.translate)) {
        await records.env.items('ir.translation')._syncTermsTranslations(this, realRecs);
      }
      else {
        value = await this.convertToColumn(value, records);
        const sourceRecs = await realRecs.withContext({ lang: null });
        let sourceValue = await first(sourceRecs)[this.name];
        if (!bool(sourceValue)) {
          sourceRecs[this.name] = value;
          sourceValue = value;
        }
        const tname = `${this.modelName},${this.name}`;
        if (!value) {
          await (await records.env.items('ir.translation').search([
            ['label', '=', tname],
            ['type', '=', 'model'],
            ['resId', 'in', realRecs._ids]
          ])).unlink();
        }
        else if (singleLang) {
          await records.env.items('ir.translation')._updateTranslations(realRecs._ids.map(resId => new Dict({
            'src': sourceValue,
            'value': value,
            'label': tname,
            'lang': lang,
            'type': 'model',
            'state': 'translated',
            'resId': resId
          })))
        }
        else {
          await records.env.items('ir.translation')._setIds(tname, 'model', lang, realRecs._ids, value, sourceValue)
        }
      }
    }
    return records;
  }
}

@MetaField.define()
class _Char extends _String {
  static type = 'char';
  static columnCastFrom = ['TEXT']

  static size = undefined;                   // maximum size of values (deprecated)
  static trim = true;                        // whether value is trimmed (only by web client)

  get columnType() { return ['VARCHAR', this.size ? `VARCHAR(${this.size})` : 'VARCHAR'] }

  convertDataType(type: string) {
    return dbFactory.convertDataTypeVarchar(type);
  }

  async updateDbColumn(model, column) {
    const self = this as any;
    // Xu ly type va size
    let maximum;
    if (bool(column)) {
      const type = column['type'] as string
      maximum = dbFactory.getVarcharMaximumLength(type);
    }
    if (
      bool(column) && maximum && (!self.size || maximum < self.size)
    ) {
      // the column's varchar size does not match this.size; convert it
      await sql.convertColumn(model._cr, model.constructor._table, self.name, self.columnType[1])
    }
    await super.updateDbColumn(model, column)
  }

  static get _relatedSize() { return attrgetter('size') }
  static get _relatedTrim() { return attrgetter('trim') }
  static get _descriptionSize() { return attrgetter('size') }
  static get _descriptionTrim() { return attrgetter('trim') }

  async convertToColumn(value, record, values?: any, validate = true) {
    if (value == null || value === false) {
      return null;
    }
    return super.convertToColumn(toText(value).slice(0, this.size), record, values, validate);
  }

  async convertToCache(value, record, validate = true) {
    if (value == null || value === false) {
      return null;
    }
    return toText(value).slice(0, this.size);
  }
}

@MetaField.define()
class _Text extends _String {
  static type = 'text';
  get columnType() { return ['TEXT', 'TEXT'] }

  async convertToCache(value, record, validate = true) {
    if (value == null || value === false) {
      return null;
    }
    return value;
  }
}

@MetaField.define()
class _Html extends _String {
  static type = 'html';
  static columnCastFrom = ['VARCHAR']       // text
  static sanitize = true                    // whether value must be sanitized
  static sanitizeTags = true                // whether to sanitize tags (only a white list of attributes is accepted)
  static sanitizeAttributes = true          // whether to sanitize attributes (only a white list of attributes is accepted)
  static sanitizeStyle = false              // whether to sanitize style attributes
  static sanitizeForm = true                // whether to sanitize forms
  static stripStyle = false                 // whether to strip style attributes (removed and therefore not sanitized)
  static stripClasses = false               // whether to strip classes attributes

  static get _relatedSanitize() { return attrgetter('sanitize') }
  static get _relatedSanitizeTags() { return attrgetter('sanitizeTags') }
  static get _relatedSanitizeAttributes() { return attrgetter('sanitizeAttributes') }
  static get _relatedSanitizeStyle() { return attrgetter('sanitizeStyle') }
  static get _relatedStripStyle() { return attrgetter('stripStyle') }
  static get _relatedStripClasses() { return attrgetter('stripClasses') }

  static get _descriptionSanitize() { return attrgetter('sanitize') }
  static get _descriptionSanitizeTags() { return attrgetter('sanitizeTags') }
  static get _descriptionSanitizeAttribtes() { return attrgetter('sanitizeAttributes') }
  static get _descriptionSanitizeStyle() { return attrgetter('sanitizeStyle') }
  static get _descriptionStripStyle() { return attrgetter('stripStyle') }
  static get _descriptionStripClasses() { return attrgetter('stripClasses') }

  get columnType() { return ['TEXT', 'TEXT'] }

  _getAttrs(modelClass, name) {
    // called by _setupAttrs(), working together with _String._setupAttrs()
    const attrs = super._getAttrs(modelClass, name);
    // Translated sanitized html fields must use htmlTranslate or a callable.
    if (attrs.get('translate') === true && attrs.get('sanitize', true)) {
      attrs['translate'] = htmlTranslate;
    }
    return attrs;
  }

  async convertToColumn(value, record, values?: any, validate = true) {
    return super.convertToColumn(this._convert(value, record, true), record, values, validate);
  }

  async convertToCache(value, record, validate = true) {
    return this._convert(value, record, validate);
  }

  _convert(value, record, validate = true) {
    if (value == null || value === false) {
      return null;
    }
    if (validate && this.sanitize) {
      return htmlSanitize(
        value, {
        silent: true,
        sanitizeTags: this.sanitizeTags,
        sanitizeAttributes: this.sanitizeAttributes,
        sanitizeStyle: this.sanitizeStyle,
        sanitizeForm: this.sanitizeForm,
        stripStyle: this.stripStyle,
        stripClasses: this.stripClasses
      }
      );
    }
    return value
  }

  async convertToRecord(value, record) {
    let r = await super.convertToRecord(value, record);
    if (isInstance(r, Uint8Array)) {
      r = r.decode();
    }
    return markup(r);
  }

  async convertToRead(value, record, useNameGet = true) {
    let r = await super.convertToRead(value, record, useNameGet);
    if (isInstance(r, Uint8Array)) {
      r = r.decode();
    }
    return markup(r);
  }

  async getTransTerms(value) {
    // ensure the translation terms are stringified, otherwise we can break the PO file
    return (await super.getTransTerms(value)).map(v => `${v}`);
  }
}

@MetaField.define()
export class _Date extends Field {
  static type = 'date';
  static columnCastFrom = [dbFactory.getDataTypeDatetime()];

  get columnType() { return ['DATE', 'DATE'] }

  /**
   * Return the current date as seen in the client's timezone in a format
    fit for date fields.
   ** note:: This method may be used to compute default values.
   * @param record recordset from which the timezone will be obtained.
   * @param timestamp optional datetime value to use instead of
        the current date and time (must be a datetime, regular dates
        can't be converted between timezones).
   * @returns a Date
   */
  static async contextToday(record, timestamp?: number) {
    const today = timestamp ?? Date.now();
    let contextToday;
    const timeZone = record._context['tz'] ?? await (await record.env.user()).tz;
    if (timeZone) {
      try {
        const todayUtc = (new Date()).toLocaleString('en-US', {
          timeZone: 'UTC'
        });
        contextToday = new Date(todayUtc);
      } catch (e) {
        console.debug("failed to compute context/client-specific today date, using UTC value for `today`");
      }
    }
    return contextToday ?? new Date(today);
  }

  async convertFromColumn(value, record, values?: any, validate = true): Promise<any> {
    return _Date.toDate(value);
  }

  async convertToColumn(value, record, values?: any, validate = true): Promise<any> {
    if (value == null || value === false) {
      return null;
    }
    if (typeof (value) == 'string') {
      if (!value.includes('T') && value.length == DATETIME_FORMAT.length) {
        const timeZone = record._context['tz'] || await (await record.env.user()).tz;
        return fromFormat(value, DATETIME_FORMAT, { zone: timeZone || 'UTC' }).toISOString();
      }
      return value;
    }
    const date = new Date(value);
    if (!(date instanceof Date)) {
      console.log('value is Invalid time value', value);
    }
    return date.toISOString(); // write to postgres type timestamp
  }

  static today(date?: Date) {
    return today(date);
  }

  static get min() {
    return new Date('0001-01-01');
  }

  static get max() {
    return new Date('9999-12-31');
  }

  /**
   * Convert a class `Date` object to a string.
   * @param value value to convert.
   * @returns a string representing `value` in the server's date format, if `value` is of
        type class `Date`, the hours, minute, seconds, tzinfo will be truncated.
   */
  static toString(value?: Date) {
    return value ? DateTime.fromJSDate(value).toFormat(DATE_FORMAT) : false;
  }

  [util.inspect.custom]() {
    return `${this.modelName}.${this.name}`;
  }

  /**
   * Attempt to convert `value` to a class `Date` object.
     warning
        If a datetime object is given as value,
        it will be converted to a date object and all
        datetime-specific information will be lost (HMS, TZ, ...).
   * @param value value to convert, type value: string or Date
   * @returns an object representing `value` type `Date` or `null`
   */
  static toDate(value?: string | Date, JSDate: boolean = true) {
    return toDate(value, JSDate);
  }

  async convertToCache(value: Date, record, validate = true) {
    if (!value) {
      return null;
    }
    return _Date.toDate(value) as Date;
  }

  async convertToExport(value, record) {
    if (!value) {
      return '';
    }
    return _Date.toDate(value) as Date;
  }

  async convertToRead(value, record, useNameGet = true) {
    return value == null ? false : _Date.toDate(value);
  }
}

@MetaField.define()
export class _Datetime extends Field {
  static type = 'datetime';
  static columnCastFrom = ['DATE'];

  get columnType() { return [dbFactory.getDataTypeDatetime(), dbFactory.getDataTypeDatetime()]; }

  async convertToColumn(value, record, values?: any, validate = true): Promise<any> {
    if (value == null || value === false) {
      return null;
    }
    if (typeof (value) == 'string') {
      if (!value.includes('T') && value.length == DATETIME_FORMAT.length) {
        const timeZone = record._context['tz'] || await (await record.env.user()).tz;
        return fromFormat(value, DATETIME_FORMAT, { zone: timeZone || 'UTC' }).toISOString();
      }
      return value;
    }
    return new Date(value).toISOString(); // write to postgres type timestamp
  }

  async convertFromColumn(value, record, values?: any, validate = true): Promise<any> {
    return _Datetime.toDatetime(value);
  }

  async convertToRead(value, record, useNameGet = true) {
    return value == null ? false : value instanceof Date ? value : new Date(value);
  }

  async convertToCache(value: Date | string, record, validate = true) {
    if (!value) {
      return null;
    }
    if (typeof (value) == 'string') {
      if (!value.includes('T') && value.length == DATETIME_FORMAT.length) {
        const timeZone = record._context['tz'] || await (await record.env.user()).tz;
        return fromFormat(value, DATETIME_FORMAT, { zone: timeZone || 'UTC' });
      }
    }
    return _Datetime.toDatetime(value) as Date;
  }

  convertDataType(type: string) {
    return dbFactory.convertDataTypeDatetime(type);
  }

  static now(...args: any[]) {
    const dt = new Date();
    dt.setMilliseconds(0);
    return dt;
  }

  static async contextTimestamp(record: any, timestamp: Date): Promise<Date> {
    assert(isInstance(timestamp, Date), 'Datetime instance expected');
    const timeZone = record._context['tz'] || await (await record.env.user()).tz;
    return timeZone ? DateTime.fromJSDate(timestamp, { zone: timeZone || 'UTC' }).toJSDate() : timestamp;
  }

  /**
   * Convert an ORM `value` into a class `Date` value.
   * @param value value to convert, type `string` or `Date`
   * @returns an object representing `value`, type `Date` or `null` 
   */
  static toDatetime(value: string | Date, JSDate: boolean = true): DateTime | Date | null {
    return toDatetime(value, JSDate);
  }

  static toString(value) {
    return value ? DateTime.fromJSDate(value).toFormat(DATETIME_FORMAT) : false;
  }

  [util.inspect.custom]() {
    return `${this.modelName}.${this.name}`;
  }
}

@MetaField.define()
class _Binary extends Field {
  static type = 'binary';
  static prefetch = false                 // not prefetched by default
  static attachment = true                // whether value is stored in attachment
  static _dependsContext = ['binSize']    // depends on context (content or size)

  static get _descriptionAttachment() { return attrgetter('attachment') }

  get columnType() { return this.attachment ? null : [dbFactory.getDataTypeBlob(), dbFactory.getDataTypeBlob()] }

  _getAttrs(modelClass, name) {
    const attrs = super._getAttrs(modelClass, name);
    if (!attrs.get('store', true)) {
      attrs['attachment'] = false;
    }
    return attrs;
  }

  async convertToColumn(value: any, record: any, values?: any, validate = true): Promise<any> {
    if (!value) {
      return null;
    }

    const magicBytes = new Set([...Buffer.from('P<', 'ascii')]); //first 6 bits of '<' (0x3C) b64 encoded; plaintext XML tag opening
    if (typeof value === 'string') {
      value = encode(value);
    }
    if (magicBytes.has(value[0])) {
      let decodedValue;
      try {
        decodedValue = b64decode(value);
      } catch (e) {
        //except binascii.Error:
        // decoded_value = value
        // Full mimetype detection
        // if (guess_mimetype(decoded_value).startsWith('image/svg') and
        //         not record.env.isSystem()):
        //     raise UserError(await this._t(record.env, "Only admins can upload SVG files."))
      }
    }

    if (isInstance(value, Uint8Array)) {
      return value;
    }
    try {
      return Buffer.from(Buffer.from(value).toString('ascii'));
    } catch (e) {
      throw new UserError(await this._t("ASCII characters are required for %s in %s", value, this.name));
    }
  }

  async convertToCache(value: any, record: any, validate?: boolean): Promise<any> {
    if (typeof value === 'string') {
      return Buffer.from(value);
    }
    if (typeof value === 'number' && (record._context['binSize'] || record._context['binSize' + UpCamelCase(this.name)])) {
      value = humanSize(value);
      return value ? Buffer.from(value) : null;
    }
    return value === false ? null : value;
  }

  async convertToRecord(value: any, record: any): Promise<any> {
    return value == null ? false : value;
  }

  async computeValue(records) {
    const binSizeName = 'binSize' + UpCamelCase(this.name);
    if (records.env.context['binSize'] || records.env.context[binSizeName]) {
      // always compute without binSize
      const recordsNoBinSize = await records.withContext({ 'binSize': false, [binSizeName]: false });
      await super.computeValue(recordsNoBinSize);
      // manually update the binSize cache
      const cache = records.env.cache;
      for (const [recordNoBinSize, record] of _.zip<ModelRecords, ModelRecords>([...recordsNoBinSize], [...records])) {
        try {
          let value = cache.get(recordNoBinSize, this);
          try {
            value = b64decode(value);
          } catch (e) {
            if (!isInstance(e, TypeError)) {
              throw e;
            }
          }
          try {
            if (isInstance(value, Uint8Array)) {
              value = humanSize(len(value));
            }
          } catch (e) {
            if (!isInstance(e, TypeError)) {
              throw e;
            }
          }
          const cacheValue = await this.convertToCache(value, record);
          cache.set(record, this, cacheValue);
        } catch (e) {
          if (!isInstance(e, CacheMiss)) {
            throw e;
          }
        }
      }
    }
    else {
      await super.computeValue(records);
    }
  }

  async read(records: ModelRecords) {
    // values are stored in attachments, retrieve them
    assert(this.attachment);
    const domain = [
      ['resModel', '=', records._name],
      ['resField', '=', this.name],
      ['resId', 'in', records.ids],
    ];
    // Note: the 'binSize' flag is handled by the field 'datas' itself
    const data = {};
    for (const att of await (await records.env.items('ir.attachment').sudo()).search(domain)) {
      data[await att.resId] = await att.datas;
    }
    const cache = records.env.cache;
    for (const record of records) {
      cache.set(record, this, data[record.id] ?? false);
    }
  }

  async create(recordValues) {
    assert(this.attachment);
    if (!bool(recordValues)) {
      return
    }
    // create the attachments that store the values
    const env: Environment = recordValues[0][0].env;
    // with env.noRecompute():
    let rec = await env.items('ir.attachment').sudo();
    rec = await rec.withContext({
      binaryFieldRealUser: await env.user(),
    });
    await rec.create(
      recordValues
        .filter(([record, value]) => !!value)
        .map(([record, value]) => {
          return {
            'label': this.name,
            'resModel': this.modelName,
            'resField': this.name,
            'resId': record.id,
            'type': 'binary',
            'datas': value,
          }
        })
    );
  }

  async write(records: ModelRecords, value) {
    if (!this.attachment) {
      return super.write(records, value);
    }
    // discard recomputation of self on records
    records.env.removeToCompute(this, records);

    // update the cache, and discard the records that are not modified
    const cache = records.env.cache;
    const cacheValue = await this.convertToCache(value, records);
    records = cache.getRecordsDifferentFrom(records, this, cacheValue);
    if (!records.ok) {
      return records;
    }
    let notNull;
    if (this.store) {
      // determine records that are known to be not null
      notNull = cache.getRecordsDifferentFrom(records, this, null);
    }
    cache.update(records, this, Array(records._length).fill(cacheValue));

    // retrieve the attachments that store the values, and adapt them
    if (this.store && records._ids.some(id => id)) {
      const realRecords = await records.filtered('id');
      let atts = await records.env.items('ir.attachment').sudo();
      if (notNull.ok) {
        atts = await atts.search([
          ['resModel', '=', this.modelName],
          ['resField', '=', this.name],
          ['resId', 'in', realRecords.ids],
        ]);
      }
      if (len(value)) {
        // update the existing attachments
        await atts.write({ 'datas': value });
        const attsRecords = records.browse(await atts.mapped('resId'));
        // create the missing attachments
        const missing = realRecords.sub(attsRecords);
        if (missing.ok) {
          await atts.create(await missing.map(record => {
            return {
              'label': this.name,
              'resModel': record._name,
              'resField': this.name,
              'resId': record.id,
              'type': 'binary',
              'datas': value,
            }
          }));
        }
      }
      else {
        await atts.unlink();
      }
    }
    return records;
  }
}

@MetaField.define()
class _Image extends _Binary {
  static maxWidth = 0;
  static maxHeight = 0;
  static varifyResolution = true;

  async create(recordValues) {
    const newRecordValues = [];
    for (const [record, value] of recordValues) {
      // strange behavior when setting related image field, when 'this' does not resize the same way as its related field
      const newValue = await this._imageProcess(value);
      newRecordValues.push([record, newValue]);
      const cacheValue = await this.convertToCache(this.related ? value : newValue, record);
      record.env.cache.update(record, this, _.fill(Array(record._length), cacheValue));
    }
    await super.create(newRecordValues);
  }

  async write(records, value) {
    let newValue;
    try {
      newValue = await this._imageProcess(value);
    } catch (e) {
      if (isInstance(e, UserError)) {
        if (!records._ids.some(id => id)) {
          // Some crap is assigned to a new record. This can happen in an onchange, where the client sends the "bin size" value of the field instead of its full value (this saves bandwidth). In this case, we simply don't assign the field: its value will be taken from the records' origin.
          return;
        }
        throw e;
      }
      else {
        // throw e: 'Input buffer contains unsupported image format'
        newValue = value; // maybe humanread
      }
    }

    await super.write(records, newValue);
    const cacheValue = await this.convertToCache(this.related ? value : newValue, records);
    records.env.cache.update(records, this, _.fill(Array(records._length), cacheValue));
  }

  async _imageProcess(value) {
    return imageProcess(value,
      {
        size: [this.maxWidth, this.maxHeight],
        verifyResolution: this.verifyResolution
      },
    );
  }

  /**
   * Override to resize the related value before saving it on self.
   * @param value 
   * @returns 
   */
  async _processRelated(value) {
    try {
      const image = await this._imageProcess(await super._processRelated(value));
      return image;
    }
    catch (e) {
      if (isInstance(e, UserError)) {
        // Avoid the following `write` to fail if the related image was saved
        // invalid, which can happen for pre-existing databases.
        return false;
      }
      else {
        throw e;
      }
    }
  }
}

@MetaField.define()
class _Selection extends Field {
  static type = 'selection';
  static selection = null;            // [[value, string)], ...], function or method name
  static validate = true;             // whether validating upon write
  static ondelete = null;             // {value: policy} (what to do when value is deleted)

  get columnType() { return ['VARCHAR', 'VARCHAR(255)'] }

  convertDataType(type: string) {
    return dbFactory.convertDataTypeVarchar(type);
  }

  constructor(selection: string | Function | any[] | FieldOptions | undefined, kwargs: FieldOptions = {}) {
    super(!selection ? kwargs : Object.assign(kwargs, {
      'selection': selection,
    }))
  }

  setupNonrelated(model) {
    super.setupNonrelated(model);
    assert(this.selection != null, `Field ${this} without selection`);
  }

  setupRelated(model) {
    super.setupRelated(model);
    // selection must be computed on related field
    const field = this.relatedField;
    this.selection = async (model) => await field._descriptionSelection(field, model.env);
  }

  _getAttrs(modelClass, name) {
    const attrs = super._getAttrs(modelClass, name);
    // arguments 'selection' and 'selectionAdd' are processed below
    attrs.pop('selectionAdd', null)
    // Selection fields have an optional default implementation of a groupExpand function
    if (attrs.get('groupExpand') == true)
      attrs['groupExpand'] = this._defaultGroupExpand
    return attrs
  }

  _setupAttrs(modelClass, name) {
    super._setupAttrs(modelClass, name);
    if (!this._baseFields.length)
      return

    // determine selection (applying 'selectionAdd' extensions)
    let values = null;
    let labels = new Dict<any>();
    const self = this as any;
    for (const field of this._baseFields) {
      // We cannot use field.selection or field.selectionAdd here
      // because those attributes are overridden by '_setupAttrs'.
      if ('selection' in field.args) {
        if (self.related) {
          console.warn("%s: selection attribute will be ignored as the field is related", self);
        }
        const selection: [string, string][] = field.args['selection']
        if (Array.isArray(selection)) {
          if (values != null && !_.isEqual(values, selection.map(kv => kv[0]))) {
            console.warn("%s: selection=%s overrides existing selection; use selectionAdd instead", self, selection);
          }
          values = selection.map(kv => kv[0]);
          labels = new Dict(selection);
          self.ondelete = {}
        }
        else {
          values = null;
          labels = new Dict();
          self.selection = selection;
          self.ondelete = null;
        }
      }

      if ('selectionAdd' in field.args) {
        if (self.related) {
          console.warn("%s: selectionAdd attribute will be ignored as the field is related", self);
        }
        const selectionAdd = field.args['selectionAdd'];
        assert(Array.isArray(selectionAdd), `${this}: selectionAdd=${selectionAdd} must be a list`);
        assert(values != null, `${this}: selectionAdd=${selectionAdd} on non-list selection ${self.selection}`);

        const ondelete = new Dict<any>(field.args['ondelete'] ?? {});
        const newValues = selectionAdd.map(kv => kv[0]).filter(kv => !values.includes(kv));
        for (const key of newValues) {
          ondelete.setdefault(key, 'SET NULL');
        }
        if (this.required && newValues.length && Object.values(ondelete).includes('SET NULL')) {
          throw new ValueError(
            `${self}: required selection fields must define an ondelete policy that implements the proper cleanup of the corresponding records upon module uninstallation. Please use one or more of the following policies: 'SET DEFAULT' (if the field has a default defined), 'CASCADE', or a single-argument callable where the argument is the recordset containing the specified option.`
          )
        }

        // check ondelete values
        for (const [key, val] of ondelete.items()) {
          if (isCallable(val) || ['SET NULL', 'CASCADE'].includes(val)) {
            continue;
          }
          if (val === 'SET DEFAULT') {
            assert(self.default != null,
              `'${self.modelName}.${self}' (default=${self.default}): ondelete policy of type 'SET DEFAULT' is invalid for this field as it does not define a default! Either define one in the base field, or change the chosen ondelete policy`,
            );
            continue;
          }
          // else if (val.startsWith('SET ')) {
          //   assert (values.includes(val.slice(4)), 
          //     `'${self.modelName}.${self}': ondelete policy of type 'set %%' must be either 'SET NULL', 'SET DEFAULT', or 'set value' where value is a valid selection value.`);
          // }
          // else {
          throw new ValueError(
            "%s: ondelete policy %s for selection value %s is not a valid ondelete policy, please choose one of 'SET NULL', 'SET DEFAULT', 'CASCADE' or a callable", self, val, key
          );
          // }
        }

        values = mergeSequences(values, selectionAdd.map(kv => kv[0]));
        labels.updateFrom(selectionAdd.filter(kv => kv.length === 2));
        setOptions(self.ondelete, ondelete);
      }
    }

    if (values != null) {
      self.selection = values.map((value) => [value, labels[value]]);
    }

    if (Array.isArray(self.selection)) {
      assert(self.selection.every(([v]) => typeof v === 'string'), `Field ${self} with non-str value in selection`);
    }
  }

  /**
   * Return a mapping from selection values to modules defining each value.
   * @param self 
   * @param model 
   * @returns 
   */
  _selectionModules(model) {
    if (!Array.isArray(this.selection)) {
      return {}
    }
    const valueModules = new DefaultDict();
    for (const field of resolveMro(model, this.name, (this.constructor as any).__instancecheck__).reverse()) {
      const module = field._moduleName;
      if (!module) {
        continue;
      }
      if ('selection' in field.args) {
        valueModules.clear();
        if (Array.isArray(field.args['selection'])) {
          for (const [value] of field.args['selection']) {
            if (!valueModules.has(value)) {
              valueModules.set(value, new Set<any>());
            }
            valueModules.get(value).add(module);
          }
        }
      }
      if ('selectionAdd' in field.args) {
        for (const valueLabel of field.args['selectionAdd']) {
          if (valueLabel.length > 1) {
            if (!valueModules.has(valueLabel[0])) {
              valueModules.set(valueLabel[0], new Set<any>());
            }
            valueModules.get(valueLabel[0]).add(module);
          }
        }
      }
    }
    return valueModules;
  }

  async _defaultGroupExpand(records, groups, domain, order) {
    // return a group per selection option, in definition order
    return this.getValues(records.env);
  }

  async convertToColumn(value, record, values?: any, validate = true) {
    if (validate && this.validate) {
      value = await this.convertToCache(value, record);
    }
    return super.convertToColumn(value, record, values, validate);
  }

  async convertToExport(value, record) {
    if (!Array.isArray(this.selection)) {
      return value ? value : '';
    }
    for (const item of await this._descriptionSelection(this, record.env)) {
      if (item[0] === value) {
        return item[1];
      }
    }
    return '';
  }

  async convertToCache(value, record, validate = true) {
    if (!validate)
      return value ? value : null
    if (value && this.columnType[0] === 'INTEGER')
      value = _.toInteger(value)
    if ((await this.getValues(record.env)).includes(value))
      return value
    else if (!value)
      return null
    throw new ValueError("Wrong value for %s: %s", this, value)
  }

  /**
   * Return a list of the possible values.
   * @param env 
   * @returns 
   */
  async getValues(env): Promise<string[]> {
    let selection = this.selection;
    if (typeof selection === 'string') {
      const model = env.items(this.modelName);
      selection = await model[selection].call(model);
    }
    else if (isCallable(selection)) {
      selection = await selection(env.items(this.modelName));
    }
    return selection.map(([value]) => value);
  }

  /**
   * return the selection list (pairs [value, label]); labels are translated according to context language
   * @param env 
   * @returns 
   */
  static async _descriptionSelection(self: Field, env: Environment) {
    const selection = self.selection;
    const model = env.items(self.modelName);
    if (typeof selection === 'string') {
      const func = model[selection];
      if (func) {
        return func.call(model);
      }
      else {
        return selection;
      }
    }
    if (isCallable(selection)) {
      return selection(model);
    }
    // translate selection labels
    if (env.lang) {
      return env.items('ir.translation').getFieldSelection(self.modelName, self.name);
    }
    else {
      return selection;
    }
  }
}

/**
 * A reference data type like record (object) but saved to the database in string form, for example: 'ir.actions.actwindow,123' refers to the record type "ir.actions.actwindow" with id = 123
 */
@MetaField.define()
class _Reference extends _Selection {
  static type = 'reference';

  get columnType() { return ['VARCHAR', 'VARCHAR(255)'] }

  convertDataType(type: string) {
    return dbFactory.convertDataTypeVarchar(type);
  }

  async convertToColumn(value, record, values?: any, validate = true) {
    return super.convertToColumn(value, record, values, validate)
  }

  async convertToCache(value, record, validate = true) {
    // cache format: string ("model,id") or null
    if (isInstance(value, BaseModel)) {
      if (!validate || ((await this.getValues(record.env)).includes(value._name) && value.length <= 1)) {
        return value ? `${value._name},${value.id}` : null
      }
    }
    else if (typeof value === 'string') {
      const [resModel, resId] = value.split(',')
      if (!validate || (await this.getValues(record.env)).includes(resModel)) {
        if (bool(await record.env.items(resModel).browse(func.parseInt(resId)).exists())) {
          return value;
        }
        else {
          return null;
        }
      }
    }
    else if (!value) {
      return null;
    }
    throw new ValueError("Wrong value for %s: %s", this, value)
  }

  async convertToRecord(value, record) {
    if (value) {
      const [resModel, resId] = value.split(',');
      return record.env.items(resModel).browse(func.parseInt(resId));
    }
    return null;
  }

  async convertToRead(value, record, useNameGet = true) {
    return value ? `${value._name},${value.id}` : false;
  }

  async convertToExport(value, record) {
    return value.ok ? await value.displayName : '';
  }

  async convertToDisplayName(value, record) {
    return `${value.ok && await value.displayName}`;
  }
}

/**
 * Abstract class for relational fields.
 */
@MetaField.define()
class _Relational extends Field {
  static relational = true
  static domain = []                         // domain for searching values
  static context = {}                        // context for searching values
  static checkCompany = false

  static get _relatedContext() { return attrgetter('context') }
  static get _descriptionRelation() { return attrgetter('comodelName') }
  static get _descriptionContext() { return attrgetter('context') }

  async __get__(records, owner) {
    // base case: do the regular access
    if (records == null || len(records._ids) <= 1) {
      return super.__get__(records, owner);
    }
    // multirecord case: use mapped
    return this.mapped(records);
  }

  setupNonrelated(model: any) {
    super.setupNonrelated(model);
    if (!model.pool.models[this.comodelName]) {
      console.warn("Field %s with unknown comodelName %s", this, this.comodelName);
      this.comodelName = 'unknown';
    }
  }

  /**
   * Return a list domain from the domain parameter.
   * @param model 
   * @returns 
   */
  async getDomainList(model) {
    let domain = this.domain;
    if (isCallable(domain)) {
      domain = await domain(model)
    }
    return Array.isArray(domain) ? domain : [];
  }

  static get _descriptionDomain() {
    return async (self: Field, env: Environment) => {
      if (self.checkCompany && !self.domain) {
        if (self.companyDependent) {
          if (self.comodelName === "res.users") {
            // user needs access to current company (self.env.company)
            return "[['companyIds', 'in', allowedCompanyIds[0]]]";
          }
          else {
            return "[['companyId', 'in', [allowedCompanyIds[0], false]]]";
          }
        }
        else {
          // when using checkCompany=true on a field on 'res.company', the
          // companyId comes from the id of the current record
          const cid = self.modelName === "res.company" ? "id" : "companyId";
          if (self.comodelName === "res.users") {
            // User allowed company ids = user.companyIds
            return `['|', [not ${cid}, '=', true), ['companyIds', 'in', [${cid}]]]`;
          }
          else {
            return `[['companyId', 'in', [${cid}, false]]]`;
          }
        }
      }
      return isCallable(self.domain) ? await self.domain(env.items(self.modelName)) : self.domain;
    }
  }

  async null(record) {
    return record.env.items(this.comodelName);
  }
}

@MetaField.define()
export class _Many2one extends _Relational {
  static type = 'many2one'
  static ondelete = null                    // what to do when value is deleted
  static autojoin = false                   // whether joins are generated upon search
  static delegate = false                   // whether self implements delegation

  get columnType() { return ['INTEGER', 'INTEGER'] }

  protected _setupAttrs(modelClass: any, name: string) {
    super._setupAttrs(modelClass, name);
    if (!this.delegate && Object.values(modelClass._inherits).includes(name)) {
      this.delegate = true;
    }
    if (this.delegate) {
      this.autojoin = true;
    }
  }

  async updateDb(model, columns): Promise<boolean> {
    const comodel = model.env.models[this.comodelName];
    if (!model.constructor._transient && comodel._transient) {
      throw new ValueError('Many2one %s from Model to TransientModel is forbidden', this);
    }
    return super.updateDb(model, columns)
  }

  async updateDbColumn(model, column) {
    await super.updateDbColumn(model, column)
    const self = this as any;
    model.pool.postInit(self.updateDbForeignKey, self, model, column)
  }

  async updateDbForeignKey(self, model: ModelRecords, column) {
    const comodel = model.env.items(self.comodelName);
    // foreign keys do not work on views, and users can define custom models on sql views.
    if (!await model._isAnOrdinaryTable() || !await comodel._isAnOrdinaryTable())
      return
    // irActions is inherited, so foreign key doesn't work on it
    if (!comodel.cls._auto || comodel.cls._table === 'irActions')
      return
    // create/update the foreign key, and reflect it in 'ir.model.constraint'
    model.pool.addForeignKey(
      model.cls._table, self.name, comodel.cls._table, 'id', self.ondelete || 'SET NULL', model, self._moduleName
    )
  }

  setupNonrelated(model: any) {
    super.setupNonrelated(model);
    if (!this.ondelete) {
      const comodel = model.env.models[this.comodelName];
      if (model.cls._transient && !comodel._transient) {
        this.ondelete = this.required ? 'CASCADE' : 'SET NULL'
      } else {
        this.ondelete = this.required ? 'RESTRICT' : 'SET NULL'
      }
    }
    if (this.ondelete === 'SET NULL' && this.required) {
      console.log(`The m2o field ${this.name} of model ${model._name} is required but declares its ondelete policy as being 'SET NULL'. Only 'RESTRICT' and 'CASCADE' make sense.`)
    }
    if (this.ondelete === 'RESTRICT' && IR_MODELS.includes(this.comodelName)) {
      console.log(`Field ${this.name} of model ${model._name} is defined as ondelete='RESTRICT' while having ${this.comodelName} as comodel, the 'RESTRICT' mode is not supported for this type of field as comodel.`)
    }
  }

  /**
   * Update the cached value of `this` for `records` with `value`.
   * @param records 
   * @param value 
   */
  async _update(records: ModelRecords, value: any) {
    const cache = records.env.cache;
    for (const record of records) {
      cache.set(record, this, await this.convertToCache(value, record, false));
    }
  }

  async convertToRecord(value, record) {
    // use registry to avoid creating a recordset for the model
    const ids = value == null ? [] : [value];
    const prefetchIds = new IterableGenerator(prefetchMany2oneIds, record, this);
    return record.env.items(this.comodelName)._browse(record.env, ids, prefetchIds);
  }

  async convertToRecordMulti(values: any, records: ModelRecords) {
    // return the ids as a recordset without duplicates
    const prefetchIds = new IterableGenerator(prefetchMany2oneIds, records, this);
    const ids = unique(values.filter(id => id != null));
    return records.env.items(this.comodelName)._browse(records.env, ids, prefetchIds);
  }

  async convertToCache(value, record, validate = true) {
    // cache format: id or None
    let id;
    if (typeof value === 'number' || typeof value === 'string') {
      id = value;
    }
    else if (value instanceof NewId) {
      id = value;
    }
    else if (isInstance(value, BaseModel)) {
      if (validate && (value._name != this.comodelName || value.length > 1)) {
        throw new ValueError("Wrong value for %s: %s", this, value)
      }
      id = bool(value._ids) ? value._ids[0] : null;
    }
    else if (Array.isArray(value)) {
      // value is either a pair [id, name], or a list of ids
      id = value.length ? value[0] : null;
    }
    else if (isInstance(value, Object)) {
      // return a new record (with the given field 'id' as origin)
      const comodel = record.env.items(this.comodelName);
      const origin = comodel.browse(value['id']);
      id = (await comodel.new(value, { origin: origin })).id;
    } else {
      id = null;
    }
    if (this.delegate && record.ok && !(record._ids.some(id => bool(id)))) {
      // if all records are new, then so is the parent
      id = newId(id);
    }

    return id;
  }

  async convertToColumn(value, record, values?: any, validate = true) {
    return value ? value : null
  }

  async convertToRead(value: ModelRecords, record, useNameGet = true) {
    if (useNameGet && bool(value)) {
      // evaluate nameGet() as superuser, because the visibility of a
      // many2one field value (id and label) depends on the current record's
      // access rights, and not the value's access rights.
      try {
        // performance: value.sudo() prefetches the same records as value
        return [value.id, await (await value.sudo()).displayName];
      } catch (e) { // MissingError
        // Should not happen, unless the foreign key is missing.
        // console.error(e.message);
        return false;
      }
    } else {
      return value.id;
    }
  }

  async convertToWrite(value, record): Promise<Number | string | boolean> {
    if (typeof value === 'number' || typeof value === 'string') {
      return value;
    }
    if (value instanceof NewId) {
      return value;
    }
    if (!value) {
      return false;
    }
    if (isInstance(value, BaseModel) && value.constructor._name === this.comodelName) {
      return value.id;
    }
    if (Array.isArray(value)) {
      // value is either a pair [id, label], or a list of ids
      return value.length ? value[0] : false;
    }
    if (isInstance(value, Dict)) {
      const res = await record.env.items(this.comodelName).new(value);
      return res.id;
    }
    throw new ValueError("Wrong value for %s: %s", this, value);
  }

  async convertToExport(value, record) {
    return bool(value) ? await value.displayName : '';
  }

  async convertToDisplayName(value, record) {
    return `${await value.displayName}`;
  }

  async convertToOnchange(value, record, names) {
    return super.convertToOnchange(value._origin, record, names);
  }

  async write(records: ModelRecords, value) {
    // discard recomputation of self on records
    records.env.removeToCompute(this, records);

    // discard the records that are not modified
    const cache = records.env.cache;
    const cacheValue = await this.convertToCache(value, records);
    records = cache.getRecordsDifferentFrom(records, this, cacheValue);
    if (!records.ok) {
      return records;
    }

    // remove records from the cache of one2many fields of old corecords
    await this._removeInverses(records, cacheValue);

    // update the cache of this
    cache.update(records, this, _.fill(Array(records._length), cacheValue));

    // update towrite
    if (this.store) {
      records.env.all.towrite[this.modelName] = records.env.all.towrite[this.modelName] ?? new Dict<any>();
      const towrite = records.env.all.towrite[this.modelName];
      for (const record of await records.filtered('id')) {
        // cacheValue is already in database format
        towrite[record.id] = towrite[record.id] ?? new Dict<any>();
        towrite[record.id][this.name] = cacheValue;
      }
    }

    // update the cache of one2many fields of new corecord
    await this._updateInverses(records, cacheValue);

    return records;
  }

  /**
   * Remove `records` from the cached values of the inverse fields of `this`.
   * @param records 
   * @param value 
   */
  async _removeInverses(records: ModelRecords, value) {
    const cache = records.env.cache;
    const recordIds = new Set(records._ids);

    // align(id) returns a NewId if records are new, a real id otherwise
    const align = records._ids.every(id => bool(id))
      ? (id) => id
      : (id) => newId(id);

    for (const invf of records.pool.fieldInverses.get(this)) {
      const corecords = records.env.items(this.comodelName).browse(
        cache.getValues(records, this).map(id => align(id))
      );
      for (const corecord of corecords) {
        const ids0 = cache.get(corecord, invf, null);
        if (ids0 !== null) {
          const ids1 = ids0.filter(id => !recordIds.has(id));
          cache.set(corecord, invf, ids1);
        }
      }
    }
  }

  /**
   * Add `records` to the cached values of the inverse fields of `this`.
   * @param records 
   * @param value 
   * @returns 
   */
  async _updateInverses(records: ModelRecords, value?: {}) {
    if (value == null) {
      return;
    }
    const cache = records.env.cache;
    const corecord = await this.convertToRecord(value, records);
    for (const invf of records.pool.fieldInverses.get(this)) {
      const validRecords = await records.filteredDomain(await invf.getDomainList(corecord));
      if (!validRecords.ok) {
        continue;
      }
      const ids0 = cache.get(corecord, invf, null);
      // if the value for the corecord is not in cache, but this is a new record, assign it anyway, as you won't be able to fetch it from database (see `test_sale_order`)
      if (ids0 != null || !bool(corecord.id)) {
        const ids1 = unique((ids0 || []).concat(validRecords._ids));
        cache.set(corecord, invf, ids1);
      }
    }
  }
}

@MetaField.define()
class _Many2oneReference extends _Integer {
  static type = 'many2oneReference';
  static modelField = null;

  static get _relatedModelField() { return attrgetter('modelField') }

  async convertToCache(value, record, validate = true) {
    // cache format: id or null
    if (isInstance(value, BaseModel)) {
      value = bool(value._ids) ? value._ids[0] : null;
    }
    return super.convertToCache(value, record, validate)
  }

  /**
   * Remove `records` from the cached values of the inverse fields of `this`.
   * @param records 
   * @param value 
   */
  async _removeInverses(records: ModelRecords, value) {
    const cache = records.env.cache;
    const recordIds = new Set(records._ids);
    const modelIds = await this._recordIdsPerResModel(records);

    for (const invf of records.pool.fieldInverses.get(this)) {
      records = records.browse(modelIds[invf.modelName]);
      if (!records.ok) {
        continue;
      }
      const corecords = records.env.items(this.comodelName).browse(
        cache.getValues(records, this)
      );
      for (const corecord of corecords) {
        const ids0 = cache.get(corecord, invf, null);
        if (ids0 !== null) {
          const ids1 = ids0.filter(id => !recordIds.has(id))
          cache.set(corecord, invf, ids1);
        }
      }
    }
  }

  /**
   * Add `records` to the cached values of the inverse fields of `this`.
   * @param records 
   * @param value 
   * @returns 
   */
  async _updateInverses(records: ModelRecords, value?: {}) {
    if (value == null) {
      return;
    }
    const cache = records.env.cache;
    const modelIds = await this._recordIdsPerResModel(records);

    for (const invf of records.pool.fieldInverses.get(this)) {
      records = records.browse(modelIds[invf.modelName]);
      if (!records.ok) {
        continue;
      }
      const corecord = records.env.items(invf.modelName).browse(value);
      records = await records.filteredDomain(await invf.getDomainList(corecord));
      if (!records.ok) {
        continue;
      }
      const ids0 = await cache.get(corecord, invf, null);
      // if the value for the corecord is not in cache, but this is a new record, assign it anyway, as you won't be able to fetch it from database (see `test_sale_order`)
      if (ids0 != null || !bool(corecord.id)) {
        const ids1 = unique((ids0 || []).concat(records._ids));
        cache.set(corecord, invf, ids1);
      }
    }
  }

  async _recordIdsPerResModel(records: ModelRecords) {
    const modelIds = new DefaultDict();
    for (const record of records) {
      let model = await record[this.modelField];
      if (!model.ok && record._fields[this.modelField].compute) {
        // fallback when the model field is computed
        record._fields[this.modelField].computeValue(record);
        model = await record[this.modelField];
        if (!model.ok) {
          continue;
        }
      }
      modelIds[model] = modelIds[model] ?? new Set<any>();
      modelIds[model].add(record.id);
    }
    return modelIds;
  }
}

@MetaField.define()
class _RelationalMulti extends _Relational {
  static writeSequence = 20

  /**
   * Update the cached value of `this` for `records` with `value`, and return whether everything is in cache.
   * @param records 
   * @param value 
   * @returns 
   */
  async _update(records: ModelRecords, value) {
    if (!isInstance(records, BaseModel)) {
      // the inverse of self is a non-relational field; `value` is a
      // corecord that refers to `records` by an integer field
      const model = value.env.items(this.cls.modelName);
      const domain = isCallable(this.domain) ? await this.domain(model) : this.domain;
      if (! await value.filteredDomain(domain)) {
        return;
      }
      records = model.browse(records);
    }
    let result = true;

    if (bool(value)) {
      const cache = records.env.cache;
      for (const record of records) {
        if (cache.contains(record, this)) {
          const val = await this.convertToCache((await record[this.name]).or(value), record, false);
          cache.set(record, this, val);
        }
        else {
          result = false;
        }
      }
      await records.modified([this.name]);
    }

    return result;
  }

  async convertToCache(value, record, validate = true) {
    if (isInstance(value, BaseModel)) {
      if (validate && value.cls._name !== this.comodelName) {
        throw new ValueError("Wrong value for %s: %s", this, value);
      }
      let ids = value._ids;
      if (bool(record) && !bool(record.id)) {
        ids = ids.map((id) => newId(id));
      }
      return ids;
    } else if (isList(value)) {
      const comodel = record.env.items(this.comodelName);
      let browse;
      if (bool(record) && !bool(record.id)) {
        browse = (id) => comodel.browse([newId(id)]);
      } else {
        browse = comodel.browse.bind(comodel);
      }
      let ids = new OrderedSet2(validate ? (await record[this.name])._ids : []);
      for (const command of value) {
        if (isList(command)) {
          if (command[0] === Command.CREATE) {
            ids.add((await comodel.new(command[2], { ref: command[1] })).id);
          } else if (command[0] === Command.UPDATE) {
            const line = browse(command[1]);
            if (validate) {
              await line.update(command[2]);
            } else {
              await line._updateCache(command[2], false);
            }
            ids.add(line.id);
          } else if ([Command.DELETE, Command.UNLINK].includes(command[0])) {
            ids.discard(browse(command[1]).id);
          } else if (command[0] === Command.LINK) {
            ids.add(browse(command[1]).id);
          } else if (command[0] === Command.CLEAR) {
            ids.clear();
          } else if (command[0] === Command.SET) {
            ids = new OrderedSet2(command[2].map((it) => browse(it).id));
          }
        } else if (isInstance(command, Dict)) {
          ids.add((await comodel.new(command)).id);
        } else {
          ids.add(browse(command).id);
        }
      }
      return Array.from(ids);
    }
    else if (!bool(value)) {
      return [];
    }

    throw new ValueError("Wrong value for %s: %s", this, value);
  }

  async convertToRecord(value, record) {
    // use registry to avoid creating a recordset for the model
    const prefetchIds = new IterableGenerator(prefetchX2manyIds, record, this);
    const comodel = record.env.items(this.comodelName);
    let corecords = comodel._browse(record.env, value, prefetchIds);
    if (
      comodel.cls._activeName
      && (this.context['activeTest'] ?? record.env.context['activeTest'] ?? true)
    ) {
      corecords = (await corecords.filtered(comodel.cls._activeName)).withPrefetch(prefetchIds);
    }
    return corecords;
  }

  async convertToRecordMulti(values, records: ModelRecords) {
    // return the list of ids as a recordset without duplicates
    const prefetchIds = new IterableGenerator(prefetchX2manyIds, records, this);
    const Comodel = records.env.items(this.comodelName);
    let res = [];
    values.forEach((ids) => res = res.concat(ids));
    res = unique(res);
    let corecords = Comodel._browse(records.env, res, prefetchIds);
    if (
      Comodel.cls._activeName
      && (this.context['activeTest'] ?? records.env.context['activeTest'] ?? true)
    ) {
      corecords = (await corecords.filtered(Comodel.cls._activeName)).withPrefetch(prefetchIds);
    }
    return corecords;
  }

  async convertToRead(value, record, useNameGet = true) {
    return value.ids
  }

  async convertToWrite(value: any, record: ModelRecords) {
    if (Array.isArray(value)) {
      // a list of ids, this is the cache format
      value = record.env.items(this.comodelName).browse(value);
    }

    if (isInstance(value, BaseModel) && value.cls._name === this.comodelName) {
      function getOrigin(val) {
        return isInstance(val, BaseModel) ? val._origin : val;
      }
      // make result with new and existing records
      const invNames = record.pool.fieldInverses.get(this).map(field => field.name);
      let result = [Command.set([])];
      for (const record of value) {
        const origin = record._origin;
        if (!bool(origin)) {
          const res = {};
          for (const name of record._cache) {
            if (!invNames.includes(name)) {
              res[name] = await record[name];
            }
          }
          const values = await record._convertToWrite(res);
          result.push(Command.create(values));
        }
        else {
          (result[0][2] as any[]).push(origin.id);
          if (!record.eq(origin)) {
            const res = {};
            for (const name of record._cache) {
              if (!invNames.includes(name) && getOrigin(await record[name]) !== await origin[name]) {
                res[name] = await record[name];
              }
            }
            const values = await record._convertToWrite(res);
            if (values) {
              result.push(Command.update(origin.id, values));
            }
          }
        }
      }
      return result;
    }
    if (value === false || value == null) {
      return [Command.clear()];
    }

    throw new ValueError("Wrong value for %s: %s", this, value);
  }

  async convertToExport(value: ModelRecords, record) {
    return bool(value) ? (await value.nameGet()).map(([id, name]) => name).join(',') : '';
  }

  async convertToDisplayName(value, record): Promise<any> {
    throw new NotImplementedError();
  }

  async getDepends(model) {
    let [depends, dependsContext] = await super.getDepends(model);
    if (!this.compute && isList(this.domain)) {
      depends = unique(chain(depends, this.domain.filter(arg => Array.isArray(arg) && (typeof arg[0] === 'string')).map(arg => this.name + '.' + arg[0])));
    }
    return [depends, dependsContext];
  }

  async create(recordValues) {
    await this.writeBatch(recordValues, true);
  }

  async write(records: ModelRecords, value) {
    // discard recomputation of self on records
    records.env.removeToCompute(this, records);
    return this.writeBatch([[records, value]]);
  }

  async writeBatch(recordsCommandsList, create = false) {
    if (!recordsCommandsList) {
      return false;
    }

    for (let [idx, [recs, value]] of enumerate(recordsCommandsList)) {
      if (isInstance(value, BaseModel) && value.cls._name === this.comodelName) {
        value = [Command.set(value._ids)];
      }
      else if (value === false || value == null) {
        value = [Command.clear()];
      }
      else if (isList(value) && !Array.isArray(value[0])) {
        value = [Command.set(value)];
      }
      recordsCommandsList[idx] = [recs, value];
    }

    const recordIds = []
    for (const [recs, cs] of recordsCommandsList) {
      for (const rid of recs._ids) {
        recordIds.push(rid);
      }
    }
    if (recordIds.every(id => bool(id))) {
      return this.writeReal(recordsCommandsList, create);
    }
    else {
      assert(!recordIds.some(id => bool(id)));
      return this.writeNew(recordsCommandsList);
    }
  }
}

function prefetchMany2oneIds(record, field) {
  const records = record.browse(record._prefetchIds)
  const ids = record.env.cache.getValues(records, field)
  return unique(ids.filter((id_) => id_ != null))
}

function prefetchX2manyIds(record, field) {
  const records = record.browse(record._prefetchIds)
  const idsList = record.env.cache.getValues(records, field)
  let res = [];
  idsList.forEach((ids) => res = res.concat(ids));
  return unique(res);
}

@MetaField.define()
export class _One2many extends _RelationalMulti {
  static type = 'one2many';
  static relationField = null;                // name of the inverse field
  static autojoin = false;                    // whether joins are generated upon search
  static limit = null;                        // optional limit to use upon read
  static copy = false;                        // o2m are not copied by default

  static get _descriptionRelationField() { return attrgetter('relationField') }

  async __get__(records, owner): Promise<any> {
    if (records != null && this.relationField != null) {
      const inverseField = records.env.models[this.comodelName]._fields[this.relationField];
      if (inverseField.compute) {
        await records.env.items(this.comodelName).recompute([this.relationField]);
      }
    }
    return super.__get__(records, owner);
  }

  setupNonrelated(model) {
    super.setupNonrelated(model);
    if (this.relationField) {
      // link self to its inverse field and vice-versa
      const comodel = model.env.items(this.comodelName);
      const invf = comodel._fields[this.relationField];
      if (invf instanceof _Many2one || invf instanceof _Many2oneReference) {
        // setting one2many fields only invalidates many2one inverses;
        // integer inverses (resModel/resId pairs) are not supported
        model.pool.fieldInverses.add(this, invf);
      }
      comodel.pool.fieldInverses.add(invf, this);
    }
  }

  async updateDb(model, columns): Promise<any> {
    if (this.comodelName in model.env.models) {
      const comodel = model.env.models[this.comodelName];
      if (!(this.relationField in comodel._fields)) {
        throw new ValueError("No inverse field %s found for %s", this.relationField, this.comodelName);
      }
    }
  }

  async read(records: ModelRecords) {
    // retrieve the lines in the comodel
    const context = { 'activeTest': false };
    Object.assign(context, this.context);
    const comodel = await records.env.items(this.comodelName).withContext(context);
    const inverse = this.relationField;
    const inverseField = comodel._fields[inverse];
    const getId = inverseField.type === 'many2one' ? (rec => rec.id) : func.parseInt;
    const domain = (await this.getDomainList(records)).concat([[inverse, 'in', records.ids]]);
    const lines = await comodel.search(domain, { limit: this.limit });

    // group lines by inverse field (without prefetching other fields)
    const group = new Dict<any[]>();
    for (const line of await lines.withContext({ prefetchFields: false })) {
      // line[inverse] may be a record or an integer
      const id = getId(await line[inverse]);
      group[id] = group[id] ?? [];
      group[id].push(line.id);
    }
    // store result in cache
    const cache = records.env.cache;
    for (const record of records) {
      cache.set(record, this, group[record.id] ?? []);
    }
  }

  async getDomainList(records) {
    const comodel = records.env.registry.models[this.comodelName];
    const inverseField = comodel._fields[this.relationField];
    let domain = await super.getDomainList(records);
    if (inverseField.type === 'many2oneReference') {
      domain = domain.concat([[inverseField.modelField, '=', records._name]]);
    }
    return domain;
  }

  async writeReal(recordsCommandsList, create = false) {
    // recordsCommandsList = [[records, commands], ...]
    if (!recordsCommandsList) {
      return;
    }

    const model = recordsCommandsList[0][0].browse();
    const comodel = await model.env.items(this.comodelName).withContext(this.context);

    const ids = [];
    for (const [recs, cs] of recordsCommandsList) {
      for (const rid of recs.ids) {
        ids.push(rid);
      }
    }
    const records = recordsCommandsList[0][0].browse(ids);

    if (this.store) {
      const inverse = this.relationField;
      let toCreate = [];                  // line vals to create
      let toDelete = [];                  // line ids to delete
      let toLink = new DefaultDict();     // {record: lineIds}
      let allowFullDelete = !create;

      function unlink(lines) {
        if (getattr(comodel._fields[inverse], 'ondelete', false) === 'CASCADE') {
          toDelete = extend(toDelete, lines._ids);
        }
        else {
          lines[inverse] = false;
        }
      }

      async function flush(self) {
        let before: Map<any, any>;
        if (bool(toLink)) {
          before = new Map();
          for (const record of toLink) {
            before.set(record, await record[self.name]);
          }
        }
        if (bool(toDelete)) {
          // unlink() will remove the lines from the cache
          await comodel.browse(toDelete).unlink();
          toDelete = [];
        }
        if (bool(toCreate)) {
          // create() will add the new lines to the cache of records
          await comodel.create(toCreate);
          toCreate = [];
        }
        if (bool(toLink)) {
          for (const [record, lineIds] of toLink) {
            const lines = comodel.browse(lineIds).sub(before.get(record));
            // linking missing lines should fail
            await lines.mapped(inverse);
            lines[inverse] = record;
          }
          toLink.clear();
        }
      }

      for (const [recs, commands] of recordsCommandsList) {
        for (const command of (bool(commands) ? commands : [])) {
          if (command[0] == Command.CREATE) {
            for (const record of recs) {
              toCreate.push(Object.assign({}, command[2], { [inverse]: record.id }))
            }
            allowFullDelete = false;
          }
          else if (command[0] == Command.UPDATE) {
            await comodel.browse(command[1]).write(command[2]);
          }
          else if (command[0] == Command.DELETE) {
            toDelete.push(command[1]);
          }
          else if (command[0] == Command.UNLINK) {
            unlink(comodel.browse(command[1]));
          }
          else if (command[0] == Command.LINK) {
            const last = recs([-1]);
            toLink[last] = toLink[last] ?? new Set();
            toLink[last].add(command[1]);
            allowFullDelete = false;
          }
          else if ([Command.CLEAR, Command.SET].includes(command[0])) {
            // do not try to delete anything in creation mode if nothing has been created before
            const lineIds = command[0] == Command.SET ? command[2] : [];
            if (!allowFullDelete && !len(lineIds)) {
              continue;
            }
            await flush(this);
            // assign the given lines to the last record only
            const lines = comodel.browse(lineIds);
            const domain = (await this.getDomainList(model)).concat([[inverse, 'in', recs.ids], ['id', 'not in', lines.ids]]);
            unlink(await comodel.search(domain));
            lines[inverse] = recs([-1]);
            const a = [];
          }
        }
      }
      await flush(this);
    }
    else {
      const cache = records.env.cache;

      async function link(record, lines) {
        const ids = (await record[this.name])._ids;
        cache.set(record, this, unique(ids.concat(lines._ids)));
      }

      async function unlink(lines) {
        for (const record of records) {
          cache.set(record, this, (await record[this.name]).sub(lines)._ids);
        }
      }

      for (const [recs, commands] of recordsCommandsList) {
        for (const command of (len(commands) ? commands : [])) {
          if (command[0] == Command.CREATE) {
            for (const record of recs) {
              await link(record, await comodel.new(command[2], { ref: command[1] }));
            }
          }
          else if (command[0] == Command.UPDATE) {
            await comodel.browse(command[1]).write(command[2]);
          }
          else if (command[0] == Command.DELETE) {
            await unlink(comodel.browse(command[1]));
          }
          else if (command[0] == Command.UNLINK) {
            await unlink(comodel.browse(command[1]));
          }
          else if (command[0] == Command.LINK) {
            await link(recs([-1]), comodel.browse(command[1]));
          }
          else if ([Command.CLEAR, Command.SET].includes(command[0])) {
            // assign the given lines to the last record only
            cache.update(recs, this, _.fill(Array(len(recs)), []));
            const lines = comodel.browse(command[0] == Command.SET ? command[2] : []);
            cache.set(recs([-1]), this, lines._ids);
          }
        }
      }
    }
    return records;
  }

  async writeNew(recordsCommandsList) {
    if (!recordsCommandsList) {
      return;
    }

    const model = recordsCommandsList[0][0].browse();
    const cache = model.env.cache as Cache;
    const comodel = await model.env.items(this.comodelName).withContext(this.context);

    const ids = [];
    for (const [records, x] of recordsCommandsList) {
      for (const record of records) {
        ids.push(record.id);
      }
    }
    const records = model.browse(ids);

    function browse(ids) {
      return comodel.browse(ids.map(id => newId(id)));
    }

    // make sure `this` is in cache
    await records[this.name];

    if (this.store) {
      const inverse = this.relationField;

      // make sure this's inverse is in cache
      const inverseField = comodel._fields[inverse];
      for (const record of records) {
        cache.update(await record[this.name], inverseField, repeat(record.id));
      }

      for (const [recs, commands] of recordsCommandsList) {
        for (const command of commands) {
          if (command[0] == Command.CREATE) {
            for (const record of recs) {
              const line = await comodel.new(command[2], { ref: command[1] });
              line[inverse] = record;
            }
          }
          else if (command[0] == Command.UPDATE) {
            browse([command[1]]).update(command[2]);
          }
          else if (command[0] == Command.DELETE) {
            browse([command[1]])[inverse] = false;
          }
          else if (command[0] == Command.UNLINK) {
            browse([command[1]])[inverse] = false;
          }
          else if (command[0] == Command.LINK) {
            browse([command[1]])[inverse] = recs([-1]);
          }
          else if (command[0] == Command.CLEAR) {
            cache.update(recs, this, repeat([]));
          }
          else if (command[0] == Command.SET) {
            // assign the given lines to the last record only
            cache.update(recs, this, repeat([]));
            const [last, lines] = [recs([-1]), browse(command[2])];
            cache.set(last, this, lines._ids);
            cache.update(lines, inverseField, repeat(last.id));
          }
        }
      }
    }
    else {
      async function link(record, lines) {
        const ids = (await record[this.name])._ids;
        cache.set(record, this, unique(ids.concat(lines._ids)));
      }

      async function unlink(lines) {
        for (const record of records) {
          cache.set(record, this, (await record[self.name]).sub(lines)._ids);
        }
      }

      for (const [recs, commands] of recordsCommandsList) {
        for (const command of commands) {
          if (command[0] == Command.CREATE) {
            for (const record of recs) {
              await link(record, await comodel.new(command[2], { ref: command[1] }));
            }
          }
          else if (command[0] == Command.UPDATE) {
            await browse([command[1]]).update(command[2]);
          }
          else if (command[0] == Command.DELETE) {
            await unlink(browse([command[1]]));
          }
          else if (command[0] == Command.UNLINK) {
            await unlink(browse([command[1]]));
          }
          else if (command[0] == Command.LINK) {
            await link(recs([-1]), browse([command[1]]));
          }
          else if ([Command.CLEAR, Command.SET].includes(command[0])) {
            // assign the given lines to the last record only
            cache.update(recs, this, _.fill(Array(len(recs)), []));
            const lines = comodel.browse(command[0] == Command.SET ? command[2] : []);
            cache.set(recs([-1]), this, lines._ids);
          }
        }
      }
    }
    return records;
  }
}

@MetaField.define()
class _Many2many extends _RelationalMulti {
  static type = 'many2many';
  static _explicit = true;             // whether schema is explicitly given
  static relation = null;              // name of table
  static column1 = null;               // column of table referring to model
  static column2 = null;               // column of table referring to comodel
  static autojoin = false;             // whether joins are generated upon search
  static limit = null;                 // optional limit to use upon read
  static ondelete = 'CASCADE';         // optional ondelete for the column2 fkey

  setupNonrelated(model: ModelRecords): void {
    const cls = model.constructor as any;
    super.setupNonrelated(model);
    if (!['CASCADE', 'RESTRICT'].includes(this.ondelete)) {
      throw new ValueError(
        "The m2m field %s of model %s declares its ondelete policy as being %s. Only 'RESTRICT' and 'CASCADE' make sense.", this.name, cls._name, this.ondelete);
    }
    if (this.store) {
      if (!(this.relation && this.column1 && this.column2)) {
        if (!this.relation) {
          this._explicit = false;
        }
        const comodel = model.env.models[this.comodelName];
        if (!this.relation) {
          const tables = [cls._table, comodel._table].sort();
          assert(tables[0] !== tables[1],
            `${this}: Implicit/canonical naming of many2many relationship table is not possible when source and destination models are the same`);
          this.relation = `${tables[0]}${_.upperFirst(tables[1])}Rel`;
        }
        if (!this.column1) {
          this.column1 = `${cls._table}Id`;
        }
        if (!this.column2) {
          this.column2 = `${comodel._table}Id`;
        }
      }
      checkObjectName(this.relation);
    } else {
      this.relation = this.column1 = this.column2 = null;
    }

    if (this.relation) {
      const m2m = model.pool._m2m;
      const key = `${[this.relation, this.column1, this.column2]}`;
      const fields = m2m.get(key) ?? [];
      m2m.set(key, fields);
      for (const field of fields) {
        if ((this.modelName === field.modelName
          && this.comodelName === field.comodelName
          && this._explicit && field._explicit) || (
            this.modelName !== field.modelName &&
            !(cls._auto && model.env.models[field.modelName]._auto)
          )) {
          continue;
        }
        const msg = `Many2many fields ${this} and ${field} use the same table and columns`;
        throw new TypeError(msg);
      }
      fields.push(this);

      const _key = `${[this.relation, this.column2, this.column1]}`;
      const _fields = m2m.get(_key) ?? [];
      m2m.set(_key, _fields);
      for (const field of _fields) {
        model.pool.fieldInverses.add(this, field);
        model.pool.fieldInverses.add(field, this);
      }
    }
  }

  async updateDb(model, columns) {
    const cr: Cursor = model._cr
    const self = this as any;
    // Do not reflect relations for custom fields, as they do not belong to a
    // module. They are automatically removed when dropping the corresponding
    // 'ir.model.field'.
    if (!self.manual) {
      const mod = model.env.items('ir.model.relation');
      model.pool.postInit(mod._reflectRelation, mod, model, self.relation, self._moduleName);
    }
    if (self.relation && !await sql.tableExists(cr, self.relation)) {
      const comodel = model.env.models[self.comodelName];
      const comment = `RELATION BETWEEN "${model.constructor._table}" AND "${comodel._table}"`;

      const query = _f(`
          CREATE TABLE "{rel}" ("{id1}" INTEGER NOT NULL,
                                "{id2}" INTEGER NOT NULL,
                                PRIMARY KEY("{id1}","{id2}"));
          COMMENT ON TABLE "{rel}" IS '%s';
          CREATE INDEX ON "{rel}" ("{id2}","{id1}");
      `, { rel: this.relation, id1: this.column1, id2: this.column2 });
      await cr.execute(query, [comment]);

      // console.debug("Create table %s: m2m relation between %s and %s", self.relation, model.constructor._table, comodel._table)
      model.pool.postInit(self.updateDbForeignKeys, self, model);
      return true;
    }
    model.pool.postInit(self.updateDbForeignKeys, self, model);
  }

  /**
   * Add the foreign keys corresponding to the field's relation table.
   * @param self 
   * @param model 
   */
  async updateDbForeignKeys(self, model: ModelRecords) {
    const comodel = model.env.items(self.comodelName);
    if (await model._isAnOrdinaryTable()) {
      model.pool.addForeignKey(
        self.relation, self.column1, model.cls._table, 'id', 'CASCADE', model, self._moduleName, false
      );
    }
    if (await comodel._isAnOrdinaryTable()) {
      model.pool.addForeignKey(
        self.relation, self.column2, comodel.cls._table, 'id', self.ondelete, model, self._moduleName,
      )
    }
  }

  async read(records: ModelRecords) {
    const context = { 'activeTest': false };
    Object.assign(context, this.context);
    const comodel: ModelRecords = await records.env.items(this.comodelName).withContext(context);
    const domain = await this.getDomainList(records);
    await comodel._flushSearch(domain);
    const wquery = await comodel._whereCalc(domain);
    await comodel._applyIrRules(wquery, 'read');
    const orderby = await comodel._generateOrderBy(null, wquery);
    const [fromC, whereC, whereParams] = wquery.getSql();
    let query = _f(`SELECT "{rel}"."{id1}", "{rel}"."{id2}" FROM "{rel}", {fromC}
                WHERE {whereC} AND "{rel}"."{id1}" IN ({ids}) AND "{rel}"."{id2}" = "{tbl}".id
                {orderby}{limit}OFFSET {offset}
            `, {
      rel: this.relation, id1: this.column1, id2: this.column2,
      tbl: comodel.cls._table, fromC: fromC, whereC: whereC || '1=1',
      limit: this.limit ? `LIMIT ${this.limit} ` : '',
      offset: 0, orderby: orderby, ids: String(records.ids)
    });
    query = _convert$(query);

    // retrieve lines and group them by record
    const group = new DefaultDict2(() => []);
    const res = await records._cr.execute(query, { bind: whereParams });
    for (const row of res) {
      group[row[this.column1]].push(row[this.column2]);
    }
    // store result in cache
    const cache = records.env.cache;
    for (const record of records) {
      cache.set(record, this, Array.from(group[record.id]));
    }
  }

  async writeReal(recordsCommandsList, create = false) {
    // recordsCommandsList = [[records, commands], ...]
    if (!recordsCommandsList)
      return

    const model: ModelRecords = recordsCommandsList[0][0].browse();
    const comodel = await model.env.items(this.comodelName).withContext(this.context);
    const cr: Cursor = model.env.cr;

    // determine old and new relation {x: ys}
    const _Set = OrderedSet2;
    const ids = new _Set();
    for (const [recs, cs] of recordsCommandsList)
      for (const rid of recs.ids) {
        ids.add(rid);
      }
    const records = model.browse(ids);

    if (this.store) {
      // Using `record[this.name]` generates 2 SQL queries when the value
      // is not in cache: one that actually checks access rules for
      // records, and the other one fetching the actual data. We use
      // `this.read` instead to shortcut the first query.
      const missingIds = [...records.env.cache.getMissingIds(records, this)];
      if (len(missingIds)) {
        await this.read(records.browse(missingIds));
      }
    }

    // determine new relation {x: ys}
    const oldRelation = new Map<any, any>();
    for (const record of records) {
      const _ids = (await record[this.name])._ids;
      oldRelation.set(record.id, new _Set(_ids));
    }

    const newRelation = new Map<any, any>();
    for (const [x, ys] of oldRelation) {
      newRelation.set(x, new _Set(ys));
    }

    // operations on new relation
    function relationAdd(xs, y) {
      for (const x of xs)
        newRelation.get(x).add(y);
    }

    function relationRemove(xs, y) {
      for (const x of xs)
        newRelation.get(x).delete(y);
    }

    function relationSet(xs, ys) {
      for (const x of xs)
        newRelation.set(x, new _Set(ys));
    }

    function relationDelete(ys) {
      // the pairs (x, y) have been CASCADE-deleted from relation
      for (let ys1 of oldRelation.values()) {
        ys1 = new Set(_.difference(ys1, ys));
      }
      for (let ys1 of newRelation.values()) {
        ys1 = new Set(_.difference(ys1, ys));
      }
    }

    for (const [recs, commands] of recordsCommandsList) {
      let toCreate = [];  // line vals to create
      let toDelete = [];  // line ids to delete
      for (const command of (len(commands) ? commands : [])) {
        if (!isList(command) || !command)
          continue;
        if (command[0] == Command.CREATE)
          toCreate.push([recs._ids, command[2]]);
        else if (command[0] == Command.UPDATE)
          await comodel.browse(command[1]).write(command[2])
        else if (command[0] == Command.DELETE)
          toDelete.push(command[1]);
        else if (command[0] == Command.UNLINK)
          relationRemove(recs._ids, command[1]);
        else if (command[0] == Command.LINK)
          relationAdd(recs._ids, command[1]);
        else if ([Command.CLEAR, Command.SET].includes(command[0])) {
          // new lines must no longer be linked to records
          // toCreate = toCreate.map(([ids, vals]) => [_.difference(ids, recs._ids), vals]);
          const _toCreate = [];
          for (const [ids, vals] of toCreate) {
            _toCreate.push([_.difference(ids, recs._ids), vals])
          }
          toCreate = _toCreate;
          relationSet(recs._ids, command[0] == Command.SET ? command[2] : []);
        }
      }
      if (len(toCreate)) {
        // create lines in batch, and link them
        const lines = await comodel.create(toCreate.map(([ids, vals]) => vals));
        for (const [line, [ids, vals]] of _.zip<any, any>([...lines], toCreate)) {
          relationAdd(ids, line.id);
        }
      }

      if (len(toDelete)) {
        // delete lines in batch
        await comodel.browse(toDelete).unlink();
        relationDelete(toDelete);
      }
    }

    // update the cache of self
    const cache: Cache = records.env.cache;
    for (const record of records) {
      cache.set(record, this, Array.from(newRelation.get(record.id)));
    }

    // process pairs to add (beware of duplicates)
    let pairs = [];
    for (const [x, ys] of newRelation) {
      const dif = _.difference(ys, oldRelation.get(x));
      for (const y of dif)
        pairs.push([x, y])
    }
    if (len(pairs)) {
      if (this.store) {
        const query = `INSERT INTO "${this.relation}" ("${this.column1}", "${this.column2}") VALUES ${_.fill(Array(len(pairs)), '%s').join(', ')} ON CONFLICT DO NOTHING`;
        const params = pairs.map(([x, y]) => `(${x},${y})`);
        await cr.execute(query, { params: params });
      }

      // update the cache of inverse fields
      const yToXs = new DefaultDict<any, any>();
      for (const [x, y] of pairs) {
        yToXs[y] = yToXs[y] ?? new _Set();
        yToXs[y].add(x);
      }
      for (const invf of records.pool.fieldInverses.get(this)) {
        const domain = await invf.getDomainList(comodel);
        const validIds = new _Set((await records.filteredDomain(domain))._ids);
        if (!len(validIds)) {
          continue;
        }
        for (const [y, xs] of yToXs) {
          const corecord = comodel.browse(y);
          try {
            const ids0 = await cache.get(corecord, invf);
            const ids1 = _.union(ids0, _.intersection(xs, [...validIds]));
            cache.set(corecord, invf, ids1);
          } catch (e) {
            if (!isInstance(e, KeyError)) {
              throw e;
            }
          }
        }
      }
    }

    // process pairs to remove
    pairs = [];
    for (const [x, ys] of oldRelation.entries()) {
      for (const y of _.difference(ys, newRelation.get(x))) {
        pairs.push([x, y]);
      }
    }
    if (len(pairs)) {
      const yToXs = new DefaultDict<any, any>();
      for (const [x, y] of pairs) {
        if (!yToXs.get(y)) {
          yToXs.set(y, new _Set());
        }
        yToXs.get(y).add(x);
      }

      if (this.store) {
        // express pairs as the union of cartesian products:
        //    pairs = [[1, 11], [1, 12], [1, 13], [2, 11], [2, 12], [2, 14]]
        // -> yToXs = {11: {1, 2}, 12: {1, 2}, 13: {1}, 14: {2}}
        // -> xsToYs = {{1, 2}: {11, 12}, {2}: {14}, {1}: {13}}
        const xsToYs = new DefaultDict<any, any>();
        for (const [y, xs] of yToXs) {
          if (!xsToYs.get(xs)) {
            xsToYs.set(xs, new _Set());
          }
          xsToYs.get(xs).add(y);
        }
        // delete the rows where (id1 IN xs AND id2 IN ys) OR ...
        const COND = `"${this.column1}" IN (%s) AND "${this.column2}" IN (%s)`;
        const query = `DELETE FROM "${this.relation}" WHERE ${_.fill(Array(len(xsToYs)), COND).join(' OR ')}`;
        const params = [];
        for (const [xs, ys] of xsToYs) {
          for (const arg of [[...xs], [...ys]]) {
            params.push(arg.join(','));
          }
        }
        await cr.execute(query, params);
      }

      // update the cache of inverse fields
      for (const invf of records.pool.fieldInverses.get(this)) {
        for (const [y, xs] of yToXs) {
          const corecord = comodel.browse(y);
          try {
            const ids0 = await cache.get(corecord, invf);
            const ids1 = ids0.filter(id => !xs.includes(id));
            cache.set(corecord, invf, ids1);
          } catch (e) {
            if (!isInstance(e, KeyError)) {
              throw e;
            }
          }
        }
      }
    }

    return records.filtered(
      (record) => !_.isEqual(newRelation.get(record.id), oldRelation.get(record.id))
    )
  }

  async writeNew(recordsCommandsList) {
    if (!recordsCommandsList) {
      return;
    }

    const model: ModelRecords = recordsCommandsList[0][0].browse();
    const comodel = await model.env.items(this.comodelName).withContext(this.context);

    // determine old and new relation {x: ys}
    const _Set = OrderedSet2;
    const oldRelation = new Map<any, any>();
    for (const [records, x] of recordsCommandsList) {
      for (const record of records) {
        oldRelation.set(record.id, new _Set((await record[this.name])._ids));
      }
    }
    const newRelation = new Map<any, any>();;
    for (const [x, ys] of oldRelation) {
      newRelation.set(x, new _Set(ys));
    }
    const ids = new Set(oldRelation.keys());

    const records = model.browse(ids);

    for (const [recs, commands] of recordsCommandsList) {
      for (const command of commands) {
        if (!isList(command) || !command) {
          continue;
        }
        if (command[0] == Command.CREATE) {
          const lineId = (await comodel.new(command[2], { ref: command[1] })).id;
          for (const lineIds of newRelation.values()) {
            lineIds.add(lineId);
          }
        }
        else if (command[0] == Command.UPDATE) {
          const lineId = newId(command[1]);
          await comodel.browse([lineId]).update(command[2]);
        }
        else if (command[0] == Command.DELETE) {
          const lineId = newId(command[1]);
          for (const lineIds of newRelation.values()) {
            lineIds.delete(lineId);
          }
        }
        else if (command[0] == Command.UNLINK) {
          const lineId = newId(command[1]);
          for (const lineIds of newRelation.values()) {
            lineIds.delete(lineId);
          }
        }
        else if (command[0] == Command.LINK) {
          const lineId = newId(command[1]);
          for (const lineIds of newRelation.values()) {
            lineIds.add(lineId);
          }
        }
        else if ([Command.CLEAR, Command.SET].includes(command[0])) {
          // new lines must no longer be linked to records
          let lineIds = command[0] == Command.SET ? command[2] : [];
          lineIds = new _Set(lineIds.map(lineId => newId(lineId)));
          for (const id of recs._ids) {
            newRelation.set(id, new _Set(lineIds));
          }
        }
      }
    }

    if (_.isEqual(newRelation, oldRelation)) {
      return records.browse();
    }

    // update the cache of self
    const cache: Cache = records.env.cache;
    for (const record of records) {
      cache.set(record, this, newRelation.get(record.id));
    }
    // process pairs to add (beware of duplicates)
    let pairs = [];
    for (const [x, ys] of newRelation.entries()) {
      for (const y of _.difference(ys, oldRelation.get(x))) {
        pairs.push([x, y]);
      }
    }
    if (len(pairs)) {
      // update the cache of inverse fields
      const yToXs = new DefaultDict<any, any>();
      for (const [x, y] of pairs) {
        if (!yToXs.has(y)) {
          yToXs.set(y, new _Set());
        }
        yToXs.get(y).add(x);
      }
      for (const invf of records.pool.fieldInverses.get(this)) {
        const domain = await invf.getDomainList(comodel);
        const validIds = new _Set((await records.filteredDomain(domain))._ids);
        if (!validIds) {
          continue;
        }
        for (const [y, xs] of yToXs) {
          const corecord = comodel.browse([y]);
          try {
            const ids0 = cache.get(corecord, invf);
            const ids1 = _.union(new _Set(ids0), (_.intersection(xs, validIds)));
            cache.set(corecord, invf, ids1);
          } catch (e) {
            if (!isInstance(e, KeyError)) {
              throw e;
            }
          }
        }
      }
    }
    // process pairs to remove
    pairs = [];
    for (const [x, ys] of oldRelation.entries()) {
      for (const y of _.difference(ys, newRelation.get(x))) {
        pairs.push([x, y]);
      }
    }
    if (len(pairs)) {
      // update the cache of inverse fields
      const yToXs = new DefaultDict<any, any>();
      for (const [x, y] of pairs) {
        if (!yToXs.has(y)) {
          yToXs.set(y, new Set());
        }
        yToXs.get(y).add(x);
      }
      for (const invf of records.pool.fieldInverses.get(this)) {
        for (const [y, xs] of yToXs) {
          const corecord = comodel.browse([y]);
          try {
            const ids0 = cache.get(corecord, invf);
            const ids1 = ids0.filter(id => !(id in xs));
            cache.set(corecord, invf, ids1);
          } catch (e) {
            if (!isInstance(e, KeyError)) {
              throw e;
            }
          }
        }
      }
    }

    return records.filtered(
      (record) => !_.isEqual(newRelation.get(record.id), oldRelation.get(record.id))
    )
  }
}

@MetaField.define()
class _Id extends Field {
  static type = 'integer';
  static string = 'ID';
  static store = true;
  static readonly = true;
  static prefetch = false;

  get columnType() { return ['INTEGER', 'INTEGER'] }

  async updateDb(model, columns): Promise<boolean> {
    return;
  }

  __get__(record, owner): any {
    if (record == null) {
      return this;
    }
    const ids = record._ids;
    const size = ids.length;
    if (size == 0) {
      return false;
    } else if (size === 1) {
      return ids[0];
    }
    throw new TypeError(`Expected singleton: ${record}`);
  }

  __set__(instance, value): Promise<void> {
    throw new TypeError("field 'id' cannot be assigned");
  }
}

enum _CmdEnum {
  CREATE = 0,
  UPDATE = 1,
  DELETE = 2,
  UNLINK = 3,
  LINK = 4,
  CLEAR = 5,
  SET = 6
}

type _CmdType = [_CmdEnum, number, number | {} | number[]]

export class Command {
  static CREATE = 0;
  static UPDATE = 1;
  static DELETE = 2;
  static UNLINK = 3;
  static LINK = 4;
  static CLEAR = 5;
  static SET = 6;
  static create(values: {}): _CmdType {
    return [Command.CREATE, 0, values];
  }
  static update(id: number, values: {}): _CmdType {
    return [Command.UPDATE, id, values];
  }
  static delete(id: number): _CmdType {
    return [Command.DELETE, id, 0];
  }
  static unlink(id: number): _CmdType {
    return [Command.UNLINK, id, 0];
  }
  static link(id: number): _CmdType {
    return [Command.LINK, id, 0];
  }
  static clear(): _CmdType {
    return [Command.CLEAR, 0, 0];
  }
  static set(ids: number[]): _CmdType {
    return [Command.SET, 0, ids];
  }
}

async function applyRequired(model: ModelRecords, fieldName: string) {
  const field = model._fields[fieldName];
  if (field.store && field.required) {
    await sql.setNotNull(model.env.cr, model.cls._table, fieldName);
  }
}