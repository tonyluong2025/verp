import ct from 'countries-and-timezones';
import * as path from "path";
import { categoryXmlid, moduleXmlid } from '../models';
import { Cursor } from "../sql_db";
import { _format, bool, doWith, extend, len } from '../tools';
import { quoteList, tableExists } from '../tools/sql';
import * as core from './../../core';
import * as modules from "./modules";
import { dbFactory } from '../service/db';
import { stringify } from '../tools/json';

export async function isInstailized(cr: Cursor): Promise<boolean> {
  try {
    return await tableExists(cr, 'irModuleModule');
  } catch (e) {
    console.log(e.message);
    return false;
  }
}

export async function initializeDb(dbName, demo, lang, userPassword, login: string = 'admin', countryCode?: string, phone?: string) {
  try {
    const db = core.sql_db.dbConnect(dbName);
    let cr = db.cursor();
    await doWith(cr, async () => {
      // TODO this should be removed as it is done by Registry.new().
      await core.modules.db.initialize(cr);
      core.tools.config.options['loadLanguage'] = lang;
      await cr.commit();
    });

    const registry = await core.modules.registry.Registry.new(dbName, { forceDemo: demo, updateModule: true });

    cr = registry.cursor();
    await doWith(cr, async () => {
      const env = await core.api.Environment.new(cr, global.SUPERUSER_ID, {});

      if (lang) {
        const modules = await env.items('ir.module.module').search([['state', '=', 'installed']]);
        await modules._updateTranslations(lang);
      }
      if (countryCode) {
        const country = (await env.items('res.country').search([['code', 'ilike', countryCode]]))[0];
        await env.items('res.company').browse(1).write({ 'countryId': countryCode && country.id, 'currencyId': countryCode && (await country.currencyId).id });
        const tz = ct.getCountry(countryCode.toUpperCase()).timezones ?? [];
        if (len(tz) == 1) {
          const users = env.items('res.users').search([]);
          await users.write({ 'tz': tz[0] });
        }
      }
      if (phone) {
        await env.items('res.company').browse(1).write({ 'phone': phone });
      }
      if (login.includes('@')) {
        await env.items('res.company').browse(1).write({ 'email': login });
      }

      // update admin's password and lang and login
      const values = { 'password': userPassword, 'lang': lang };
      if (login) {
        values['login'] = login;
        const emails = core.tools.emailSplit(login);
        if (bool(emails)) {
          values['email'] = emails[0];
        }
      }
      await (await env.ref('base.userAdmin')).write(values);

      await cr.execute('SELECT login, password FROM "resUsers" ORDER BY login');
      await cr.commit();
    });
  } catch (e) {
    console.error('CREATE DATABASE failed:', e);
  }
}

/**
 * Initialize a database with for the ORM.

    This executes base/data/base_data.sql, creates the irModuleCategories (taken from each module descriptor file), and creates the irModuleModule and irModelData entries.
 * @param cr 
 */
