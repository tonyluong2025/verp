require('./../globals');
import _ from 'lodash';
import 'reflect-metadata';
import { Field } from '../fields';
import { DefaultDict, Dict, StackMap } from '../helper';
import { WebRequest } from '../http';
import { Registry } from '../modules/registry';
import { Cursor } from '../sql_db';
import { bool, equal, getValue, int, isCallable, isInstance, isObject, len, next, zip } from '../tools';
import { contextmanager } from '../tools/context';
import { stringify } from '../tools/json';
import * as lazy from '../tools/lazy';
import { hash } from '../tools/misc';
import { _t } from '../tools/translate';
import { AccessError, CacheMiss, KeyError, MissingError, UserError, ValueError } from './../helper/errors';
import { ModelRecords } from './../models';
import { hasattr } from './func';

export enum CopyMode { all = 'all', functions = 'functions', properties = 'properties', keys = 'keys' }

export type CopyOptions = {
  mode: CopyMode
  keys?: string[],
  excludes?: string[],
  force?: boolean,
  justValue?: boolean
}

export interface IGetSet {
  get(key: string): any;
  set(key: string, value: any): void;
}

/**
 * Propagate decorators '_returns' from `'method1'` to `'method2'`, and return the resulting method.
 * @param origin 
 * @param target 
 * @param attrs 
 * @returns 
 */
export function propagate(origin: Function, target: Function, attrs?: string[]): Function {
  // dummy parent class to catch overridden methods decorated with '_returns'
  const INHERITED_ATTRS = Array.isArray(attrs) ? attrs
    : attrs === null ? Object.getOwnPropertyNames(origin).filter(key => !['constructor', 'length', 'prototype', 'name'].includes(key))
      : attrs === undefined ? ['_returns']
        : [];

  if (origin != undefined) {
    for (const attr of INHERITED_ATTRS) {
      if (hasattr(origin, attr) && !hasattr(target, attr)) {
        Object.defineProperty(target, attr, Object.getOwnPropertyDescriptor(origin, attr));
      }
    }
  }
  return target;
}

export class Meta {
  protected static init(meta: any, attrs: {}) {
    this._propagate(meta, attrs);
    this._setNames(meta, attrs);
  }

  private static _propagate(meta: any, attrs: {}) {
    function propagateDes(parentDes: any, obj: any, key: string) {
      const des: any = Object.getOwnPropertyDescriptor(obj, key);
      if (des) {
        if (isCallable(des.value.value)) {
          propagate(parentDes?.value, des.value.value);
          return key;
        }
      }
    }

    function findPro(obj: any, key: string): PropertyDescriptor | undefined {
      const des = Object.getOwnPropertyDescriptor(obj, key);
      if (des) {
        return des;
      } else { // Có thể cấp hiện tại không có khóa cần tìm (do không cần định nghĩa lại) nhưng cấp cao hơn thì có nên cần làm theo cây phân cấp. 
        const parent = Object.getPrototypeOf(obj);
        if (parent?.prototype && parent.name !== '') {
          return findPro(parent.prototype, key);
        } else {
          return;
        }
      }
    }

    // Lan theo parent len tren de duyet het cac method 
    const parent = Object.getPrototypeOf(meta);
    if (parent.name === '') {
      return;
    }
    // Scan prototype (instance) properties
    const myInsPros = Object.getOwnPropertyDescriptors(meta.prototype);
    let keys = Object.keys(myInsPros);
    // Don't propagate constructor and special properties
    keys = keys.filter(key => !key.startsWith('__') && !['constructor', 'length', 'prototype', 'name'].includes(key));
    const l = [];
    for (const key of keys) {
      const parentDes = findPro(parent.prototype, key);
      if (parentDes) {
        if (propagateDes(parentDes, myInsPros, key)) {
          l.push(key);
        }
      }
    }
  }

  private static _setNames(meta: any, attrs: {}) {
    if (isCallable(meta)) {
      const entries = Object.entries<any>(meta);
      for (const [key, value] of entries) {
        if (isObject(value) && isCallable(value.__setName)) {
          value.__setName(meta, key);
        }
      }
    }
  }

