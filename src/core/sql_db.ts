import * as sequelize from './service/sequelize';
import { format } from 'util';
import { v1 as uuidv1 } from 'uuid';
import { tools } from '.';
import { Transaction } from './api/api';
import { getattr, setattr } from './api/func';
import { OperationalError, SQLError } from './helper';
import { Dict } from './helper/collections';
import { DbFactory, dbFactory } from './service/db';
import { IDbService } from './service/dialect/abstract';
import { _f, _format, bool, splitEvery } from './tools';
import { config } from './tools/config';
import { equal, isCallable, split } from './tools/func';
import { Callbacks } from './tools/misc';
import { URI, validateUri } from './tools/uri';
import { contextmanager } from './tools/context';

global.sqlCounter = 0;

/** 
 * Wrap a cursor method that cannot be called when the cursor is closed.
*/
function check() {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalFunc = descriptor.value;
    const wrapper = async function(...args) {
      if (this.isClosed) {
        throw new OperationalError('Unable to use a closed cursor.');
      }
      return originalFunc.call(this, ...args);
    }
    setattr(wrapper, 'name', originalFunc.name);
    descriptor.value = wrapper;
  };
}

class BaseCursor {
  transaction: Transaction;
  precommit: Callbacks;
  postcommit: Callbacks;
  prerollback: Callbacks;
  postrollback: Callbacks;

  constructor() {
    this.precommit = new Callbacks();
    this.postcommit = new Callbacks();
    this.prerollback = new Callbacks();
    this.postrollback = new Callbacks();
    // By default a cursor has no transaction object.  A transaction object
    // for managing environments is instantiated by registry.cursor().  It
    // is not done here in order to avoid cyclic module dependencies.
    this.transaction = null;
  }

  /**
   * Using the cursor as a contextmanager automatically commits and
      closes it::

      await doWith(cr, async () => {
          await cr.execute(...)
      });
      // cr is committed if no failure occurred
      // cr is closed in any case
   * @returns this cursor
   */
  async __enter__() {
    return this;
  }

  async __exit__(errObj) {
    try {
      if (errObj == null) {
        await this.commit();
      }
    }
    catch(e) {
      console.log(e.message + (errObj ? `\nPrevious: ${errObj.message}` : ''));
    }
    finally {
      await this.close();
    }
  }

  /**
   * Flush the current transaction, and run precommit hooks.
   */
  async flush() {
    if (this.transaction != null) {
      await this.transaction.flush();
    }
    await this.precommit.run();
  }

  /**
   * Clear the current transaction, and clear precommit hooks.
   */
  async clear() {
    if (this.transaction != null) {
      await this.transaction.clear();
    }
    this.precommit.clear();
  }

  /**
   * Reset the current transaction (this invalidates more that clear()).
      This method should be called only right after commit() or rollback().
   */
  async reset() {
    if (this.transaction != null) {
      await this.transaction.reset();
    }
  }

  async close() {}

  async commit() {}
}

const IN_MAX = 1000;

export class Cursor extends BaseCursor {
  private _objTransaction: sequelize.Transaction;
  sqlFromLog: Record<string, any> = {};
  sqlIntoLog: Record<string, any> = {};
  sqlLogCount: number;
  protected _closed: boolean;
  private __pool: DatabasePool;
  dbName: string;
  dbDialect: string;
  dbService: IDbService;
  protected _serialized: boolean | undefined;
  _cnx: sequelize.Sequelize;
  _obj: sequelize.Sequelize;
  _query: any;
  _gen: any;
  sqlLog: any;
  private __caller: any;
  protected _defaultLogExceptions = true;
  cache: Record<string, any>;
  protected _now: any;
  private _autoCommit: boolean;

