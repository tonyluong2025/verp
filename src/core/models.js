import assert from "assert";
import crypto from 'crypto';
import _, { camelCase, difference, fill, intersection, isEqual, zip } from "lodash";
import { DateTime, Duration } from 'luxon';
import { format } from 'node:util';
import * as path from "path";
import { v1 as uuidv1 } from 'uuid';
import * as api from './api';
import { CopyMode, Meta } from './api/api';
import { discardattr, getattr, hasattr, setattr } from './api/func';
import { Command, Field, Fields, _Datetime } from './fields';
import { DefaultDict, DefaultDict2, Dict, LastOrderedSet, OrderedSet2 } from './helper/collections';
import { AccessError, KeyError, MissingError, NotImplementedError, UserError, ValidationError, ValueError } from './helper/errors';
import { showConstraints } from './modules/db';
import { Query, expression } from "./osv";
import { DataTypes } from './service/sequelize';
import * as tools from './tools';
import { getLang, stringify } from './tools';
import { bool } from './tools/bool';
import { config } from "./tools/config";
import { isCallable, isInstance, partial } from './tools/func';
import { IterableGenerator, extend, filter, islice, len, map, remove, sorted, sortedAsync } from './tools/iterable';
import { DEFAULT_SERVER_DATETIME_FORMAT, DEFAULT_SERVER_DATE_FORMAT, allTimezones, pop, update } from './tools/misc';
import { addConstraint, quoteList } from './tools/sql';
import { _t } from './tools/translate';
import { _format, f } from './tools/utils';

export const PREFETCH_MAX = 1000;
export const VALID_AGGREGATE_FUNCTIONS = [
  'array_agg', 'count', 'count_distinct',
  'bool_and', 'bool_or', 'max', 'min', 'avg', 'sum',
]

export const LOG_ACCESS_COLUMNS = ['createdUid', 'createdAt', 'updatedUid', 'updatedAt'];
export const MAGIC_COLUMNS = ['id'].concat(LOG_ACCESS_COLUMNS);

const regexOrder = new RegExp(/^(\s*([a-z0-9:_]+|"[a-z0-9:_]+")(\s+(desc|asc))?\s*(,|$))+(?<!,)$/, 'i')
const regexObjectName = new RegExp(/^[a-z0-9_.]+$/)
const regexName = new RegExp(/^[a-z_][a-z0-9_$]*$/, 'i')
const regexPrivate = new RegExp(/^(_.*|init)$/);

export function* traverseContainers(val, type) {
  // from core.models import BaseModel
  if (isInstance(val, type)) {
    yield val;
  }
  else if (typeof val === 'string' || isInstance(val, Uint8Array, BaseModel)) {
    return;
  }
  else if (tools.isIterable(val)) {
    for (const v of val) {
      for (const i of traverseContainers(v, type)) {
        yield i;
      }
    }
  }
  else if (isInstance(val, Map, Dict, Object)) {
    const iterable = isInstance(val, Map) ? val.entries() : Object.entries(val);
    for (const [k, v] of iterable) {
      for (const i of traverseContainers(k, type)) {
        yield i;
      }
      for (const i of traverseContainers(v, type)) {
        yield i;
      }
    }
  }
}

export function checkObjectName(name) {
  return regexObjectName.test(name)
}

export async function checkMethodName(name) {
  if (regexPrivate.test(name)) {
    throw new AccessError(await _t('Private methods (such as %s) cannot be called remotely.', name));
  }
}

function originIds(ids) {
  return Array.from(map(filter(ids ?? [], (id) => bool(id) || id.origin), (id) => bool(id) ? id : id.origin));
}

export function* expandIds(id0, ids) {
  yield id0;
  const seen = new Set([id0]);
  const kind = bool(id0);
  for (const id of ids) {
    if (!seen.has(id) && bool(id) === kind) {
      yield id;
      seen.add(id);
    }
  }
}

export function findProperty(cls, key) {
  const value = cls[key];
  if (value !== undefined) {
    return value;
  } else {
    for (const base of cls.__baseClasses || []) {
      if (base[key] !== undefined) {
        return base[key];
      }
    }
    for (const base of cls.__baseClasses || []) {
      const parent = Object.getPrototypeOf(base);
      if (parent) {
        return findProperty(parent, key);
      }
    }
    return undefined;
  }
}

export function getModule(modul) {
  const par = path.parse(modul.filename);
  let dir = par.dir;
  const i = dir.indexOf('addons');
  if (i >= 0) {
    dir = dir.slice(i);
  }
  else {
    const i = dir.indexOf('verp');
    if (i >= 0) {
      dir = dir.slice(i);
      return 'core.addons.base';
    }
  }
  const list = dir.split(path.sep);
  if (par.name) {
    list.push(par.name);
  }
  const name = 'core.' + list.join('.');
  return name;
}

export function isDefinitionClass(cls) {
  return (cls.prototype instanceof BaseModel) && (getattr(cls, 'pool', null) === null);
}

export function isRegistryClass(cls) {
  const res = getattr(cls, 'pool', null) !== null;
  return res;
}

async function lazyNameGet(self) {
  const names = Object.fromEntries(await self.nameGet());
  const res = [];
  for (const rid of self.ids) {
    res.push([rid, names[rid]]);
  }
  return res;
}

export function _super(cls, obj, bypass = true) {
  return new Proxy({}, {
    get(target, prop, receiver) {
      const objIsClass = obj.mro != null;
      const mro = objIsClass ? obj.mro() : obj.cls.mro();

      // Find the class
      let index = 0;
      while (index < mro.length) {
        if (mro[index] === cls) {
          break;
        }
        index++;
      }
      if (bypass) {
        index++;
      }
      let method;
      while (index < mro.length) {
        const parent = mro[index++];
        const proto = objIsClass ? parent : parent.prototype;
        if (prop in proto) {
          method = proto[prop];
          if (isCallable(method)) {
            const boundMethod = method.bind(obj);
            api.propagate(method, boundMethod, null);
            setattr(boundMethod, 'name', method.name);
            method = boundMethod;
          }
          break;
        }
      }
      return method;
    }
  });
}

export function isSubclass(obj, base) {
  const mro = obj.cls.mro();
  return mro.includes(base.__bases[0]);
}

const BASIC_KEYS = [
  // javascript system, rarely used
  // 'length', 'name', 'arguments', 'caller', 'prototype',
  // BaseModel properties
  'env', 'cls', 'pool', '_fields', '_name', '_ids', '_prefetchIds', 'then', 'mro'
];

export class MetaModel extends Meta {
  static moduleToModels = new DefaultDict();

  static define = (name) => {
    return (cls) => {
      assert(getattr(cls, '_module'), `Invalid controller ${cls.name}, it should declare 'static _module = module`);
      const attrs = Object.assign({}, cls);
      attrs['_fieldDefinitions'] = getattr(cls, '_fieldDefinitions', []);

      if (attrs['_register'] ?? true) {
        if (!('_moduleName' in attrs)) {
          const modulepath = getModule(cls._module);
          assert(modulepath.startsWith('core.addons.'), `Invalid import of ${modulepath}.${cls.name}, it should start with 'core.addons`);
          const modulename = modulepath.split('.')[2];
          attrs['_moduleName'] = modulename;
          attrs['_classname'] = `${modulepath}.${cls.name}`;
        }

        let parents = attrs['_parents'] || [];
        if (typeof parents === 'string') {
          parents = [parents];
        }
        attrs['_parents'] = parents;
        if (!attrs['_name']) {
          attrs['_name'] = (parents.length == 1 ? parents[0] : name) ?? `${attrs['_moduleName']}.${cls.name.toLowerCase()}`;
        }
      }

      // Update child properties and private functions by static keywords
      Object.assign(cls, attrs);

      // Copy properties from parent class (directly mentioned) to child (if child does not have them yet)
      super.copy(cls, Object.getPrototypeOf(cls), { mode: CopyMode.properties });

      this.init(cls, attrs);
    }
  };

  static init(cls, attrs = {}) {
    super.init(cls, attrs);

    if (!getattr(attrs, '_register', true)) {
      return;
    }
    if (cls._moduleName) {
      MetaModel.moduleToModels[cls._moduleName] = MetaModel.moduleToModels[cls._moduleName] || [];
      MetaModel.moduleToModels[cls._moduleName].push(cls);
    }
    if (!cls._abstract && !(cls._parents || []).includes(cls._name)) {
      function add(name, field) {
        setattr(cls, name, field);
        field.__setName(cls, name);
      }

      function addDefault(name, field) {
        if (!hasattr(attrs, name)) {
          setattr(cls, name, field);
          field.__setName(cls, name);
        }
      }

      add('id', Fields.Id('id', { automatic: true }));
      add(cls.CONCURRENCY_CHECK_FIELD, Fields.Datetime({
        string: 'Last Modified on', automatic: true,
        compute: '_computeConcurrencyField', computeSudo: false
      }))
      addDefault('displayName', Fields.Char('Display Name', { automatic: true, compute: '_computeDisplayName' }));
      if (getattr(attrs, '_logAccess', cls._auto)) {
        addDefault('createdUid', Fields.Many2one(
          'res.users', { string: 'Created by', automatic: true, readonly: true }))
        addDefault('createdAt', Fields.Datetime(
          { string: 'Created on', automatic: true, readonly: true }))
        addDefault('updatedUid', Fields.Many2one(
          'res.users', { string: 'Last Updated by', automatic: true, readonly: true }))
        addDefault('updatedAt', Fields.Datetime(
          { string: 'Last Updated on', automatic: true, readonly: true }))
      }
    }
  }

  static build(base, name) {
    class Virtual extends BaseModel {
      static isVirtual = true;

      static __bases__ = [base];

      static get __bases() { return this.__bases__; }

      static set __bases(list) { this.__bases__ = list; }

      constructor() {
        super();
        return this._getProxy();
      }
    }

    setattr(Virtual, 'name', name || base.name);

    this.setPrototype(Virtual, base);     // Set prototype to the base
    this.copyAtributes(Virtual, [base]);  // Copy all static properties because maybe be overrided by children.

    return Virtual;
  }

  static copyProperties(cls, bases) {
    for (const base of bases) {
      this.copy(cls, base, { mode: CopyMode.properties });
    }
  }

  static copyAtributes(cls, bases) {
    for (const base of bases) {
      this.copy(cls, base, { mode: CopyMode.all });
    }
  }

  static setPrototype(target, source) {
    Object.setPrototypeOf(target, source); // => [[Prototype]]
    Object.setPrototypeOf(target.prototype, source.prototype); // => prototype
  }
}

export function newId(id) {
  return id instanceof NewId ? id : new NewId(id);
}

export class NewId extends Number {
  constructor(origin, ref) {
    super();
    this._uuid = uuidv1().slice(0, 8);
    this.origin = origin;
    this.ref = ref;
  }

  valueOf() {
    return this.origin || this.ref;
  }

  _bool() {
    return false;
  }

  eq(other) {
    const res = isInstance(other, NewId) && (
      (this.origin && other.origin && this.origin == other.origin)
      || (this.ref && other.ref && this.ref == other.ref)
    );
    return res;
  }

  toString() {
    let idPart;
    if (this.origin || this.ref) {
      idPart = String(this.origin || this.ref);
    }
    else {
      idPart = this._uuid;
    }
    return f("NewId_%s", idPart);
  }
}

class RecordCache {
  constructor(record) {
    assert(record._length === 1, `Unexpected RecordCache(${record})`);
    this._record = record;
  }

  /**
   * Iterate over the field names with a cached value.
   */
  *[Symbol.iterator]() {
    for (const field of this._record.env.cache.getFields(this._record)) {
      yield field.name;
    }
  }

  /**
   * Return the number of fields with a cached value.
   * @returns 
   */
  get length() {
    let count = 0;
    for (const name of this) {
      count++
    }
    return count;
  }

  items() {
    const result = [];
    for (const [name, field] of this._record.env.cache.items(this._record)) {
      result.push([name, this._record.env.cache.get(this._record, field)]);
    }
    return result;
  }

  has(fname) {
    return fname in this._record.env.cache;
  }

  get(fname) {
    const field = this._record._fields[fname];
    return this._record.env.cache.get(this._record, field);
  }

  set(fname, value) {
    const field = this._record._fields[fname];
    return this._record.env.cache.set(this._record, field, value);
  }

  clear() {
    this._record.env.cache.clear();
  }

  includes(field) {
    return this.contains(field);
  }

  contains(field) {
    return this._record.env.cache.contains(this._record, field);
  }
}

function hash(data, algorithm = 'sha1', encoding = 'hex') {
  return crypto.createHash(algorithm, data, encoding)
    .update(data)
    .digest(encoding);
}

export class BaseModel extends Function {
  static _auto = false;
  static _register = false;           // registry visibility
  static _abstract = true;
  static _transient = false;          // not transient

  static _name = null;                // the model name (in dot-notation, module namespace)
  static _description = null;         // the model's informal name
  static _moduleName = null;          // the model's module (in the Verp sense)
  static _custom = null;              // should be true for custom models only

  static _parents = [];
  static _inherits = {};

  static _table = null;               // SQL table name used by model if :attr:`_auto`
  static _tableQuery = null;          // SQL expression of the table's content (optional)
  static _sequence = null;            // SQL sequence to use for ID field
  static _sqlConstraints = [];        // SQL constraints [[name, sql_def, message]]

  static _recName = null;             // field to use for labeling records, default: ``label``
  static _order = 'id';               // default order field for searching results
  static _parentName = 'parentId';    // the many2one field used as parent field
  static _parentStore = null;

  static _activeName = null;          // field to use for active records
  static _dateName = 'date';          // field to use for default calendar view
  static _foldName = 'fold';          // field to determine folded groups in kanban views

