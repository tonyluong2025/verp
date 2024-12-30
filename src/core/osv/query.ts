import assert from "assert";
import crc32 from 'crc-32';
import _ from 'lodash';
import utf8 from 'utf8';
import { Cursor } from "../sql_db";
import { extend } from "../tools/iterable";
import { _convert$, _f } from "../tools/utils";
import * as lazy from "../tools";

/**
 * Generate a standard table alias name. An alias is generated as following:
  - the base is the source table name (that can already be an alias)
  - then, the joined table is added in the alias using a 'link field name'
    that is used to render unique aliases for a given path
  - the name is shortcut if it goes beyond PostgreSQL's identifier limits

  Examples:
  - srcTableAlias='resUsers', link='parentId'
      alias = 'resUsers__parentId'

 * @param srcTableAlias alias of the source table
 * @param link field name 
 * @returns alias
 */
export function _generateTableAlias(srcTableAlias: string, link: string): string {
    let alias = `${srcTableAlias}__${link}`
    // Use an alternate alias scheme if length exceeds the PostgreSQL limit
    // of 63 characters.
    if (alias.length >= 64) {
        // We have to fit a crc32 hash and one underscore into a 63 character
        // alias. The remaining space we can use to add a human readable prefix.
      alias = `${alias.slice(0,54)}_${crc32.str(utf8.encode(alias)).toString(16).padStart(8, '0')}`;
    }
    return alias;
}

export class Query {
  _cr: Cursor
  _query: any; //AbstractQueryInterface
  _tables: Record<string, any>;
  _joins: Record<string, any>;
  _whereClauses: any[];
  _whereParams: any[];
  order: any;
  limit: any;
  offset: any;
  
  constructor(cr: Cursor, alias: string, table?: string) {
    // database cursor
    this._cr = cr;
    this._query = cr._obj.getQueryInterface();

    // tables {alias: table}
    this._tables = {[alias]: table ?? alias};

    // joins {alias: [kind, table, condition, conditionParams]}
    this._joins = {};

    // holds the list of WHERE clause elements (to be joined with 'AND'), and
    // the list of parameters
    this._whereClauses = [];
    this._whereParams = [];

    // order, limit, offset
    this.order = null;
    this.limit = null;
    this.offset = null;
  }

  addTable(alias: string, table?: string) {
    assert(!this._tables[alias] && !this._joins[alias], `Alias ${alias} already in ${this}}`);
    this._tables[alias] = table ?? alias;
  }

  addWhere(whereClause, whereParams=[]) {
    this._whereClauses.push(whereClause);
    this._whereParams = extend(this._whereParams, whereParams);
  }

  @lazy.define()
  async result(): Promise<any> {
    const [sql, params] = this.select();
    const [res] = await this._cr.query(_convert$(sql), {bind: params});
    return res;
  }

  async *[Symbol.asyncIterator] () {
    const res = await this.result();
    for (const row of res) {
      yield row['id'];
    }
  }

  async getIds() {
    const ids = [];
    for await (const id of this) {
      ids.push(id)
    }
    return ids;
  }

  _join(kind: string, lhsAlias: string, lhsColumn: string, rhsTable: string, rhsColumn: string, link: string, options?: {extra?: string, extraParams?: string[]}): string {
    assert (lhsAlias in this._tables || lhsAlias in this._joins, `Alias ${lhsAlias} not in ${this}`);

    const rhsAlias = _generateTableAlias(lhsAlias, link);
    assert (!(rhsAlias in this._tables), `Alias ${rhsAlias} already in ${this}`);

    const extra = options?.extra;
    const extraParams = options?.extraParams;
    if (!(rhsAlias in this._joins)) {
      let condition = `"${lhsAlias}"."${lhsColumn}" = "${rhsAlias}"."${rhsColumn}"`;
      let conditionParams = [];
      if (extra) {
        condition = condition + " AND " + this._format(extra, {lhs: lhsAlias, rhs: rhsAlias});
        conditionParams = extraParams;
      }
      if (kind) {
        this._joins[rhsAlias] = [kind, rhsTable, condition, conditionParams];
      }
      else {
        this._tables[rhsAlias] = rhsTable;
        this.addWhere(condition, conditionParams);
      }
    }
    return rhsAlias;
  }

  leftJoin(lhsAlias: string, lhsColumn: string, rhsTable: string, rhsColumn: string, link: string, options?: {extra?: string, extraParams?: string[]}): string {
    return this._join('LEFT JOIN', lhsAlias, lhsColumn, rhsTable, rhsColumn, link, options);
  }

  select(...args: string[]): [any, any] {
    const gen: any = this._cr._obj.getQueryInterface().queryGenerator;
    const tables = (args?.length 
      ? args 
      : Object.keys(this._tables).map((k) => `${gen.quoteIdentifiers(k)}.id`)
    ).join(', ');
    const [fromClause, whereClause, params] = this.getSql();
    const sql = `SELECT ${tables} FROM ${fromClause} WHERE ${whereClause ? whereClause : "TRUE"}${this.order ? ' ORDER BY ' + this.order : ''}${this.limit ? ' LIMIT ' + `${this.limit}` : ''}${this.offset ? ' OFFSET ' + `${this.offset}` : ''}`;
    return [sql, params];
  }

  /**
   * Similar to method `.select`, but for sub-queries. This one avoids the ORDER BY clause when possible.
   * @param args 
   * @returns 
   */
  subselect(...args: string[]) {
    if (this.limit || this.offset) {
      // in this case, the ORDER BY clause is necessary
      return this.select(...args);
    }
    const gen: any = this._cr._obj.getQueryInterface().queryGenerator;
    const tables = (args?.length 
      ? args 
      : Object.keys(this._tables).map((k) => `${gen.quoteIdentifiers(k)}.id`)
    ).join(', ');
    const [fromClause, whereClause, params] = this.getSql();
    const queryStr = _f('SELECT {tables} FROM {from} WHERE {where}', {
      'tables': tables,
      'from': fromClause,
      'where': whereClause || "TRUE",
    })
    return [queryStr, params];
  }

  getSql(): [string, string, any[]] {
    // postgres: SELECT "irModel".id FROM "irModel" WHERE true
    // mysql: SELECT `irModel`.id FROM `irModel` WHERE true
    const tables = Object.entries(this._tables).map(([alias, table]) => this._fromTable(table, alias));
    const joins = [];
    let params = [];
    for (const [alias, [kind, table, condition, conditionParams]] of Object.entries(this._joins)) {
      joins.push(`${kind} ${this._fromTable(table, alias)} ON (${condition})`);
      params = extend(params, conditionParams);
    }
    const fromClause = _.union([tables.join(', ')], joins).join(' ');
    const whereClause = this._whereClauses.join(' AND ');
    return [fromClause, whereClause, [...params, ...this._whereParams]];
  }

  _fromTable(table: any, alias: string): string {
    const gen: any = this._cr._gen;
    if (alias === table) {
      return `${gen.quoteIdentifiers(alias)}`;
    } else if (IDENT_RE.test(table)) {
      return `${gen.quoteIdentifiers(table)} AS ${gen.quoteIdentifiers(alias)}`;
    } else {
      return `(${table}) AS ${gen.quoteIdentifiers(alias)}`;
    }
  }

  _format(str: string, replacements: Record<string, any>): string {
    return str.replace(
      /{\w+}/g,
      (all) => replacements[all.substring(1, all.length-1)] || all
    );
  }

  get whereClause() {
    return this._whereClauses;
  }
}

const IDENT_RE = /^[a-z_][a-z0-9_$]*$/i;