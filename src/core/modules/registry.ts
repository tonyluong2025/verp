import AsyncLock from 'async-lock';
import { api, Field, helper, modules, sql_db, tests, tools } from '..';
import { getattr, setattr } from '../api/func';
import { Dict, LRU, OrderedSet2 } from '../helper';
import * as core from './../../core';
import { Collector, DefaultDict } from './../helper/collections';
import { dbFactory } from './../service/db';
require('./../globals');

import assert from 'assert';
import _ from 'lodash';
import { Environment } from '../api/api';
import { linearize } from '../api/mro';
import { WebRequest } from '../http';
import { BaseModel, MetaModel } from '../models';
import { Cursor, TestCursor } from '../sql_db';
import { addForeignKey, dropConstraint, extend, isIterable, len } from '../tools';
import { config } from '../tools/config';
import { contextmanager } from '../tools/context';
import { isInstance, partial } from '../tools/func';
import * as lazy from '../tools/lazy';
import { randomUUID } from 'crypto';

const _logger = console;//.getLogger(__name__)
const _schema = console;//.getLogger('core.schema');

const _globalIdref = {};

export class Registry {
  private static _registries: Record<string, Registry> = {};
  private static _lock = new AsyncLock();

  populatedModels: {};
  models: Record<string, any>;
  _mro: Record<string, any>;
  _sqlConstraints: any[];
  _init: boolean;
  _assertionReport: tests.runner.VerpTestResult;
  _fieldsByModel: Collector;
  _ordinaryTables: Collector;
  _constraintQueue: helper.Queue<any>;
  __cache: LRU<any>;
  _loginFailures: DefaultDict<any, any>;

  // modules fully loaded (maintained during init phase by `loading` module)
  _initModules: Set<string>;
  updatedModules: string[];       // installed/updated modules
  loadedXmlids: Set<string>;

  dbName: string;
  _db: sql_db.Connection;

  // cursor for test mode; None means "normal" mode
  testCr: Cursor | undefined;
  testLock: boolean | undefined;

  // Indicates that the registry is
  loaded = false;           // whether all modules are loaded
  ready = false;            // whether everything is set up

  // field dependencies
  fieldDepends: helper.Collector;
  fieldDependsContext: helper.Collector;
  fieldInverses: helper.Collector;

  // Inter-process signaling:
  // The `base_registry_signaling` sequence indicates the whole registry must be reloaded.
  // The `base_cache_signaling sequence` indicates all caches must be invalidated (i.e. cleared).
  registrySequence: number;
  cacheSequence: number;
  _postInitQueue: helper.Queue<Function>;
  _foreignKeys: Dict<any>;
  _isInstall: boolean;
  _m2m: Map<any, any>;
  _invalidationFlags: any;
  /**
   * unaccent is a text search dictionary that removes accents (diacritic signs) from lexemes. It's a filtering dictionary, which means its output is always passed to the next dictionary (if any), unlike the normal behavior of dictionaries. This allows accent-insensitive processing for full text search.
   */
  hasUnaccent: boolean;
  /**
   * A trigram is a group of three consecutive characters taken from a string. We can measure the similarity of two strings by counting the number of trigrams they share. This simple idea turns out to be very effective for measuring the similarity of words in many natural languages.
   */
  hasTrigram: boolean;

  websiteViewsToAdapt: string[];

  readonly _id: string;

  private constructor() {
    this._id = randomUUID().slice(0, 8);
  }

  private async init(dbName: string) {
    this.models = new Dict();
    this._mro = {};
    this._sqlConstraints = [];
    this._init = true;
    this._assertionReport = new tests.runner.VerpTestResult();
    this._constraintQueue = new helper.Queue<any>();
    this.__cache = new LRU<any>(8192);

    this._initModules = new Set<string>();
    this.updatedModules = [];
    this.loadedXmlids = new Set<string>();

    this.dbName = dbName;
    this._db = sql_db.dbConnect(dbName);

    this.loaded = false;           // whether all modules are loaded
    this.ready = false;            // whether everything is set up

    this.fieldDepends = new helper.Collector();
    this.fieldDependsContext = new helper.Collector();
    this.fieldInverses = new helper.Collector();

    this.registrySequence = 0;
    this.cacheSequence = 0;

    this._invalidationFlags = {};

    const cr = this.cursor();
    try {
      this.hasUnaccent = await dbFactory.hasUnaccent(cr);
      this.hasTrigram = await dbFactory.hasTrigram(cr);
    } catch (e) {
      console.warn('Database "%s" not support unaccent or trigram', config.get('dbDialect'));
    }
    await cr.close();
  }

