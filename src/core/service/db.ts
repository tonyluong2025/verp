import fs from 'fs';
import _ from 'lodash';
import path from "node:path";
import temp from 'temp';
import xpath from "xpath/xpath";
import { api, modules, release } from '..';
import { AccessDenied, KeyError } from "../helper/errors";
import { initializeDb } from '../modules/db';
import { versionInfo } from "../release";
import * as tools from '../tools';
import { muteLogger, sorted } from "../tools";
import { zipDir } from '../tools/osutils';
import { getrootXml, parseXml } from "../tools/xml";
import * as sql_db from "./../sql_db";
import { IDbService } from "./dialect/abstract";

/**
 * Dùng trong trường hợp gọi hàm truy xuất DB mà Sequelize chưa hỗ trợ, cần truy xuất trực tiếp hỗ trợ của dialiect nguyên     
 */
export class DbFactory {
  static create(dialect: string): IDbService {
    let dbFactory;
    switch (dialect) {
      case 'postgres':
        dbFactory = require('./dialect/postgres');
        break;
      case 'mssql':
        dbFactory = require('./dialect/mssql');
        break;
      case 'mysql':
        dbFactory = require('./dialect/mysql');
        break;
      case 'mariadb':
        dbFactory = require('./dialect/mariadb');
        break;
      case 'sqlite':
        dbFactory = require('./dialect/sqlite');
        break;
      case 'db2':
      case 'snowflake':
      default:
        console.log(`The dialect ${dialect} is not supported. Supported dialects: mssql, mariadb, mysql, postgres, db2 and sqlite.`);
    }
    return dbFactory;
  }

  private constructor(dialect?: string) {
    console.log('Must call Dbfactory.create(name).');
  }
}

export const dbFactory = DbFactory.create(tools.config.get('dbDialect'));

function checkDbManagementEnabled() {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    if (!tools.config.options['listDb']) {
      console.error('Database management functions blocked, admin disabled database listing')
      throw new AccessDenied();
    }
  }
}

class _expDbExist extends Function {
  constructor() {
    super();
    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args[0]);
      }
    });
  }

  @muteLogger('sqlDb')
  async __call__(dbName) {
    try {
      const db = sql_db.dbConnect(dbName);
      const cr = db.cursor();
      await cr.close();
      return true;
    } catch (e) {
      return false;
    }
  }
}

export class MetaDatebase {
  static async expDbExist(req, dbName) {
    return (new _expDbExist())(dbName);
  }

  static async expList() {
    if (!tools.config.get('listDb')) {
      throw new AccessDenied();
    }
    return this.listDbs();
  }

  static async expListLang() {
    return tools.scanLanguages();
  }

  /**
   * Return the version of the server
          Used by the client to verify the compatibility with its own version
  * @returns 
  */
  static expServerVersion() {
    return release.version;
  }

  // Master password required

  static async checkSuper(password: any) {
    if (password && tools.config.verifyAdminPassword(password)) {
      return true;
    }
    throw new AccessDenied();
  }

  static async createEmptyDatabase(name: string) {
    const db = sql_db.dbConnect(dbFactory.getSystemDbName());
    const cr = db.cursor();
    await cr.execute(dbFactory.sqlCreateDatabase(name));
    await cr.close();
  }

  static async expListCountries() {
    const listCountries = [];
    const xmlString = fs.readFileSync(path.join(tools.config.get('rootPath'), 'addons/base/data/res_country_data.xml'), 'utf-8');
    const root = getrootXml(parseXml(xmlString));
    const data: any = xpath.select('data', root)[0];
    const nodes: any[] = xpath.select('record[@model="res.country"]', data) ?? [];
    for (const country of nodes) {
      const label: any = xpath.select('field[@name="label"]', country)[0];
      const code: any = xpath.select('field[@name="code"]', country)[0];
      listCountries.push([code.textContent, label.textContent]);
    }
    return sorted(listCountries, (c) => c[1]);
  }

  static async _dropConn(cr: sql_db.Cursor, dbName) {
    // Try to terminate all other connections that might prevent
    // dropping the database
    try {
      const pidCol = tools.parseInt(cr._cnx.getDatabaseVersion()) >= 90200 ? 'pid' : 'procpid';

      await cr.execute(`SELECT pg_terminate_backend('${pidCol}')
                      FROM pg_stat_activity
                      WHERE datname = '${dbName}' AND '${pidCol}' != pg_backend_pid()`);
    } catch (e) {
      // pass
    }
  }