export async function initialize(cr: Cursor) {
  const modPath = modules.getModulePath('base');
  const dataPath = path.resolve(modPath, 'data', cr.dbDialect, 'base_first');

  try {
    const { models, data } = require(dataPath)(cr);
    // TODO xem xet transaction
    const res = await createModels(cr, models);
    if (res) {
      const r = await insertData(cr, data);
      if (!r.length) {
        console.warn('Can not insert data from base/data/base_first');
      }
    } else {
      console.warn('Can not create models from base/data/base_first');
    }
  } catch (e) {
    console.log(e.message);
    throw e;
  }

  for (const mod of modules.getModules()) {
    const modPath = modules.getModulePath(mod);
    if (!modPath) {
      continue;
    }
    const info = modules.loadInformationFromDescriptionFile(mod);
    if (!info) {
      continue;
    }
    const categories = `${info['category']}`.split('/');
    const categoryId = await createCategories(cr, categories);

    const state = info['installable'] ? 'uninstalled' : 'uninstallable';

    let data = [
      'irModuleModule',
      ['author', 'website', 'label', 'shortdesc', 'description',
        'categoryId', 'autoInstall', 'state', 'web', 'license',
        'application', 'icon', 'sequence', 'summary'],
      [info['author'], info['website'], mod, info['shortdesc'], info['description'],
        categoryId, info['autoInstall'] !== false, state, info['web'], info['license'],
      info['application'], info['icon'], info['sequence'], info['summary']],
    ];
    let [res] = await insertData(cr, [data]);
    if (!res) {
      console.warn(`Can not insert data: ${stringify(data)}`);
    }
    const id = res['irModuleModule'][0]['id'];
    data = [
      'irModelData',
      ['label', 'model', 'module', 'resId', 'noupdate'],
      [moduleXmlid(mod), 'ir.module.module', 'base', id, true]
    ];
    await insertData(cr, [data]);
    const dependencies = info['depends'] || [];
    for (const d of dependencies) {
      const autoInstallRequired = (info['autoInstall'] || []).includes(d);
      data = [
        'irModuleModuleDependency',
        ['moduleId', 'label', 'autoInstallRequired'],
        [id, d, autoInstallRequired]
      ];
      await insertData(cr, [data]);
    }
  }

  // For debug
  // await cr.commit();
  // await cr.reset();
  // For debug
  // Install recursively all auto-installing modules
  while (true) {
    // this selects all the autoInstall modules whose autoInstallRequired
    // deps are marked as to install
    let sql = `
      SELECT m.label FROM "irModuleModule" m
      WHERE m."autoInstall"
      AND m.state != 'to install'
      AND NOT EXISTS (
        SELECT 1 FROM "irModuleModuleDependency" d
        JOIN "irModuleModule" mdep ON (d.label = mdep.label)
        WHERE d."moduleId" = m.id
          AND d."autoInstallRequired"
          AND mdep.state != 'to install'
      )`;
    let res = await cr.execute(sql);
    let toAutoInstall = res.map(x => x['label']);
    // however if the module has non-required deps we need to install
    // those, so merge-in the modules which have a dependen*t* which is
    // *either* to_install or in toAutoInstall and merge it in?
    sql = `
      SELECT d.label FROM "irModuleModuleDependency" d
      JOIN "irModuleModule" m ON (d."moduleId" = m.id)
      JOIN "irModuleModule" mdep ON (d.label = mdep.label)
      WHERE (m.state = 'to install'`
      + (toAutoInstall.length ? ` OR m.label IN (${quoteList(toAutoInstall)})` : '') +
      `)
      AND NOT (mdep.state = 'to install'`
      + (toAutoInstall.length ? ` OR mdep.label IN (${quoteList(toAutoInstall)})` : '') +
      `)
    `;
    res = await cr.execute(sql);
    toAutoInstall = extend(toAutoInstall, res.map(x => x['label']));

    if (!toAutoInstall.length) {
      break;
    }
    await cr.execute(`UPDATE "irModuleModule" SET state='to install' WHERE label in (${quoteList(toAutoInstall)})`);
  }
}

async function createModels(cr: Cursor, models: any): Promise<boolean> {
  const seq = cr._obj;
  const list = Array.isArray(models) ? models : [models];
  const query = await seq.getQueryInterface();
  let currentModel;
  try {
    for (const element of list) {
      if (typeof element !== 'object') {
        console.log('Data invalid. Must be an object or {}')
      }
      const command = `${element['#command']}`;
      delete element['#command'];
      if (command === 'addConstraint') {
        for (const [tableName, value] of Object.entries<any>(element)) {
          Object.assign(value, { transaction: cr.objTransaction });
          if (!(value['name'] as String).startsWith(tableName)) {
            value['name'] = tableName + '_' + value['name']
          }
          const options = {
            where: {
              constraintName: value['name'],
              constraintType: value['type'],
            },
          }
          const constraint = await constraintExists(cr, tableName, value['name'], options);
          if (constraint)
            await query.removeConstraint(tableName, value['name'], { transaction: cr.objTransaction })
          await addConstraint(cr, tableName, value);
        }
      } else {
        for (const [name, value] of Object.entries<any>(element)) {
          currentModel = name;
          const query = cr._obj.getQueryInterface();
          await query.createTable(name, value, {
            transaction: cr.objTransaction
          });
        }
      }
    }
    return true;
  } catch (e) {
    console.log(e.message, currentModel);
    throw e;
  }
}

/**
 * Serve many data structures:
 *  1) SQL string: "INSERT INTO ..."
 *  2) Array of objects: [{'tableName': {id: 1, name: 'Abc',...}}]
 *  3) Tuple of data: ['tableName', [fieldNames], [values]]
 * @param cr 
 * @param data 
 * @returns 
 */