  static async create(dbName: string, options: { req?: WebRequest, forceDemo?: boolean, status?: string, updateModule?: boolean } = {}) {
    let reg = this.registries[dbName];
    if (!reg) {
      reg = await this.new(dbName, options);
    }
    process.env.dbName = dbName;
    return reg;
  }

  static async new(dbName: string, options: { req?: WebRequest, res?: any, forceDemo?: boolean, status?: string, updateModule?: boolean } = {}): Promise<Registry> {
    const forceDemo = options?.forceDemo ?? false;
    const status = options?.status;
    const updateModule = options?.updateModule ?? false;
    const idref = _globalIdref;

    let registry: Registry;

    {
      global.logDebug = false;
      const t0 = new Date();

      registry = new Registry();
      await registry.init(dbName);

      delete this.registries[dbName];
      this.registries[dbName] = registry;
      try {
        await registry.setupSignaling();
        try {
          const cr = registry.cursor();
          const env = await Environment.new(cr, global.SUPERUSER_ID, {}, true, options?.req);
          await modules.loadModules(env, forceDemo, status, updateModule, idref);
        } catch (e) {
          console.error(`resetModulesState ${e}`);
          await modules.resetModulesState(dbName);
          throw e;
        }
      } catch (e) {
        console.error('Failed to run registry.setupSignaling or loadModules %s: ', dbName, e.message);
        delete this.registries[dbName];
        throw e;
      }

      /** 
       * loadModules() above can replace the registry by calling indirectly new() again (when modules have to be uninstalled). Yeah, crazy.
      */
      registry = this.registries[dbName];
      registry._init = false;
      registry.ready = true;
      registry.registryInvalidated = Boolean(updateModule);
      registry.init = null;
      const t = ((new Date()).getTime() - t0.getTime()) / 1000;
      console.info(`Registry loaded in ${t}ms`);
      // global.logDebug = true;
    }
    return registry;
  }

  static delete(dbName: string) {
    Registry.lock.acquire('registry', (done) => {
      delete this.registries[dbName];
      done();
    });
  }

  /**
   * Delete all the registries.
   */
  static deleteAll() {
    this.lock.acquire('registry', (done) => {
      for (const key of Object.keys(this.registries)) {
        delete this.registries[key];
      }
      done();
    });
  }

  static get registries() {
    return this._registries;
  }

  static get lock() {
    return this._lock;
  }

  /**
   * Return the models corresponding to `'modelNames'` and all those that inherit/inherits from them.
   * @param modelNames 
   * @param arg1 
   * @param arg2 
   */
  descendants(modelNames: string[], ...kinds: string[]): Set<string> {
    assert(kinds.every(kind => ['_parents', '_inherits'].includes(kind)));

    const funcs = kinds.map((kind) => api.attrgetter(kind + 'Children'));
    const models = new OrderedSet2();
    let queue: string[] = [];
    queue = [...modelNames];
    while (queue.length) {
      const model = this.models[queue.shift()];
      const attr = api.getattr(model, '_name');
      if (attr) {
        models.add(attr);
      }
      for (const func of funcs) {
        const res = func(model);
        if (isIterable(res) && len(res)) {
          queue = extend(queue, res);
        }
      }
    }
    return new Set(models);
  }

  /**
   * Load a given module in the registry, and return the names of the modified models.
   * At the core level, the modules are already loaded, but not yet on a per-registry level. This method populates a registry with the given modules, i.e. it instantiates all the classes of a the given module and registers them in the registry.
   * @param cr 
   * @param modul 
   * @returns 
   */
  buildModels(cr: Cursor, modul: Record<string, any>): Set<string> {
    this.__cache.clear();

    lazy.resetAll(this);

    const modelNames = [];
    const moduleToModels = MetaModel.moduleToModels;
    const modelStatic = moduleToModels[modul.name];
    if (Array.isArray(modelStatic)) {
      for (const cls of modelStatic) {
        const model = BaseModel.buildModel(cls, this, cr);
        modelNames.push(model._name);
      }
    }
    return this.descendants(modelNames, '_parents', '_inherits');
  }