  @checkDbManagementEnabled()
  static async expDuplicateDatabase(req, dbOriginalName, dbName) {
    console.info('Duplicate database `%s` to `%s`.', dbOriginalName, dbName);
    await sql_db.closeDb(dbOriginalName);
    const db = sql_db.dbConnect('postgres');
    let cr = db.cursor();
    // database-altering operations cannot be executed inside a transaction
    cr.autocommit(true);
    await this._dropConn(cr, dbOriginalName);
    await cr.execute(`CREATE DATABASE %s ENCODING 'unicode' TEMPLATE %s"`,
      [cr.dbService.quote(dbName), cr.dbService.quote(dbOriginalName)]
    )
    await cr.close();

    const registry = await modules.registry.Registry.new(dbName);
    cr = registry.cursor();
    // if it's a copy of a database, force generation of a new dbuuid
    const env = await api.Environment.new(cr, global.SUPERUSER_ID);
    await env.items('ir.config.parameter').init(true);
    await cr.close();

    const fromFs = tools.config.filestore(dbOriginalName);
    const toFs = tools.config.filestore(dbName);
    if (fs.existsSync(fromFs) && !fs.existsSync(toFs)) {
      fs.cpSync(fromFs, toFs, { recursive: true });
    }
    return true;
  }

  @checkDbManagementEnabled()
  static async expDrop(req, dbName: string) {
    if (!(await this.listDbs(true)).includes(dbName)) {
      return false;
    }
    modules.registry.Registry.delete(dbName);
    await sql_db.closeDb(dbName);

    const db = sql_db.dbConnect(dbFactory.getSystemDbName());
    const cr = db.cursor();
    cr.autocommit(true);
    await cr.execute(dbFactory.sqlDropDatabase(dbName));
    await cr.close();

    const fstore = tools.config.filestore(dbName);
    if (fs.existsSync(fstore)) {
      fs.rmSync(fstore, { recursive: true, force: true });
    }
    return true;
  }

  @checkDbManagementEnabled()
  static async expChangeAdminPassword(req, newPassword) {
    tools.config.setAdminPassword(newPassword);
    tools.config.save();
    return true;
  }

  /**
   * Similar to expCreate but blocking.
   * @param dbName 
   * @param demo 
   * @param lang 
   * @param userPassword 
   * @param login 
   * @param countryCode 
   * @param phone 
   * @returns 
   */
  @checkDbManagementEnabled()
  static async expCreateDatabase(req, dbName, demo, lang, userPassword = 'admin', login = 'admin', countryCode?: any, phone?: any) {
    console.info('Create database "%s".', dbName);
    await this.createEmptyDatabase(dbName);
    await initializeDb(dbName, demo, lang, userPassword, login, countryCode, phone);
    return true;
  }

  static async listDbs(force?: boolean): Promise<string[]> {
    if (!tools.config.options['listDb'] && !force) {
      throw new AccessDenied();
    }

    if (!tools.config.options['dbFilter'] && tools.config.options['dbName']) {
      // In case --db-filter is not provided and --database is passed, Verp will not
      // fetch the list of databases available on the postgres server and instead will
      // use the value of --database as comma seperated list of exposed databases.
      const res = sorted(tools.config.options['dbName'].split(',').map(db => db.trim()));
      return res;
    }

    const chosenTemplate = tools.config.options['dbTemplate'];
    const templatesList = Array.from(new Set([tools.config.get('dbDialect'), chosenTemplate]));
    const db = sql_db.dbConnect(tools.config.get('dbDialect'));
    const cr = db.cursor();
    let res;
    try {
      res = await cr.execute(`select datname from pg_database where datdba=(select usesysid from pg_user where usename=current_user) and not datistemplate and datallowconn and datname not in (${tools.quoteList(templatesList)}) order by datname`)
      res = res.map(rec => rec['datname']);
    } catch (e) {
      console.error('Listing databases failed:');
      res = [];
    }
    await cr.close();
    return res;
  }