  // Copies the functions, properties from one class to another
  static copy(target: object, source: object, options?: CopyOptions) {
    options = options ?? {
      mode: CopyMode.properties,
      justValue: true
    };
    let keys: string[];
    const badKeys: string[] = [];
    if (options.mode === CopyMode.keys && options.keys) {
      keys = options.keys;
    }
    keys = keys ?? Object.getOwnPropertyNames(source);
    keys = keys.filter(key => !['constructor', 'length', 'prototype', 'name', '_attrs'].includes(key));
    keys = keys.filter(key => !(options.excludes ?? []).includes(key));
    for (const key of keys) {
      const desc: any = Object.getOwnPropertyDescriptor(source, key);
      if (!desc) {
        badKeys.push(key);
        continue;
      }
      if (options.mode === CopyMode.functions && !isCallable(desc.value)) { // Just copy functions
        continue;
      }
      if (options.mode === CopyMode.properties && isCallable(desc.value)) { // Just copy properties
        continue;
      }
      if (options.force || !hasattr(target, key)) {
        if (options.justValue) {
          desc.value = getValue(desc.value); // Just get value of properties (3 primary types: string/boolean/number) and referrence/pointer (objects, array, set,...)
        }
        Object.defineProperty(target, key, desc);
      }
    }
    if (badKeys.length) {
      console.log(`Keys not found in ${source}`)
    }
  }
}

type indexType = string | number | symbol | null;

type ArgEnviroment = [Cursor, any, {}, boolean];

/**
 * An environment wraps data for ORM records:
  - `cr` the current database cursor;
  - `uid` the current user id;
  - `context` the current context dictionary;
  - `su` whether in superuser mode.

  It provides access to the registry by implementing a mapping from model
  names to new api models. It also holds a cache for records, and a data
  structure to manage recomputations.
 */
export class Environment {
  args: ArgEnviroment; // [cursor, uid, context, su]
  cr: Cursor;
  uid: number;
  context: Record<indexType, any>;
  su: boolean;

  registry: Registry;
  transaction: Transaction;
  all: Transaction;
  cache: Cache;

  req: WebRequest;

  private _user: any;
  private _cacheKey: DefaultDict<any, any>;
  private _protected: StackMap;

  daemonic: boolean;
  label: string;
  ident: any;

  private constructor() { }

  static async new(cr: Cursor, uid: any, context: {} = {}, su: boolean = false, req?: WebRequest): Promise<Environment> {
    const env = new Environment();
    return env.init(cr, uid, context, su, req);
  }

  async init(cr: Cursor, uid: any, context: {} = {}, su = false, req?: WebRequest): Promise<Environment> {
    if (uid === global.SUPERUSER_ID) {
      su = true;
    }
    let transaction: Transaction = cr.transaction;
    if (!transaction) {
      transaction = cr.transaction = new Transaction(await Registry.create(cr.dbName, { req: req }));
    }
    // if env already exists, update the new request and return it
    for (const env of transaction.envs) {
      if (env.cr === cr && env.uid === uid && env.su === su && equal(env.context, context)) {
        Object.assign(this, env, { req: req });
        return this;
      }
    }

    this.args = [this.cr, this.uid, this.context, this.su] = [cr, uid, Object.assign({}, context), su];
    this.transaction = this.all = transaction;
    this.registry = transaction.registry;
    this.cache = transaction.cache;
    this._protected = transaction._protected;
    this._cacheKey = new DefaultDict<any, any>();
    this.req = req;
    transaction.envs.add(this);
    return this;
  }

  async reset() {
    await this.transaction.reset();
  }

  async change(options: { cr?: Cursor, user?: any, context?: {}, su?: boolean, req?: WebRequest } = {}) {
    const cr = options.cr ?? this.cr;
    let uid = options.user == null ? this.uid : int(options.user);
    uid = uid || this.uid;
    const context = options.context ?? this.context;
    const su = options.su ?? (!options.user && this.su);
    const req = options.req ?? this.req;
    const self = await Environment.new(cr, uid, context, su, req);
    Object.assign(self, {}); // pass this properties
    return self;
  }

  async clone(options: { registry?: Registry, cr?: Cursor, user?: number, context?: {}, su?: boolean, req?: WebRequest } = {}) {
    return this.change(options);
  }

  /**
   * Return the record corresponding to the given `'xmlid'`.
   * @param xmlid 
   * @param raiseIfNotFound 
   * @returns null or record
   */
  async ref(xmlid: string, raiseIfNotFound = true) {
    const [resModel, resId] = await this.items('ir.model.data')._xmlidToResModelResId(xmlid, raiseIfNotFound) ?? [];
    if (resModel && resId) {
      const record = this.items(resModel).browse(resId);
      if (bool(await record.exists())) {
        return record;
      }
      if (raiseIfNotFound) {
        throw new ValueError('No record found for unique ID %s. It may have been deleted.', xmlid);
      }
    }
    return null;
  }

  /**
   * Return whether the environment is in superuser mode.
   * @returns 
   */
  isSuperuser(): boolean {
    return this.su;
  }