  static _needaction = false;         // whether the model supports "need actions" (Old API)
  static _translate = true;           // false disables translations export for this model (Old API)
  static _checkCompanyAuto = false;

  static _depends = new Dict();

  static _modelSeq = null;

  static _defination = null;

  static CONCURRENCY_CHECK_FIELD = '__lastUpdate';
  static _transientMaxCount = config.get('osvMemoryCountLimit');
  static _transientMaxHours = config.get('transientAgeLimit');

  static toString() {
    return this.name;
  }

  static mro(type = 'origin') {
    let res = this._mro();
    if (res && type === 'origin') {
      res = res.filter(c => getattr(c, 'isVirtual', false) === false);
    }
    else if (res && type === 'proxy') {
      res = res.filter(c => getattr(c, 'isVirtual', false) === true);
    }
    return res;
  }

  static _mro() {
    return this.pool._mro[this._name];
  }

  static buildModel(baseClass, pool, cr) {
    setattr(baseClass, '_localSqlConstraints', getattr(baseClass, '_sqlConstraints', []));

    const name = baseClass._name;
    const parents = Array.from(baseClass._parents);
    if (name != 'base') {
      parents.push('base');
    }
    let VirtualClass;
    if (parents.includes(name)) {
      if (!pool.models[name]) {
        console.log(`"Model ${name} does not exist in registry."`);
      }
      VirtualClass = pool.models[name];
      BaseModel._buildModelCheckBase(VirtualClass, baseClass);
      Object.setPrototypeOf(baseClass, Object.getPrototypeOf(VirtualClass));
    } else {
      VirtualClass = MetaModel.build(baseClass, name);
      Object.assign(VirtualClass, {
        '_name': name,
        '_register': false,
        '_originalModule': baseClass._moduleName,
        '_parentsModule': {},                  // map parent to introducing module
        '_parentsChildren': new OrderedSet2(), // names of children models
        '_inheritsChildren': new Set(),        // names of children models
        '_fields': new Dict(),                 // populated in _setupBase()
      });
    }
    const bases = new LastOrderedSet([baseClass]);
    for (const parent of parents) {
      const parentClass = pool.models[parent];
      if (!parentClass) {
        throw new TypeError(`"Model ${name} inherits from non-existing model ${parent}."`);
      }
      if (parent === name) {
        for (const base of (parentClass.__baseClasses || [])) {
          bases.add(base);
        }
      }
      else {
        BaseModel._buildModelCheckParent(VirtualClass, baseClass, parentClass);
        bases.add(parentClass);
        VirtualClass._parentsModule[parent] = baseClass._moduleName;
        parentClass._parentsChildren.add(name);
      }
    }

    VirtualClass.__baseClasses = [...bases];
    VirtualClass._buildModelAttributes(pool);

    checkTableName(VirtualClass._table);

    if (VirtualClass._transient) {
      assert(VirtualClass._logAccess, 'TransientModels must have logAccess turned on, in order to implement their vacuum policy');
    }

    setattr(VirtualClass, 'pool', pool);
    pool.models[name] = VirtualClass;

    return VirtualClass;
  }

  static _buildModelCheckBase(virtualClass, baseClass) {
    let msg;
    if (virtualClass._abstract && !baseClass._abstract) {
      msg = `${baseClass} transforms the abstract model ${virtualClass._name} into a non-abstract model.
      That class should either inherit from AbstractModel, or set a different '_name'.`;
      console.log(msg);
    }
    if (virtualClass._transient !== baseClass._transient) {
      if (virtualClass._transient) {
        msg = `${baseClass._name} transforms the transient model ${virtualClass._name} into a non-transient model.
        That class should either inherit from TransientModel, or set a different '_name'.`
      } else {
        msg = `${baseClass._name} transforms the model ${virtualClass._name} into a transient model.
        That class should either inherit from Model, or set a different '_name'.`
      }
      console.log(msg);
    }
  }

  static _buildModelCheckParent(myCls, cls, parentClass) {
    if (myCls._abstract && !parentClass._abstract) {
      const msg = `In ${cls}, the abstract model ${myCls._name} cannot inherit from the non-abstract model ${parentClass._name}.`;
      console.log(msg);
    }
  }

  static _initConstraintsOnchanges() {
    const cls = this;
    // store list of sql constraint qualified names
    for (const [key] of this._sqlConstraints) {
      cls.pool._sqlConstraints.push(cls._table + '_' + key);
    }
    // reset properties memoized on cls
    setattr(cls, '_constraintMethods', BaseModel._constraintMethods);
    setattr(cls, '_ondeleteMethods', BaseModel._ondeleteMethods);
    setattr(cls, '_onchangeMethods', BaseModel._onchangeMethods);
  }

  static _buildModelAttributes(pool) {
    const cls = this;
    cls._description = cls._name;
    cls._table = camelCase(cls._name.replace('.', '_'));
    cls._sequence = null;
    cls._logAccess = cls._auto;
    cls._sqlConstraints = {};

    const inherits = {};
    const depends = {};

    for (let i = cls.__baseClasses.length - 1; i >= 0; i--) {
      const base = cls.__baseClasses[i];
      if (isDefinitionClass(base)) {
        cls._description = base._description ?? cls._description;
        cls._table = base._table ?? cls._table;
        cls._sequence = base._sequence ?? cls._sequence;
        cls._logAccess = getattr(base, '_logAccess', cls._logAccess);
      }

      Object.assign(inherits, base._inherits);

      for (const [mname, fnames] of Object.entries(base._depends ?? {})) {
        depends[mname] = depends[mname] || [];
        depends[mname] = extend(depends[mname], fnames);
      }

      for (const cons of base._sqlConstraints) {
        cls._sqlConstraints[cons[0]] = cons;
      }
    }

    cls._sequence = cls._sequence ?? (cls._table + '_id_seq');
    cls._sqlConstraints = Object.values(cls._sqlConstraints);

    if (Object.entries(inherits).length > 0) {
      cls._inherits = inherits;
    }
    if (Object.entries(depends).length > 0) {
      cls._depends = depends;
    }

    for (const parentName of Object.keys(cls._inherits ?? {})) {
      pool.models[parentName]._inheritsChildren.add(cls._name);
    }

    for (const childName of cls._parentsChildren) {
      const childClass = pool.models[childName];
      childClass._buildModelAttributes(pool);
    }
  }

  static _constraintMethods(model) {
    function isConstraint(func) {
      return isCallable(func) && hasattr(func, '_constrains');
    }

    function wrap(method, names) {
      const wrapper = function (...args) {
        return method.call(this, ...args);
      }
      setattr(wrapper, '_constrains', names);
      return wrapper;
    }

    const methods = [];
    for (const [attr, _func] of getmembers(this, 'proto', isConstraint)) {
      let func = _func;
      if (isCallable(func._constrains)) {
        const names = func._constrains(model);
        func = wrap(func, names);
      }
      for (const name of func._constrains) {
        const field = this._fields[name];
        if (!field) {
          console.warn("method %s.%s: @constraints parameter %s is not a field name", this._name, attr, name);
        } else if (!(field.store || field.inverse || field.inherited)) {
          console.warn("method %s.%s: @constraints parameter %s is not writeable", this._name, attr, name);
        }
      }
      methods.push(func);
    }

    this._constraintMethods = () => methods;
    return methods;
  }

  static _ondeleteMethods() {
    function isOndelete(func) {
      return isCallable(func) && hasattr(func, '_ondelete');
    }

    const methods = getmembers(this, 'proto', isOndelete).map(([, func]) => func);
    // optimization: memoize results on cls, it will not be recomputed
    this._ondeleteMethods = () => methods;
    return methods;
  }

  static _onchangeMethods() {
    function isOnChange(func) {
      return isCallable(func) && hasattr(func, '_onchange');
    }

    // collect onchange methods on the model's class
    const methods = new Dict();
    for (const [, func] of getmembers(this, 'proto', isOnChange)) {
      const missing = [];
      for (const name of func._onchange) {
        if (!(name in this._fields)) {
          missing.push(name);
        }
        methods[name] = methods[name] ?? [];
        methods[name].push(async (self) => func.call(self));
      }
      if (missing.length) {
        console.warn("@api.onchange%s parameters must be field names -> not valid: %s", func._onchange, missing);
      }
    }

    // add onchange methods to implement "changeDefault" on fields
    async function onchangeDefault(field, self) {
      const value = await field.convertToWrite(await self[field.name], self);
      const condition = `${field.name}=${value}`;
      const defaults = await self.env.items('ir.default').getModelDefaults(self._name, condition);
      await self.update(defaults);
    }

    for (const [name, field] of this._fields) {
      if (field.changeDefault) {
        methods[name] = methods[name] ?? [];
        methods[name].push(partial(onchangeDefault, field));
      }
    }

    // optimization: memoize result on cls, it will not be recomputed
    this._onchangeMethods = () => methods;
    return methods;
  }

