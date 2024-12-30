import ast from 'abstract-syntax-tree';
import { ValueError } from '../helper/errors';
import { safeEval } from './save_eval';
/**
 * Safely evaluate an expression node or a string containing a Javascript
    expression.  The string or node provided may only consist of the following
    literal structures: strings, bytes, numbers, tuples, lists, dicts,
    sets, booleans, and None.
 * @param nodeOrString 
 * @returns 
 */
export function literalEval(nodeOrString) {
  if (typeof(nodeOrString) === 'string') {
    try {
      nodeOrString = safeEval(nodeOrString);//, mode='eval')
    } catch(e) {
      console.warn('Error eval "%s"', nodeOrString);
      throw e;
    }
  }
  return nodeOrString;
}

export function astParse(source: any) {  
  let expr;
  try {
    expr = 'const __astParse__ = ' + source.trim();
    expr = ast.parse(expr).body[0];
    expr = expr['declarations'][0];
    expr = expr['init'];
  } catch(e) {
    throw new ValueError("Invalid expression: %s", source);
  }

  if (typeof(expr) !== 'object') {
    throw new ValueError("Non-dict expression");
  }
  if (expr.properties && !expr.properties.every(prop => prop.key !== 'Literal')) {
    throw new ValueError("Non-string literal dict key");
  }
  return expr;
}