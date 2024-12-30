import { DbServiceAbstract, IDbService } from '../abstract/index';
import { config } from '../../../tools/config';
import { sql_db } from '../../..';

class DbPostgres extends DbServiceAbstract implements IDbService {
  readonly QUOTE_NAME = '"';
  readonly QUOTE_STRING = "'";

  options = {
    dialect: config.get('dbDialect'), 
    username: config.get('dbUser'),
    password: config.get('dbPassword'),
    host: config.get('dbHost'),
    port: config.get('dbPort'),
    database: 'postgres', // super database of postgres
  };

  getConnection(man) {
    return man('postgres://username:password@host:port/database', {
      host: '',
      port: 5432,
      database: '',
      username: '',
      password: ''
    })
  }

  now(): string {
    return `SELECT (now() AT TIME ZONE 'UTC')`;
  }

  async createEmptyDatabase(name: string) {
    const db = sql_db.dbConnect(this.getSystemDbName());
    const cr = db.cursor();
    await cr._obj.getQueryInterface().createDatabase(name);
  }

  async hasUnaccent(cr) {
    const res = await cr.execute("SELECT proname FROM pg_proc WHERE proname='unaccent'");
    return res.length > 0;
  }
  
  async hasTrigram(cr) {
    const res = await cr.execute("SELECT proname FROM pg_proc WHERE proname='word_similarity'");
    return res.length > 0;
  }

  getDataTypeBlob(): string {
    return 'BYTEA'
  }

  getDataTypeDatetime(): string {
    return 'TIMESTAMP'
  }

  convertDataTypeVarchar(type: string):string {
    type = type.toUpperCase();
    if (type.startsWith('CHARACTER VARYING')) {
      return 'VARCHAR';
    } else {
      return type;
    }
  }

  convertDataTypeFloat(type: string):string {
    type = type.toUpperCase();
    if (type.startsWith('DOUBLE')) {
      return 'FLOAT';
    } else {
      return type;
    }
  }

  convertDataTypeDatetime(type: string): string {
    type = type.toUpperCase();
    if (type.startsWith('TIMESTAMP')) {
      return 'TIMESTAMP';
    } else {
      return type;
    }
  }
 
  // SQL
  sqlSetSessionTimeout(): string {
    return `SET SESSION lock_timeout = '15s'`
  }

  sqlSelectTablesExists(tableNames: string[]): string {
    const sql = `
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON (n.oid = c.relnamespace)
      WHERE c.relname IN (${tableNames.map((name) => `'${name}'`)})
        AND c.relkind IN ('r', 'v', 'm')
        AND n.nspname = 'public'
    `
    /**
     * Tuong tu
     * SELECT table_name FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name IN ${tablenames}
     */
    return sql;
  }

  sqlCreateNewSequence(name: string): string {
    return `CREATE SEQUENCE IF NOT EXISTS ${name} INCREMENT BY 1 START WITH 1`
  }

  sqlSelectSequenceByName(name: string): string {
    return `SELECT sequence_name FROM information_schema.sequences WHERE sequence_name='${name}'`;
  }
  
  sqlSelectNextSequence(names: string[]): string {
    return `SELECT ` + names.map((name) => `nextval('${name}')`);
  }
  
  sqlSelectLastSequence(names: string[]): string {
    return `SELECT ` + names.map((name) => `${name}.last_value`)
    + ' FROM ' + names;
  }

  sqlDropSequence(names: string[]): string {
    return `DROP SEQUENCE IF EXISTS ` + names.map((name) => `${name}`);
  }

  sqlSelectForeignKey(tablename1, columnname1, tablename2, columnname2, ondelete): string {
    const _CONFDELTYPES = {
      'RESTRICT': 'r',
      'NO ACTION': 'a',
      'CASCADE': 'c',
      'SET NULL': 'n',
      'SET DEFAULT': 'd',
    }
    const sql = `SELECT fk.conname as "constraintName",
                c1.relname as "tableName",
                a1.attname as "columnName",
                c2.relname as "refTableName",
                a2.attname as "refColumnName",
                fk.confdeltype as "ondelete",
                fk.confupdtype as "onupdate"
                FROM pg_constraint AS fk
                JOIN pg_class AS c1 ON fk.conrelid = c1.oid
                JOIN pg_class AS c2 ON fk.confrelid = c2.oid
                JOIN pg_attribute AS a1 ON a1.attrelid = c1.oid AND fk.conkey[1] = a1.attnum
                JOIN pg_attribute AS a2 ON a2.attrelid = c2.oid AND fk.confkey[1] = a2.attnum
                WHERE fk.contype = 'f' 
                AND c1.relname = '${tablename1}'
                AND a1.attname = '${columnname1}'
                AND c2.relname = '${tablename2}'
                AND a2.attname = '${columnname2}'
                AND fk.confdeltype = '${_CONFDELTYPES[ondelete.toUpperCase()]}';`
    return sql;
  }

  sqlSelectExistingTables(tableNames: string[]): string {
    return `
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON (n.oid = c.relnamespace)
      WHERE c.relname IN (${tableNames.map((name) => `'${name}'`)})
        AND c.relkind IN ('r', 'v', 'm')
        AND n.nspname = current_schema
    `;
  }

  sqlSelectAllForeignKeys(tableNames: string[], schemaName?: string) {
    const sql = `SELECT fk.conname as "constraintName",
                c1.relname as "tableName",
                a1.attname as "columnName",
                c2.relname as "refTableName",
                a2.attname as "refColumnName",
                fk.confdeltype as "ondelete",
                fk.confupdtype as "onupdate"
                FROM pg_constraint AS fk
                JOIN pg_class AS c1 ON fk.conrelid = c1.oid
                JOIN pg_class AS c2 ON fk.confrelid = c2.oid
                JOIN pg_attribute AS a1 ON a1.attrelid = c1.oid AND fk.conkey[1] = a1.attnum
                JOIN pg_attribute AS a2 ON a2.attrelid = c2.oid AND fk.confkey[1] = a2.attnum
                WHERE fk.contype = 'f' AND c1.relname IN (${tableNames.map((name) => `'${name}'`)});`
    return sql;
  }

  sqlSelectTableExists(tableName: any): string {
    const table = tableName.tableName || tableName;
    const schema = tableName.schema || 'public';

    return `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = '${table}'`;
  }
}

module.exports = new DbPostgres();