  constructor(pool: DatabasePool, dbname: string, dsn: sequelize.ConnectionInfo, serialized?: boolean) {
    super();

    // default log level determined at cursor creation, could be
    // overridden later for debugging purposes
    // this.sqlLog = _logger.isEnabledFor(logging.DEBUG)

    this.sqlLogCount = 0;

    // avoid the call of close() if an exception
    // is raised by any of the following initialisations
    this._closed = true;

    this.__pool = pool;
    this.dbName = dbname;
    this.dbDialect = dsn.dialect.toString();
    this.dbService = DbFactory.create(this.dbDialect);
    // Whether to enable snapshot isolation level for this cursor.
    // see also the docstring of Cursor.
    this._serialized = serialized ?? true;

    this._cnx = pool.borrow(dsn);
    this._obj = this._cnx;
    this._query = this._obj.getQueryInterface();
    this._gen = this._query.queryGenerator;
    if (this.sqlLog) {
      this.__caller = frameCodeInfo(currentFrame(), 2);
    }
    else {
      this.__caller = false;
    }
    this._closed = false;   // real initialisation value
    this.autocommit(false);

    this._defaultLogExceptions = true;

    this.cache = {};
    this._now = undefined;
  }

  get objTransaction() {
    return this._objTransaction;
  }

  set objTransaction(trans: sequelize.Transaction) {
    if (this._objTransaction) {
      this.clear()
    }
    this._objTransaction = trans;
  }

  _log(msg) {
    // console.log(msg, getattr(this._objTransaction, 'id', ''));
  }

  get hasTransaction() {
    return this._objTransaction && !getattr(this._objTransaction, 'finished', false);
  }

  async reset(resetTransaction=false) {
    if (resetTransaction) {
      await super.reset();
    }
    if (this._objTransaction) {
      this._log('<<< RES:');
      try {
        this._objTransaction.forceCleanup();
      } catch (e) {
        console.log(e.message);
      }
    }
    // console.log('=============================================');
    this._objTransaction = await this._obj.startUnmanagedTransaction();
    this._log('>>> NEW:');
  }

  get isClosed() {
    return !this._cnx || this._cnx.connectionManager.isClosed;
  }

  @check()
  async commit() {
    try {
      await this.flush();
      if (this.hasTransaction) {
        this._log('*** COM:');
        await this._objTransaction.commit();
      }
    } catch (e) {
      console.log(e.message);
    }
    await this.clear();
    this._now = null;
    this.prerollback.clear();
    this.postrollback.clear();
    await this.postcommit.run();
  }

  @check()
  async rollback() {
    await this.clear();
    this.postcommit.clear();
    await this.prerollback.run();
    if (this.hasTransaction) {
      this._log('~~~ ROL:');
      try {
        await this._objTransaction.rollback();
      } catch (e) {
        console.log(e.message);
      }
    } 
    this._now = null;
    await this.postrollback.run();
  }

  @check()
  async close() {
    if (this.hasTransaction) {
      this._log('### CLO:');
      try {
        this._objTransaction.cleanup();
      }
      finally {
        this._objTransaction = null;
      }
    }
  }

  @check()
  async clear() {
    await super.clear();
    this._objTransaction = null;
  }

  /**
   * @param flush 
   * @param func 
   */
  @contextmanager()
  @check()
  async savepoint(flush: boolean | Function, func?: Function) {
    if (typeof flush === 'function') {
      func = flush;
      flush = false;
    }
    const name = uuidv1();
    if (!this._objTransaction) {
      await this.reset();
    }
    this._log(`SAVEPOINT "${name}"`);
    await this.execute(`SAVEPOINT "${name}"`);
    try {
      if (flush) {
        await this.flush();
      }
      if (isCallable(func)) {
        await func();
      }
      if (flush) {
        await this.flush();
      }
    } catch (e) {
      if (flush) {
        await this.close();
      }
      this._log(`ROLLBACK TO SAVEPOINT "${name}"`);
      await this.execute(`ROLLBACK TO SAVEPOINT "${name}"`);
      throw e;
    }
    this._log(`RELEASE SAVEPOINT "${name}"`);
    try {
      await this.execute(`RELEASE SAVEPOINT "${name}"`);
    } catch(e) {
      if (!(e.name === 'SequelizeDatabaseError' && e.message === `savepoint "${name}" does not exist`)) {
        throw e;
      }
    }
  }

  async flush() {
    if (this.transaction != null) {
      await this.transaction.flush();
    }
    await this.precommit.run();
  }

  splitForInConditions(ids: any, size?: number) {
    return splitEvery(size ?? IN_MAX, ids);
  }

  fetchAll(): any {
    console.warn('Method not implemented.');
  }