  _buildMro() {
    // console.log('Start building registry MRO...');
    const graph = new Map<any, any>();
    for (const cls of Object.values(this.models)) {
      graph.set(cls, cls.__baseClasses);
    };

    const _mro = linearize(graph);
    for (const cls of Object.values(this.models)) {
      this._mro[cls._name] = _mro.get(cls);
    };
    // For debug
    // console.log('>>> MRO for "res.users":', String(this._mro["res.users"].map(o => {
    //   const module = o._originalModule || o._moduleName;  
    //   return (!module || module === 'base' ? '' : module + '.') + o.toString();
    // })));
    // console.log(`MRO for ${graph.size}/${_mro.size} models/objects built.`);
    // For debug
  }

  /**
   * Complete the setup of models.
   * This must be called after loading modules and before using the ORM.
   * @param cr 
   */
  async setupModels(cr: Cursor) {
    const env = await Environment.new(cr, global.SUPERUSER_ID);
    const modelNames = Object.keys(env.models);
    const models: BaseModel[] = modelNames.map((k) => env.items(k));
    if (this.ready) {
      for (const model of models) {
        await model._unregisterHook();
      }
    }

    this.__cache.clear();

    lazy.resetAll(this);
    this.registryInvalidated = true;

    if (env.all.tocompute.size) {
      console.log("Remaining fields to compute before setting up registry: %s", [...env.all.tocompute.keys()].map(key => key.repr()).join(','));
    }

    const model = env.items('ir.model');
    model._prepareSetup();
    this._buildMro();
    if (this._initModules.size) {
      await model._addManualModels();
    }

    for (const model of models) {
      model._prepareSetup();
    }
    this._buildMro();

    this.fieldDepends.clear();
    this.fieldDependsContext.clear();
    this.fieldInverses.clear();

    for (const model of models) {
      model.__init__(this, cr);
      await model._setupBase();
    }

    this._m2m = new Map();
    for (const model of models) {
      model._setupFields();
    }
    delete this._m2m;

    for (const model of models) {
      model._setupComplete();
    }

    // console.debug('* Depends:')
    for (const model of models) {
      // console.debug('***', model._name);
      for (const field of Object.values<Field>(model._fields)) {
        const [depends, dependsContext] = await field.getDepends(model);
        if (depends.length) {
          if (!depends[0]) {
            console.log('depends:', field.modelName, field.name, depends);
          }
          this.fieldDepends.set(field, depends);
        }
        if (dependsContext.length) {
          this.fieldDependsContext.set(field, dependsContext);
        }
      }
    }

    if (this.ready) {
      for (const model of models) {
        await model._registerHook();
      }
      await env.items('base').flush();
    }
  }

  cursor(): Cursor {
    if (this.testCr) {
      const cr = new TestCursor(this.testCr, this.testLock);
      return cr as Cursor;
    }
    return this._db.cursor();
  }

  async setupSignaling() {
    async function createSequences() {
      await cr.query(dbFactory.sqlCreateNewSequence('base_registry_signaling'), { withoutTransaction: true });
      await cr.query(dbFactory.sqlSelectNextSequence(['base_registry_signaling']), { withoutTransaction: true });

      await cr.query(dbFactory.sqlCreateNewSequence('base_cache_signaling'), { withoutTransaction: true });
      await cr.query(dbFactory.sqlSelectNextSequence(['base_cache_signaling']), { withoutTransaction: true });
    }

    if (this.inTestMode()) {
      return;
    }

    const cr = this.cursor();
    try {
      const res = await cr.execute(dbFactory.sqlSelectSequenceByName('base_registry_signaling'), { withoutTransaction: true });
      if (!res || !res.length) {
        await createSequences();
      }
      let registrySequence, cacheSequence;
      registrySequence = await cr.execute(dbFactory.sqlSelectLastSequence(['base_registry_signaling']), { withoutTransaction: true });
      cacheSequence = await cr.execute(dbFactory.sqlSelectLastSequence(['base_cache_signaling']), { withoutTransaction: true });
      if (config.get('dbDialect') === 'postgres') {
        this.registrySequence = registrySequence[0]['last_value'];
        this.cacheSequence = cacheSequence[0]['last_value'];
      } else if (config.get('dbDialect') === 'mariadb') {
        this.registrySequence = registrySequence[0]['LASTVAL(base_registry_signaling)'];
        this.cacheSequence = registrySequence[0]['LASTVAL(base_cache_signaling)'];
      }
      console.debug("Multiprocess load registry signaling: {Registry: %s, Cache: %s}", this.registrySequence, this.cacheSequence);
    } catch (e) {
      if (e.name === 'SequelizeDatabaseError') {
        await createSequences();
      }
      else {
        throw e;
      }
    } finally {
      await cr.close();
    }
  }

