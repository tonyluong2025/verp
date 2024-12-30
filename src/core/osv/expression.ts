import assert from "assert";
import _ from "lodash";
import util from 'util';
import * as core from '..';
import { Field } from '..';
import { Dict } from '../helper/collections';
import { NotImplementedError, ValueError } from '../helper/errors';
import { BaseModel, ModelRecords } from '../models';
import { Cursor } from '../sql_db';
import { bool } from "../tools/bool";
import { toText } from '../tools/compat';
import { isInstance, split } from "../tools/func";
import { isIterable } from "../tools/iterable";
import { stringify } from "../tools/json";
import { setOptions } from "../tools/misc";
import { f } from "../tools/utils";
import { Query, _generateTableAlias } from "./query";

export type Token = [string | number, string, any];

export const TRUE_LEAF: Token = [1, '=', 1];
export const FALSE_LEAF: Token = [0, '=', 1];

export const TRUE_DOMAIN = [TRUE_LEAF];
export const FALSE_DOMAIN = [FALSE_LEAF];

const NOT_OPERATOR = '!';
const OR_OPERATOR = '|';
const AND_OPERATOR = '&';
const DOMAIN_OPERATORS = [NOT_OPERATOR, OR_OPERATOR, AND_OPERATOR];
const TERM_OPERATORS = ['=', '!=', '<=', '<', '>', '>=', '=?', '=like', '=ilike', 'like', 'not like', 'ilike', 'not ilike', 'in', 'not in', 'childof', 'parentof', 'childOf', 'parentOf'];
export const NEGATIVE_TERM_OPERATORS = ['!=', 'not like', 'not ilike', 'not in'];
const DOMAIN_OPERATORS_NEGATION = {
  [AND_OPERATOR]: OR_OPERATOR,
  [OR_OPERATOR]: AND_OPERATOR,
}
export const TERM_OPERATORS_NEGATION = {
  '<': '>=',
  '>': '<=',
  '<=': '>',
  '>=': '<',
  '=': '!=',
  '!=': '=',
  'in': 'not in',
  'like': 'not like',
  'ilike': 'not ilike',
  'not in': 'in',
  'not like': 'like',
  'not ilike': 'ilike',
}

export function isTrueLeaf(token: any[]) {
  return token.length === 3 &&
    token.every((element, index) => element === TRUE_LEAF[index]);
}

export function isFalseLeaf(token: any[]) {
  return token.length === 3 &&
    token.every((element, index) => element === FALSE_LEAF[index]);
}

/**
 * Return whether `'domain'` is logically equivalent to false. 
 * use three-valued logic: -1 is false, 0 is unknown, +1 is true
 * @param model 
 * @param domain 
 */
export function isFalse(model, domain) {
  const stack: number[] = [];
  const list = normalizeDomain(domain);
  for (let i = list.length - 1; i >= 0; i--) {
    const token = list[i];
    if (token === '&') {
      stack.push(Math.min(stack.pop(), stack.pop()));
    } else if (token === '|') {
      stack.push(Math.max(stack.pop(), stack.pop()));
    } else if (token === '!') {
      stack.push(-stack.pop());
    } else if (isTrueLeaf(token)) {
      stack.push(+1);
    } else if (isFalseLeaf(token)) {
      stack.push(-1);
    } else if (token[1] === 'in' && !((token[2] instanceof Query) || token[2])) {
      stack.push(-1);
    } else if (token[1] === 'not in' && !((token[2] instanceof Query) || token[2])) {
      stack.push(+1);
    } else {
      stack.push(0);
    }
  }
  return stack.pop() === -1;
}

export function normalizeDomain(domain: any[]): any[] {
  const isIter = Array.isArray(domain);
  assert(isIter, `Domains "${domain}" to normalize must have a 'domain' form: an array of domain components`);
  if (!domain || !domain.length) {
    return [TRUE_LEAF];
  }
  let result = [];
  let expected = 1;
  const opArity = {
    [NOT_OPERATOR]: 1,
    [AND_OPERATOR]: 2,
    [OR_OPERATOR]: 2
  };
  for (const token of domain) {
    if (expected == 0) {
      result.unshift(AND_OPERATOR);
      expected = 1;
    }
    if (isIterable(token)) {
      expected -= 1;
    } else {
      expected += (opArity[token] || 0) - 1;
    }
    result.push(token);
  }
  assert(expected == 0, `This domain is syntactically not correct: ${domain}`);
  return result;
}

export function AND(domains) {
  return combine(AND_OPERATOR, [TRUE_LEAF], [FALSE_LEAF], domains);
}

export function OR(domains) {
  return combine(OR_OPERATOR, [FALSE_LEAF], [TRUE_LEAF], domains);
}

/**
 * Returns a new domain expression where all domain components from `'domains'`
     have been added together using the binary operator `'operator'`.
     It is guaranteed to return a normalized domain.
 * @param operator 
 * @param unit the identity element of the domains "set" with regard to the operation
                  performed by `'operator'`, i.e the domain component `'i'` which, when
                  combined with any domain `'x'` via ``operator``, yields `'x'`.
                  E.g. [[1,'=',1]] is the typical unit for AND_OPERATOR: adding it
                  to any domain component gives the same domain.
 * @param zero the absorbing element of the domains "set" with regard to the operation
                  performed by `'operator'`, i.e the domain component `'z'` which, when
                  combined with any domain `'x'` via `'operator'`, yields `'z'`.
                  E.g. [[1,'=',1]] is the typical zero for OR_OPERATOR: as soon as
                  you see it in a domain component the resulting domain is the zero.
 * @param domains a list of normalized domains.
 */