  _getProxy() {
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (BASIC_KEYS.includes(prop)) {
          return Reflect.get(target, prop, receiver);
        }
        const cls = Object.getPrototypeOf(target).constructor;
        if (cls._fields[prop] instanceof Field) {
          return cls._fields[prop].__get__(receiver, cls);
        }
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        } else {
          const key = parseInt(String(prop));
          if (!isNaN(key)) { // is number
            return target.__call__([key]); // inst[3]
          }
          const func = _super(Object.getPrototypeOf(cls), receiver, false)[prop];
          setattr(target, prop, func);
          return func;
        }
      },
      set(target, prop, value, receiver) {
        const cls = Object.getPrototypeOf(target).constructor;
        if (cls._fields[prop] instanceof Field) {
          return cls._fields[prop].__set__(receiver, value);
        }
        return Reflect.set(target, prop, value);
      },
      apply(target, thisArg, args) {
        return target.__call__(args);
      },
    });
  }

  /**
   * If ``key`` is an integer or a slice, return the corresponding record
    selection as an instance (attached to ``self.env``).
    Otherwise read the field ``key`` of the first record in ``self``.
    Examples::
        inst = await model.search(dom)    // inst is a recordset
        r4 = inst(3)                      // record: fourth record in inst
        rs = inst([10,20])                // records: subset of inst
        nm = await rs('label')            // value: label of first record in inst
        first = user(0);
        [id, comapny] = await user('id', 'companyId');
        [id, comapny] = await user(['id', 'companyId']);
        [first] = await user([0, 1]);
        [second, third] = await user(1, 2);
   * @param target 
   * @param args 
   * @returns 
   */
  __call__(args) {
    if (Array.isArray(args[0])) {
      if (typeof args[0][0] === 'number') {
        return this.browse(this._ids.slice(...args[0]));
      }
      else {
        return this._getValue.call(this._getProxy(), args[0]);
      }
    }
    if (typeof args[0] === 'number') {
      return this.browse(this._ids.slice(args[0])[0]);
    } else {
      return this._getValue.call(this._getProxy(), ...args);
    }
  }

  clearCaches() {
    this.cls.pool._clearCache();
  }

  async _isAnOrdinaryTable() {
    return this.pool.isAnOrdinaryTable(this);
  }

  @api.model()
  _prepareSetup() {
    const cls = Object.getPrototypeOf(this).constructor;
    cls._setupDone = false;
    if (cls.__bases[0] !== cls.__baseClasses[0]) { // Already to make in MetaModel.build() 
      MetaModel.setPrototype(cls, cls.__baseClasses[0]);
      cls._moduleName = cls.__baseClasses[0]._moduleName;
    }

    for (const attr of ['_recName', '_activeName']) {
      discardattr(cls, attr);
    }
  }

  @api.model()
  async _setupBase() {
    const cls = this.constructor;
    if (cls._setupDone) {
      return;
    }

    for (const name of cls._fields.keys()) {
      discardattr(cls, name);
    }
    cls._fields.clear();

    const definitions = new DefaultDict();
    const mro = cls._mro();

    for (let i = mro.length - 1; i >= 0; i--) {
      const klass = mro[i];
      if (isDefinitionClass(klass)) {
        for (const field of klass._fieldDefinitions ?? []) {
          definitions[field.name] = definitions[field.name] || [];
          definitions[field.name].push(field);
        }
      }
    }
    for (const [name, fields] of Object.entries(definitions)) {
      if (fields.length == 1 && fields[0]._direct && fields[0].modelName === cls._name) {
        cls._fields[name] = fields[0];
      } else {
        this._addField(name, fields.slice(-1)[0].new({ _baseFields: fields }));
      }
    }

    if (getattr(cls, 'pool')._initModules.size) {
      const model = this.env.items('ir.model.fields');
      await model._addManualFields(this);
    }

    await this._inheritsCheck();
    for (const parent of Object.keys(cls._inherits ?? {})) {
      await this.env.items(parent)._setupBase();
    }
    this._addInheritedFields();

    cls._setupDone = true;

    for (const [name, field] of cls._fields) {
      field.prepareSetup();
    }

    if (cls._recName) {
      assert(cls._fields.has(cls._recName), `Invalid _recName=${cls._recName} for model ${cls._name}`)
    } else if (cls._fields.has('label')) {
      cls._recName = 'label';
    } else if (cls._custom && cls.fields.has('xLabel')) {
      cls._recName = 'xLabel';
    }

    if (cls._activeName) {
      assert(cls._fields.has(cls._activeName) && ['active', 'xActive'].includes(cls._activeName),
        `Invalid _activeName=${cls._activeName} for model ${cls._name}; only 'active' and 'xActive' are supported and the field must be present on the model`
      )
    } else if (cls._fields.has('active')) {
      cls._activeName = 'active';
    } else if (cls._fields.has('xActive')) {
      cls._activeName = 'xActive';
    }
  }

  @api.model()
  _setupFields() {
    const cls = this.constructor;

    const badFields = [];
    for (const [name, field] of cls._fields.items()) {
      try {
        field.setup(this);
      } catch (e) {
        if (field.baseField.manual) {
          badFields.push(name);
          continue;
        }
        throw e;
      }
    }
    for (const name of badFields) {
      this._popField(name)
    }
  }

  @api.model()
  _addField(name, field) {
    const cls = this.cls;
    const f = getattr(cls, name, field);
    if (!isInstance(f, Field)) {
      console.warn("In model '%s', field '%s' overriding existing value", cls._name, name);
    }
    setattr(cls, name, field);
    field._toplevel = true;
    field.__setName(cls, name);
    cls._fields[name] = field;
  }

  @api.model()
  _popField(name) {
    const cls = this.cls;
    const field = cls._fields.pop(name, null);
    discardattr(cls, name);
    if (cls._recName === name) {
      cls._recName = null;
      if (cls.displayName in cls.pool.fieldDepends) {
        cls.pool.fieldDepends[cls.displayName] = cls.pool.fieldDepends[cls.displayName].filter(dep => dep !== name);
      }
    }
    return field;
  }

  @api.model()
  _setupComplete() {
    const cls = this.constructor;
    cls._initConstraintsOnchanges();
  }

  @api.model()
  _addInheritedFields() {
    const cls = this.constructor;
    if (cls._abstract || !bool(cls._inherits)) {
      return;
    }

    const toInherit = {};
    for (const [parentModelName, parentFname] of Object.entries(cls._inherits)) {
      for (const [name, field] of this.env.models[parentModelName]._fields) {
        toInherit[name] = [parentFname, field];
      }
    }

    for (const [name, [parentFname, field]] of Object.entries(toInherit)) {
      if (!cls._fields.has(name)) {
        this._addField(name, field.new({
          inherited: true,
          inheritedField: field,
          related: `${parentFname}.${name}`,
          relatedSudo: false,
          copy: field.copy,
          readonly: field.readonly,
        }))
      }
    }
  }

  @api.depends((model) => model.constructor._logAccess ? ['createdAt', 'updatedAt'] : [])
  async _computeConcurrencyField() {
    const cls = this.cls;
    const fname = cls.CONCURRENCY_CHECK_FIELD;
    if (cls._logAccess) {
      for (const record of this) {
        const value = await record.updatedAt || await record.createdAt || _Datetime.now();
        await record.set(fname, value);
      }
    } else {
      await this.set(fname, _Datetime.now());
    }
  }

  @api.model()
  async _validateFields(fieldNames, excludedNames = []) {
    const cls = this.constructor;
    fieldNames = fieldNames;
    excludedNames = excludedNames;
    const methods = cls._constraintMethods(this);
    for (const check of methods) {
      if (intersection(fieldNames, check._constrains).length &&
        !intersection(excludedNames, check._constrains).length)
        await check.apply(this);
    }
  }

  @api.model()
  async userHasGroups(groups) {
    const request = this.env.req;
    const user = await this.env.user();

    const hasGroups = [];
    const notHasGroups = [];
    for (let groupExtId of groups.split(',')) {
      groupExtId = groupExtId.trim();
      if (groupExtId[0] === '!') {
        notHasGroups.push(groupExtId.substring(1));
      }
      else {
        hasGroups.push(groupExtId);
      }
    }
    for (const groupExtId of notHasGroups) {
      if (groupExtId === 'base.groupNoOne') {
        // check: the groupNoOne is effective in debug mode only
        if (await user.hasGroup(groupExtId) && request && request.session.debug) {
          return false;
        }
      }
      else {
        if (await user.hasGroup(groupExtId)) {
          return false;
        }
      }
    }

    for (const groupExtId of hasGroups) {
      if (groupExtId === 'base.groupNoOne') {
        // check: the groupNoOne is effective in debug mode only
        if (await user.hasGroup(groupExtId) && request && request.session.debug) {
          return true;
        }
      }
      else {
        if (await user.hasGroup(groupExtId)) {
          return true;
        }
      }
    }
    return !hasGroups.length;
  }

  @api.model()
  async checkAccessRights(operation, raiseException = true) {
    if (typeof operation !== 'string') {
      raiseException = operation['raiseException'] ?? true;
      operation = operation['operation'];
    }
    const model = this.env.items('ir.model.access');
    return model.check(this.cls._name, operation, raiseException)
  }

  async checkAccessRule(operation) {
    if (this.env.su) {
      return;
    }

    const invalid = this.sub(await this._filterAccessRulesSystem(operation));
    if (!invalid.ok) {
      return;
    }

    const forbidden = await invalid.exists();
    if (bool(forbidden)) {
      throw await this.env.items('ir.rule')._makeAccessError(operation, forbidden);
    }

    if (['read', 'unlink'].includes(operation)) {
      return;
    }

    console.info('Failed operation on deleted record(s): %s, uid: %s, model: %s', operation, this._uid, this.cls._name);
    throw new MissingError(
      await this._t('One of the documents you are trying to access has been deleted, please try again after refreshing.') + format('\n\n(%s %s, %s %s, %s %s, %s %s)', await this._t('Document type:'), this.cls._name, await this._t('Operations:'), operation, await this._t('Records:'), invalid.ids.slice(0, 6), await this._t('User:'), this._uid)
    );
  }

  async _filterAccessRules(operation) {
    if (this.env.su) {
      return this;
    }

    if (!this._ids) {
      return this;
    }

    const query = new Query(this.env.cr, this.cls._table, await this.tableQuery());
    await this._applyIrRules(query, operation);
    if (!bool(query.whereClause)) {
      return this;
    }

    // determine ids in database that satisfy ir.rules
    const validIds = new Set();
    query.addWhere(`"${this.cls._table}".id IN (%%s)`);
    const [queryStr, params] = query.select();
    await this._flushSearch([]);
    for (const subIds of this._cr.splitForInConditions(this.ids)) {
      let str = queryStr.replace('%%s', subIds.toString());
      str = tools._convert$(str);
      const res = await this._cr.execute(str, { bind: params });
      res.forEach((row) => validIds.add(row['id']));
    }

    // return new ids without origin and ids with origin in validIds
    return this.browse(this._ids.filter((it) => !(it ?? it.origin) || validIds.has(it ?? it.origin)));
  }

  async _filterAccessRulesSystem(operation) {
    const dom = await this.env.items('ir.rule')._computeDomain(this.cls._name, operation);
    return (await this.sudo()).filteredDomain(dom || []);
  }

  @api.model()
  async checkFieldAccessRights(operation, fields) {
    if (this.env.su) {
      return fields ?? this.cls._fields.keys();
    }

    const self = this;
    function valid(fname) {
      const field = self._fields[fname];
      if (field && field.groups) {
        return self.userHasGroups(field.groups);
      }
      else {
        return true;
      }
    }

    if (!bool(fields)) {
      fields = this._fields.keys().filter(name => valid(name));
    }
    else {
      const invalidFields = fields.filter(name => !valid(name));
      if (invalidFields.length) {
        console.log('Access Denied by ACLs for operation: %s, uid: %s, model: %s, fields: %s', operation, this._uid, this.cls._name, invalidFields.join(','));
        const description = await (await this.env.items('ir.model')._get(this.cls._name)).label;
        if (!await (await this.env.user()).hasGroup('base.groupNoOne')) {
          throw new AccessError(_format(await this._t(`You do not have enough rights to access the fields "{fields}" on {documentKind} (%{documentModel}). Please contact your system administrator.\n(Operation: {operation})')`), {
            'fields': invalidFields.join(','),
            'documentKind': description,
            'documentModel': this.cls._name,
            'operation': operation,
          }));
        }

        async function formatGroups(field) {
          if (field.groups === '.')
            return this._t("always forbidden")

          let anyof = this.env.items('res.groups');
          let noneof = this.env.items('res.groups');
          for (const g of field.groups.split(',')) {
            if (g.startsWith('!')) {
              noneof = noneof.or(await this.env.ref(g.slice(1)));
            }
            else {
              anyof = anyof.or(await this.env.ref(g));
            }
          }
          const strs = [];
          if (anyof._length) {
            const list = await Promise.all(sorted(anyof, (g) => g.id).map(async (g) => await g.displayName));
            strs.push(await this._t("allowed for groups %s", list.join(', ')));
          }
          if (noneof._length) {
            const list = await Promise.all(sorted(noneof, (g) => g.id).map(async (g) => await g.displayName));
            strs.push(await this._t("forbidden for groups %s", list.join(', ')));
          }
          return strs.join('; ');
        }

        throw new AccessError(_format(await this._t(`The requested operation can not be completed due to security restrictions.
          Document type: {documentKind} ({documentModel})
          Operation: {operation}
          User: {user}
          Fields: {fieldsList}`),
          {
            'documentModel': this.cls._name,
            'documentKind': description || this.cls._name,
            'operation': operation,
            'user': this._uid,
            'fieldsList': sorted(invalidFields).map(f => `- ${f} (${formatGroups(this.cls._fields[f])})`).join('\n')
          }));
      }
    }

    return fields;
  }

  async copyTranslations(newObj, excluded = {}) {
    let old = this;
    // avoid recursion through already copied records in case of circular relationship
    if (!('__copyTranslationsSeen' in old._context)) {
      old = await old.withContext({ __copyTranslationsSeen: new DefaultDict2(() => new Set()) });
    }
    const seenMap = old._context['__copyTranslationsSeen'];
    if (seenMap[old.cls._name].has(old.id)) {
      return;
    }
    seenMap[old.cls._name].add(old.id);

    /**
     * Return the `label` of the translations to search for, together
          with the record ids corresponding to `'old'` and `'new'`.
     * @param field 
     * @param old 
     * @param newObj 
     * @returns 
     */
    async function getTrans(field, oldObj, newObj) {
      if (field.inherited) {
        const pname = field.related.split('.')[0];
        return getTrans(field.relatedField, await oldObj[pname], await newObj[pname]);
      }
      return [`${field.modelName},${field.name}`, oldObj.id, newObj.id]
    }

    // removing the lang to compare untranslated values
    const [oldWoLang, newWoLang] = [...await old.add(newObj).withContext({ lang: null })];
    const Translation = old.env.items('ir.translation');

    for (const [name, field] of old._fields.items()) {
      if (!field.copy)
        continue;

      if (field.inherited && field.related.split('.')[0] in excluded) {
        // inherited fields that come from a user-provided parent record must not copy translations, as the parent record is not a copy of the old parent record
        continue;
      }

      if (field.type === 'one2many' && !(field.name in excluded)) {
        // we must recursively copy the translations for o2m; here we
        // rely on the order of the ids to match the translations as
        // foreseen in copyData()
        const oldLines = await (await old[name]).sorted('id');
        const newLines = await (await newObj[name]).sorted('id');
        for (const [oldLine, newLine] of zip(oldLines, newLines)) {
          // don't pass excluded as it is not about those lines
          await oldLine.copyTranslations(newLine);
        }
      }
      else if (field.translate) {
        // for translatable fields we copy their translations
        const [transName, sourceId, targetId] = await getTrans(field, old, newObj);
        const domain = [['label', '=', transName], ['resId', '=', sourceId]];
        const newVal = await newWoLang[name];
        if (old.env.lang && isCallable(field.translate)) {
          // the new value *without lang* must be the old value without lang
          await newWoLang.set(name, await oldWoLang[name]);
        }
        const valsList = [];
        for (const vals of await Translation.searchRead(domain)) {
          delete vals['id'];
          delete vals['module'];      // duplicated vals is not linked to any module
          vals['resId'] = targetId;
          if (!isCallable(field.translate))
            vals['src'] = await newWoLang[name];
          if (vals['lang'] === old.env.lang && field.translate === true) {
            // update master record if the newVal was not changed by copy override
            if (newVal === await old[name]) {
              await newWoLang.set(name, await oldWoLang[name]);
              vals['src'] = await oldWoLang[name];
            }
            // the value should be the new value (given by copy())
            vals['value'] = newVal;
          }
          valsList.push(vals);
        }
        await Translation._upsertTranslations(valsList);
      }
    }
  }

  async _readFormat(fnames = [], load = '_classicRead') {
    const data = [];
    for (const record of this) {
      data.push([record, { 'id': record._ids[0] }]);
    }

    const useNameGet = (load === '_classicRead');
    for (const name of fnames) {
      const field = this._fields[name];
      const convert = field.convertToRead;
      for (const [record, vals] of data) {
        // missing records have their vals empty
        if (!len(vals)) {
          continue;
        }
        try {
          vals[name] = await convert.call(field, await record[name], record, useNameGet);
        } catch (e) {
          if (isInstance(e, MissingError)) {
            for (const key of Object.keys(vals)) {
              delete vals[key];
            }
          }
          else {
            throw e;
          }
        }
      }
    }
    return data.filter(([record, vals]) => len(vals)).map(([record, vals]) => vals);
  }

  async readOne(fields, load = '_classicRead') {
    const res = (await this.read(fields, load))[0] ?? {};
    return res;
  }

  @api.model()
  async _readGroupExpandFull(groups, domain, order) {
    return groups.search([], { order: order });
  }

  async _readGroupResolveMany2xFields(data, fields) {
    const many2xfields = new Set(fields.filter(field => ['many2one', 'many2many'].includes(field['type'])).map(field => field['field']));
    for (const field of many2xfields) {
      const idsSet = new Set(data.filter(d => d[field]).map(d => d[field]));
      const m2xRecords = await this.env.items(this._fields[field].comodelName).browse(idsSet);
      const dataDict = Dict.from(await lazyNameGet(await m2xRecords.sudo()));
      for (const d of data) {
        d[field] = d[field] ? [d[field], dataDict[d[field]]] : false
      }
    }
  }

  @api.model()
  async _readGroupFillTemporal(data, groupby, aggregatedFields, annotatedGroupbys,
    fillFrom = false, fillTo = false, minGroups = false) {
    const firstAGby = annotatedGroupbys[0];
    if (!['date', 'datetime'].includes(firstAGby['type'])) {
      return data;
    }
    const interval = firstAGby['interval'];
    const granularity = firstAGby['granularity'];
    const tz = firstAGby["tzConvert"] ? this._context['tz'] : false;
    let groupbyName = groupby[0];

    // existing non null datetimes
    let existing = data.filter(d => d[groupbyName]).map(d => d[groupbyName]);
    existing = existing.length ? existing : [null];
    // assumption: existing data is sorted by field 'groupbyLabel'
    const [existingFrom, existingTo] = [existing[0], existing.slice(-1)[0]];

    if (fillFrom) {
      fillFrom = tools.startOf(_Datetime.toDatetime(fillFrom), granularity);
      if (tz) {
        fillFrom = tools.dateSetTz(fillFrom, tz);
      }
    }
    else if (existingFrom) {
      fillFrom = existingFrom;
    }
    if (fillTo) {
      fillTo = tools.startOf(_Datetime.toDatetime(fillTo), granularity);
      if (tz) {
        fillTo = tools.dateSetTz(fillTo, tz);
      }
    }
    else if (existingTo) {
      fillTo = existingTo;
    }
    if (!fillTo && fillFrom) {
      fillTo = fillFrom;
    }
    if (!fillFrom && fillTo) {
      fillFrom = fillTo;
    }
    if (!fillFrom && !fillTo) {
      return data;
    }

    if (minGroups > 0) {
      fillTo = tools.dateMax(fillTo, fillFrom + (minGroups - 1) * interval);
    }
    if (fillTo < fillFrom) {
      return data;
    }

    const requiredDates = tools.daterange(fillFrom, fillTo, interval);

    if (existing[0] == null) {
      existing = Array.fom(requiredDates);
    }
    else {
      existing = sorted(_.union(existing, requiredDates));
    }
    const emptyItem = { 'id': false, [(groupbyName.split(':')[0] + '_count')]: 0 };
    update(emptyItem, Object.fromEntries(aggregatedFields.map(key => [key, false])));
    update(emptyItem, Object.fromEntries(annotatedGroupbys.slice(1).map(group => group['groupby']).map(key => [key, false])));

    const groupedData = new DefaultDict2(() => []);
    for (const d of data) {
      groupedData[d[groupbyName]].push(d);
    }
    const result = [];
    for (const dt of existing) {
      extend(result, bool(groupedData[dt]) ? groupedData[dt] : [Object.assign({}, emptyItem, { [groupbyName]: dt })]);
    }
    if (false in groupedData) {
      extend(result, groupedData[false]);
    }
    return result;
  }

  @api.model()
  async _readGroupFormatResult(data, annotatedGroupbys, groupby, domain) {
    const sections = [];
    for (const gb of annotatedGroupbys) {
      const ftype = gb['type'];
      let value = data[gb['groupby']];

      // full domain for this groupby spec
      let d = null;
      if (bool(value)) {
        if (['many2one', 'many2many'].includes(ftype)) {
          value = value[0];
        }
        else if (['date', 'datetime'].includes(ftype)) {
          const locale = (await (await getLang(this.env)).code).replace('_', '-');
          const fmt = ftype == 'datetime' ? DEFAULT_SERVER_DATETIME_FORMAT : DEFAULT_SERVER_DATE_FORMAT;
          let tzinfo = null;
          let rangeStart = value;
          let rangeEnd = tools.addDate(value, gb['interval']);
          // value from postgres is in local tz (so range is
          // considered in local tz e.g. "day" is [00:00, 00:00]
          // local rather than UTC which could be [11:00, 11:00]
          // local) but domain and raw value should be in UTC
          if (gb['tzConvert']) {
            tzinfo = rangeStart.tzinfo;
            // rangeStart = rangeStart.astimezone(pytz.utc)
            // rangeEnd = tzinfo.localize(rangeEnd.replace(tzinfo=None))
            // rangeEnd = rangeEnd.astimezone(pytz.utc)
          }
          rangeStart = tools.toFormat(rangeStart, fmt);
          rangeEnd = tools.toFormat(rangeEnd, fmt);
          let label;
          if (ftype == 'datetime') {
            label = DateTime.fromJSDate(value).setLocale(locale).toLocaleString(gb['displayFormat'], { zone: tzinfo });
          }
          else {
            label = DateTime.fromJSDate(value).setLocale(locale).toLocaleString(gb['displayFormat']);
          }
          data[gb['groupby']] = [`${rangeStart}/${rangeEnd}`, label]
          d = [
            '&',
            [gb['field'], '>=', rangeStart],
            [gb['field'], '<', rangeEnd],
          ]
        }
      }
      if (d == null) {
        d = [[gb['field'], '=', value]];
      }
      sections.push(d);
    }
    sections.push(domain);

    data['__domain'] = expression.AND(sections);
    if (len(groupby) - len(annotatedGroupbys) >= 1) {
      data['__context'] = { 'groupby': groupby.slice(len(annotatedGroupbys)) }
    }
    delete data['id'];
    return data;
  }

  @api.model()
  async _readGroupFillResults(domain, groupby, remainingGroupbys, aggregatedFields, countField, readGroupResult, readGroupOrder) {
    const field = this._fields[groupby];
    if (!field.groupExpand)
      return readGroupResult;

    // field.groupExpand is a callable or the name of a method, that returns
    // the groups that we want to display for this field, in the form of a
    // recordset or a list of values (depending on the type of the field).
    // This is useful to implement kanban views for instance, where some
    // columns should be displayed even if they don't contain any record.
    let groupExpand = field.groupExpand;
    if (typeof groupExpand === 'string') {
      groupExpand = this[groupExpand];
    }
    assert(isCallable(groupExpand));

    // determine all groups that should be returned
    let values = [];
    for (const line of readGroupResult) {
      if (bool(line[groupby])) {
        values.push(line[groupby]);
      }
    }

    let value2key, groups;
    if (field.relational) {
      // groups is a recordset; determine order on groups's model
      groups = this.env.items(field.comodelName).browse(values.map(value => value[0]));
      let order = groups.cls._order;
      if (readGroupOrder === groupby + ' desc') {
        order = tools.reverseOrder(order);
      }
      groups = await groupExpand.call(this, groups, domain, order);
      groups = await groups.sudo();
      values = await lazyNameGet(groups);
      value2key = (value) => value && value[0];
    }
    else {
      // groups is a list of values
      values = await groupExpand.call(this, values, domain, null);
      if (readGroupOrder === groupby + ' desc') {
        values = await values.reversed();
      }
      value2key = (value) => value;
    }
    // Merge the current results (list of dicts) with all groups. Determine
    // the global order of results groups, which is supposed to be in the
    // same order as read_groupResult (in the case of a many2one field).
    const result = new Dict(await values.map(value => [value2key(value), {}]));

    // fill in results from readGroupResult
    for (const line of readGroupResult) {
      const key = value2key(line[groupby]);
      if (!bool(result[key])) {
        result[key] = line;
      }
      else {
        result[key][countField] = line[countField];
      }
    }

    // fill in missing results from all groups
    for (const value of values) {
      const key = value2key(value);
      if (!bool(result[key])) {
        const line = Dict.fromKeys(aggregatedFields, false);
        line[groupby] = value;
        line[groupby + '_count'] = 0;
        line['__domain'] = [[groupby, '=', key]].concat(domain);
        if (bool(remainingGroupbys)) {
          line['__context'] = { 'groupby': remainingGroupbys }
        }
        result[key] = line;
      }
    }
    // add folding information if present
    if (field.relational && groups.cls._foldName in groups._fields) {
      const fold = {}
      for (const group of groups.browse(Object.keys(result).filter(key => bool(key)))) {
        fold[group.id] = await group[groups.cls._foldName];
      }
      for (const [key, line] of Object.entries(result)) {
        line['__fold'] = fold[key] ?? false;
      }
    }

    return Array.from(Object.values(result));
  }

  @api.model()
  async _readGroupPrepareData(key, value, groupbyDict = {}) {
    value = value == null ? false : value;
    const gb = groupbyDict[key];
    if (gb && ['date', 'datetime'].includes(gb['type']) && value) {
      if (typeof value === 'string') {
        value = gb['type'] === 'date' ? tools.toDate(value) : tools.toDatetime(value);
      }
      if (gb['tzConvert']) {
        value = tools.dateSetTz(value, this._context['tz']);
      }
    }
    // force parse Number
    if (typeof value === 'string' && value !== '') {
      const val = Number(value);
      if (!Number.isNaN(val)) {
        return val;
      }
    }
    return value;
  }

  @api.model()
  async _readGroupPrepare(orderby, aggregatedFields, annotatedGroupbys, query) {
    const orderbyTerms = [];
    let groupbyTerms = annotatedGroupbys.map(gb => gb['qualifiedField']);
    if (!orderby) {
      return [groupbyTerms, orderbyTerms];
    }

    await this._checkQorder(orderby);

    // when a field is grouped as 'foo:bar', both orderby='foo' and orderby='foo:bar' generate the clause 'ORDER BY "foo:bar"'
    const groupbyFields = {};
    for (const gb of annotatedGroupbys) {
      for (const key of ['field', 'groupby']) {
        groupbyFields[gb[key]] = gb['groupby'];
      }
    }
    for (const orderPart of orderby.split(',')) {
      const orderSplit = orderPart.replace('  ', ' ').split(' ');
      const orderField = orderSplit[0];
      if (orderField === 'id' || orderField in groupbyFields) {
        if (this._fields[orderField.split(':')[0]].type === 'many2one') {
          const orderClause = (await this._generateOrderBy(orderPart, query)).replace('ORDER BY ', '');
          if (orderClause) {
            orderbyTerms.push(orderClause);
            extend(groupbyTerms, orderClause.split(',').filter(e => e.trim()).map(orderTerm => orderTerm.replace(/\s+/g, ' ').trim().split(' ')[0]));
          }
        }
        else {
          orderSplit[0] = f('"%s"', groupbyFields[orderField] ?? orderField);
          orderbyTerms.push(orderSplit.join(' '));
        }
      }
      else if (aggregatedFields.includes(orderField)) {
        orderSplit[0] = f('"%s"', orderField);
        orderbyTerms.push(orderSplit.join(' '));
      }
      else if (!(orderField in this._fields)) {
        throw new ValueError("Invalid field %s on model %s", orderField, this._name);
      }
      else {
        // Cannot order by a field that will not appear in the results (needs to be grouped or aggregated)
        console.warn('%s: readGroup order by `%s` ignored, cannot sort on empty columns (not grouped/aggregated)', this._name, orderPart);
      }
    }
    return [groupbyTerms, orderbyTerms];
  }

  @api.model()
  async _readGroupProcessGroupby(gb, query) {
    const split = gb.split(':')
    const field = this._fields.get(split[0]);
    if (!field) {
      throw new ValueError("Invalid field %s on model %s", split[0], this._name);
    }
    const fieldType = field.type;
    const gbFunction = len(split) == 2 ? split[1] : null;
    const temporal = ['date', 'datetime'].includes(fieldType);
    const tzConvert = fieldType === 'datetime' && allTimezones.includes(this._context['tz']);
    let qualifiedField = await this._inheritsJoinCalc(this.cls._table, split[0], query);
    let displayFormats, timeIntervals;
    if (temporal) {
      displayFormats = {
        // Careful with week/year formats:
        //  - yyyy (lower) must always be used, *except* for week+year formats
        //  - YYYY (upper) must always be used for week+year format
        //         e.g. 2006-01-01 is W52 2005 in some locales (de_DE), and W1 2006 for others
        //
        // Mixing both formats, e.g. 'MMM YYYY' would yield wrong results,
        // such as 2006-01-01 being formatted as "January 2005" in some locales.
        // Cfr: http://babel.pocoo.org/en/latest/dates.html#date-fields
        'hour': 'hh:00 dd MMM',
        'day': 'dd MMM yyyy', // yyyy = normal year
        'week': "WW yyyy",  // w YYYY = ISO week-year
        'month': 'MMMM yyyy',
        'quarter': 'q yyyy',
        'year': 'yyyy',
      }
      timeIntervals = {
        'hour': Duration.fromObject({ hours: 1 }),
        'day': Duration.fromObject({ days: 1 }),
        'week': Duration.fromObject({ days: 7 }),
        'month': Duration.fromObject({ months: 1 }),
        'quarter': Duration.fromObject({ months: 3 }),
        'year': Duration.fromObject({ years: 1 })
      }
      if (tzConvert) {
        qualifiedField = f("timezone('%s', timezone('UTC',%s))", this._context['tz'] || 'UTC', qualifiedField);
      }
      qualifiedField = f("date_trunc('%s', %s::timestamp)", gbFunction ?? 'month', qualifiedField);
    }
    if (fieldType === 'boolean') {
      qualifiedField = f("coalesce(%s,false)", qualifiedField);
    }
    return {
      'field': split[0],
      'groupby': gb,
      'type': fieldType,
      'displayFormat': temporal ? displayFormats[gbFunction ?? 'month'] : null,
      'interval': temporal ? timeIntervals[gbFunction ?? 'month'] : null,
      'granularity': temporal ? (gbFunction ?? 'month') : null,
      'tzConvert': tzConvert,
      'qualifiedField': qualifiedField,
    }
  }

  async _parentStoreCompute() {
    if (!this.cls._parentStore) {
      return;
    }

    // Each record is associated to a string 'parentPath', that represents
    // the path from the record's root node to the record. The path is made
    // of the node ids suffixed with a slash (see example below). The nodes
    // in the subtree of record are the ones where 'parentPath' starts with
    // the 'parentPath' of record.
    //
    //               a                 node | id | parentPath
    //              / \                  a  | 42 | 42/
    //            ...  b                 b  | 63 | 42/63/
    //                / \                c  | 84 | 42/63/84/
    //               c   d               d  | 85 | 42/63/85/
    //
    // Note: the final '/' is necessary to match subtrees correctly: '42/63'
    // is a prefix of '42/630', but '42/63/' is not a prefix of '42/630/'.
    console.info('Computing parentPath for table %s...', this.cls._table);
    const query = tools._f(`
          WITH RECURSIVE __parent_store_compute(id, "parentPath") AS (
              SELECT row.id, concat(row.id, '/')
              FROM "{table}" row
              WHERE row."{parent}" IS NULL
          UNION
              SELECT row.id, concat(comp."parentPath", row.id, '/')
              FROM "{table}" row, __parent_store_compute comp
              WHERE row."{parent}" = comp.id
          )
          UPDATE "{table}" row SET "parentPath" = comp."parentPath"
          FROM __parent_store_compute comp
          WHERE row.id = comp.id
      `, { table: this.cls._table, parent: this.cls._parentName });
    await this.env.cr.execute(query);
    this.invalidateCache(['parentPath']);
    return true;
  }

  async _parentStoreUpdatePrepare(vals = {}) {
    if (!this.cls._parentStore || !(this.cls._parentName in vals)) {
      return this.browse();
    }

    // No need to recompute the values if the parent is the same.
    const parentVal = vals[this.cls._parentName]
    let query, params;
    if (parentVal) {
      query = `SELECT id FROM "${this.cls._table}"
                  WHERE id IN (${String(this.ids) || 'NULL'}) AND ("${this.cls._parentName}" != ${parentVal} OR "${this.cls._parentName}" IS NULL)`;
    }
    else {
      query = ` SELECT id FROM "${this.cls._table}"
                  WHERE id IN (${String(this.ids) || 'NULL'}) AND "${this.cls._parentName}" IS NOT NULL `
    }
    const res = await this._cr.execute(query, params);
    return this.browse(res.map(row => row['id']));
  }

  async _parentStoreUpdate() {
    const cr = this.env.cr;

    // determine new prefix of parentPath
    let query = `
        SELECT "parent"."parentPath" FROM "${this.cls._table}" node, "${this.cls._table}" parent
        WHERE node.id = ${this.ids[0]} AND parent.id = node."${this.cls._parentName}"
    `;
    let res = await cr.execute(query);
    const prefix = res.length ? res[0]['parentPath'] : '';

    // check for recursion
    if (prefix) {
      const parentIds = prefix.split('/').slice(0, -1).map(label => parseInt(label));
      if (intersection(parentIds, this._ids).length) {
        throw new UserError(await this._t("Recursion Detected."));
      }
    }

    // update parentPath of all records and their descendants
    query = `
        UPDATE "${this.cls._table}" child
        SET "parentPath" = concat(%s, substr(child."parentPath",
                length(node."parentPath") - length(node.id || '/') + 1))
        FROM "${this.cls._table}" node
        WHERE node.id IN (${String(this.ids) || 'NULL'})
        AND child."parentPath" LIKE concat(node."parentPath", '%%')
        RETURNING child.id, child."parentPath"
    `;
    res = await cr.execute(query);

    // update the cache of updated nodes, and determine what to recompute
    const records = this.browse(res.map(row => row['id']));
    this.env.cache.update(records, this._fields['parentPath'], res.map(row => row['parentPath']));
    await records.modified(['parentPath']);
  }

  async _parentStoreCreate() {
    if (!this.cls._parentStore) {
      return;
    }
    const query = `
      UPDATE "${this.cls._table}" node
      SET "parentPath"=concat((SELECT parent."parentPath" FROM "${this.cls._table}" parent
        WHERE parent.id=node."${this.cls._parentName}"), node.id, '/')
      WHERE node.id IN (${String(this.ids) || 'NULL'})
    `;
    await this._cr.execute(query);
  }

  _browse(env, ids, prefetchIds) {
    const cls = this.constructor;
    const records = new cls();
    records._name = cls._name;
    records._ids = ids;
    records._prefetchIds = prefetchIds;
    records.env = env;
    records.cls = cls;
    records.pool = cls.pool;
    return records;
  }

  browse(ids) {
    if (!ids) {
      ids = [];
    } else if (ids instanceof NewId) {
      ids = [ids];
    } else if (typeof ids === 'number') {
      ids = [ids];
    } else if (typeof ids === 'string') {
      ids = [Number(ids)];
    } else if (ids instanceof Dict) {
      ids = ids.keys().map(id => Number(id));
    } else if (ids instanceof Map) {
      ids = Array.from(ids.keys()).map(id => Number(id));
    } else {
      ids = Array.from(ids);
    }
    if (typeof ids[0] === 'string') { // Sometimes ids is array of string 'id'
      ids = ids.map(id => Number(id));
    }
    return this._browse(this.env, ids, ids);
  }

  @api.model()
  @api.returns('self',
    (self, value, args, options = {}) => options.count ? value : value.ids,
    (self, value, args, options = {}) => options.count ? value : self.browse(value))
  async search(args, options = {}) {
    let res = await this._search(args, options);
    return options.count ? res : this.browse(res);
  }

  @api.model()
  async searchCount(args) {
    const res = await this.search(args, { count: true });
    return typeof res === 'number' ? res : len(res);
  }

  @api.model()
  async nameSearch(options = {}) { // Tony todo will change labelSearch
    const ids = await this._nameSearch(pop(options, 'name', ''), pop(options, 'args', []), pop(options, 'operator', 'ilike'), options);
    return (await this.browse(ids).sudo()).nameGet();
  }

  @api.model()
  async _addMissingDefaultValues(values) {
    const avoidModels = new Set();

    const self = this;
    function collectModelsToAvoid(model) {
      for (const [parentMname, parentFname] of Object.entries(model._inherits)) {
        if (parentFname in values) {
          avoidModels.add(parentMname);
        }
        else {
          // manage the case where an ancestor parent field is set
          collectModelsToAvoid(self.env.models[parentMname]);
        }
      }
    }
    collectModelsToAvoid(self.cls);

    function avoid(field) {
      // check whether the field is inherited from one of avoidModels
      if (avoidModels.size) {
        while (field.inherited) {
          field = field.relatedField;
          if (avoidModels.has(field.modelName)) {
            return true;
          }
        }
      }
      return false;
    }

    const missingDefaults = new Set();
    for (const [name, field] of this._fields) {
      if (!(name in values) && !avoid(field)) {
        missingDefaults.add(name);
      }
    }

    const defaults = await this.defaultGet(Array.from(missingDefaults));
    for (const [name, value] of defaults) {
      if (this._fields[name].type === 'many2many' && value && typeof value[0] === 'number') {
        defaults[name] = [Command.set(value)];
      }
      else if (this._fields[name].type === 'one2many' && value && isInstance(value[0], Dict)) {
        defaults[name] = value.map(x => Command.create(x));
      }
    }
    defaults.updateFrom(values);
    return defaults;
  }

  _inCacheWithout(field, limit = PREFETCH_MAX) {
    let ids = expandIds(this.id, this._prefetchIds);
    ids = this.env.cache.getMissingIds(this.browse(ids), field);
    if (limit) {
      ids = islice(ids, limit);
    }
    // Those records are aimed at being either fetched, or computed.  But the
    // method '_fetchField' is not correct with new records: it considers
    // them as forbidden records, and clears their cache!  On the other hand,
    // compute methods are not invoked with a mix of real and new records for
    // the sake of code simplicity.
    return this.browse(ids);
  }

  async _fetchField(field) {
    await this.checkFieldAccessRights('read', [field.name]);
    // determine which fields can be prefetched
    let fnames = [];
    let self = this;
    if ((self._context['prefetchFields'] ?? true) && field.prefetch) {
      for (const [name, f] of self._fields) {
        if ((f.prefetch)
          && (!(f.groups && !(await self.userHasGroups(f.groups))))
          && (!(f.compute && self.env.recordsToCompute(f).ok))) {
          fnames.push(name);
        }
      }
      if (!fnames.includes(field.name)) {
        fnames.push(field.name);
        self = self.sub(self.env.recordsToCompute(field));
      }
    } else {
      fnames = [field.name];
    }
    await self._read(fnames);
  }

  async _checkConcurrency() {
    if (!(this.cls._logAccess && this._context[this.cls.CONCURRENCY_CHECK_FIELD])) {
      return;
    }
    const checkClause = `(id = %s AND "%s" < COALESCE("updatedAt", "createdAt", (now() at time zone 'UTC'))::timestamp)`;
    for (const subIds of this._cr.splitForInConditions(this.ids)) {
      let nclauses = 0;
      let params = [];
      for (const id of subIds) {
        const idRef = `${this.cls._name},${id}`;
        const updateDate = this._context[this.cls.CONCURRENCY_CHECK_FIELD].pop(idRef) ?? null;
        if (updateDate) {
          nclauses += 1;
          params = extend(params, [id, updateDate]);
        }
      }
      if (!nclauses) {
        continue;
      }
      const clause = fill(Array(nclauses), checkClause).join(' OR ');
      const query = `SELECT id FROM "${this.cls._table}" WHERE ${clause}`;
      const sql = format(query, params);
      const res = await this._cr.execute(sql);
      if (res.length) {
        // mention the first one only to keep the error message readable
        throw new ValidationError(await this._t('A document was modified since you last viewed it (%s:%s)', this.cls._description, res[0]));
      }
    }
  }

  async _inheritsJoinCals(alias, fname, query) {
    let model = this;
    let field = this._fields[fname];
    while (field.inherited) {
      const parentModel = this.env.items(field.relatedField.modelName);
      const parentFname = field.related.split('.')[0];
      const parentAlias = query.leftJoin(alias, parentFname, parentModel.cls._table, 'id', parentFname);
      [model, alias, field] = [parentModel, parentAlias, field.relatedField];
    }

    if (field.type === 'many2many') {
      const comodel = this.env.items(field.comodelName);
      const subquery = new Query(this.env.cr, comodel.cls._table);
      await comodel._applyIrRules(subquery);
      let extra = null;
      let extraParams = [];
      let subqueryStr;
      if (subquery.whereClause.length) {
        [subqueryStr, extraParams] = subquery.select();
        extra = `"{rhs}"."${field.column2}" IN (${subqueryStr})`
      }
      const relAlias = query.leftJoin(alias, 'id', field.relation, field.column1, field.name, { extra: extra, extraParams: extraParams });
      return `"${relAlias}"."${field.column2}"`;
    }
    else if (field.translate === true) {
      return model._generateTranslatedField(alias, fname, query);
    }
    else {
      return `"${alias}"."${fname}"`;
    }
  }

  _addFakeFields(fields) {
    fields['null'] = Fields.Char('recName');
    fields['id'] = Fields.Char('External ID');
    fields['.id'] = Fields.Integer('Database ID');
    return fields;
  }

  async _convertToWrite(values) {
    const fields = this._fields;
    const result = {}
    for (let [name, value] of Object.entries(values)) {
      if (name in fields) {
        const field = fields[name];
        value = await field.convertToWrite(value, this);
        if (!isInstance(value, NewId)) {
          result[name] = value
        }
      }
    }
    return result;
  }

  @api.model()
  invalidateCache(fnames, ids) {
    let fields = [];
    if (!bool(fnames)) { // fnames == null
      if (!bool(ids)) {  // ids == null
        return this.env.cache.invalidate();
      }
      fields = this._fields.values();
    } else {
      fields = fnames.map((n) => this._fields[n]).filter(f => f != null);
    }
    let spec = [];
    for (const f in fields) {
      for (const invf of this.pool.fieldInverses.get(f)) {
        spec.push([invf, null]);
      }
    }
    spec = fields.map(f => [f, ids]).concat(spec);
    this.env.cache.invalidate(spec);
  }

  async modified(fnames, create = false, before = false) {
    if (!this.ok || !fnames) {
      return;
    }
    let tree;
    fnames = Array.isArray(fnames) ? fnames : Object.keys(fnames);
    if (fnames.length == 1) {
      const field = this._fields[fnames[0]];
      tree = this.pool.fieldTriggers.get(field);
    } else {
      tree = new Map();
      for (const fname of fnames) {
        const node = this.pool.fieldTriggers.get(this._fields[fname]);
        if (bool(node)) {
          triggerTreeMerge(tree, node);
        }
      }
    }
    if (len(tree)) {
      const sudo = await (await this.sudo()).withContext({ activeTest: false });
      let tocompute = sudo._modifiedTriggers(tree, create);

      if (before) {
        const _tocompute = [];
        for await (let item of tocompute) {
          _tocompute.push(item);
        }
        tocompute = _tocompute;
      }

      for await (let [field, records, create] of tocompute) {
        let recursivelyMarked;
        records = records.sub(this.env.protected(field));
        if (records.nok) {
          continue;
        }
        if (field.compute && field.store) {
          if (field.recursive) {
            recursivelyMarked = this.env.notToCompute(field, records);
          }
          this.env.addToCompute(field, records);
        } else {
          if (field.recursive) {
            recursivelyMarked = records.and(this.env.cache.getRecords(records, field));
          }
          const val = this.env.cache.invalidate([[field, records._ids]]);
        }
        if (field.recursive) {
          await recursivelyMarked.modified([field.name], create);
        }
      }
    }
  }

  async *_modifiedTriggers(tree, create = false) {
    if (!this.ok) {
      return;
    }

    for (const field of (tree.get(null) ?? [])) {
      yield [field, this, create];
    }

    for (const [key, val] of tree.entries()) {
      if (key === null) {
        continue;
      } else if (create && ['many2one', 'many2oneReference'].includes(key.type)) {
        continue;
      } else {
        const model = this.env.items(key.modelName);
        let found = false;
        let records;
        for (const invf of model.pool.fieldInverses.get(key)) {
          if (!(['one2many', 'many2many'].includes(invf.type) && invf.domain?.length)) {
            if (invf.type === 'many2oneReference') {
              const recIds = new Set();
              for (const rec of this) {
                try {
                  if (await rec[invf.modelField] === key.modelName) {
                    recIds.add(await rec[invf.name])
                  }
                } catch (e) {
                  if (isInstance(e, MissingError)) {
                    continue;
                  }
                  else {
                    throw e;
                  }
                }
              }
              records = model.browse(recIds);
            } else {
              records = await this[invf.name];
              if (records == undefined) {
                const self = await this.exists();
                records = await self[invf.name];
              }
            }
            if (key.modelName === records.constructor._name) {
              if (!this._ids.every((id) => id != 0)) {
                // if self are new, records should be new as well
                records = records.browse(records._ids.map((id) => newId(id)))
              }
              found = true;
              break;
            }
          }
        }
        if (!found) {
          const newRecords = await this.filtered((r) => !bool(r.id));
          const realRecords = this.sub(newRecords);
          records = model.browse();
          if (realRecords.ok) {
            records.or(await model.search([[key.name, 'in', Array.from(realRecords._ids)]], { order: 'id' }));
          }
          if (newRecords.ok) {
            const cacheRecords = this.env.cache.getRecords(model, key);
            const self = this;
            records.or(await cacheRecords.filtered(async (r) => intersection((await r[key.name])._ids, self._ids).length));
          }
        }
        const trigger = records._modifiedTriggers(val);
        for await (const entry of trigger) {
          yield entry;
        }
      }
    }
  }

  async _checkM2mRecursion(fieldName) {
    const field = this._fields.get(fieldName);
    if (!(field && field.type === 'many2many' &&
      field.comodelName === this._name && field.store)) {
      // field must be a many2many on itself
      throw new ValueError('invalid fieldName: %s', fieldName);
    }
    this.flush([fieldName]);

    const cr = this._cr;
    const query = tools.f('SELECT "%s" AS id1, "%s" AS id2 FROM "%s" WHERE "%s" IN ($1) AND "%s" IS NOT NULL', field.column1, field.column2, field.relation, field.column1, field.column2);

    const succs = new DefaultDict2(Set);        // transitive closure of successors
    const preds = new DefaultDict2(Set);        // transitive closure of predecessors
    const [todo, done] = [new Set(this.ids), new Set()];
    while (todo.size) {
      // retrieve the respective successors of the nodes in 'todo'
      const res = await cr.execute(query, { bind: [Array.from(todo).join(',')] });
      todo.forEach(e => done.add(e));
      todo.clear();
      for (const { id1, id2 } of res) {
        // connect id1 and its predecessors to id2 and its successors
        for (const [x, y] of tools.product([id1].concat([...preds[id1]]), [id2].concat([...succs[id2]]))) {
          if (x === y) {
            return false;    // we found a cycle here!
          }
          succs[x].add(y);
          preds[y].add(x);
        }
        if (!done.has(id2)) {
          todo.add(id2);
        }
      }
    }
    return true;
  }

  async _getExternalIds() {
    const result = new DefaultDict();
    const domain = [['model', '=', this.cls._name], ['resId', 'in', this.ids]]
    for (const data of await (await this.env.items('ir.model.data').sudo()).searchRead(domain, ['module', 'label', 'resId'], { order: 'id' })) {
      result[data['resId']] = result[data['resId']] || [];
      result[data['resId']].push(`${data['module']}.${data['label']}`);
    }
    const res = {}
    for (const record of this) {
      res[record.id] = result[record._origin.id];
    }
    return res;
  }

  async getExternalId() {
    const results = await this._getExternalIds();
    return Object.fromEntries(Object.entries(results).map(([key, val]) => [key, len(val) ? val[0] : '']));
  }

  @api.model()
  async recompute(fnames, records) {
    const self = this;
    async function _process(field) {
      let recs = self.env.recordsToCompute(field);
      if (!bool(recs)) {
        return;
      }
      if (field.compute && field.store) {
        recs = await recs.filtered('id');
        try {
          await field.recompute(recs);
        } catch (e) {
          if (isInstance(e, MissingError)) {
            const existing = await recs.exists();
            await field.recompute(existing);
            for (const f of recs.pool.fieldComputed[field]) {
              this.env.removeToCompute(f, recs.filter((r) => !existing.includes(r)))
            }
          }
          else {
            throw e;
          }
        }
      } else {
        self.env.cache.invalidate([[field, recs._ids]])
        self.env.removeToCompute(field, recs)
      }
    }

    if (!fnames) {
      for (const field of this.env.fieldsToCompute()) {
        await _process(field);
      }
    } else {
      const fields = fnames.map(fname => this._fields[fname]);
      if (records != null && !fields.some(field => bool(records.and(this.env.recordsToCompute(field))))) {
        return;
      }

      // recompute the given fields on self's model
      for (const field of fields) {
        await _process(field);
      }
    }
  }

  _dependentFields(field) {
    function* traverse(node) {
      for (const [key, val] of Object.entries(node)) {
        if (key == null) {
          for (const v of val) {
            yield v;
          }
        }
        else {
          for (const v of traverse(val)) {
            yield v;
          }
        }
      }
    }
    return traverse(this.pool.fieldTriggers.get(field) ?? {});
  }

  @api.model()
  async _whereCalc(domain = [], activeTest = true) {
    const cls = this.constructor;
    if (cls._activeName && activeTest && (this._context['activeTest'] !== false)) {
      if (!domain.some((item) => item[0] === cls._activeName)) {
        domain = [[cls._activeName, '=', 1], ...domain];
      }
    }
    if (domain.length) {
      const exp = await expression.Expression.new(domain, this);
      return exp.query;
    } else {
      return new Query(this.env.cr, cls._table, await this.tableQuery());
    }
  }

  @api.model()
  _generateTranslatedField(tableAlias, field, query) {
    if (this.env.lang) {
      const alias = query.leftJoin(
        tableAlias, 'id', 'irTranslation', 'resId', field,
        {
          extra: `"{rhs}"."type" = 'model' AND "{rhs}"."label" = %s AND "{rhs}"."lang" = %s AND "{rhs}"."value" != %s`,
          extraParams: [f("%s,%s", this._name, field), this.env.lang, ""]
        },
      )
      return f('COALESCE("%s"."%s", "%s"."%s")', alias, 'value', tableAlias, field);
    }
    else {
      return f('"%s"."%s"', tableAlias, field);
    }
  }

  @api.model()
  async _generateOrderByInner(alias, orderSpec, query, reverseDirection = false, seen) {
    if (seen == null) {
      seen = new Set();
    }
    await this._checkQorder(orderSpec);

    let orderByElements = [];
    for (const orderPart of orderSpec.split(',')) {
      const orderSplit = orderPart.trim().split(' ');
      const orderField = orderSplit[0].trim();
      let orderDirection = orderSplit.length == 2 ? orderSplit[1].trim().toLocaleUpperCase() : '';
      if (reverseDirection) {
        orderDirection = orderDirection === 'DESC' ? 'ASC' : 'DESC';
      }
      const doReverse = orderDirection === 'DESC';

      let field = this.cls._fields[orderField];
      if (!field) {
        throw new ValueError("Invalid field %s on model %s", orderField, this.cls._name);
      }

      if (orderField === 'id') {
        orderByElements.push(`"${alias}"."${orderField}" ${orderDirection}`);
      }
      else {
        if (field.inherited) {
          field = field.baseField;
        }
        if (field.store && field.type === 'many2one') {
          const key = [field.modelName, field.comodelName, orderField];
          if (!seen.has(key)) {
            seen.add(key);
            orderByElements = orderByElements.concat(await this._generateM2oOrderBy(alias, orderField, query, doReverse, seen))
          }
        }
        else if (field.store && field.columnType) {
          let qualifieldName = await this._inheritsJoinCalc(alias, orderField, query);
          if (field.type === 'boolean') {
            qualifieldName = `COALESCE(${qualifieldName}, false)`;
          }
          orderByElements.push(`${qualifieldName} ${orderDirection}`);
        }
        else {
          console.warn("Model %s cannot be sorted on field %s (not a column)", this.cls._name, orderField);
          continue;  // ignore non-readable or "non-joinable" fields
        }
      }
    }
    return orderByElements;
  }

  async _checkQorder(word) {
    if (!regexOrder.test(word)) {
      throw new UserError(await this._t(
        'Invalid "order" specified (%s). A valid "order" specification is a comma-separated list of valid field names (optionally followed by asc/desc for the direction)',
        word,
      ))
    }
    return true;
  }

  _inheritsJoinAdd(currentModel, parentModelName, query) {
    const inheritsField = currentModel._inherits[parentModelName];
    const parentModel = this.env.models[parentModelName];
    const parentAlias = query.leftJoin(
      currentModel._table, inheritsField, parentModel._table, 'id', inheritsField,
    )
    return parentAlias;
  }

  @api.model()
  async _inheritsJoinCalc(alias, fname, query) {
    // INVARIANT: alias is the SQL alias of model._table in query
    let model = this;
    let field = this.cls._fields[fname];
    while (field.inherited) {
      // retrieve the parent model where field is inherited from
      const parentModel = this.env.items(field.relatedField.modelName);
      const parentFname = field.related.split('.')[0];
      // JOIN parentModel._table AS parentAlias ON alias.parentFname = parentAlias.id
      const parentAlias = query.leftJoin(
        alias, parentFname, parentModel.cls._table, 'id', parentFname,
      );
      [model, alias, field] = [parentModel, parentAlias, field.relatedField]
    }

    if (field.type === 'many2many') {
      // special case for many2many fields: prepare a query on the comodel
      // in order to reuse the mechanism _applyIrRules, then inject the
      // query as an extra condition of the left join
      const comodel = this.env.items(field.comodelName);
      const subquery = new Query(this.env.cr, comodel.cls._table);
      await comodel._applyIrRules(subquery);
      // add the extra join condition only if there is an actual subquery
      let [extra, extraParams] = [null, []];
      if (subquery.whereClause) {
        let subqueryStr;
        [subqueryStr, extraParams] = subquery.select();
        extra = `"{rhs}"."${field.column2}" IN (${subqueryStr})`;
      }
      // LEFT JOIN field_relation ON
      //     alias.id = field_relation.field_column1
      //     AND field_relation.field_column2 IN (subquery)
      const relAlias = query.leftJoin(
        alias, 'id', field.relation, field.column1, field.name,
        { extra: extra, extraParams: extraParams }
      )
      return `"${relAlias}"."${field.column2}"`;
    }

    else if (field.translate === true) {
      // handle the case where the field is translated
      return model._generateTranslatedField(alias, fname, query);
    }
    else {
      return `"${alias}"."${fname}"`;
    }
  }

  @api.model()
  async _generateM2oOrderBy(alias, orderField, query, reverseDirection, seen) {
    let field = this._fields[orderField];
    if (field.inherited) {
      // also add missing joins for reaching the table containing the m2o field
      const qualifiedField = await this._inheritsJoinCalc(alias, orderField, query);
      [alias, orderField] = qualifiedField.replace('"', '').split('.', 1);
      field = field.baseField;
    }

    assert(field.type === 'many2one', 'Invalid field passed to _generateM2oOrderBy()');
    if (!field.store) {
      console.debug("Many2one function/related fields must be stored to be used as ordering fields! Ignoring sorting for %s.%s", this.cls._name, orderField);
      return [];
    }

    // figure out the applicable orderby for the m2o
    const destModel = this.env.items(field.comodelName);
    let m2oOrder = destModel.cls._order;
    if (!regexOrder.test(m2oOrder)) {
      // _order is complex, can't use it here, so we default to _recName
      m2oOrder = destModel.cls._recName;
    }

    // Join the dest m2o table if it's not joined yet. We use [LEFT] OUTER join here
    // as we don't want to exclude results that have NULL values for the m2o
    const destAlias = query.leftJoin(alias, orderField, destModel.cls._table, 'id', orderField);
    return destModel._generateOrderByInner(destAlias, m2oOrder, query, reverseDirection, seen);
  }

  @api.model()
  async _generateOrderBy(orderSpec, query) {
    let orderByClause = '';
    orderSpec = orderSpec ? orderSpec : this.cls._order;
    if (orderSpec) {
      const orderByElements = await this._generateOrderByInner(this.cls._table, orderSpec, query);
      if (orderByElements.length) {
        orderByClause = orderByElements.join(',');
      }
    }

    return orderByClause ? `ORDER BY ${orderByClause} ` : '';
  }

  @api.model()
  async getEmptyListHelp(help) {
    return help;
  }

  @api.model()
  async _applyIrRules(query, mode) {
    const cls = this.cls;
    if (this.env.su) {
      return;
    }

    const rule = this.env.items('ir.rule');
    const domain = await rule._computeDomain(cls._name, mode);
    if (len(domain)) {
      await expression.Expression.new(domain, await this.sudo(), cls._table, query);
    }

    // apply ir.rules from the parents (through _parents)
    for (const parentModelName of Object.keys(cls._inherits || {})) {
      const domain = await rule._computeDomain(parentModelName, mode);
      if (len(domain)) {
        const parentModel = this.env.items(parentModelName);
        const parentAlias = this._inheritsJoinAdd(cls, parentModelName, query);
        await expression.Expression.new(domain, await parentModel.sudo(), parentAlias, query);
      }
    }
  }

  @api.model()
  fieldsGetKeys() {
    return Array.from(this._fields.keys());
  }

  @api.model()
  _recNameFallback() {
    // if this._recName is set, it belongs to this._fields
    return this.cls._recName ?? 'id';
  }

  @api.model()
  async _flushSearch(domain, options = {}) {
    const self = this;
    const cls = this.cls;
    let seen = options.seen;
    if (!seen) {
      seen = new Set();
    }
    else if (seen.has(cls._name)) {
      return;
    }
    const toFlush = new DefaultDict([]);
    if (options.fields) {
      toFlush[cls._name] = toFlush[cls._name] ?? new Set();
      options.fields.forEach((e) => toFlush[cls._name].add(e));
    }
    const computeDomain = await self.env.items('ir.rule')._computeDomain(cls._name, 'read') || [];
    domain = domain.concat(computeDomain);
    for (const arg of domain) {
      if (typeof arg === 'string') {
        continue;
      }
      if (typeof arg[0] !== 'string') {
        continue;
      }
      let modelName = cls._name;
      for (const fname of arg[0].split('.')) {
        const field = self.env.models[modelName]._fields.get(fname);
        if (!field) {
          break;
        }
        toFlush[modelName] = toFlush[modelName] ?? new Set();
        toFlush[modelName].add(fname);
        if (field.relatedField) {
          let model = self;
          for (const f of field.related.split('.')) {
            const rfield = model._fields.get(f);
            if (rfield) {
              toFlush[model.cls._name] = toFlush[model.cls._name] ?? new Set();
              toFlush[model.cls._name].add(f);
              if (['many2one', 'one2many', 'many2many'].includes(rfield.type)) {
                model = self.env.items(rfield.comodelName);
                if (rfield.type === 'one2many' && rfield.relationField) {
                  toFlush[rfield.comodelName] = toFlush[rfield.comodelName] ?? new Set();
                  toFlush[rfield.comodelName].add(rfield.relationField);
                }
              }
            }
          }
        }
        if (field.comodelName) {
          modelName = field.comodelName;
        }
      }
      if (['childOf', 'parentOf'].includes(arg[1])) {
        const model = self.env.items(modelName);
        if (model._parentStore) {
          toFlush[modelName] = toFlush[modelName] ?? new Set();
          toFlush[modelName].add(model.constructor._parentName);
        }
      }
    }

    // flush  the order fields
    const orderSpec = options.order ?? cls._order;
    for (const orderPart of orderSpec.split(',')) {
      const orderField = orderPart.trim().split(/\s+/)[0];
      const field = cls._fields.get(orderField);
      if (field) {
        toFlush[cls._name] = toFlush[cls._name] ?? new Set();
        toFlush[cls._name].add(orderField);
        if (field.relational) {
          await self.env.items(field.comodelName)._flushSearch([], { seen: options.seen });
        }
      }
    }

    if (cls._activeName) {
      toFlush[cls._name] = toFlush[cls._name] ?? new Set();
      toFlush[cls._name].add(cls._activeName);
    }

    // flush model dependencies (recursively)
    if (cls._depends.length) {
      const models = [cls];
      while (models.length) {
        const model = models.pop();
        for (const [modelName, fieldNames] of model._depends.items()) {
          fieldNames.forEach((e) => {
            toFlush[modelName] = toFlush[modelName] ?? new Set();
            toFlush[modelName].add(e);
          });
          models.push(self.env.models[modelName]);
        }
      }
    }

    for (const [modelName, fieldNames] of Object.entries(toFlush)) {
      await self.env.items(modelName).flush([...fieldNames]);
    }
  }

  get ids() {
    return originIds(this._ids);
  }

  get id() {
    return this.ids[0];
  }

  get _cr() {
    return this.env.cr;
  }

  get _uid() {
    return this.env.uid;
  }

  get _context() {
    return this.env.context ?? {};
  }

  get _fields() {
    return this.cls._fields;
  }

  get _origin() {
    const ids = originIds(this._ids);
    const prefetchIds = new IterableGenerator(originIds, this._prefetchIds);
    return this._browse(this.env, ids, prefetchIds);
  }

  get _cache() {
    if (!this.__cache__) {
      this.__cache__ = new RecordCache(this);
    }
    return this.__cache__;
  }

  get _length() {
    return this._ids ? this._ids.length : 0;
  }

  get ok() {
    return bool(getattr(this, '_ids', true));
  }

  get nok() {
    return !this.ok;
  }

  _bool() {
    return this.ok;
  }

  _hash() {
    if (hasattr(this, '_ids')) {
      return hash(stringify([this._name, Array.from(new Set(this._ids)).sort()]));
    }
    else {
      return hash(this._name);
    }
  }

  _int() {
    return bool(this.id) ? this.id : 0;
  }

  toString() {
    return `${this.cls._name}${this._ids.length == 0 ? '()' :
      this._ids.length == 1 ? '(' + this._ids.length + ')' : '(len:' + this._ids.length + ')'}`;
  }

  repr() {
    return this.toString();
  }

  valueOf() {
    return this.toString();
  }

  has(id) {
    return this._ids.includes(id);
  }

  includes(item) {
    return this.contains(item);
  }

  contains(item) {
    const cls = this.cls;
    if (isInstance(item, BaseModel) && cls._name === item._name) {
      return item._length == 1 && this._ids.includes(item.id);
    } else if (typeof (item) === 'string' || typeof (item) === 'symbol') {
      return item in cls._fields;
    } else if (isInstance(item, BaseModel)) {
      throw new TypeError(`cannot compare different models: '${cls._name}' and '${item._name}'`);
    } else {
      throw new TypeError(`unsupported operand type(s) for "of": '${cls._name}' and '${typeof item}'`);
    }
  }

  *[Symbol.iterator]() {
    if (len(this._ids) > PREFETCH_MAX && this._prefetchIds === this._ids) {
      for (const ids of this.env.cr.splitForInConditions(this._ids)) {
        for (const id of ids || []) {
          yield this._browse(this.env, [id], ids);
        }
      }
    } else {
      for (const id of this._ids || []) {
        yield this._browse(this.env, [id], this._prefetchIds);
      }
    }
  }

  forEach(func = (obj) => obj) {
    for (const obj of this) {
      func(obj);
    }
  }

  add(others) {
    return this.concat(others);
  }

  concat(others) {
    others = Array.isArray(others) ? others : [others];
    let ids = new Set(this._ids);
    for (const other of others) {
      if (isInstance(other, BaseModel) && other._name === this._name) {
        other._ids.forEach(id => { if (!ids.has(id)) ids.add(id) });
      } else if (isInstance(other, BaseModel)) {
        throw new TypeError(`cannot concat different models: '${this._name}()' and '${other._name}()'`)
      } else {
        throw new TypeError(`unsupported operand type(s) for "concat": '${this._name}()' and '${typeof other}'`)
      }
    }
    return this.browse(ids);
  }

  union(others) {
    others = Array.isArray(others) ? others : [others];
    let ids = new Set(this._ids);
    for (const other of others) {
      if (isInstance(other, BaseModel) && this._name === other._name) {
        other._ids.forEach(id => { if (!ids.has(id)) ids.add(id) });
      }
      else if (isInstance(other, BaseModel)) {
        throw new TypeError(`cannot union different models: '${this._name}()' and '${other._name}()'`);
      }
      else {
        throw new TypeError(`unsupported operand type(s) for "union": '${this._name}()' and '${typeof other}'`)
      }
    }
    return this.browse(ids);
  }

  slice(start, end) {
    const ids = len(this._ids) ? this._ids.slice(start, end) : [];
    return this.browse(ids);
  }

  sub(other) {
    let otherIds;
    if (isInstance(other, BaseModel) && this._name === other._name) {
      otherIds = other._ids;
    }
    else if (isInstance(other, BaseModel)) {
      throw new TypeError(`cannot substract different models: '${this._name}()' and '${other._name}()'`);
    }
    else {
      throw new TypeError(`unsupported operand type(s) for "-": '${this._name}()' and '${typeof other}'`);
    }
    return this.browse((this._ids ?? []).filter((id) => !(otherIds ?? []).includes(id)));
  }

  and(other) {
    let otherIds;
    if (isInstance(other, BaseModel) && this._name == other._name) {
      otherIds = other._ids;
    }
    else if (isInstance(other, BaseModel)) {
      throw new TypeError(`cannot "and" different models: '${this._name}()' and '${other._name}()'`);
    }
    else {
      throw new TypeError(`unsupported operand type(s) for "and": '${this._name}()' and '${typeof other}'`);
    }
    return this.browse((this._ids ?? []).filter((id) => otherIds.includes(id)));
  }

  or(other) {
    return this.union(other);
  }

  eq(other) {
    if (!isInstance(other, BaseModel)) {
      if (other) {
        console.warn("unsupported operand type(s) for '==': '%s()' == '%s' (%s:%s)", this._name, other, 'filename', 'lineno');
      }
      return;
    }
    return this._name === other._name && tools.equal(this._ids, other._ids);
  }

  ne(other) {
    return !this.eq(other);
  }

  lt(other) {
    if (!isInstance(other, BaseModel) || this._name !== other._name) {
      return new NotImplementedError();
    }
    return difference(other._ids, this._ids).length > 0;
  }

  le(other) {
    if (!isInstance(other, BaseModel) || this._name !== other._name) {
      return new NotImplementedError();
    }
    if (!this.ok) {
      return true;
    }
    return difference(other._ids, this._ids).length >= 0;
  }

  gt(other) {
    if (!isInstance(other, BaseModel) || this._name !== other._name) {
      return new NotImplementedError();
    }
    return difference(this._ids, other._ids).length > 0;
  }

  ge(other) {
    if (!isInstance(other, BaseModel) || this._name !== other._name) {
      return new NotImplementedError();
    }
    if (!other.ok) {
      return true;
    }
    return difference(this._ids, other._ids).length >= 0;
  }

  async _t(source, ...args) {
    return _t(this.env, source, ...args);
  }

  ensureOne() {
    try {
      const [id0, id1] = this._ids;
      if (id0 && !id1) {
        return this;
      }
      throw new TypeError();
    } catch (e) {
      if (isInstance(e, TypeError)) {
        throw new ValueError("Expected singleton: %s", this);
      }
    }
  }

  @api.model()
  async update(values) {
    for (const record of this) {
      for (const [name, value] of Object.entries(values)) {
        await record.set(name, value);
      }
    }
  }

  async set(fieldName, value) {
    await this._fields[fieldName].__set__(this, value);
  }

  async _getValue(...fieldNames) {
    assert(fieldNames.length, 'Must have fieldNames');
    const cls = this.constructor;
    if (Array.isArray(fieldNames[0])) {
      fieldNames = fieldNames[0];
    } else if (fieldNames.length == 1) {
      return cls._fields[fieldNames[0]].__get__(this, cls);
    }
    const values = [];
    for (const key of fieldNames) {
      values.push(await cls._fields[key].__get__(this, cls));
    }
    return values;
  }

  async getDict(...fieldNames) {
    this.ensureOne();
    if (Array.isArray(fieldNames[0])) {
      fieldNames = fieldNames[0];
    }
    return Dict.from(zip(fieldNames, await this._getValue(fieldNames)));
  }

  async sudo(flag = true) {
    return this.withEnv(await this.env.change({ su: flag }));
  }

  withEnv(env) {
    return this._browse(env, this._ids, this._prefetchIds);
  }

  async withUser(user) {
    // const self: any = this;
    if (!user) {
      return this;
    }
    return this.withEnv(await this.env.change({ user: user, su: false }))
  }

  async withCompany(company) {
    if (!bool(company)) {
      // With company = undefined/null/false/0/[]/empty recordset: keep current environment
      return this;
    }

    const companyId = typeof company === 'number' ? company : tools.parseInt(company.id);
    let allowedCompanyIds = this.env.context['allowedCompanyIds'] ?? [];
    if (allowedCompanyIds && companyId == allowedCompanyIds[0]) {
      return this;
    }
    // Copy the allowedCompanyIds list
    // to avoid modifying the context of the current environment.
    allowedCompanyIds = Array.from(allowedCompanyIds);
    if (allowedCompanyIds.includes(companyId)) {
      remove(allowedCompanyIds, companyId);
    }
    allowedCompanyIds.unshift(companyId);

    return this.withContext({ allowedCompanyIds: allowedCompanyIds });
  }

  async withContext(args = {}, kwargs = {}) {
    if ('forceCompany' in args || 'forceCompany' in kwargs) {
      console.warn(`Context key 'forceCompany' is no longer supported. Use withCompany(company) instead.`);
    }
    if ('company' in args || 'company' in kwargs) {
      console.warn(`Context key 'company' is not recommended, because of its special meaning in @dependsContext.`);
    }
    const context = {};
    if (Object.keys(kwargs).length) {
      Object.assign(context, args);
      Object.assign(context, kwargs);
    } else {
      Object.assign(context, this._context);
      Object.assign(context, args);
    }

    if (!('allowedCompanyIds' in context) && ('allowedCompanyIds' in this._context)) {
      context['allowedCompanyIds'] = this._context['allowedCompanyIds']
    }
    return this.withEnv(await this.env.clone({ context: context }));
  }

  withPrefetch(prefetchIds) {
    if (prefetchIds == null) {
      prefetchIds = this._ids;
    }
    return this._browse(this.env, this._ids, prefetchIds);
  }

  async _updateCache(values = {}, validate = true) {
    this.ensureOne();
    const cache = this.env.cache;
    const fields = this._fields;
    const fieldValues = [];
    for (const [name, value] of Object.entries(values)) {
      if (name in fields) {
        fieldValues.push([fields[name], value]);
      } else {
        throw new ValueError("Invalid field %s on model %s", name, this)
      }
    }
    for (const [field, value] of sorted(fieldValues, (item) => item[0].writeSequence)) {
      cache.set(this, field, await field.convertToCache(value, this, validate));
      if (field.relational) {
        const invRecs = await (await this[field.name]).filtered(r => !bool(r.id));
        if (!invRecs.ok) {
          continue;
        }
        for (const invf of this.pool.fieldInverses.get(field)) {
          for (const invRec of invRecs) {
            if (!cache.contains(invRec, invf)) {
              const val = await invf.convertToCache(this, invRec, false);
              cache.set(invRec, invf, val);
            } else {
              invf._update(invRec, this);
            }
          }
        }
      }
    }
  }

  async _checkRemovedColums(log = false) {
    if (this.cls._abstract)
      return;
    // iterate on the database columns to drop the NOT NULL constraints of
    // fields which were required but have been removed (or will be added by
    // another module)
    const cr = this._cr
    const cols = this._fields.items().filter(([name, field]) => field.store && field.columnType).map(([name]) => name);
    const sql = `
      SELECT a.attname, a.attnotnull
      FROM pg_class c, pg_attribute a
      WHERE c.relname='${this.cls._table}'
        AND c.oid=a.attrelid
        AND a.attisdropped=false
        AND pg_catalog.format_type(a.atttypid, a.atttypmod) NOT IN ('cid', 'tid', 'oid', 'xid')
        AND a.attname NOT IN (${quoteList(cols)})
    `;
    const res = await cr.execute(sql);

    for (const row of res) {
      if (log) {
        console.debug(`column ${row['attname']} is in the table ${this.cls._table} but not in the corresponding object ${this.cls._name}`);
      }
      if (row['attnotnull']) {
        await tools.dropNotNull(cr, this.cls._table, row['attname'])
      }
    }
  }

  async _tableHasRows() {
    const res = await this.env.cr.execute('SELECT 1 FROM "%s" LIMIT 1', [this.cls._table]);
    return res.length;
  }

  async _createParentColumns() {
    const cls = this.constructor;
    const cr = this._cr;
    await cr._obj.getQueryInterface().addColumn(cls._table, 'parentPath', DataTypes.STRING, { transaction: cr.objTransaction });
    if (!('parentPath' in cls._fields)) {
      console.error("add a field parentPath on model %s: parentPath = Fields.Char(index:true)", cls._name)
    } else if (!cls._fields['parentPath'].index) {
      console.error('parentPath field on model %s must be indexed! Add (index:true) to the field definition', cls._name)
    }
  }

  async _addSqlConstraints() {
    const cls = this.constructor;
    const cr = this._cr;
    const foreignKeyRe = new RegExp('\s*foreign\s+key\b.*', 'i');
    const constraints = await showConstraints(cr, cls._table);
    for (const [key, definition, message] of cls._sqlConstraints) {
      const conname = f('%s_%s', cls._table, key);
      const currentDefinition = constraints.find((value) => value['constraintName'] === conname);
      if (currentDefinition && currentDefinition['constraintName'] === definition) {
        continue;
      }
      if (currentDefinition) {
        // constraint exists but its definition may have changed
        await cr._obj.getQueryInterface().removeConstraint(cls._table, conname, { transaction: cr.objTransaction })
      }

      if (foreignKeyRe.test(definition)) {
        cls.pool.postInit(addConstraint, cr, cls._table, conname, definition, message);
      } else {
        cls.pool.postConstraint(addConstraint, cr, cls._table, conname, definition, message);
      }
    }
  }

  async _executeSql() {
    if (hasattr(this, '_sql')) {
      await this._cr.execute(this._sql);
    }
  }

  async _mappedFunc(func) {
    if (this.ok) {
      const vals = [];
      for (const rec of this) {
        vals.push(await func(rec));
      }
      if (isInstance(vals[0], BaseModel)) {
        return vals[0].union(...vals);
      }
      return vals;
    } else {
      const vals = await func(this);
      return isInstance(vals, BaseModel) ? vals : []
    }
  }

  async mapped(func) {
    if (!func) {
      return this;             // support for an empty path of fields
    }
    if (typeof func === 'string') {
      let recs = this;
      for (const name of func.split('.')) {
        const field = recs._fields[name];
        if (!field) {
          console.log('Not found field:', name);
        }
        recs = await field.mapped(recs);
      }
      return recs;
    } else {
      return this._mappedFunc(func);
    }
  }

  async map(func) {
    const vals = [];
    for (const rec of this) {
      vals.push(func(rec));
    }
    return Promise.all(vals);
  }

  async filter(func) {
    const vals = [];
    for (const rec of this) {
      if (bool(await func(rec))) {
        vals.push(rec);
      }
    }
    return vals;
  }

  async some(func) {
    for (const rec of this) {
      if (bool(await func(rec))) {
        return true;
      }
    }
    return false;
  }

  async sum(func) {
    let result = 0;
    for (const rec of this) {
      result += await func(rec);
    }
    return result;
  }

  async all(func) {
    for (const rec of this) {
      if (!bool(await func(rec))) {
        return false;
      }
    }
    return true;
  }

  async every(func) {
    return this.all(func);
  }

  async filtered(func) {
    if (typeof func === 'string') {
      const name = func;
      func = async (rec) => (await rec.mapped(name)).some(e => bool(e));
      // populate cache
      await this.mapped(name);
    }
    const ids = [];
    for (const rec of this) {
      if (bool(await func(rec))) {
        ids.push(rec.id);
      }
    }
    return this.browse(ids);
  }

  async filteredDomain(domain) {
    if (!bool(domain)) return this;
    const result = [];
    for (const d of Array.from(domain).reverse()) {
      if (d === '|')
        result.push(result.pop().or(result.pop()))
      else if (d === '!')
        result.push(this.sub(result.pop()))
      else if (d === '&')
        result.push(result.pop().and(result.pop()))
      else if (expression.isTrueLeaf(d))
        result.push(this)
      else if (expression.isFalseLeaf(d))
        result.push(this.browse())
      else {
        let [key, comparator, value] = d;
        if (['childOf', 'parentOf'].includes(comparator)) {
          result.push(this.search([['id', 'in', this.ids], d]));
          continue;
        }
        if (key.endsWith('.id'))
          key = key.slice(0, -3);
        if (key === 'id')
          key = '';
        // determine the field with the final type for values
        let field = null;
        if (key) {
          let model = this.browse();
          for (const fname of key.split('.')) {
            field = model._fields[fname];
            model = await model[fname];
          }
        }
        let valueEsc;
        if (['like', 'ilike', '=like', '=ilike', 'not ilike', 'not like'].includes(comparator)) {
          valueEsc = value.replace('_', '?').replace('%', '*').replace('[', '?');
        }
        const recordsIds = new OrderedSet2();
        for (const rec of this) {
          let data = await rec.mapped(key);
          if (isInstance(data, BaseModel)) {
            let v = value;
            if (Array.isArray(value) && value.length) {
              v = value[0];
            }
            if (typeof v === 'string') {
              data = await data.mapped('displayName');
            }
            else {
              data = data.ok && data.ids;
              data = bool(data) ? data : [false];
            }
          }
          else if (field && ['date', 'datetime'].includes(field.type)) {
            // convert all date and datetime values to datetime
            const normalize = _Datetime.toDatetime;
            if (Array.isArray(value)) {
              value = value.map(v => normalize(v));
            }
            else {
              value = normalize(value);
            }
            data = data.map(v => normalize(v));
          }
          if (['in', 'not in'].includes(comparator)) {
            if (!(Array.isArray(value))) {
              value = [value];
            }
          }

          let ok;
          if (comparator === '=')
            ok = data.includes(value)
          else if (comparator === 'in')
            ok = value.some(x => data.includes(x))
          else if (comparator === '<')
            ok = data.some(x => x != null && x < value)
          else if (comparator === '>')
            ok = data.some(x => x != null && x > value)
          else if (comparator === '<=')
            ok = data.some(x => x != null && x <= value)
          else if (comparator === '>=')
            ok = data.some(x => x != null && x >= value)
          else if (['!=', '<>'].includes(comparator))
            ok = !data.includes(value)
          else if (comparator === 'not in')
            ok = value.every(x => !data.includes(x))
          else if (comparator === 'not ilike') {
            data = data.map(x => x || "")
            ok = data.every(x => !x.toLowerCase().includes(value.toLowerCase()))
          }
          else if (comparator === 'ilike') {
            data = data.map(x => (x || "").toLowerCase())
            ok = data.filter(d => d.includes(valueEsc || '')).length > 0
          }
          else if (comparator === 'not like') {
            data = data.map(x => x || "")
            ok = data.every(x => !x.includes(value))
          }
          else if (comparator === 'like') {
            data = data.map(x => x || "")
            ok = data.filter(d => d.includes(value && valueEsc)).length > 0
          }
          else if (comparator === '=?')
            ok = data.includes(value) || !value
          else if (['=like'].includes(comparator)) {
            data = data.map(x => x || "")
            ok = data.filter(d => d.includes(valueEsc)).length > 0
          }
          else if (['=ilike'].includes(comparator)) {
            data = data.map(x => (x || "").toLowerCase())
            ok = data.filter(d => d.includes(value && valueEsc.toLowerCase())).length > 0
          }
          else
            throw new ValueError('data invalid %s', data)
          if (ok)
            recordsIds.add(rec.id)
        }
        result.push(this.browse(recordsIds));
      }
    }
    while (result.length > 1) {
      result.push(result.pop().and(result.pop()));
    }
    return result[0];
  }

  async sorted(key, reverse = false) {
    if (!key) {
      const recs = await this.search([['id', 'in', this.ids]]);
      return reverse ? this.browse(Array.from(recs._ids).reverse()) : recs;
    }
    if (typeof key === 'string') {
      key = async (item) => await item[key];
    }
    return this.browse((await sortedAsync(this, key, reverse)).map(item => item.id));
  }

  async reversed(key = null) {
    return this.sorted(key, true);
  }

  get _populateSizes() {
    return {
      'small': 10,    // minimal representative set
      'medium': 100,  // average database load
      'large': 1000,  // maxi database load
    }
  }

  get _populateDependencies() {
    return [];
  }

  async _populate(size) {
    const batchSize = 1000,
      minSize = this._populateSizes[size];

    let recordCount = 0,
      createValues = [],
      complete = false;

    const fieldGenerators = await this._populateFactories();
    if (!bool(fieldGenerators)) {
      return this.browse(); // maybe create an automatic generator?
    }

    const recordsBatches = [];
    const generator = await populate.chainFactories(fieldGenerators, this._name);
    while (recordCount <= minSize || !complete) {
      const values = await tools.nextAsync(generator);
      complete = values.pop('__complete');
      createValues.push(values);
      recordCount += 1;
      if (len(createValues) >= batchSize) {
        console.info('Batch: %s/%s', recordCount, minSize);
        recordsBatches.push(await this.create(createValues));
        createValues = [];
      }
    }
    if (createValues.length) {
      recordsBatches.push(await this.create(createValues));
    }
    return this.concat(recordsBatches);
  }
}

