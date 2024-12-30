import { sql_db } from '../../..';
import { DatabaseExistsError } from '../../../helper';
import { config, quoteList } from '../../../tools';
import { DbServiceAbstract, IDbService } from '../abstract';

class DbMariaDb extends DbServiceAbstract implements IDbService {
  readonly QUOTE_NAME = "`";
  readonly QUOTE_STRING = "'";

  options = {
    dialect: config.get('dbDialect'), 
    username: config.get('dbUser'),
    password: config.get('dbPassword'),
    host: config.get('dbHost'),
    port: config.get('dbPort'),
    database: 'sys', // super database of mariadb
  };
  
  createPool(man) {
    return man.createPool({
      host: "192.0.2.50",
      user: "db_user",
      password: "db_user_password",
      database: "test",
      connectionLimit: 100,
    });
  }

  async createEmptyDatabase(name: string) {
    const mysql = require("mariadb");

    // Open the connection to MySQL server
    const client = await mysql.createConnection({
      user: config.get('dbUser'),
      password: config.get('dbPassword'),
      host: config.get('dbHost'),
      port: config.get('dbPort'),
    });

    // Run create database statement
    const sql = `CREATE DATABASE IF NOT EXISTS '${name}'`;
    const res = await client.query(sql);
    if (res.rowCount) {
      // throw sql_db.errorDatabaseExists(new Error());
      throw new DatabaseExistsError(`database "${name}" not created`);
    }
    console.log(`database "${name}" created!`);
    
    if (config.get('unaccent')) {
      const db = sql_db.dbConnect(name);
      const cr = db.cursor();
      await cr.execute('CREATE EXTENSION IF NOT EXISTS unaccent');
    }
  }

  sqlSelectTablesExists(tableNames: string[]):string {
    const sql = `
      SELECT table_name
      FROM information_schema.tables 
      WHERE table_schema = SCHEMA()
      AND table_name IN (${quoteList(tableNames)});
    `
    return sql;
  }

  sqlCreateNewSequence(name: string): string {
    return `CREATE SEQUENCE IF NOT EXISTS ${name} INCREMENT BY 1 START WITH 1`
  }

  sqlSelectSequenceByName(name: string): string {
    return `SELECT start_value FROM ${name}`;
  }

  sqlSelectNextSequence(names: string[]): string {
    return `SELECT ` + names.map((name) => `NEXTVAL(${name})`).join(',');
  }

  sqlSelectLastSequence(names: string[]): string {
    return `SELECT ` + names.map((name) => `LASTVAL(${name})`).join(',')
  }

  sqlDropSequence(name: string): string {
    return `DROP SEQUENCE IF EXISTS ${name}`;
  }

  sqlSelectForeignKey(tablename1, columnname1, tablename2, columnname2, ondelete): string {
    const sql = `SELECT fk.CONSTRAINT_NAME as constraintName,
                    fk.TABLE_NAME as tableName,
                    fk.COLUMN_NAME as columnName,
                    fk.REFERENCED_TABLE_NAME as refTableName,
                    fk.REFERENCED_COLUMN_NAME as refColumnName,
                    c1.DELETE_RULE as ondelete,
                    c1.UPDATE_RULE as onupdate
                FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE as fk
                JOIN information_schema.REFERENTIAL_CONSTRAINTS AS c1 ON fk.CONSTRAINT_NAME = c1.CONSTRAINT_NAME
                WHERE fk.CONSTRAINT_NAME!='PRIMARY'
                  AND fk.TABLE_NAME = '${tablename1}'
                  AND fk.COLUMN_NAME = '${columnname1}'
                  AND fk.REFERENCED_TABLE_NAME = '${tablename2}'
                  AND fk.REFERENCED_COLUMN_NAME = '${columnname2}'
                  AND c1.DELETE_RULE = '${ondelete}'
                  AND fk.CONSTRAINT_SCHEMA = SCHEMA()
                  AND fk.REFERENCED_TABLE_NAME IS NOT NULL`;
    return sql;
  }

  sqlSelectAllForeignKeys(tableNames: string[], schemaName) {
    const sql = `SELECT fk.CONSTRAINT_NAME as constraintName,
                    fk.TABLE_NAME as tableName,
                    fk.COLUMN_NAME as columnName,
                    fk.REFERENCED_TABLE_NAME as refTableName,
                    fk.REFERENCED_COLUMN_NAME as refColumnName,
                    c1.DELETE_RULE as ondelete,
                    c1.UPDATE_RULE as onupdate
                FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE as fk
                JOIN information_schema.REFERENTIAL_CONSTRAINTS AS c1 ON fk.CONSTRAINT_NAME = c1.CONSTRAINT_NAME
                WHERE fk.CONSTRAINT_NAME!='PRIMARY'
                  AND fk.TABLE_NAME IN (${quoteList(tableNames)})
                  AND fk.CONSTRAINT_SCHEMA = '${schemaName}'
                  AND fk.REFERENCED_TABLE_NAME IS NOT NULL`;
    return sql;
  }

  sqlSetSessionTimeout(): string{
    return `SET GLOBAL wait_timeout=15`
  }

  getDataTypeBlob(): string {
    return 'BLOB'
  }
  
  getDataTypeDatetime(): string {
    return 'DATETIME'
  }
  
  now(): string {
    return "SELECT CURRENT_TIMESTAMP()";
  }
}

module.exports = new DbMariaDb();