  /**
   * Test whether the registry is in 'test' mode.
   * @returns 
   */
  inTestMode(): boolean {
    return this.testCr != null;
  }

  async checkSignaling() {
    const cr = this.cursor();
    // await cr.close();

    let registrySequence, cacheSequence;
    registrySequence = await cr.execute(dbFactory.sqlSelectLastSequence(['base_registry_signaling']), { withoutTransaction: true });
    cacheSequence = await cr.execute(dbFactory.sqlSelectLastSequence(['base_cache_signaling']), { withoutTransaction: true });
    if (config.get('dbDialect') === 'postgres') {
      registrySequence = registrySequence[0]['last_value'];
      cacheSequence = cacheSequence[0]['last_value'];
    } else if (config.get('dbDialect') === 'mariadb') {
      registrySequence = registrySequence[0]['LASTVAL(base_registry_signaling)'];
      cacheSequence = cacheSequence[0]['LASTVAL(base_cache_signaling)'];
    }
    // console.debug(`Multiprocess signaling check: [Registry - ${this.registrySequence} -> ${registrySequence}] [Cache - ${this.cacheSequence} -> ${cacheSequence}]`);
    // Check if the model registry must be reloaded
    let self: Registry = this;
    if (self.registrySequence !== registrySequence) {
      console.info("Reloading the model registry after database signaling.");
      self = await Registry.new(self.dbName);
    }
    // Check if the model caches must be invalidated.
    else if (self.cacheSequence !== cacheSequence) {
      console.info("Invalidating all model caches after database signaling.");
      self.clearCaches();
    }

    // prevent re-signaling the clearCaches() above, or any residual one that
    // would be inherited from the master process (first request in pre-fork mode)
    self.cacheInvalidated = false;

    self.registrySequence = registrySequence;
    self.cacheSequence = cacheSequence;

    return self;
  }

  /**
   * Notifies other processes if registry or cache has been invalidated.
   */
  async signalChanges() {
    if (this.registryInvalidated && !this.inTestMode()) {
      console.info("Registry changed, signaling through the database");
      const cr = this.cursor();
      try {
        const res = await cr.execute(dbFactory.sqlSelectLastSequence(['base_registry_signaling']), { withoutTransaction: true });
        if (config.get('dbDialect') === 'postgres') {
          this.registrySequence = res[0]['last_value'];
        } else if (config.get('dbDialect') === 'mariadb') {
          this.registrySequence = res[0]['LASTVAL(base_registry_signaling)'];
        }
      }
      finally {
        await cr.close();
      }
    }
    // no need to notify cache invalidation in case of registry invalidation,
    // because reloading the registry implies starting with an empty cache
    else if (this.cacheInvalidated && !this.inTestMode()) {
      console.debug("At least one model cache has been invalidated, signaling through the database.");
      const cr = this.cursor();
      try {
        const res = await cr.execute(dbFactory.sqlSelectLastSequence(['base_cache_signaling']), { withoutTransaction: true });
        if (config.get('dbDialect') === 'postgres') {
          this.cacheSequence = res[0]['last_value'];
        } else if (config.get('dbDialect') === 'mariadb') {
          this.cacheSequence = res[0]['LASTVAL(base_cache_signaling)'];
        }
      }
      finally {
        await cr.close();
      }
    }
    this.registryInvalidated = false;
    this.cacheInvalidated = false;
  }

  /**
   * Reset the registry and cancel all invalidations.
   */
  async resetChanges() {
    if (this.registryInvalidated) {
      const cr = this.cursor();
      await this.setupModels(cr);
      this.registryInvalidated = false;
      await cr.close();
    }
    if (this.cacheInvalidated) {
      this.__cache.clear();
      this.cacheInvalidated = false;
    }
  }

  /**
   * Context manager to signal/discard registry and cache invalidations
   */
  @contextmanager()
  async* manageChanges() {
    try {
      yield this;
      await this.signalChanges();
    } catch (e) {
      await this.resetChanges();
      throw e;
    }
  }