async function insertData(cr: Cursor, data: any): Promise<any[]> {
  const seq = cr._obj;
  const list = Array.isArray(data) ? data : [data];
  const result: any[] = [];
  let current;
  try {
    for (const rec of list) {
      if (typeof rec === 'string') { // SQL string
        current = rec;
        const [res] = await cr.query(rec, { transaction: cr.objTransaction });
        result.push(...res);
      } else if (Array.isArray(rec) && rec.length == 3) {
        const table = `${rec[0]}`;
        const lenFields = rec[1].length;
        const lenValues = rec[2].length;
        if (lenValues !== lenFields) {
          console.log(`number of values (${lenValues}) not equals to number of fields (${lenFields}) for ${rec}`);
        }
        const sql = _format(
          `INSERT INTO {table} ({fields}) VALUES (${rec[2].map((x, i) => `$${i + 1}`)}) RETURNING id;`, {
          table: dbFactory.quote(table),
          fields: rec[1].map(x => dbFactory.quotes(x))
        });
        current = rec;
        const [res] = await cr.query(sql, { transaction: cr.objTransaction, bind: rec[2] });
        result.push({ [table]: res });
      } else if (typeof rec === 'object') { // json objects
        for (const [table, values] of Object.entries<{}>(rec)) {
          current = [table, values];
          const sql = _format(
            `INSERT INTO {table} ({fields}) VALUES (${Object.keys(values).map((x, i) => `$${i + 1}`)}) RETURNING id;`, {
            table: dbFactory.quote(table),
            fields: Object.keys(values).map(x => dbFactory.quotes(x))
          });
          const [res] = await cr.query(sql, { transaction: cr.objTransaction, bind: Object.values(values) });
          result.push({ [table]: res });
        }
      } else {
        console.log('Data invalid. Must be an object or {} or [tableName, [fields], [values]]')
      }
    }
    return result;
  } catch (e) {
    console.log(e.message, current);
    return result;
  }
}

export async function showConstraints(cr: Cursor, tableName: string, constraintName?: string, options?: {}): Promise<[any[], any]> {
  const gen: any = cr._obj.getQueryInterface().queryGenerator;
  const sql = gen.showConstraintsQuery(tableName, { constraintName: constraintName });
  return cr.query(sql, { ...options, type: 'SHOWCONSTRAINTS' });
}

export async function constraintExists(cr: Cursor, tableName: string, constraintName: string, options?: {}): Promise<boolean> {
  const constraints = await showConstraints(cr, tableName, constraintName, options);
  return constraints.some((value: {}) => value['constraintName'] === constraintName);
}

export async function getConstraint(cr: Cursor, tableName: string, constraintName: string, options?: {}): Promise<{}> {
  const constraints = await showConstraints(cr, tableName, constraintName, options);
  return constraints.find((value: {}) => value['constraintName'] === constraintName);
}

async function addConstraint(cr: Cursor, tableName: string, definition: any): Promise<void> {
  try {
    const query = cr._obj.getQueryInterface();
    await query.addConstraint(tableName, definition);
  } catch (e) {
    console.log(`Table ${tableName}: unable to add constraint ${definition}`)
    throw e;
  }
}

export async function createCategories(cr: Cursor, categories: string[]): Promise<number> {
  const seq = cr._obj;
  let pId;
  const category = [];
  while (categories.length) {
    category.push(categories[0]);

    const xmlid = categoryXmlid(category);
    let res = await cr.execute(`SELECT ${cr.dbService.quote("resId")} FROM ${cr.dbService.quote("irModelData")} WHERE label=$1 AND module=$2 AND model=$3`,
      { bind: [xmlid, 'base', 'ir.module.category'] });
    let cId;
    if (res.length && res[0]['resId']) {
      cId = res[0]['resId'];
    } else {
      res = await cr.execute(`INSERT INTO ${cr.dbService.quote("irModuleCategory")} (label, ${cr.dbService.quote("parentId")}) VALUES ($1, $2) RETURNING id`, { bind: [categories[0], pId] });
      cId = res[0]['id'];
      await cr.execute(`INSERT INTO ${cr.dbService.quote("irModelData")} (module, label, ${cr.dbService.quote("resId")}, model, noupdate) VALUES ($1, $2, $3, $4, $5)`, { bind: ['base', xmlid, cId, 'ir.module.category', true] });
    }
    pId = cId;
    categories = categories.slice(1);
  }
  return pId;
}

export async function hasUnaccent(cr: Cursor) {
  const res = await cr.execute("SELECT proname FROM pg_proc WHERE proname='unaccent'");
  return res.length > 0;
}

export async function hasTrigram(cr: Cursor) {
  const res = await cr.execute("SELECT proname FROM pg_proc WHERE proname='word_similarity'");
  return res.length > 0;
}