export const AbstractModel = BaseModel;

@MetaModel.define()
export class Model extends BaseModel {
  static _module = module;
  static _auto = true;                // automatically create database backend
  static _register = false;           // not visible in ORM registry, meant to be background-inherited only
  static _abstract = false;           // not abstract
  static _transient = false;          // not transient
}

@MetaModel.define()
export class TransientModel extends Model {
  static _module = module;
  static _auto = true;                // automatically create database backend
  static _register = false;           // not visible in ORM registry, meant to be background-inherited only
  static _abstract = false;           // not abstract
  static _transient = true;           // transient
}

function checkTableName(name) {
  if (!regexName.test(name)) {
    throw new ValidationError(`Invalid characters in table name ${name}`);
  }
  if (name.length > 63) {
    throw new ValidationError(`Table name ${name} is too long`);
  }
}

function triggerTreeMerge(tree, node) {
  for (const [key, val] of node) {
    if (key == null) {
      if (!tree.has(null)) {
        tree.set(null, new OrderedSet2());
      }
      tree.get(null).update(val);
    } else {
      if (!tree.has(key)) {
        tree.set(key, new Map());
      }
      triggerTreeMerge(tree.get(key), node.get(key));
    }
  }
}

const PRIVATE_NAMES = ['constructor', 'prototype', '_getProxy', '__call__'];