  /**
   * Register a function to call at the end of method `'initModels'`
   * @param func 
   * @param args 
   */
  postInit(func: Function, ...args: any[]) {
    this._postInitQueue.enqueue(partial(func, ...args));
  }

  _checkpostConstraint(func: Function, args: any[]) {
    for (const constraint of this._constraintQueue) {
      if (constraint[0] === func && _.isEqual(constraint[1], args)) {
        return true;
      }
    }
    return false;
  }

  async postConstraint(func: Function, ...args: any[]) {
    const self = this as any;
    try {
      if (!this._checkpostConstraint(func, args)) {
        await func(...args);
      }
    } catch (e) {
      if (this._isInstall) {
        console.error(e);
      } else {
        console.info(e);
        this._constraintQueue.enqueue([func, args])
      }
    }
  }

  /**
   * Call the delayed functions from above. 
   */
  async finalizeConstraints() {
    while (this._constraintQueue.size) {
      const [func, args] = this._constraintQueue.popleft()
      try {
        await func(...args);
      } catch (e) {
        // warn only, this is not a deployment showstopper, and
        // can sometimes be a transient error
        _schema.warn(e)
      }
    }
  }

  /**
   * Initialize a list of models (given by their name). Call methods
    `'_autoInit'` and `'init'` on each model to create or update the
    database tables supporting the models.

    The ``context`` may contain the following items:
      - ``module``: the name of the module being installed/updated, if any;
      - ``update_custom_fields``: whether custom fields should be updated.
   * @param cr 
   * @param modelNames 
   * @param context 
   * @param install 
   * @returns 
   */
  async initModels(cr: Cursor, modelNames?: string[], context?: {}, install?: boolean) {
    if (!modelNames || !modelNames.length) {
      return;
    }
    if (context['module']) {
      console.log('%s: creating or updating database tables', context['module']);
    } else if (context['modelsToCheck'] ?? false) {
      console.log('Verifying fields for every extended model');
    }
    const env = await Environment.new(cr, global.SUPERUSER_ID, context);
    const models = modelNames.map((modelName) => env.items(modelName));
    console.log(`${context['module']}: registry database "${this.dbName}" and initialize ${modelNames.length} models`);
    try {
      const t0 = new Date();

      this._postInitQueue = new helper.Queue<Function>();
      this._foreignKeys = new Dict();
      this._isInstall = install;

      for (const model of models) {
        await model._autoInit();
        // For debug
        // await cr.commit()
        // await cr.reset()
        // For debug
        await model.init();
      }

      await env.items('ir.model')._reflectModels(modelNames);
      await env.items('ir.model.fields')._reflectFields(modelNames);
      await env.items('ir.model.fields.selection')._reflectSelections(modelNames);
      await env.items('ir.model.constraint')._reflectConstraints(modelNames);

      this._ordinaryTables = null;

      while (this._postInitQueue.size) {
        const func = this._postInitQueue.dequeue();
        await func();
      }

      await this.checkIndexes(cr, modelNames);
      await this.checkForeignKeys(cr);
      await env.items('base').flush();
      await this.checkTablesExist(cr);

      const t = ((new Date()).getTime() - t0.getTime()) / 1000;
      console.info(`${context['module']}: initialation in ${t}ms`);
    } catch (e) {
      // console.debug(e.stack);
      throw e;
    } finally {
      delete this._postInitQueue;
      delete this._foreignKeys;
      delete this._isInstall;
    }
  }

  /**
   * Verify that all tables are present and try to initialize those that are missing.
   * @param cr 
   */
  async checkTablesExist(cr: Cursor) {
    const env = await core.api.Environment.new(cr, global.SUPERUSER_ID);
    const table2model = {}
    for (const [name, model] of Object.entries<any>(env.models)) {
      if (!model._abstract && model._tableQuery == null) {
        table2model[model._table] = name;
      }
    }
    const checkingTables = Object.keys(table2model);
    const existingTables = await tools.existingTables(cr, checkingTables);
    let missingTables = _.difference(checkingTables, existingTables);

    if (missingTables.length) {
      const missing = missingTables.map(table => table2model[table]);
      _logger.info("Models have no table: %s.", missing.join(', '));
      // recreate missing tables
      for (const name of missing) {
        _logger.info("Recreate table of model %s.", name);
        await env.items(name).init();
      }
      await env.items('base').flush();
      // check again, and log errors if tables are still missing
      const existingTables = await tools.existingTables(cr, checkingTables)
      missingTables = _.difference(checkingTables, existingTables);
      for (const table of missingTables) {
        _logger.error("Model %s has no table.", table2model[table]);
      }
    }
  }