export function combine(operator, unit, zero, domains) {
  let result = []
  let count = 0
  if (_.isEqual(domains, [unit])) {
    return unit;
  }
  for (const domain of domains) {
    if (_.isEqual(domain, unit)) {
      continue;
    }
    if (_.isEqual(domain, zero)) {
      return zero;
    }
    if (domain?.length) {
      result = result.concat(normalizeDomain(domain));
      count += 1;
    }
  }
  result = _.fill(Array(Math.max(count - 1, 0)), operator).concat(result);
  return result.length ? result : unit
}

/**
 * Distribute any '!' domain operators found inside a normalized domain.

  Because we don't use SQL semantic for processing a 'left not in right'
  query (i.e. our 'not in' is not simply translated to a SQL 'not in'),
  it means that a '! left in right' can not be simply processed
  by __leaf_to_sql by first emitting code for 'left in right' then wrapping
  the result with 'not (...)', as it would result in a 'not in' at the SQL
  level.

  This function is thus responsible for pushing any '!' domain operators
  inside the terms themselves. For example::

     ['!','&',['userId','=',4],['partnerId','in',[1,2]]]
        will be turned into:
     ['|',['userId','!=',4],['partnerId','not in',[1,2]]]

  This is an iterative version of a recursive function that split domain
  into subdomains, processes them and combine the results. The "stack" below
  represents the recursive calls to be done.
 * @param domain 
 * @returns 
 */
export function distributeNot(domain) {
  const result = [];
  const stack = [false];

  for (const token of domain) {
    const negate = stack.pop();
    // negate tells whether the subdomain starting with token must be negated
    if (isLeaf(token)) {
      if (negate) {
        const [left, operator, right] = token;
        if (operator in TERM_OPERATORS_NEGATION) {
          if (isTrueLeaf(token) || isFalseLeaf(token)) {
            result.push(isTrueLeaf(token) ? FALSE_LEAF : TRUE_LEAF);
          } else {
            result.push([left, TERM_OPERATORS_NEGATION[operator], right]);
          }
        } else {
          result.push(NOT_OPERATOR);
          result.push(token);
        }
      } else {
        result.push(token);
      }
    }
    else if (token === NOT_OPERATOR) {
      stack.push(!negate);
    }
    else if (token in DOMAIN_OPERATORS_NEGATION) {
      result.push(negate ? DOMAIN_OPERATORS_NEGATION[token] : token);
      stack.push(negate);
      stack.push(negate);
    }
    else {
      result.push(token);
    }
  }
  return result;
}


function _quote(toQuote: string): string {
  if (!toQuote.includes('"')) {
    return `"${toQuote}"`;
  }
  return toQuote;
}

function normalizeLeaf(element: any): any {
  if (!isLeaf(element)) {
    return element;
  }
  let [left, operator, right] = element;
  const original = operator;
  operator = operator.toLowerCase();
  if (operator === '<>') {
    operator = '!=';
  }
  if (typeof right === 'boolean' && ['in', 'not in'].includes(operator)) {
    console.warn("The domain term '%s,%s,%s' should use the '=' or '!=' operator.", left, original, right);
    operator = operator === 'in' ? '=' : '!=';
  }
  if (Array.isArray(right) && ['=', '!='].includes(operator)) {
    console.warn("The domain term '%s,%s,%s' should use the 'in' or 'not in' operator.", left, original, right);
    operator = operator === '=' ? 'in' : 'not in';
  }
  return [left, operator, right];
}

/**
 * Test whether an object is a valid domain operator.
 * @param element 
 * @returns 
 */
function isOperator(element) {
  return typeof (element) === 'string' && DOMAIN_OPERATORS.includes(element);
}

/**
 * Test whether an object is a valid domain term:
    - is a list or tuple
    - with 3 elements
    - second element if a valid op
    Note: OLD TODO change the share wizard to use this function.
 * @param element a leaf in form [left, operator, right]
 * @param internal allow or not the 'inselect' internal operator
        in the term. This should be always left to false.
 * @returns 
 */
function isLeaf(element: any[], internal = false) {
  let INTERNAL_OPS = [...TERM_OPERATORS, '<>'];
  if (internal) {
    INTERNAL_OPS = INTERNAL_OPS.concat('inselect', 'not inselect');
  }
  let res: any = (Array.isArray(element)
    && element.length === 3
    && INTERNAL_OPS.includes(element[1]));
  if (res) {
    res = (typeof element[0] === 'string') && element[0];
    if (!res) {
      res = isTrueLeaf(element) || isFalseLeaf(element);
    }
  }
  return res;
}

function isBoolean(element) {
  return isTrueLeaf(element) || isFalseLeaf(element);
}