  @check()
  async execute(sql: string, options?: any, logExceptions?: boolean): Promise<any[]> {
    const start = Date.now();

    if (this.sqlLog) {
      console.debug("query: %s", sql);
    }

    let res: any[];
    try {
      [res] = await this.query(sql, options, logExceptions);
    } catch (e) {
      throw e;
    }
    let delay = Date.now() - start;

    for (const hook of getattr(process, 'queryHooks', [(...args) => { }])) {
      hook(this, sql, options, start, delay);
    }

    if (this.sqlLog) {
      delay *= 1E6;
    }

    return res;
  }

  protected format(sql, params: any[] = []) {
    var count = (sql.match(/%s/g) || []).length;
    if (count) {
      sql = format(sql, ...(params.slice(0, Math.min(params.length, count))));
    }
    return sql;
  }

  @check()
  async query(sql: any, options?: any, logExceptions?: boolean): Promise<[any, number]> {
    let params;
    if (Array.isArray(options)) {
      params = options;
      options = {};
    }
    else {
      if (options && typeof options !== 'object') {
        throw new SQLError('Query "options" must be an array or object');
      }
      params = options?.params;
    }
    sql = this.format(sql, params);
    options = this.injectTransaction(options);
    this.sqlLogCount += 1;
    try {
      const res = await this._obj.query(sql, options);
      return res;
    } catch (e) {
      const str = bool(options.bind || params) ? String(options.bind || params).slice(0, 200).trim() : '';
      console.debug(_f('Bad SQL: {message}{query}{params}{cause}', {
        message: e.name + ' ' + e.message, 
        query: '\n\t' + sql, 
        params: str ? '\n\tparams: ' + str : '', 
        cause: e.cause?.message !== e.message ? '\n\t' + e.cause?.message : ''
      }));
      throw e;
    }
  }

  private injectTransaction(options = {}): any {
    if (this.hasTransaction && !options['withoutTransaction']) {
      options['transaction'] = this._objTransaction;
    } else {
      delete options['transaction'];
    }
    return options;
  }

  @check()
  autocommit(val: boolean) {
    this._autoCommit = val;
  }

  @check()
  after() {}

  /**
   * Return the transaction's timestamp ``NOW() AT TIME ZONE 'UTC'``.
   * @returns 
   */
  async now() {
    if (this._now == null) {
      const [res] = await this.query(dbFactory.now());
      this._now = (new Date(res[0]['timezone'])).toISOString();
    }
    return this._now;
  }
}

export class TestCursor extends BaseCursor {
  constructor(testCr: Cursor, testLock?: boolean) {
    super();
    console.log(`chua trien khai TestCursor`);
  }
}

/**
 * The pool of connections to database(s)

  Keep a set of databases open, and reuse them to open cursors for all transactions.

  The connections are *not* automatically closed. Only a closeDb() can trigger that.
 */
export class DatabasePool {
  private _maxConn: number;
  private _connections: Dict<sequelize.Sequelize>;

  constructor(maxConn = 64) {
    this._maxConn = maxConn;
    this._connections = new Dict();
  }

  borrow(dsn: sequelize.ConnectionInfo): sequelize.Sequelize | undefined {
    let cnx = this._connections.get(dsn.database);

    if (!cnx) {
      if (this._connections.size == this._maxConn) {
        console.log(`Unable to connect to the database because maximum is ${this._maxConn}`)
      }
      cnx = new sequelize.Sequelize(dsn.uri, Object.assign({}, dsn, {
        pool: {
          max: config.get('dbMaxConn'),
          min: 0,
          acquire: config.get('dbAcquireTimeOut'),
          idle: config.get('dbIdleTimeOut')
        },
        showWarnings: false,
        logging: global.logSql
      }));
    }
    if (!this._connections.get(dsn.database)) {
      this._connections.set(dsn.database, cnx);
    }

    return cnx;
  }

  // @locked
  async closeAll(dsn?: any) {
    let count = 0;
    let last = null;
    for (let [i, [name, cnx]] of tools.reverseEnumerate<[string, sequelize.Sequelize]>(this._connections)) {
      const cnxDsn = this._cnxToDsn(cnx);
      if (dsn == null || this._dsnEquals(cnxDsn, dsn)) {
        await cnx.close();
        last = this._connections.pop(name);
        count += 1;
      }
    }
    if (count) {
      console.info('Closed %s connections %s', count, format(dsn && last && 'to %s', last && this._cnxToDsn(last)) || '');
    }
  }