  /**
   * Specify an expected foreign key.
   * @param table1 
   * @param column1 
   * @param table2 
   * @param column2 
   * @param ondelete 
   * @param model 
   * @param module 
   * @param force 
   */
  addForeignKey(table1, column1, table2, column2, ondelete, model, module, force = true) {
    const key = `${table1}:${column1}`;
    const val = [table2, column2, ondelete, model, module];
    if (force) {
      this._foreignKeys[key] = val;
    }
    else {
      this._foreignKeys.setdefault(key, val);
    }
  }

  async checkForeignKeys(cr: Cursor) {
    if (!this._foreignKeys || !Object.keys(this._foreignKeys).length) {
      return;
    }
    const seqQuery = cr._query;
    const tableNames = await seqQuery.listTables({ transaction: cr.objTransaction });
    const pgActionCode = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
    const sql = dbFactory.sqlSelectAllForeignKeys(tableNames.map(r => r['tableName']));
    const [res] = await cr.query(sql);
    const existing = {}
    res.forEach((r) => { existing[`${r['tableName']}:${r['columnName']}`] = [r['constraintName'], r['refTableName'], r['refColumnName'], r['ondelete']] });
    for (const [key, val] of this._foreignKeys) {
      const [table1, column1] = key.split(':');
      const [table2, column2, ondelete, model, module] = val;
      const deltype = ondelete;
      const spec = existing[key];
      if (!spec) {
        await addForeignKey(cr, table1, column1, table2, column2, ondelete);
        const sql = dbFactory.sqlSelectForeignKey(table1, column1, table2, column2, ondelete);
        const [conname] = await cr.query(sql);
        await model.env.items('ir.model.constraint')._reflectConstraint(model.cls, conname[0]['constraintName'], 'f', null, module)
      } else if (spec[1] !== table2 && spec[2] !== column2 && pgActionCode[spec[3]] !== deltype) {
        await dropConstraint(cr, table1, spec[0]);
        await addForeignKey(cr, table1, column1, table2, column2, ondelete);
        const sql = dbFactory.sqlSelectForeignKey(table1, column1, table2, column2, ondelete);
        const [conname] = await cr.query(sql);
        await model.env.items('ir.model.constraint')._reflectConstraint(model.cls, conname[0]['constraintName'], 'f', null, module);
      }
    }
  }

  /**
   * Create or drop column indexes for the given models.
   * @param rc 
   * @param modelNames 
   * @returns 
   */
  async checkIndexes(cr: Cursor, modelNames: string[]) {
    const expected = [];
    for (const modelName of modelNames) {
      for (const model of [this.models[modelName]]) {
        if (model._auto && !model._abstract) {
          for (const field of Object.values<Field>(model._fields)) {
            if (field.columnType && field.store) {
              expected.push([`${model._table}_${field.name}_index`, model._table, field.name, field.index]);
            }
          }
        }
      }
    }
    if (!expected.length)
      return

    const res = await cr.execute(`SELECT indexname FROM pg_indexes WHERE indexname IN (${expected.map(row => `'${row[0]}'`)})`);
    const existing = res.map(row => row['id']);

    for (const [indexname, tablename, columnname, index] of expected) {
      if (index && !existing.includes(indexname)) {
        try {
          await cr.savepoint(false, async () => {
            await tools.createIndex(cr, indexname, tablename, [`"${columnname}"`]);
          });
        } catch (e) {
          _schema.error("Unable to add index for %s", self)
        }
      }
      else if (!index && existing.includes(indexname)) {
        _schema.info("Keep unexpected index %s on table %s", indexname, tablename)
      }
    }
  }

  async isAnOrdinaryTable(model): Promise<boolean> {
    const cr = model.env.cr as Cursor;
    const sql = dbFactory.sqlSelectTablesExists([model.constructor._table]);
    const [res] = await cr.query(sql);
    // mariadb
    // res = [{
    //   table_name: "irmodelfields",
    // }]
    // postgres
    // [{
    //   relname: 'irModelFields',
    // }]
    return res && isInstance(res, Object) && Object.keys(res).length > 0;
  }