function checkLeaf(element, internal = false) {
  const isO = isOperator(element);
  const isL = isLeaf(element, internal);
  if (!isO && !isL) {
    throw new ValueError(`Invalid leaf "${stringify(element)}"`);
  }
}

export async function getUnaccentWrapper(cr: Cursor): Promise<Function> {
  if ((await core.registry(cr.dbName)).hasUnaccent) {
    return (x: any) => `unaccent(${x})`;
  }
  return (x: any) => x;
}

export class Expression {
  _unaccent: any;
  query: Query;
  rootModel: ModelRecords;
  rootAlias: any;
  expression: any;
  domain: [];
  result: any;

  private constructor(domain, model: ModelRecords, alias?: string, query?: Query, tableQuery?: string) {
    this.rootModel = model;
    this.rootAlias = alias ?? model.cls._table;
    this.domain = domain;
    // this object handles all the joins
    this.query = query == null ? new Query(model.env.cr, model.cls._table, tableQuery) : query;
  }

  static async new(domain, model: any, alias?: string, query?: Query) {
    const tableQuery = await model.tableQuery();
    const exp = new Expression(domain, model, alias, query, tableQuery);
    await exp.init();
    return exp;
  }

  async init() {
    this._unaccent = await getUnaccentWrapper(this.rootModel._cr);

    // normalize and prepare the expression for parsing
    this.expression = distributeNot(normalizeDomain(this.domain));

    // parse the domain expression
    await this.parse();
    return this;
  }

