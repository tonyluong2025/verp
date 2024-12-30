import { ValueError } from "../helper/errors";
import { isIterable } from "./iterable";

/**
 * New function with partial application of the given arguments and keywords.
 * @param func 
 * @param args 
 * @returns 
 */
export function partial(func: Function, ...args: any[]): Function {
  if (!isCallable(func)) {
    throw new TypeError("the first argument must be callable");
  }
  return (...rest: any[]) => func(...args, ...rest);
}

export async function doWith(obj, func) {
  if (typeof obj !== 'object') {
    return func();
  }
  if (isCallable(obj['__enter__'])) {
    await obj['__enter__'].call(obj);
  }
  let err;
  try {
    await func();
  } catch(e) {
    err = e;
  }
  if (isCallable(obj['__exit__'])) {
    await obj['__exit__'].call(obj, err);
  }    
}

export function doWithSync(obj, func) {
  if (typeof obj !=='object') {
    return func();
  }
  if (isCallable(obj['__enter__'])) {
    obj['__enter__'].call(obj);
  }
  let err;
  try {
    func();
  } catch(e) {
    err = e;
  }
  if (isCallable(obj['__exit__'])) {
    obj['__exit__'].call(obj, err);
  }   
}

export function isCallable(obj: any) {
  return typeof obj === 'function';
}

export function isObject(obj: any) {
  return typeof obj === "object" ? obj !== null : typeof obj === "function";
}

export function isInstance(obj: any, ...classes: any[]) {
  if (!classes?.length) {
    return false;
  }
  const list = Array.from(classes);
  const cls = list.shift();
  return (obj instanceof cls) || list.some((c) => obj instanceof c);
}

export function isBasestring(tag: any) {
  return isInstance(tag, Uint8Array) || typeof(tag) === 'string'
}

/**
 * 
 * @param obj 
 * @returns tuple
 * Class    => ['class', parent name, name]
 * Function => ['function', 'Function', name]
 * Instance => ['instance', class name, null]
 */ 
export function getType(obj) {
  const name = obj.constructor.name;
  if (name === 'Function') {
    const pro = Object.getPrototypeOf(obj).name;
    if (pro) {
      return ['class', pro, obj.name];
    } else {
      return ['function', 'Function', obj.name];
    }
  }
  else if (name === 'Object') {
    return ['instance', 'Object', null];
  }
  else {
    return ['instance', name, null]
  }
}

export function isUndefined(x) {
  return x === undefined;
}

export function isNull(x) {
  return x === null;
}

export function isFalse(x: any) {
  return !x;// => undefined/null/false/0/''
}

export function isNone(x: any) {
  return x == undefined;// or == null
}

export function isSymbol(x) {
  return typeof x === "symbol";
}

export function isAlpha(x) {
  return x ? String(x).match(/^[a-z0-9]+$/i) != null : false;
}

export function isDigit(x) {
  return x ? String(x).match(/^[0-9]+$/i) != null : false;
}

