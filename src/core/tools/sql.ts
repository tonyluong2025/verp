import { QueryTypes } from "@sequelize/core";
import util, { format } from 'util';
import { SQLError } from '../helper/errors';
import { dbFactory } from '../service/db';
import { Cursor } from "../sql_db";

export const quote = (x) => `'${x}'`;
export const quoteDouble = (x) => `"${x}"`;
export const quoteList = (list, q = quote) => Array.from(list).map(n => q(n)).join(',');

/**
 * Reverse an ORDER BY clause
 * @param order 
 * @returns 
 */
export function reverseOrder(order: any) {
  const items = [];
  for (let item of order.split(',')) {
    item = item.toLowerCase().trim().split(' ');
    const direction = item.slice(1)[0] === 'desc' ? 'asc' : 'desc'
    items.push(`${item[0]} ${direction}`);
  }
  return items.join(', ')
}

export async function existingTables(cr: Cursor, tableNames: string[]) {
  const query = dbFactory.sqlSelectExistingTables(tableNames);
  const [res] = await cr.query(query);
  return res.length ? res.map(row => row['relname']) : [];
}

export async function tableExists(cr: Cursor, tableName: string): Promise<boolean> {
  const query = dbFactory.sqlSelectTableExists(tableName);
  const [out] = await cr.query(query, {
    // type: QueryTypes.SHOWTABLES,
  });

  return out?.length === 1;
}

/**
 * Return the kind of a table: `'r'` (regular table), `'v'` (view),
    `'f'` (foreign table), `'t'` (temporary table),
    `'m'` (materialized view), or `'null'`.
 * @param cr 
 * @param tablename 
 * @returns 
 */
export async function tableKind(cr: Cursor, tableName: string): Promise<string | null> {
  const sql = `SELECT c.relkind
               FROM pg_class c
                 JOIN pg_namespace n ON (n.oid = c.relnamespace)
               WHERE c.relname = '%s'
                 AND n.nspname = current_schema`
  const [res] = await cr.query(sql, [tableName]);

  return res[0] ? res[0]['relkind'] : null;
}

export async function describeTable(cr: Cursor, tableName: string): Promise<{}> {
  try {
    // Cach 1: OK
    const gen: any = cr._obj.getQueryInterface().queryGenerator;
    const sql = gen.describeTableQuery(tableName);
    const res: any = await cr.query(sql, { type: QueryTypes.DESCRIBE });

    // Cach 2: OK
    // const query = cr._obj.getQueryInterface();
    // const res = await query.describeTable(tableName, {transaction: cr.objTransaction});  
    return res;
  } catch (e) {
    return;
  }
}

export async function tableColumns(cr: Cursor, tableName: string): Promise<{}> {
  return describeTable(cr, tableName);
}

export async function createModelTable(cr: Cursor, tableName: string, comment: any, options: any[]) {
  console.warn('Function not implemented.');
}

export async function columnExists(cr: Cursor, tableName: string, column: string): Promise<boolean> {
  const res = await describeTable(cr, tableName) ?? {};
  return column in res;
}

/**
 * Create a column with the given type.
 * @param cr 
 * @param tableName 
 * @param columnName 
 * @param columnType 
 * @param comment 
 */
export async function createColumn(cr: Cursor, tableName: string, columnName: string, columnType: string, comment: string) {
  const coldefault = '';
  await cr.execute(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnType} ${coldefault}`);
  if (comment) {
    await cr.execute(`COMMENT ON COLUMN "${tableName}"."${columnName}" IS '${comment}'`);
  }
}

/**
 * Convert the column to the given type.
 * @param cr 
 * @param tableName 
 * @param columnName 
 * @param columnType 
 */
export async function convertColumn(cr: Cursor, tableName: string, columnName: string, columnType: string) {
  try {
    // with cr.savepoint(flush=false):
    await cr.execute(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" TYPE ${columnType}`);
  } catch (e) {
    if (e) {//} except psycopg2.NotSupportedError:
      // # can't do inplace change -> use a casted temp column
      // query = '''
      //     ALTER TABLE "{0}" RENAME COLUMN "{1}" TO __temp_type_cast;
      //     ALTER TABLE "{0}" ADD COLUMN "{1}" {2};
      //     UPDATE "{0}" SET "{1}"= __temp_type_cast::{2};
      //     ALTER TABLE "{0}" DROP COLUMN  __temp_type_cast CASCADE;
      // '''
      // cr.execute(query.format(tablename, columnname, columntype))
    }
  }
  // console.debug("Table %s: column %s changed to type %s", tableName, columnName, columnType)
}