  /**
   * Return a dict mapping each field to the fields computed by the same method.
   */
  @lazy.define()
  get fieldComputed() {
    const computed = new DefaultDict<any, any>();
    for (const [modelName, model] of Object.entries<BaseModel>(this.models)) {
      const groups = new DefaultDict<string, Field[]>();
      for (const field of model._fields.values()) {
        if (field.compute) {
          if (!groups.has(field.compute)) {
            groups.set(field.compute, []);
          }
          const group = groups.get(field.compute);
          group.push(field);
          computed.set(field, group);
        }
      }
      for (const fields of groups.values()) {
        if ((new Set(fields.map(field => field.computeSudo))).size > 1) {
          console.warn("%s: inconsistent 'computeSudo' for computed fields: %s", modelName, fields.map(field => field.name).join(','));
        }
      }
    }
    return computed;
  }

  @lazy.define()
  get fieldTriggers(): Map<any, any> {
    const dependencies = new Map<any, any>();
    for (const model of Object.values(this.models)) {
      if (model._abstract) {
        continue;
      }
      for (const field of Object.values<Field>(model._fields)) {
        const exceptions = field.baseField.manual ? [Error] : [];

        for (const resolveDepends of field.resolveDepends(this)) {
          if (!dependencies.has(field)) {
            dependencies.set(field, new OrderedSet2());
          }
          dependencies.get(field).add(resolveDepends);
        }
      }
    }

    function* transitiveDependencies(field: Field, seen = []) {
      if (seen.includes(field)) {
        return;
      }
      for (const seq1 of dependencies.get(field) || []) {
        yield seq1;
        for (const seq2 of transitiveDependencies(seq1[seq1.length-1], seen.concat([field]))) {
          yield concat(seq1.slice(0, -1), seq2)
        }
      }
    }

    function concat(seq1: Field[], seq2: Field[]) {
      if (seq1.length && seq2.length) {
        const f1 = seq1[seq1.length-1];
        const f2 = seq2[0];
        if (f1.type === 'one2many' && f2.type === 'many2many' && f1.modelName === f2.comodelName && f1.relationField === f2.name) {
          return concat(seq1.slice(0, -1), seq2.slice(1))
        }
      }
      return seq1.concat(seq2);
    }

    const triggers = new Map<any, any>();
    for (const field of dependencies.keys()) {
      for (const path of transitiveDependencies(field)) {
        if (path.length) {
          let tree = triggers;
          for (const label of Array.from(path).reverse()) {
            if (!tree.has(label)) {
              tree.set(label, new Map<any, any>());
            }
            tree = tree.get(label);
          }
          if (!tree.has(null)) {
            tree.set(null, new OrderedSet2());
          }
          tree.get(null).add(field);
        }
      }
    }

    // this._debugTriggers(triggers);

    return triggers;
  }

  _debugTriggers(triggers?: Map<any, any>) {
    console.log('=====');
    console.log('_fieldTriggers');
    for (const [k, v] of triggers || this.fieldTriggers) {
      console.log(k == null ? 'null' : `${k.modelName}.${k.name}<${k.type}>`,
        Array.from(v.entries()).map((e) =>
        (e[0] == null
          ? 'null:' + e[1].map(k => k.modelName + '.' + k.name)
          : e[0].modelName + '.' + e[0].name + ':' + Array.from<any>(e[1].keys()).map(k => k == null ? 'null' : k.modelName + '.' + k.name)
        )
        )
      );
    }
    console.log('=====');
  }

  /**
   * Determine whether the current thread has modified the registry.
   */
  get registryInvalidated() {
    return getattr(this._invalidationFlags, 'registry', false);
  }

  set registryInvalidated(value) {
    setattr(this._invalidationFlags, 'registry', value);
  }

  /**
   * Determine whether the current thread has modified the cache.
   */
  get cacheInvalidated() {
    return getattr(this._invalidationFlags, 'cache', false);
  }

  set cacheInvalidated(value) {
    this._invalidationFlags.cache = value;
  }

  /**
   * Clear the cache and mark it as invalidated.
   */
  _clearCache() {
    this.__cache.clear();
    this.cacheInvalidated = true;
  }

  /**
   * Clear the caches associated to methods decorated with
    ``tools.ormcache`` or ``tools.ormcacheMulti`` for all the models.
   */
  clearCaches() {
    for (const model of this.models.values()) {
      model.clearCaches();
    }
  }
}