  /**
   * Transform the leaves of the expression

    The principle is to pop elements from a leaf stack one at a time.
    Each leaf is processed. The processing is a if/elif list of various
    cases that appear in the leafs (many2one, function fields, ...).
    Three things can happen as a processing result:
    - the leaf is a logic operator, and updates the result stack
      accordingly;
    - the leaf has been modified and/or new leafs have to be introduced
      in the expression; they are pushed into the leaf stack, to be
      processed right after;
    - the leaf is converted to SQL and added to the result stack

    Here is a suggested execution:

        step                stack               result_stack

                            ['&', A, B]         []
        substitute B        ['&', A, B1]        []
        convert B1 in SQL   ['&', A]            ["B1"]
        substitute A        ['&', '|', A1, A2]  ["B1"]
        convert A2 in SQL   ['&', '|', A1]      ["B1", "A2"]
        convert A1 in SQL   ['&', '|']          ["B1", "A2", "A1"]
        apply operator OR   ['&']               ["B1", "A1 or A2"]
        apply operator AND  []                  ["(A1 or A2) and B1"]

    Some internal var explanation:
        :var list path: left operand seen as a sequence of field names
            ("foo.bar" -> ["foo", "bar"])
        :var obj model: model object, model containing the field
            (the name provided in the left operand)
        :var obj field: the field corresponding to `path[0]`
        :var obj column: the column corresponding to `path[0]`
        :var obj comodel: relational model of field (field.comodel)
            (resPartner.bankIds -> res.partner.bank)
   * @param self 
   * @returns 
   */
  async parse() {
    const [cr, uid, context, su] = this.rootModel.env.args;

    /**
     * Normalize a single id or name, or a list of those, into a list of ids
      :param {int,long,basestring,list,tuple} value:
          if int, long -> return [value]
          if basestring, convert it into a list of basestrings, then
          if list of basestring ->
              perform a nameSearch on comodel for each name
              return the list of related ids
     * @param value 
     * @param comodel 
     * @param leaf 
     * @returns 
     */
    async function toIds(value, comodel: ModelRecords, leaf): Promise<any[]> {
      let names = [];
      if (typeof value === 'string') {
        names = [value];
      }
      else if (value && Array.isArray(value) && value.every(item => typeof item === 'string')) {
        names = value;
      }
      else if (typeof value === 'number') {
        if (!value) {
          // given this nonsensical domain, it is generally cheaper to
          // interpret false as [], so that "X childOf false" will
          // match nothing
          console.warn("Unexpected domain [%s], interpreted as false", leaf);
          return [];
        }
        return [value];
      }
      if (names.length) {
        const res = [];
        for (const name of names) {
          const rids = await comodel._nameSearch(name, [], 'ilike', { limit: null });
          for (const rid of rids) {
            res.push(rid);
          }
        }
        return res;
      }
      return Array.from<any>(value);
    }

    /**
     * Return a domain implementing the childOf operator for [[left,childOf,ids]],
        either as a range using the parent_path tree lookup field
        (when available), or as an expanded [[left,in,child_ids]]
     * @param left 
     * @param ids 
     * @param leftModel 
     * @param parent 
     * @param prefix 
     * @returns 
     */
    async function childOfDomain(left, ids, leftModel, options: { parent?: any, prefix?: string } = {}): Promise<any[]> {
      setOptions(options, { prefix: '' });
      let domain;
      if (!ids?.length) {
        return [FALSE_LEAF];
      }
      const model = (await leftModel.sudo()).browse(ids);
      if (leftModel.cls._parentStore) {
        domain = OR(
          await Promise.all(await model.map(async rec => [['parentPath', '=like', await rec.parentPath + '%']]))
        );
      }
      else {
        // recursively retrieve all children nodes with sudo(); the
        // filtering of forbidden records is done by the rest of the
        // domain
        const parentName = options.parent ?? leftModel.cls._parentName;
        let childIds = new Set<number>();
        let records = model;
        while (records.ok) {
          records._ids.forEach(id => childIds.add(id));
          records = await records.search([[parentName, 'in', records.ids]], { order: 'id' });
        }
        domain = [['id', 'in', Array.from(childIds)]];
      }
      if (options.prefix) {
        return [[left, 'in', await leftModel._search(domain, { order: 'id' })]];
      }
      return domain;
    }

    /**
     * Return a domain implementing the parent_of operator for [[left,parentOf,ids]],
      either as a range using the parent_path tree lookup field
      (when available), or as an expanded [[left,in,parentIds]]
     * @param left 
     * @param ids 
     * @param leftModel 
     * @param parent 
     * @param prefix 
     * @returns 
     */
    async function parentOfDomain(left, ids, leftModel, options: { parent?: any, prefix?: string } = {}): Promise<any[]> {
      setOptions(options, { prefix: '' });
      let domain;
      if (!ids?.length) {
        return [FALSE_LEAF];
      }
      const model = (await leftModel.sudo()).browse(ids);
      if (leftModel.cls._parentStore) {
        const parentIds = [];
        for (const rec of model) {
          for (const label of (await rec.parentPath).split('/').slice(0, -1)) {
            parentIds.push(parseInt(label));
          }
        }
        domain = [['id', 'in', parentIds]];
      }
      else {
        // recursively retrieve all parent nodes with sudo() to avoid
        // access rights errors; the filtering of forbidden records is
        // done by the rest of the domain
        const parentName = options.parent ?? leftModel.cls._parentName;
        let parentIds = [];
        let records = model;
        while (records.ok) {
          parentIds = parentIds.concat(records._ids);
          records = await records[parentName];
        }
        domain = [['id', 'in', parentIds]];
      }
      if (options.prefix) {
        return [[left, 'in', await leftModel._search(domain, { order: 'id' })]];
      }
      return domain;
    }

    const HIERARCHY_FUNCS = { 'childof': childOfDomain, 'parentof': parentOfDomain }

    /**
     * Pop a leaf to process.
     * @returns 
     */
    function pop(): [string | Token, ModelRecords, string] {
      return stack.pop();
    }

    /**
     * Push a leaf to be processed right after.
     * @param leaf 
     * @param model 
     * @param alias 
     * @param internal 
     */
    function push(leaf: string | Token, model: ModelRecords, alias: string, internal = false) {
      leaf = normalizeLeaf(leaf);
      checkLeaf(leaf, internal);
      stack.push([leaf, model, alias]);
    }

    function popResult(): [string, any[]] {
      return resultStack.pop();
    }

    function pushResult(query, params) {
      resultStack.push([query, params]);
    }

    // process domain from right to left; stack contains domain leaves, in
    // the form: (leaf, corresponding model, corresponding table alias)
    const stack: [string | Token, ModelRecords, string][] = [];
    for (const leaf of this.expression) {
      push(leaf, this.rootModel, this.rootAlias);
    }

    // stack of SQL expressions in the form: (expr, params)
    const resultStack: [string, any[]][] = [];

    while (stack.length) {
      // Get the next leaf to process
      let [leaf, model, alias] = pop();

      // ----------------------------------------
      // SIMPLE CASE
      // 1. leaf is an operator
      // 2. leaf is a true/false leaf
      // -> convert and add directly to result
      // ----------------------------------------

      if (isOperator(leaf)) {
        if (leaf === NOT_OPERATOR) {
          const [expr, params] = popResult();
          pushResult(`(NOT (${expr}))`, params);
        } else {
          const ops = { [AND_OPERATOR]: '(%s AND %s)', [OR_OPERATOR]: '(%s OR %s)' };
          const [lhs, lhsParams] = popResult();
          const [rhs, rhsParams] = popResult();
          pushResult(util.format(ops[leaf as string], lhs, rhs), [...lhsParams, ...rhsParams]);
        }
        continue;
      }
      if (isBoolean(leaf)) {
        const [expr, params] = await this.__leafToSql(leaf, model, alias);
        pushResult(expr, params);
        continue;
      }
      // Get working variables
      let [left, operator, right] = leaf;
      const path = split(left, '.', 1);

      const field = model._fields.get(path[0]);
      const comodel = field.comodelName ? model.env.items(field.comodelName) : null;

      // ----------------------------------------
      // FIELD NOT FOUND
      // -> from inherits'd fields -> work on the related model, and add
      //    a join condition
      // -> ('id', 'childOf', '..') -> use a 'to_ids'
      // -> but is one on the _log_access special fields, add directly to
      //    result
      //    TODO: make these fields explicitly available in self.columns instead!
      // -> else: crash
      // ----------------------------------------

      if (!field) {
        throw new ValueError("Invalid field %s.%s in leaf %s", model.cls._name, path[0], leaf);
      }
      else if (field.inherited) {
        const parentModel = model.env.items(field.relatedField.modelName);
        const parentFname = model.cls._inherits[parentModel.cls._name];
        const parentAlias = this.query.leftJoin(
          alias, parentFname, parentModel.cls._table, 'id', parentFname,
        );
        push(leaf, parentModel, parentAlias);
      }
      else if (left === 'id' && operator in HIERARCHY_FUNCS) {
        const ids2 = await toIds(right, model, leaf);
        const dom = await HIERARCHY_FUNCS[operator](left, ids2, model);
        for (const domLeaf of dom) {
          push(domLeaf, model, alias);
        }
      }
      // ----------------------------------------
      // PATH SPOTTED
      // -> many2one or one2many with _autojoin:
      //    - add a join, then jump into linked column: column.remaining on
      //      src_table is replaced by remaining on dst_table, and set for re-evaluation
      //    - if a domain is defined on the column, add it into evaluation
      //      on the relational table
      // -> many2one, many2many, one2many: replace by an equivalent computed
      //    domain, given by recursively searching on the remaining of the path
      // -> note: hack about columns.property should not be necessary anymore
      //    as after transforming the column, it will go through this loop once again
      // ----------------------------------------

      else if (path.length > 1 && field.store && field.type === 'many2one' && field.autojoin) {
        // res_partner.stateId = res_partner__state_id.id
        const coalias = this.query.leftJoin(
          alias, path[0], comodel.cls._table, 'id', path[0],
        );
        push([path[1], operator, right], comodel, coalias);
      }
      else if (path.length > 1 && field.store && field.type === 'one2many' && field.autojoin) {
        // use a subquery bypassing access rules and business logic
        const domain = [[path[1], operator, right]].concat(await field.getDomainList(model));
        const query = await (await comodel.withContext(field.context))._whereCalc(domain);
        const [subquery, subparams] = query.select(`"${comodel.cls._table}"."${field.relationField}"`);
        push(['id', 'inselect', [subquery, subparams]], model, alias, true);
      }
      else if (path.length > 1 && field.store && field.autojoin) {
        throw new NotImplementedError('autojoin attribute not supported on field %s', field);
      }
      else if (path.length > 1 && field.store && field.type === 'many2one') {
        const rightIds = await (await comodel.withContext({ activeTest: false }))._search([[path[1], operator, right]], { order: 'id' });
        push([path[0], 'in', rightIds], model, alias);
      }
      // Making search easier when there is a left operand as one2many or many2many
      else if (path.length > 1 && field.store && ['many2many', 'one2many'].includes(field.type)) {
        const rightIds = await (await comodel.withContext(field.context))._search([[path[1], operator, right]], { order: 'id' });
        push([path[0], 'in', rightIds], model, alias);
      }
      else if (!field.store) {
        // Non-stored field should provide an implementation of search.
        let domain;
        if (!field.search) {
          // field does not support search!
          console.error("Non-stored field %s cannot be searched.", field);
          // if (_logger.isEnabledFor(logging.DEBUG))
          //   _logger.debug(''.join(traceback.format_stack()))
          // Ignore it: generate a dummy leaf.
          domain = [];
        } else {
          // Let the field generate a domain.
          if (path.length > 1) {
            right = await comodel._search([[path[1], operator, right]], { order: 'id' });
            operator = 'in';
          }
          domain = await field.determineDomain(model, operator, right);
          await model._flushSearch(domain, { order: 'id' });
        }
        for (const elem of normalizeDomain(domain)) {
          push(elem, model, alias, true);
        }
      }
      // -------------------------------------------------
      // RELATIONAL FIELDS
      // -------------------------------------------------

      // Applying recursivity on field(one2many)
      else if (field.type === 'one2many' && operator in HIERARCHY_FUNCS) {
        const ids2 = await toIds(right, comodel, leaf);
        let dom;
        if (field.comodelName != model.cls._name) {
          dom = HIERARCHY_FUNCS[operator](left, ids2, comodel, { prefix: field.comodelName });
        }
        else {
          dom = HIERARCHY_FUNCS[operator]('id', ids2, model, { parent: left });
        }
        for (const domLeaf of dom) {
          push(domLeaf, model, alias);
        }
      }
      else if (field.type === 'one2many') {
        const domain = await field.getDomainList(model);
        const inverseField = comodel._fields[field.relationField];
        const inverseIsInt = ['integer', 'many2oneReference'].includes(inverseField.type);
        const unwrapInverse = inverseIsInt ? (ids => ids) : (recs => recs.ids);

        if (right !== false) {
          // determine ids2 in comodel
          let ids2;
          if (typeof right === 'string') {
            const op2 = [NEGATIVE_TERM_OPERATORS.includes(operator) ? TERM_OPERATORS_NEGATION[operator] : operator];
            ids2 = await comodel._nameSearch(right, domain ?? [], op2, { limit: null });
          }
          else if (isIterable(right)) {
            ids2 = right;
          }
          else {
            ids2 = [right];
          }
          if (inverseIsInt && bool(domain)) {
            ids2 = await comodel._search([['id', 'in', ids2], ...domain], { order: 'id' });
          }

          if (inverseField.store) {
            // In the condition, one must avoid subqueries to return
            // NULL values, since it makes the IN test NULL instead
            // of FALSE.  This may discard expected results, as for
            // instance "id NOT IN (42, NULL)" is never TRUE.
            const in_ = NEGATIVE_TERM_OPERATORS.includes(operator) ? 'NOT IN' : 'IN';
            let subquery, subparams;
            if (isInstance(ids2, Query)) {
              if (!inverseField.required) {
                ids2.addWhere(`"${comodel.cls._table}"."${inverseField.name}" IS NOT NULL`);
              }
              [subquery, subparams] = ids2.subselect(`"${comodel.cls._table}"."${inverseField.name}"`);
              pushResult(`("${alias}"."id" ${in_} (${subquery}))`, subparams);
            } else {
              subquery = `SELECT "${inverseField.name}" FROM "${comodel.cls._table}" WHERE "id" IN (%s)`;
              if (!inverseField.required) {
                subquery += ` AND "${inverseField.name}" IS NOT NULL`;
              }
              subparams = bool(ids2) ? ids2.join(',') : null;
              pushResult(f(`("${alias}"."id" ${in_} (${subquery}))`, subparams), []);
            }
          } else {
            // determine ids1 in model related to ids2
            const recs = await (await comodel.browse(ids2).sudo()).withContext({ prefetchFields: false });
            const ids1 = unwrapInverse(await recs.mapped(inverseField.name));
            // rewrite condition in terms of ids1
            const op1 = NEGATIVE_TERM_OPERATORS.includes(operator) ? 'not in' : 'in';
            push(['id', op1, ids1], model, alias);
          }

        } else {
          if (inverseField.store && !(inverseIsInt && bool(domain))) {
            // rewrite condition to match records with/without lines
            const op1 = NEGATIVE_TERM_OPERATORS.includes(operator) ? 'inselect' : 'not inselect';
            const subquery = `SELECT "${inverseField.name}" FROM "${comodel.cls._table}" WHERE "${inverseField.name}" IS NOT NULL`;
            push(['id', op1, [subquery, []]], model, alias, true);
          } else {
            let comodelDomain = [[inverseField.name, '!=', false]];
            if (inverseIsInt && bool(domain)) {
              comodelDomain = comodelDomain.concat(domain);
            }
            const recs = await (await (await comodel.search(comodelDomain, { order: 'id' })).sudo()).withContext({ prefetchFields: false });
            // determine ids1 = records with lines
            const ids1 = unwrapInverse(await recs.mapped(inverseField.name));
            // rewrite condition to match records with/without lines
            const op1 = NEGATIVE_TERM_OPERATORS.includes(operator) ? 'in' : 'not in';
            push(['id', op1, ids1], model, alias);
          }
        }
      }
      else if (field.type === 'many2many') {
        const [relTable, relId1, relId2] = [field.relation, field.column1, field.column2];
        let relAlias;
        if (operator in HIERARCHY_FUNCS) {
          // determine ids2 in comodel
          let ids2 = await toIds(right, comodel, leaf);
          const domain = await HIERARCHY_FUNCS[operator]('id', ids2, comodel);
          ids2 = await comodel._search(domain, { order: 'id' });

          // rewrite condition in terms of ids2
          if (comodel === model) {
            push(['id', 'in', ids2], model, alias);
          } else {
            relAlias = _generateTableAlias(alias, field.name);
            console.warn('Not fix');
            pushResult(`
              EXISTS (
                SELECT 1 FROM "${relTable}" AS "${relAlias}"
                WHERE "${relAlias}"."${relId1}" = "${alias}".id
                AND "${relAlias}"."${relId2}" IN (%s)
              )
            `, ids2 ? [[...ids2].join(',')] : [null]);
          }
        }

        else if (right !== false) {
          let ids2, termId2, params;
          // determine ids2 in comodel
          if (typeof right === 'string') {
            const domain = await field.getDomainList(model);
            const op2 = NEGATIVE_TERM_OPERATORS.includes(operator) ? TERM_OPERATORS_NEGATION[operator] : operator;
            ids2 = await comodel._nameSearch(right, bool(domain) ? domain : [], op2, { limit: null });
          }
          else if (isIterable(right)) { //collections.abc.Iterable))
            ids2 = right;
          }
          else {
            ids2 = [right];
          }

          if (isInstance(ids2, Query)) {
            // rewrite condition in terms of ids2
            const [subquery, params] = ids2.subselect();
            termId2 = `(${subquery})`;
          }
          else {
            // rewrite condition in terms of ids2
            termId2 = "%s";
            const _ids2 = ids2.filter(it => it);
            params = _ids2.length ? _ids2 : [null];
          }
          const exists = NEGATIVE_TERM_OPERATORS.includes(operator) ? 'NOT EXISTS' : 'EXISTS';
          relAlias = _generateTableAlias(alias, field.name);
          pushResult(`
            ${exists} (
              SELECT 1 FROM "${relTable}" AS "${relAlias}"
              WHERE "${relAlias}"."${relId1}" = "${alias}".id
              AND "${relAlias}"."${relId2}" IN (${termId2})
            )
          `, params);
        }

        else {
          // rewrite condition to match records with/without relations
          const exists = NEGATIVE_TERM_OPERATORS.includes(operator) ? 'EXISTS' : 'NOT EXISTS';
          relAlias = _generateTableAlias(alias, field.name);
          pushResult(`
            ${exists} (
              SELECT 1 FROM "${relTable}" AS "${relAlias}"
              WHERE "${relAlias}"."${relId1}" = "${alias}".id
            )
          `, []);
        }
      }
      else if (field.type === 'many2one') {
        if (operator in HIERARCHY_FUNCS) {
          const ids2 = await toIds(right, comodel, leaf);
          let dom;
          if (field.comodelName != model.cls._name) {
            dom = await HIERARCHY_FUNCS[operator](left, ids2, comodel, { prefix: field.comodelName });
          }
          else {
            dom = await HIERARCHY_FUNCS[operator]('id', ids2, model, { parent: left });
          }
          for (const domLeaf of dom) {
            push(domLeaf, model, alias);
          }
        } else {
          // eslint-disable-next-line no-inner-declarations
          async function _getExpression(comodel, left, right, operator): Promise<Token> {
            // #Special treatment to ill-formed domains
            operator = ['<', '>', '<=', '>='].includes(operator) && 'in' || operator;

            const dictOp = { 'not in': '!=', 'in': '=', '=': 'in', '!=': 'not in' }
            if ((!Array.isArray(right)) && ['not in', 'in'].includes(operator)) {
              operator = dictOp[operator];
            }
            else if (Array.isArray(right) && ['!=', '='].includes(operator)) { // for domain (FIELD,'=',['value1','value2'])
              operator = dictOp[operator];
            }
            let resIds = await (await comodel.withContext({ activeTest: false }))._nameSearch(right, [], operator, { limit: null });
            if (NEGATIVE_TERM_OPERATORS.includes(operator)) {
              resIds = resIds.concat([false]);  // TODO this should not be appended if false was in 'right'
            }
            return [left, 'in', resIds];
          }
          // resolve string-based m2o criterion into IDs
          if (typeof right === 'string' || (Array.isArray(right) && bool(right) && right.every((item) => typeof item === 'string'))) {
            push(await _getExpression(comodel, left, right, operator), model, alias);
          } else {
            // right == [] or right == false and all other cases are handled by __leaf_to_sql()
            const [expr, params] = await this.__leafToSql(leaf, model, alias);
            pushResult(expr, params);
          }
        }
      }
      // -------------------------------------------------
      // BINARY FIELDS STORED IN ATTACHMENT
      // -> check for null only
      // -------------------------------------------------
      else if (field.type === 'binary' && field.attachment) {
        if (['=', '!='].includes(operator) && !bool(right)) {
          const inselectOperator = NEGATIVE_TERM_OPERATORS.includes(operator) ? 'inselect' : 'not inselect';
          const subselect = `SELECT "resId" FROM "irAttachment" WHERE "resModel"='%s' AND "resField"=%s`;
          const params = [model.cls._name, left];
          push(['id', inselectOperator, [subselect, params]], model, alias, true);
        } else {
          console.error("Binary field '%s' stored in attachment: ignore %s %s %s", field.string, left, operator, right);
          push(TRUE_LEAF, model, alias);
        }
      }
      // -------------------------------------------------
      // OTHER FIELDS
      // -> datetime fields: manage time part of the datetime
      //    column when it is not there
      // -> manage translatable fields
      // -------------------------------------------------
      else {
        if (field.type === 'datetime' && bool(right)) {
          if (typeof right === 'string' && right.length === 10) {
            if (['>', '<='].includes(operator)) {
              right += ' 23:59:59';
            }
            else {
              right += ' 00:00:00';
            }
            push([left, operator, right], model, alias);
          }
          else if (isInstance(right, Date)) {
            right = right.toISOString();
            push([left, operator, right], model, alias);
          }
          else {
            const [expr, params] = await this.__leafToSql(leaf, model, alias);
            pushResult(expr, params);
          }
        } else if (field.translate === true && bool(right)) {
          const needWildcard = ['like', 'ilike', 'not like', 'not ilike'].includes(operator);
          const sqlOperator = new Dict<string>({ '=like': 'like', '=ilike': 'ilike' }).get(operator, operator);
          if (needWildcard) {
            right = `%${right}%`;
          }
          if (['in', 'not in'].includes(sqlOperator)) {
            right = [right];
          }

          const unaccent = sqlOperator.endsWith('like') ? this._unaccent : (x) => x;

          left = unaccent(model._generateTranslatedField(alias, left, this.query));
          const instr = unaccent('%s');
          pushResult(`${left} ${sqlOperator} ${instr}`, [right]);
        } else {
          const [expr, params] = await this.__leafToSql(leaf, model, alias);
          pushResult(expr, params);
        }
      }
    }
    // ----------------------------------------
    // END OF PARSING FULL DOMAIN
    // -> put result in self.result and self.query
    // ----------------------------------------

    [this.result] = resultStack;
    const [whereClause, whereParams] = this.result;
    this.query.addWhere(whereClause, whereParams);
  }