/**
 * Drop the NOT NULL constraint on the given column.
 * @param cr 
 * @param tableName 
 * @param columnName 
 */
export async function dropNotNull(cr: Cursor, tableName: string, columnName: string) {
  await cr.execute(`ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" DROP NOT NULL`);
}

export async function dropViewIfExists(cr: Cursor, viewname: string) {
  await cr.execute(`DROP view IF EXISTS "${viewname}" CASCADE`);
}
/**
 * Add a NOT NULL constraint on the given column.
 * @param cr 
 * @param tablename 
 * @param columnname 
 */
export async function setNotNull(cr, tablename, columnname) {
  const query = format('ALTER TABLE "%s" ALTER COLUMN "%s" SET NOT NULL', tablename, columnname);
  try {
    // with cr.savepoint(flush=false):
    await cr.execute(query);
  } catch (e) {
    throw new SQLError("Table %s: unable to set NOT NULL on column %s, %s", tablename, columnname, e);
  }
}

export async function renameColumn(cr: Cursor, tableName: string, columnName1: string, columnName2: string) {
  await cr.execute(`ALTER TABLE "${tableName}" RENAME COLUMN "${columnName1}" TO "${columnName2}"`);
}

/**
 * Add a constraint on the given table.
 * @param cr 
 * @param tablename 
 * @param constraintname 
 * @param definition 
 */
export async function addConstraint(cr, tablename, constraintname, definition, message) {
  const query1 = format('ALTER TABLE "%s" ADD CONSTRAINT "%s" %s;', tablename, constraintname, definition)
  const query2 = format(`COMMENT ON CONSTRAINT "%s" ON "%s" IS '%s';`, constraintname, tablename, message.replace(/'/g, '"'))
  try {
    // await cr.savepoint(false, async () => {
    await cr.execute(query1);
    await cr.execute(query2);
    // });
  } catch (e) {
    throw new SQLError("Table %s: unable to add constraint %s as %s %s", tablename, constraintname, definition, e);
  }
}

/**
 * drop the given constraint.
 * @param cr 
 * @param tablename 
 * @param constraintname 
 */
export async function dropConstraint(cr, tablename, constraintname) {
  try {
    // with cr.savepoint(flush=false):
    await cr.execute('ALTER TABLE "%s" DROP CONSTRAINT "%s"', [tablename, constraintname]);
  } catch (e) {
    throw new SQLError("Table %s: unable to drop constraint %s!", tablename, constraintname)
  }
}

/**
 * Create the given foreign key, and return `'true'`.
 * @param cr 
 * @param tablename1 
 * @param columnname1 
 * @param tablename2 
 * @param columnname2 
 * @param ondelete 
 * @returns 
 */
export async function addForeignKey(cr, tablename1, columnname1, tablename2, columnname2, ondelete) {
  const query = 'ALTER TABLE "%s" ADD FOREIGN KEY ("%s") REFERENCES "%s" ("%s") ON DELETE %s';
  await cr.execute(util.format(query, tablename1, columnname1, tablename2, columnname2, ondelete));
  return true;
}

/**
 * Return whether the given index exists.
 * @param cr 
 * @param indexname 
 */
export async function indexExists(cr: Cursor, indexname: string) {
  const res = await cr.execute(`SELECT 1 FROM pg_indexes WHERE indexname='${indexname}'`);
  return res.length;
}

/**
 * Create the given index unless it exists.
 * @param cr 
 * @param indexname 
 * @param tablename 
 * @param expressions 
 * @returns 
 */
export async function createIndex(cr: Cursor, indexname: string, tablename: string, expressions: string[]) {
  if (await indexExists(cr, indexname)) {
    return;
  }
  return cr.execute(`CREATE INDEX "${indexname}" ON "${tablename}" (${expressions})`);
}

/**
 * Create the given index unless it exists.
 * @param cr 
 * @param indexname 
 * @param tablename 
 * @param expressions 
 * @returns 
 */
export async function createUniqueIndex(cr: Cursor, indexname: string, tablename: string, expressions: string[]) {
  if (await indexExists(cr, indexname)) {
    return;
  }
  return cr.execute(`CREATE UNIQUE INDEX "${indexname}" ON "${tablename}" (${expressions})`);
}

export function escapePsql(toEscape: string) {
  return toEscape.replace(/\\/, '\\\\').replace('%', '\%').replace('_', '\_');
}