  /**
   * Check a list of databases if they are compatible with this version of Verp

        @param databases: A list of existing Postgresql databases
        @return: A list of databases that are incompatible
  */
  static async listDbIncompatible(databases: string[]) {
    const incompatibleDatabases = [];
    const serverVersion = versionInfo.slice(0, 2).map(v => String(v)).join('.');
    for (const databaseName of databases) {
      let cr: sql_db.Cursor;
      try {
        cr = sql_db.dbConnect(databaseName).cursor();
        if (await tools.tableExists(cr, 'irModuleModule')) {
          const res = await cr.execute(`SELECT "latestVersion" AS version FROM "irModuleModule" WHERE label='base'`);
          if (!res.length) {
            incompatibleDatabases.push(databaseName);
          } else {
            const baseVersion = res[0]['version'];
            const localVersion = baseVersion.split('.').slice(0, 2).join('.');
            if (localVersion !== serverVersion) {
              incompatibleDatabases.push(databaseName);
            }
          }
        } else {
          incompatibleDatabases.push(databaseName);
        }
      } catch (e) {

      } finally {
        await cr.close();
      }
    }
    for (const databaseName of incompatibleDatabases) {
      // release connection
      await sql_db.closeDb(databaseName);
    }
    return incompatibleDatabases;
  }

  @checkDbManagementEnabled()
  static async dumpDbManifest(cr: sql_db.Cursor) {
    const pgVersion = tools.f("%d.%d", tools.divmod(tools.parseInt(cr._obj.getDatabaseVersion()) / 100, 100));
    const modules = await cr.execute(`SELECT label, "latestVersion" FROM "irModuleModule" WHERE state = 'installed'`);
    const manifest = {
      'verpDump': '1',
      'dbName': cr.dbName,
      'version': release.version,
      'versionInfo': release.versionInfo,
      'majorVersion': release.majorVersion,
      'pgVersion': pgVersion,
      'modules': modules,
    }
    return manifest;
  }

  /**
   * Dump database `db` into file-like object `stream` if stream is null
      return a file object with the dump
   * @param dbName 
   * @param stream 
   * @param backupFormat 
   * @returns 
   */
  @checkDbManagementEnabled()
  static async dumpDb(dbName: string, stream: null, backupFormat = 'zip') {
    console.info('DUMP DB: %s format %s', dbName, backupFormat);

    const cmd = 'pg_dump';
    const args = ['--no-owner']
    args.push(dbName);

    if (backupFormat == 'zip') {
      const dumpDir = await temp.mkdir();
      const filestore = tools.config.filestore(dbName);
      if (fs.existsSync(filestore)) {
        fs.cpSync(filestore, path.join(dumpDir, 'filestore'));
      }
      const fh = path.join(dumpDir, 'manifest.json');
      const db = sql_db.dbConnect(dbName);
      const cr = db.cursor();
      fs.writeFileSync(fh, tools.stringify(await this.dumpDbManifest(cr)));
      await cr.close();

      args.splice(args.length - 1, 0, '--file=' + path.join(dumpDir, 'dump.sql'));
      await tools.execPgCommand(cmd, ...args);
      if (stream) {
        zipDir(dumpDir, stream, { includeDir: false, fnctSort: fileName => fileName != 'dump.sql' });
      }
      else {
        const dataFile: temp.OpenFile = await temp.open({ suffix: '.html', prefix: 'report.header.tmp.' });
        zipDir(dumpDir, dataFile, { includeDir: false, fnctSort: fileName => fileName != 'dump.sql' });
        return dataFile;
      }
    }
    else {
      args.splice(args.length - 1, 0, '--format=c');
      await tools.execPgCommand(cmd, ...args)
      // if (stream) {
      //     shutil.copyfileobj(stdout, stream);
      // }
      // else {
      //     return stdout;
      // }
    }
  }

  @checkDbManagementEnabled()
  static async restoreDb(name: any, name1: any, arg2: any) {
    throw new Error('Function not implemented.');
  }
}

// db service dispatch

export async function dispatch(method, req, ...params) {
  const expMethodName = 'exp' + _.upperFirst(method);
  if (['dbExist', 'list', 'listLang', 'serverVersion'].includes(method)) {
    return MetaDatebase[expMethodName](req, ...params);
  }
  else if (expMethodName in MetaDatebase) {
    const passwd = params[0];
    params = params.slice(1);
    await MetaDatebase.checkSuper(passwd);
    return MetaDatebase[expMethodName](req, ...params);
  }
  else {
    throw new KeyError("Method not found: %s", method);
  }
}