  /**
   * Return whether the current user has group "Access Rights", or is in superuser mode.
   * @returns 
   */
  async isAdmin(): Promise<boolean> {
    return this.su || await (await this.user())._isAdmin();
  }

  /**
   * Return whether the current user has group "Settings", or is in superuser mode.
   * @returns 
   */
  async isSystem(): Promise<boolean> {
    return this.su || await (await this.user())._isSystem();
  }

  has(modelName: string) {
    return modelName in this.registry.models;
  }

  items(modelName: string): any {
    const cls = this.registry.models[modelName];
    if (!cls) {
      throw new KeyError('Undefined model "%s"', modelName);
    }
    return cls.prototype._browse(this, [], []);
  }

  get models() {
    return this.registry.models;
  }

  async user() {
    if (!this._user) {
      this._user = (await this.change({ su: true })).items('res.users').browse(this.uid);
    }
    return this._user;
  }

  async company() {
    const companyIds = this.context['allowCompanyIds'] || [];
    if (companyIds.length) {
      if (!this.su) {
        const userCompanyIds = await (await this.user()).companyIds;
        if (companyIds.some((cid) => !userCompanyIds.ids.includes(cid))) {
          throw new AccessError(await _t(this, 'Access to unauthorized or invalid companies.'))
        }
      }
      return this.items('res.company').browse(companyIds[0]);
    }
    return (await (await this.user()).companyId).withEnv(this);
  }

  async companies() {
    const companyIds = this.context['allowCompanyIds'] || [];
    const userCompanyIds = await (await this.user()).companyIds;
    if (companyIds.length) {
      if (!this.su) {
        if (companyIds.some((cid) => !userCompanyIds.ids.includes(cid))) {
          throw new AccessError(await _t(this, 'Access to unauthorized or invalid companies.'));
        }
      }
      return this.items('res.company').browse(companyIds);
    }
    return userCompanyIds.withEnv(this);
  }

  get lang() {
    return this.context['lang'];
  }

  clear() {
    lazy.resetAll(this);
    this.transaction.clear();
  }

  async protecting(what: any, records: any, func?: Function) {
    const _protected = this._protected;
    try {
      _protected.push();
      what = records == null ? what : [[what, records]];
      for (const [fields, records] of what) {
        for (const field of fields) {
          let ids = _protected.get(field, []);
          ids = _.union(ids, records._ids);
          _protected.set(field, ids);
        }
      }
      if (isCallable(func)) {
        await func();
      }
    } catch (e) {
      if (!isInstance(e, MissingError)) {
        console.debug('Protecting', e.stack); // todo hide
      }
    } finally {
      _protected.pop();
    }
  }

  isProtected(field: any, record: any): boolean {
    return this._protected.get(field, []).includes(record.id);
  }

  protected(field: any): ModelRecords {
    return this.items(field.modelName).browse(this._protected.get(field, []));
  }

  fieldsToCompute(): IterableIterator<any> {
    return this.all.tocompute.keys();
  }

  recordsToCompute(field: Field): any {
    const ids = this.all.tocompute.get(field, []);
    return this.items(field.modelName).browse(ids);
  }

  isToCompute(field: any, record: any): boolean {
    return this.all.tocompute.get(field, []).includes(record.id);
  }

  notToCompute(field: any, records: any): any {
    const ids = this.all.tocompute.get(field, []);
    return records.browse(records._ids.filter(id => !ids.includes(id)));
  }

  addToCompute(field: Field, records: any): any {
    if (!bool(records)) {
      return records;
    }
    if (!this.all.tocompute.has(field)) {
      this.all.tocompute.set(field, []);
    }
    const ids = this.all.tocompute.get(field);
    for (const id of records._ids) {
      if (ids.indexOf(id) === -1) {
        ids.push(id);
      }
    }
  }

  removeToCompute(field: Field, records: any): any {
    if (!bool(records)) {
      return;
    }
    let ids = this.all.tocompute.get(field, null);
    if (ids == null) {
      return;
    }
    let i = 0;
    while (i < ids.length) {
      if (records._ids.indexOf(ids[i]) !== -1) {
        ids.splice(i, 1);
      } else {
        i++;
      }
    }
    if (ids.length == 0) {
      this.all.tocompute.delete(field);
    }
  }

  @contextmanager()
  *noRecompute(): any {
    yield;
  }

