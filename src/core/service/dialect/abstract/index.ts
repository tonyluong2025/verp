import { NotImplementedError } from "../../../helper/errors";

export interface IDbService {
  options: {};
  now(): string;
  name(name: string): string;
  string(name: string): string;
  quote(name: string, char?: string): string;
  quotes(names: any, char?: string): string;
  hasUnaccent(cr): Promise<boolean>;
  hasTrigram(cr): Promise<boolean>;

  createEmptyDatabase(name: string): Promise<void>;

  getSystemDbName(): string;
  getVarcharMaximumLength(type: string): number;
  getDataTypeBlob(): string;
  getDataTypeDatetime(): string

  convertDataTypeFloat(type: string): string;
  convertDataTypeVarchar(type: string): string;
  convertDataTypeDatetime(type: string): string;

  sqlCreateDatabase(name): string;
  sqlDropDatabase(name: string): string;

  sqlSetSessionTimeout(): string;

  sqlCreateNewSequence(name: string): string;

  sqlSelectExistingTables(tableNames: string[]): string;
  sqlSelectTablesExists(tableNames: string[]): string;
  sqlSelectSequenceByName(name: string): string;
  sqlSelectNextSequence(names: string[]): string
  sqlSelectLastSequence(names: string[]): string;
  sqlSelectForeignKey(tablename1, columnname1, tablename2, columnname2, ondelete): string;
  sqlSelectAllForeignKeys(tableNames: string[], schemaName?: string): string;
  sqlSelectTableExists(tableName: any): string;
}

export class DbServiceAbstract implements IDbService {
  QUOTE_NAME: string;
  QUOTE_STRING: string;
  // Data
  options: {};

  // Helpers
  now(): string {
    throw new Error("Method not implemented.");
  }

  name(name: string) {
    return this.quote(name, this.QUOTE_NAME);
  }

  string(name: string) {
    return this.quote(name, this.QUOTE_STRING);
  }

  quote(name: string, char: string=this.QUOTE_NAME) {
    if (typeof name !== 'string') {
      throw new Error(`qname received a non-string name: ${typeof name}`);
    }
    return char + name.replace(char, char + char) + char;
  }

  quotes(names: any, char: string=this.QUOTE_NAME) {
    if (names.includes('.')) {
      names = names.split('.');

      const head = names.slice(0, -1).join('->');
      const tail = names.at(-1);

      return `${this.quote(head, char)}.${tail === '*' ? '*' : this.quote(tail, char)}`;
    }

    if (names === '*') {
      return '*';
    }

    return this.quote(names, char);
  }

  async hasUnaccent(cr) {
    return false;
  }

  async hasTrigram(cr) {
    return false;
  }

  async createEmptyDatabase(name: string) {
    throw new Error("Method not implemented.");
  }

  getSystemDbName(): string {
    return this.options['database'];
  }

  getVarcharMaximumLength(type: string): number {
    const start = type.indexOf('(');
    const end = type.indexOf(')');
    const maximum = start < end && end < type.length ? Number(type.slice(start + 1, end)) : 0;
    return maximum;
  }

  getDataTypeBlob(): string {
    throw new Error("Method not implemented.");
  }

  getDataTypeDatetime(): string {
    throw new Error("Method not implemented.");
  }

  // Convert data types
  convertDataTypeFloat(type: string): string {
    return type.toUpperCase();
  }

  convertDataTypeVarchar(type: string): string {
    return type.toUpperCase();
  }

  convertDataTypeDatetime(type: string): string {
    return type.toUpperCase();
  }

  // SQL
  sqlCreateDatabase(name) {
    return 'CREATE DATABASE ' + name;
  }

  sqlDropDatabase(name) {
    return 'DROP DATABASE ' + name;
  }

  sqlSetNextSequence(name: string, value: number): string {
    return `SELECT SETVAL(${name}, ${value})`;
  }  

  sqlSetSessionTimeout(): string {
    throw new Error("Method not implemented.");
  }

  sqlCreateNewSequence(name: string): string {
    throw new NotImplementedError('Need to code');
  }

  sqlSelectExistingTables(tableNames: string[]): string {
    throw new NotImplementedError('Need to code');
  }

  sqlSelectTablesExists(tableNames: string[]): string {
    throw new NotImplementedError('Need to code');
  }

  sqlSelectNextSequence(names: string[]): string {
    throw new NotImplementedError('Need to code');
  }

  sqlSelectLastSequence(names: string[]): string {
    throw new Error("Method not implemented.");
  }

  sqlSelectSequenceByName(name: string): string {
    throw new Error("Method not implemented.");
  }

  sqlSelectForeignKey(tablename1, columnname1, tablename2, columnname2, ondelete): string {
    throw new Error("Method not implemented.");
  }

  sqlSelectAllForeignKeys(tableNames: string[], schemaName?: string): string {
    throw new Error("Method not implemented.");
  }

  sqlSelectTableExists(tableName): string {
    throw new Error("Method not implemented.");
  }
}