export function getmembers(cls, type = 'class', predicate = isCallable) {
  const func = type === 'class'
    ? (obj) => obj
    : (obj) => obj.prototype

  let names = Object.getOwnPropertyNames(func(cls));
  const bases = cls.mro ? cls.mro() : api.mro(cls);
  for (const base of bases) {
    Object.getOwnPropertyNames(func(base)).forEach(name => { if (!names.includes(name)) names.push(name) });
  }
  names = names.filter(name => !PRIVATE_NAMES.includes(name)).sort();

  let results = [];
  const processed = new Set();
  for (const key of names) {
    let value = [];
    try {
      value = [getattr(func(cls), key), cls];
      if (processed.has(key)) {
        throw new KeyError();
      }
    } catch (e) {
      if (isInstance(e, KeyError)) {
        for (const base of bases) {
          const attr = getattr(func(base), key, null);
          if (attr) {
            value = [attr, base];
            break;
          }
        }
      } else {
        continue;
      }
    }
    if (predicate(value[0])) {
      results.push([key, value[0], value[1]]);
    }
    processed.add(key);
  }
  return results;
}

export function categoryXmlid(category) {
  return 'category_' + camelCase(category.join('_').replace('&', 'and').replace(' ', '_'));
}

export function moduleXmlid(module) {
  return 'module_' + module;
}

export function modelXmlid(module, modelName) {
  return `${module}.model_${camelCase(modelName.replace('.', '_'))}`;
}

export function fieldXmlid(module, modelName, fieldName) {
  return `${module}.field_${camelCase(modelName.replace('.', '_'))}_${camelCase(fieldName)}`;
}

export function selectionXmlid(module, modelName, fieldName, value) {
  const xmodel = modelName.replace('.', '_')
  const xvalue = value.replace('.', '_').replace(' ', '_').toLowerCase();
  return `${module}.selection_${camelCase(xmodel)}_${camelCase(fieldName)}_${camelCase(xvalue)}`;
}