  cacheKey(field: Field): any {
    try {
      if (!this._cacheKey.has(field)) {
        throw new KeyError('field "%s" of "%s" not found in %s', field, field.modelName, this);
      }
      return this._cacheKey.get(field);
    } catch (e) {
      if (isInstance(e, KeyError)) {
        const self = this;
        async function _get(key: any, context = self.context) {
          if (key === 'company') {
            return (await self.company()).id; // Tony check async
          } else if (key === 'uid') {
            return [self.uid, self.su];
          } else if (key === 'activeTest') {
            return context['activeTest'] ?? field.context['activeTest'] ?? true;
          } else {
            return context[key];
          }
        }

        const result = Object.values(this.registry.fieldDependsContext.get(field)).map((key) => _get(key));
        const cachkey = hash(field.repr(), result)
        this._cacheKey.set(field, cachkey);
        return cachkey;
      }
      else {
        throw e;
      }
    }
  }

  printArgs() {
    const args = this.args;
    return console.log(`evn: reg=${this.registry._id};uid=${args[1]},su=${args[3]},ctx=${stringify(args[2])}}`);
  }
}

export class Transaction {
  _protected: StackMap;
  registry: Registry;
  envs: Set<Environment>;
  cache: Cache;
  tocompute: DefaultDict<any, any>;
  towrite: Dict<any>;

  constructor(registry: Registry) {
    this.registry = registry
    // weak set of environments
    this.envs = new Set();
    // cache for all records
    this.cache = new Cache();
    // fields to protect {field: ids}
    this._protected = new StackMap();
    // pending computations {field: ids}
    this.tocompute = new DefaultDict();
    // pending updates {model: {id: {field: value}}}
    this.towrite = new Dict();
  }

  async flush() {
    let envToFlush: Environment;
    for (const env of this.envs) {
      if (env.uid == undefined || typeof env.uid === 'number') {
        envToFlush = env;
        if (env.uid != null) {
          break;
        }
      }
    }
    if (envToFlush != undefined && 'base' in envToFlush.models) {
      await envToFlush.items('base').flush();
    }
  }

  async clear() {
    this.cache.invalidate();
    this.tocompute.clear();
    this.towrite.clear();
  }

  async reset() {
    this.registry = await Registry.create(this.registry.dbName);
    for (const env of this.envs) {
      env.registry = this.registry;
      lazy.resetAll(env);
    }
    await this.clear();
  }

}

const NOTHING = new Object()

export class Cache {
  private _data: DefaultDict<any, any>; // easy debug using MapKey<any, any>;

  constructor() {
    this._data = new DefaultDict();     // MapKey(key => key.repr());
  }

  /**
   * Return the fields with a value for `'record'`.
   * @param record 
   * @returns 
   */
  *getFields(record: any) {
    for (const [name, field] of record._fields.items()) {
      if (name !== 'id' && this._getFieldCache(record, field).has(record.id)) {
        yield field;
      }
    }
  }

  items(record: any) {
    const res: [string, Field][] = [];
    for (const [name, field] of record._fields.items()) {
      if (name !== 'id' && this._getFieldCache(record, field).has(record.id)) {
        res.push([name, field]);
      }
    }
    return res;
  }

  getValues(records: ModelRecords, field: Field) {
    const fieldCache = this._setFieldCache(records, field);
    const res = [];
    for (const id of records._ids) {
      if (fieldCache.has(id)) {
        res.push(fieldCache.get(id));
      }
    }
    return res;
  }

  getRecordsDifferentFrom(records: ModelRecords, field: Field, value: any): ModelRecords {
    const fieldCache = this._getFieldCache(records, field);
    const ids = new Set();
    for (const id of records._ids) {
      let val;
      if (fieldCache.has(id)) {
        val = fieldCache.get(id);
        if (val !== value) {
          ids.add(id);
        }
      }
      else {
        ids.add(id);
      }
    }
    return records.browse(ids);
  }

  getRecords(model: ModelRecords, field: Field): ModelRecords {
    const fieldCache = this._getFieldCache(model, field);
    return model.browse(fieldCache);
  }

  /**
   * Return the ids of ``records`` that have no value for ``field``.
   * @param records 
   * @param field 
   */
  *getMissingIds(records: ModelRecords, field: Field): Generator<any, any, number> {
    const fieldCache = this._getFieldCache(records, field);
    for (const id of records._ids) {
      if (!fieldCache.has(id)) {
        yield id;
      }
    }
  }

  contains(record: any, field: Field): boolean {
    const fieldCache = this._getFieldCache(record, field);
    return fieldCache.has(record.id);
  }

  get(record: ModelRecords, field: Field, value: any = NOTHING): any {
    try {
      const fieldCache = this._getFieldCache(record, field);
      if (!fieldCache.has(record._ids[0])) {
        throw new KeyError('field "%s" of %s(%s) not found in env.cache', field.name, record._name, record._ids[0]);
      }
      return fieldCache.get(record._ids[0]);
    } catch (e) {
      if (isInstance(e, KeyError)) {
        if (value === NOTHING) {
          throw new CacheMiss(record, field, e);
        }
        return value;
      } else {
        throw e;
      }
    }
  }

