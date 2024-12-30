import { ValueError } from '../helper/errors';
import { Dict } from './../helper/collections';
import { astParse } from './ast';

function _getAttrsSymbols() {
  return [
    'true', 'false', 'null',
    'this',
    'self',
    'id',
    'uid',
    'context',
    'contextToday',
    'activeId',
    'activeIds',
    'allowedCompanyIds',
    'currentCompanyId',
    'activeModel',
    'time',
    'datetime',
    'relativedelta',
    'currentDate',
    'today',
    'now',
    'abs',
    'len',
    'bool',
    'float',
    'string',
    'unicode',
  ]
}

/**
 * Check that the given string or AST node represents a dict expression
    where all keys are string literals, and return it as a dict mapping string
    keys to the AST of values.
 * @param expr 
 * @returns 
 */
export function getDictAsts(expr: any): Dict<any> {
  if (typeof(expr) === 'string') {
    expr = astParse(expr);
  }

  const res = new Dict<any>();
  for (const prop of expr.properties) {
    res[prop.key.value] = prop.value;
  }
  return res;
}

/**
 * Return the subexpressions of the kind "VARNAME(.ATTNAME)*" in the given
  string or AST node.
 * @param expr 
 * @returns 
 */
export function getVariableNames(expr: any) {
  const IGNORED = _getAttrsSymbols();
  const names = [];

  function getNameSeq(node) {
    if (node.type === 'VariableDeclarator') {
      return [node.id.name];
    }
    else if (node.type === 'ExpressionStatement') {
      const left = getNameSeq(node.expression.object);
      return left && left.concat([node.property.name]);
    } else {
      return [];
    }
  }

  function process(node) {
    if (node?.type == null) {
      return;
    }
    const seq = getNameSeq(node);
    if (seq.length && !IGNORED.includes(seq[0])) {
      names.push(seq.join('.'));
    }
    else {
      for (const elem of node.elements ?? []) {
        process(elem);
      }
    }
  }

  if (typeof(expr) === 'string') {
    expr = astParse(expr);
  }
  
  process(expr);

  return names;
}

function _check(condition, explanation) {
  if (! condition) {
    throw new ValueError("Expression is not a valid domain: %s", explanation);
  }
}

/**
 * Check that the given string or AST node represents a domain expression,
  and return a pair of sets `'[fields, vars]'` where `'fields'` are the field
  names on the left-hand side of conditions, and `'vars'` are the variable
  names on the right-hand side of conditions.
 * @param expr 
 * @returns 
 */
export function getDomainIdentifiers(expr) {
  if (! expr) { // case of expr=""
    return [[], []];
  }
  if (typeof(expr) === 'string') {
    expr = astParse(expr);
  }

  const fnames = new Set<string>();
  const vnames = new Set<string>();

  if (expr.type === 'ArrayExpression') {
    for (const elem of expr.elements) {
      if (elem.type === 'Literal') {
        // note: this doesn't check the and/or structure
        _check(['&', '|', '!'].includes(elem.value),
          `logical operators should be '&', '|', or '!', found ${elem.value}`);
        // continue;
      }
      else if (elem.type === 'ArrayExpression') {
        _check(elem.elements.length == 3,
          `segments should have 3 elements, found ${elem.elements.length}: ${elem.elements}`)

        const [lhs, operator, rhs] = elem.elements;
        _check(operator.type === 'Literal',
          `operator should be a string, found ${operator.type}`);
        if (lhs.type === 'Literal') {
          fnames.add(lhs.value);
        }
      }
    }
  }

  getVariableNames(expr).forEach(name => vnames.add(name));

  return [[...fnames], [...vnames]];
}

const _validators = new Dict();

export function validView(arch, kwargs={}) {
  for (const pred of (_validators[arch.tagName] ?? [])) {
    const check = pred(arch, kwargs)
    if (!check) {
      console.error("Invalid XML: %s", pred.__doc__)
      return false
    }
    if (check === "Warning") {
      console.warn("Invalid XML: %s", pred.__doc__)
      return "Warning"
    }
  }
  return true
}

/**
 * Registers a view-validation function for the specific view types
 * @param viewTypes 
 * @returns 
 */
export function validate(...viewTypes: any[]) {
  return (target: any, propertyName: string, descriptor: PropertyDescriptor) => {
    for (const arch of viewTypes) {
      _validators[arch] = _validators[arch] || [];
      _validators[arch].push(descriptor.value);
    }
  }
}