  _dsnEquals(dsn1: any, dsn2: any) {
    const aliasKeys: any = {'dbName': 'database'};
    const ignoreKeys: any = ['password'];
    [dsn1, dsn2] = [dsn1, dsn2].map(dsn => 
      Object.fromEntries(Object.entries(typeof dsn === 'string' && this._dsnToDict(dsn) || dsn)
        .filter(([key]) => !ignoreKeys.includes(key))
        .map(([key, value]) => [aliasKeys[key] ?? key, String(value)])
      )
    );
    return equal(dsn1, dsn2);
  }

  _dsnToDict(dsn: any) {
    return Object.fromEntries(dsn.trim().split('\n').map((value: any) => split(value, '=', 1) as any));
  }

  _cnxToDsn(cnx) {
    return Object.fromEntries(sequelize.ConnectionInfoFields.map(field => [field, cnx.options[field]]));
  }
}

export class Connection {
  private _pool: DatabasePool;
  private _database: string;
  private _options: sequelize.ConnectionInfo;
  private _lastCursor: Cursor;

  constructor(pool: DatabasePool, database: string, options: sequelize.ConnectionInfo) {
    this._pool = pool;
    this._database = database;
    this._options = options;
  }

  cursor() {
    if (this._lastCursor) {
      return this._lastCursor;
    }
    // console.log('================================================');
    this._lastCursor = new Cursor(this._pool, this._database, this._options);
    return this._lastCursor;
  }
}

export function connectionInfoFor(dbOrUri: string, ssl=true): [string, sequelize.ConnectionInfo] {
  let database: string;
  // uri: 'postgres://verp:verp@localhost:5432/postgres'
  if (validateUri(dbOrUri, { protocol: ['postgres', "mysql", "mariadb"] })) { // Uri
    const uri = new URI(dbOrUri);
    if (uri.pathname && uri.pathname.startsWith('/')) {
      database = uri.pathname.slice(1);
    } else if (uri.username) {
      database = uri.username;
    } else {
      database = uri.hostname;
    }
    const connectionInfo: sequelize.ConnectionInfo = {
      uri: dbOrUri,
      database: database
    };
    return [database, connectionInfo];
  }
  const connectionInfo: sequelize.ConnectionInfo = {
    uri: _format('{protocol}://{username}:{password}@{hostname}:{port}/{pathname}', { protocol: config.get('dbDialect'), hostname: config.get('dbHost'), port: config.get('dbPort'), username: config.get('dbUser'), password: config.get('dbPassword'), pathname: dbOrUri }),
    database: dbOrUri,
    dialect: config.get('dbDialect'),
    username: config.get('dbUser'),
    password: config.get('dbPassword'),
    host: config.get('dbHost'),
    port: config.get('dbPort'),
    ssl: ssl && config.get('dbSslMode') ? true : false
  }
  return [dbOrUri, connectionInfo]
}

global._Pool = null;

export function dbConnect(to: string, allowUri?: boolean): Connection {
  if (!global._Pool) {
    global._Pool = new DatabasePool(Number.parseInt(config.get('dbMaxConn')))
  }
  const [db, info] = connectionInfoFor(to);
  if (!allowUri && db !== to) {
    throw Error('URI connections not allowed');
  }
  return new Connection(global._Pool, to, info);
}

/**
 * You might want to call core.modules.registry.Registry.delete(dbName) along this function.
 * @param dbName 
 */
export async function closeDb(dbName) {
  const _Pool = global._Pool as DatabasePool;
  if (_Pool) {
    await _Pool.closeAll(connectionInfoFor(dbName)[1]);
  }
}

export async function closeAll() {
  const _Pool = global._Pool as DatabasePool;
  if (_Pool) {
    await _Pool.closeAll();
  }
}

function frameCodeInfo(arg0: any, arg1: number): any {
  console.warn('Function not implemented.');
}

function currentFrame(): any {
  console.warn('Function not implemented.');
  // return null;
}