  async __leafToSql(leaf, model, alias): Promise<[string, any[]]> {
    let query, params;
    let [left, operator, right] = leaf;

    // final sanity checks - should never fail
    assert([...TERM_OPERATORS, 'inselect', 'not inselect'].includes(operator),
      `Invalid operator ${operator} in domain term ${leaf}`
    )
    assert(isTrueLeaf(leaf) || isFalseLeaf(leaf) || left in model._fields,
      `Invalid field ${left} in domain term ${leaf}`
    )
    assert(!isInstance(right, BaseModel),
      `Invalid value ${right} in domain term ${leaf}`
    )

    const tableAlias = `"${alias}"`;

    if (isTrueLeaf(leaf)) {
      query = 'TRUE';
      params = [];
    }

    else if (isFalseLeaf(leaf)) {
      query = 'FALSE';
      params = [];
    }

    else if (operator === 'inselect') {
      query = `(${tableAlias}."${left}" in (${right[0]}))`;
      params = right[1];
    }

    else if (operator === 'not inselect') {
      query = `(${tableAlias}."${left}" not in (${right[0]}))`;
      params = right[1];
    }

    else if (['in', 'not in'].includes(operator)) {
      // Two cases: right is a boolean or a list. The boolean case is an
      // abuse and handled for backward compatibility.
      if (typeof right === 'boolean') {
        console.warn("The domain term '%s' should use the '=' or '!=' operator.", leaf);
        if ((operator === 'in' && right) || (operator === 'not in' && !right)) {
          query = `(${tableAlias}."${left}" IS NOT NULL)`;
        }
        else {
          query = `(${tableAlias}."${left}" IS NULL)`;
        }
        params = [];
      }
      else if (isInstance(right, Query)) {
        const [subquery, subparams] = right.subselect();
        query = `(${tableAlias}."${left}" ${operator} (${subquery}))`;
        params = subparams;
      }
      else if (Array.isArray(right)) {
        let checkNull, instr;
        if (model._fields[left].type === "boolean") {
          params = [true, false].filter(it => right.includes(it));
          checkNull = right.includes(false);
        }
        else {
          params = right.filter(it => it !== false);
          checkNull = params.length < right.length;
        }
        if (params?.length) {
          if (left === 'id') {
            instr = _.fill(Array(params.length), '%s').join(',');
          }
          else {
            const field = model._fields[left] as Field;
            instr = _.fill(Array(params.length), field.columnFormat).join(',');
            const _params = [];
            for (const p of params) {
              _params.push(await field.convertToColumn(p, model, null, false));
            }
            params = _params;
          }
          query = `(${tableAlias}."${left}" ${operator} (${instr}))`;
        }
        else {
          // The case for (left, 'in', []) or (left, 'not in', []).
          query = operator === 'in' ? 'FALSE' : 'TRUE';
        }
        if ((operator === 'in' && checkNull) || (operator === 'not in' && !checkNull)) {
          query = `(${query} OR ${tableAlias}."${left}" IS NULL)`;
        }
        else if (operator === 'not in' && checkNull) {
          query = `(${query} AND ${tableAlias}."${left}" IS NOT NULL)`; // needed only for TRUE.
        }
      }
      else {  // Must not happen
        throw new ValueError("Invalid domain term %s", leaf);
      }
    }

    else if ((left in model._fields) && model._fields[left].type === "boolean" && ((operator === '=' && right === false) || (operator === '!=' && right === true))) {
      query = `(${tableAlias}."${left}" IS NULL or ${tableAlias}."${left}" = false )`;
      params = [];
    }

    else if ((right === false || right == null) && (operator === '=')) {
      query = `${tableAlias}."${left}" IS NULL`;
      params = [];
    }

    else if (left in model._fields && model._fields[left].type === "boolean" && ((operator === '!=' && right === false) || (operator === '==' && right === true))) {
      query = `(${tableAlias}."${left}" IS NOT NULL and ${tableAlias}."${left}" != false)`;
      params = [];
    }

    else if ((right === false || right == null) && (operator === '!=')) {
      query = `${tableAlias}."${left}" IS NOT NULL`;
      params = [];
    }

    else if (operator === '=?') {
      if (right === false || right == null) {
        // '=?' is a short-circuit that makes the term TRUE if right is None or false
        query = 'TRUE';
        params = [];
      }
      else {
        // '=?' behaves like '=' in other cases
        [query, params] = await this.__leafToSql([left, '=', right], model, alias);
      }
    }

    else {
      const needWildcard = ['like', 'ilike', 'not like', 'not ilike'].includes(operator);
      const sqlOperator = new Dict<string>({ '=like': 'like', '=ilike': 'ilike' }).get(operator, operator);
      const cast = sqlOperator.endsWith('like') ? '::text' : '';

      if (!(left in model._fields)) {
        throw new ValueError("Invalid field %s in domain term %s", left, leaf);
      }
      const format = needWildcard ? '%s' : model._fields[left].columnFormat;
      const unaccent = sqlOperator.endsWith('like') ? this._unaccent : (x) => x;
      const column = `${tableAlias}.${_quote(left)}`;
      query = `(${unaccent(column + cast)} ${sqlOperator} ${unaccent(format)})`;

      if ((needWildcard && !right) || (right && NEGATIVE_TERM_OPERATORS.includes(operator))) {
        query = `(${query} OR ${tableAlias}."${left}" IS NULL)`;
      }
      if (needWildcard) {
        params = [`%${toText(right)}%`];
      }
      else {
        const field = model._fields[left];
        params = [await field.convertToColumn(right, model, false)];
      }
    }

    return [query, params];
  }
}