  /**
   * Return the field cache of the given field, but not for modifying it.
   * @param model 
   * @param field 
   * @returns 
   */
  _getFieldCache(model: ModelRecords, field: Field): DefaultDict<any, any> {
    let fieldCache: DefaultDict<any, any> = this._data.get(field) ?? new DefaultDict<any, any>();
    if (fieldCache.size && model.pool.fieldDependsContext.get(field)?.length) {
      const key = model.env.cacheKey(field);
      fieldCache = fieldCache.get(key, new DefaultDict<any, any>());
    }
    return fieldCache;
  }

  /**
   * Return the field cache of the given field for modifying it. 
   * @param model 
   * @param field 
   * @returns 
   */
  _setFieldCache(model: ModelRecords, field: Field) {
    let fieldCache: DefaultDict<any, any> = this._data.setdefault(field, new DefaultDict<any, any>());
    if (model.pool.fieldDependsContext.get(field)?.length) {
      const key = model.env.cacheKey(field);
      fieldCache = fieldCache.setdefault(key, new DefaultDict<any, any>());
    }
    return fieldCache;
  }

  set(record: ModelRecords, field: Field, value: any) {
    const fieldCache = this._setFieldCache(record, field);
    fieldCache.set(record._ids[0], value);
  }

  update(records: ModelRecords, field: Field, values: any) {
    const fieldCache = this._setFieldCache(records, field)
    for (const value of zip(records._ids, values)) {
      fieldCache.set(value[0], value[1]);
    }
  }

  remove(record: ModelRecords, field: Field) {
    try {
      const fieldCache = this._setFieldCache(record, field);
      fieldCache.delete(record._ids[0]);
    } catch (e) {
      if (!isInstance(e, KeyError)) {
        throw e;
      }
    }
  }

  clear() {
    this._data.clear();
  }

  invalidate(spec?: any) {
    if (spec == null) {
      this._data.clear();
    } else if (len(spec)) {
      for (const [field, ids] of spec) {
        if (ids == null) {
          this._data.pop(field, null);
          continue;
        }
        const cache: DefaultDict<any, any> = this._data.get(field);
        if (!bool(cache)) {
          continue;
        }
        const key = next(cache.keys());
        const caches = typeof (key) === 'string' ? cache.values() : [cache];
        for (const fieldCache of caches) {
          for (const id of ids) {
            fieldCache.delete(id);
          }
        }
      }
    }
  }

  getUntilMiss(records: ModelRecords, field: Field) {
    const fieldCache = this._getFieldCache(records, field);
    const vals = [];
    for (const recordId of records._ids || []) {
      if (!fieldCache.has(recordId)) {
        break;
      }
      vals.push(fieldCache.get(recordId));
    }
    return vals;
  }

  /**
   * Check the consistency of the cache for the given environment.
   * @param env 
   */
  async check(env: Environment) {
    // flush fields to be recomputed before evaluating the cache
    await env.items('res.partner').recompute();

    // make a copy of the cache, and invalidate it
    const dump = new DefaultDict(this._data.items());
    this.invalidate();

    const dependsContext = env.registry.fieldDependsContext;

    // re-fetch the records, and compare with their former cache
    const invalids = [];

    async function _check(model: ModelRecords, field: Field, fieldDump: DefaultDict<any, any>) {
      const records = env.items(field.modelName).browse(fieldDump);
      for (const record of records) {
        if (!bool(record.id)) {
          continue;
        }
        try {
          const cached = fieldDump.get(record.id);
          const value = await field.convertToRecord(cached, record);
          const fetched = await record[field.name];
          if (fetched !== value) {
            const info = { 'cached': value, 'fetched': fetched };
            invalids.push([record, field, info]);
          }
        } catch (e) {
          if (!isInstance(e, AccessError, MissingError)) {
            throw e;
          }
        }
      }
    }

    for (const [field, fieldDump] of dump) {
      const model = env.items((field as any).modelName);
      if (dependsContext[field]) {
        for (const [contextKeys, fieldCache] of fieldDump) {
          const context = new Dict(_.zip(dependsContext[field], contextKeys));
          await _check(await model.withContext(context), field, fieldCache);
        }
      } else {
        await _check(model, field, fieldDump);
      }
    }
    if (invalids) {
      throw new UserError('Invalid cache for fields\n' + invalids);
    }
  }
}