export function escapeJson(str: string='') {
  return str.replace(/(?:['])([^@\.'`][^"'`]*)(?:['])/g, `"$1"`);
}

export function escapeQuote(str: string='') {
  return str.replace(/(?:["])([^@\."`][^"'`]*)(?:["])/g, `'$1'`);
}

/**
 * Translate Set(s) to List(s) because JSON can not understand Set 
 * @param obj 
 * @param deep 
 * @returns 
 */
export function fixJson(obj: any, deep=0): any {
  if (obj === undefined) {
    return 'undefined';
  }
  if (obj === null) {
    return 'null';
  }
  if (typeof obj !== 'object') {
    return obj;
  }
  if (deep++ >= 10) {
    return `<Object: deep=${deep}>`;
  }
  if (isIterable(obj)) {
    const o = [];
    for (const entry of obj) {
      o.push(fixJson(entry, deep));
    }
    return o;
  } else {
    const o: any = {};
    for (const [key, value] of Object.entries<any>(obj)) {
      o[key] = fixJson(value, deep);
    }
    return o;
  }
}

export function getValue(obj: any): any {
  if (obj == undefined) // or null, null is a special object
    return obj;
  if (Array.isArray(obj)) 
    return Array.from(obj)
  if (obj instanceof Set) 
    return new Set(obj)
  if (obj instanceof Map) 
    return new Map(obj)
  if (typeof obj === 'object') 
    return Object.create(obj)
  else // primitive: number, string, boolean, class/function
    return obj;
}

export function parseInt(value: any, base=10, raiseIfError=false) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : parseInt(String(value));
  }
  const str = String(value);
  if (['true', 'false'].includes(str)) {
    return str === 'true' ? 1 : 0;
  }
  const res = Number.parseInt(str, base);
  if (!isNaN(res)) {
    return res;
  }
  if (!raiseIfError) {
    return 0;
  } else {
    throw Error(`invalid ${str} for parseInt() with base ${base}`);
  }
}

export function int(obj: any): number {
  if (typeof obj === 'object' || typeof obj === 'function') {
    if (typeof obj['_int'] === 'function') {
      return obj._int();
    }
  }
  return parseInt(obj);
}

export function parseFloat(value, raiseIfError=false) {
  const str = String(value);
  const res = Number.parseFloat(str);
  if (!isNaN(res)) {
    return res;
  }
  if (!raiseIfError) {
    return 0.0;
  } else {
    throw new ValueError('invalid %s for parseFloat()', str);
  }
}

export function stringPart(str: string, sub: string): [string, string, string] {
  var index = str.indexOf(sub);  // Gets the first index where a sub occours
  if (index < 0) {
    return [str, '', ''];
  } 
  return [str.substring(0, index), sub, str.substring(index + sub.length)];
}

export function rstringPart(str: string, sub: string): [string, string, string] {
  var index = str.lastIndexOf(sub);  // Gets the last index where a space occours
  if (index < 0) {
    return ['', '', str]; 
  }
  return [str.substring(0, index), sub, str.substring(index + sub.length)];
}

export const rpartition = rstringPart;

export function split(str: string, sep: string=' ', num: number=1): string[] {
  const split = str.split(sep);
  const last = split.slice(num).join(sep);
  return num ? split.slice(0, num).concat(last ? [last] : []) : split;
}

export function rsplit(str: string, sep: string=' ', num: number=1): string[] {
  const split = str.split(sep);
  const last = split.slice(0, -num).join(sep);
  return num ? (last ? [last] : []).concat(split.slice(-num)) : split;
}

export function removeQuotes(value: string, quotes=`"'`) {
  if (value.slice(0,1) === value.slice(-1) && quotes.includes(value[0])) {
    value = value.slice(1,-1);
  }
  return value;
}

export function escapeRegExp(text: string) {
  return text ? text.replace(/[[\]{}()*+?./,^$|#\s\t\n\r\v\f]/g, '\$&') : text;
}

const _MAX = 3;

/**
 * An alternative of _.isEqual
 * @param a 
 * @param b 
 * @param m 
 * @returns 
 */
export function equal(a, b, m=0) {
  if (m >= _MAX) return true;
  m++;
  if (a === b) return true;

  if (a && b && typeof a == 'object') {//} && typeof b == 'object') {
    // if (a.constructor !== b.constructor) return false;
    if (typeof a.eq === 'function') return a.eq(b); // ModelRecords or NewId
    
    var length, i, keys;
    if (Array.isArray(a)) {
      length = a.length;
      if (length != b.length) return false;
      for (i = length; i-- !== 0;) {
        if (!equal(a[i], b[i], m)) return false;
      }
      return true;
    }

    if ((a instanceof Map) && (b instanceof Map)) {
      if (a.size !== b.size) return false;
      for (i of a) {
        if (!b.has(i[0])) return false;
      }
      for (i of a) {
        if (!equal(i[1], b.get(i[0]), m)) return false;
      }
      return true;
    }

    if ((a instanceof Set) && (b instanceof Set)) {
      if (a.size !== b.size) return false;
      for (i of a.entries()) {
        if (!b.has(i[0])) return false;
      }
      return true;
    }

    if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) {
      length = a.buffer.byteLength;
      if (length != b.buffer.byteLength) return false;
      for (i = length; i-- !== 0;) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
    if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
    if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();

    keys = Object.keys(a);
    length = keys.length;
    if (length !== Object.keys(b).length) return false;

    for (i = length; i-- !== 0;) {
      if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
    }

    for (i = length; i-- !== 0;) {
      var key = keys[i];
      if (key === '_owner' && a.$$typeof) {
        // React-specific: avoid traversing React elements' _owner.
        //  _owner contains circular references
        // and is not needed when comparing the actual elements (and not their owners)
        continue;
      }
      if (!equal(a[key], b[key], m)) return false;
    }

    return true;
  }

  // true if both NaN, false otherwise
  return a!==a && b!==b;
};

export function ellipsis(text: string, size: number, chars: string='...') {
  if (text.length > size) {
    return text.slice(0, size - chars.length) + chars;
  }
  return text;
}

export function getArgumentNames(func) {
	// String representation of the function code
	let str = func.toString();

	// Remove comments of the form /* ... */
	// Removing comments of the form //
	// Remove body of the function { ... }
	// removing '=>' if func is arrow function 
	str = str.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/(.)*/g, '')
		.replace(/{[\s\S]*}/, '')
		.replace(/=>/g, '')
		.trim();

	// Start parameter names after first '('
	let start = str.indexOf("(") + 1;

	// End parameter names is just before last ')'
	let end = str.length - 1;

	let result = str.substring(start, end).split(", ");

	let params = [];

	result.forEach(element => {
		// Removing any default value
		// element = element.replace(/=[\s\S]*/g, '').trim();
		if (element.length > 0) {
			params.push(element);
    }
	});

	return params;
}

export async function replaceAsync(str, regex, asyncFn) {
  const promises = [];
  str.replace(regex, (match, ...args) => {
    const promise = asyncFn(match, ...args);
    promises.push(promise);
  });
  const data = await Promise.all(promises);
  return str.replace(regex, () => data.shift());
}