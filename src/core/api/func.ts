import { format } from "util";
import { KeyError } from "../helper/errors";
import { isCallable, isInstance, isObject } from "../tools/func";
import { len } from "../tools/iterable";
import { pop } from "../tools/misc";

export function setattr(obj: any, attr: number | string | symbol, value: any, options?: {
  writable?: boolean,
  enumerable?: boolean,
  configurable?: boolean,
  get?: Function, // null to remove get() # undefined
  set?: Function, // null to remove set() # undefined
}): any {
  if (!isCallable(obj) && !isObject(obj)) {
    return undefined;
  }
  let des: any;
  try {
    des = Object.getOwnPropertyDescriptor(obj, attr);
    des.value = value;
  } catch (e) {
    des = {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true
    };
  }
  if (options) {
    des = {};
    if (options.enumerable !== undefined) des.enumerable = options.enumerable;
    if (options.configurable !== undefined) des.configurable = options.configurable;
    if (options.get !== undefined) des.get = options.get === null ? undefined : options.get;
    if (options.set !== undefined) des.set = options.set === null ? undefined : options.set;
    if (options.get === undefined && options.set === undefined) {
      des.value = value;
      des.writable = options.writable;
    }
  }
  try {
    Object.defineProperty(obj, attr, des);
    return des.value;
  } catch (e) {
    console.log(`Error set ${obj?.constructor?.name}.${attr.toString()}=${value} ${e}`);
    return undefined;
  }
}

export function setdefault(obj: any, attr: number | string | symbol, value?: any, options?: {
  writable?: boolean,
  enumerable?: boolean,
  configurable?: boolean,
  get?: Function, // null to remove get() # undefined
  set?: Function, // null to remove set() # undefined
}): any {
  const defaultValue = getattr(obj, attr, null);
  if (defaultValue !== null) {
    return defaultValue;
  } else {
    setattr(obj, attr, value, options);
    return value;
  }
}

export function getattr(obj: any, attr: number | string | symbol, value?: any): any {
  try {
    const des: any = Object.getOwnPropertyDescriptor(obj, attr);
    if (des) {
      return des.value;
    } else {
      if (value === undefined) {
        throw new KeyError('%s has not attr "%s"', obj?.name || obj?.constructor?.name, attr);
      }
      return value;
    }
  } catch (e) {
    if (value === undefined) {
      throw new KeyError('%s has not attr "%s"', obj?.name, attr);
    }
    return value;
  }
}

export function hasattr(obj: any, attr: string | symbol): boolean {
  return (typeof obj === 'object' || typeof obj === 'function') && obj.hasOwnProperty(attr);
}

export function delattr(obj: any, attr: string) {
  return Reflect.deleteProperty(obj, attr);
}

export function discardattr(obj: any, attr: string) {
  if (obj.hasOwnProperty(attr)) {
    delete obj[attr];
  }
}

export function attrgetter(...items: string[]) {
  return new AttrGetter(items[0], ...items.slice(1));
}

/**
 * Return a callable object that fetches the given attribute(s) from its operand.
    After f = attrgetter('name'), the call f(r) returns r.name.
    After g = attrgetter('name', 'date'), the call g(r) returns (r.name, r.date).
    After h = attrgetter('name.first', 'name.last'), the call h(r) returns
    (r.name.first, r.name.last).
 * @param items 
 * @returns 
 */
class AttrGetter extends Function {
  private _attrs: string[];
  private _call: Function;

  constructor(attr: string, ...attrs: string[]) {
    super();
    if (attrs == null) {
      if (typeof attr !== 'string') {
        throw new TypeError('attribute name must be a string');
      }
      this._attrs = [attr];
    } else {
      this._attrs = [attr].concat(attrs);
    }
    this._call = _attrgetter(...this._attrs);
    return new Proxy(this, {
      apply(target, thisArg, args) {
        return target._call(args[0]);
      },
    });
  }

  toString() {
    return format('%s(%s)', this.name, this._attrs.join(', '));
  }

  valueOf() {
    return this.toString();
  }
}

function _attrgetter(...items: string[]) {
  if (items.length == 1) {
    return (obj: any) => resolveAttr(obj, items[0]);
  } else {
    return (obj: any) => items.map((attr) => resolveAttr(obj, attr));
  }
}

function resolveAttr(obj: any, attr: string) {
  for (const name of attr.split('.')) {
    obj = getattr(obj, name);
  }
  return obj;
}

/**
 * @enumerable decorator that sets the enumerable property of a class field to false.
 * @param value true|false
 */
export function enumerable(value: boolean) {
  return function (target: any, propertyKey: string) {
    let descriptor = Object.getOwnPropertyDescriptor(target, propertyKey) || {};
    if (descriptor.enumerable != value) {
      descriptor.enumerable = value;
      descriptor.writable = true;
      Object.defineProperty(target, propertyKey, descriptor);
    }
  };
}

export function deprecated(deprecationReason: string) {
  return (target: any, memberName: string, propertyDescriptor: PropertyDescriptor) => {
    return {
      get() {
        const wrapperFn = (...args: any[]) => {
          console.warn(`Method ${memberName} is deprecated with reason: ${deprecationReason}`);
          propertyDescriptor.value.apply(this, args)
        }
        Object.defineProperty(this, memberName, {
          value: wrapperFn,
          configurable: true,
          writable: true
        });
        return wrapperFn;
      }
    }
  }
}

/**
 * Convert `'value'` returned by `'method'` on `'self'` to traditional style.
 * @param method 
 * @param value 
 * @param self 
 * @param kwargs 
 * @returns 
 */
export function downgrade(method, value, self, args: any[] = [], kwargs: {} = {}) {
  const spec = getattr(method, '_returns', null);
  if (!spec) {
    return value;
  }
  const convert = spec[1];
  if (convert) {
    return convert.call(self, value, ...args, kwargs);
  }
  else {
    return value.ids;
  }
}

export function splitArgs(args: any[]): [any[], {}] {
  args = Array.from(args);
  const kwargs = {};
  const lastIndex = args.length - 1;
  if (typeof (args[lastIndex]) === 'object') {
    Object.assign(kwargs, args.pop());
  }
  return [args, kwargs];
}

/**
 * Extract the context from a pair of positional and keyword arguments.
  Return a triple `'context, args, kwargs'`.
 * @param method 
 * @param args 
 * @param kwargs 
 */
function splitContext(args, kwargs) {
  // altering kwargs is a cause of errors, for instance when retrying a request
  // after a serialization error: the retry is done without context!
  kwargs = Object.assign({}, kwargs);
  return [pop(kwargs, 'context', {}), args, kwargs];
}

async function _callKwModel(method: Function, self: any, args: any[] = [], kwargs: {} = {}) {
  let context;
  [context, args, kwargs] = splitContext(args, kwargs);
  const recs = await self.withContext(context ?? {});
  method = recs[method.name];
  const result = await method.call(recs, ...args, kwargs);
  return downgrade(method, result, recs, args, kwargs);
}

async function _callKwModelCreate(method: Function, self: any, args: any[] = [], kwargs: {} = {}) {
  let context;
  [context, args, kwargs] = splitContext(args, kwargs);
  const recs = await self.withContext(context ?? {});
  method = recs[method.name];
  const result = await method.call(recs, ...args, kwargs);
  return isInstance(args[0], Array) ? result.ids : result.id;
}

async function _callKwMulti(method: Function, self: any, args: any[] = [], kwargs: {} = {}) {
  const ids = args.shift();
  let context;
  [context, args, kwargs] = splitContext(args, kwargs);
  const recs = (await self.withContext(context ?? {})).browse(ids);
  method = recs[method.name];
  const result = await method.call(recs, ...args, kwargs);
  return downgrade(method, result, recs, args, kwargs);
}

/**
 * Invoke the given method `'name'` on the recordset `'model'`.
 * @param model 
 * @param name 
 * @param kwargs 
 * @returns 
 */
export async function callKw(model, methodName: string, args: any[], kwargs: {}) {
  const method = model[methodName];
  const api = getattr(method, '_api', null);
  let result;
  if (api === 'model') {
    result = await _callKwModel(method, model, args, kwargs);
  }
  else if (api === 'modelCreate') {
    result = await _callKwModelCreate(method, model, args, kwargs);
  }
  else {
    result = await _callKwMulti(method, model, args, kwargs);
  }
  await model.flush();
  return result;
}

export function mro(cls: any, rebuild: boolean = false, type: string = 'origin'): any[] {
  let res = _mro(cls, rebuild);
  if (type === 'origin') {
    res = res.filter(c => getattr(c, 'isVirtual', false) === false);
  }
  else if (type === 'proxy') {
    res = res.filter(c => getattr(c, 'isVirtual', false) === true);
  }
  return res;
}

function _mro(cls: any, rebuild: boolean = false): any[] {
  let res = [];
  if (rebuild || !cls.hasOwnProperty('__mro__')) {
    const parent = Object.getPrototypeOf(cls);
    const bases = len(cls.__bases) ? cls.__bases : ['Object', 'Function', ''].includes(parent.name) ? [] : [parent];
    res = [...bases];
    for (const pro of bases) {
      for (const p of _mro(pro, rebuild)) {
        if (!res.includes(p)) {
          res.push(p);
        }
      }
    }
    res.unshift(cls);
    setattr(cls, '__mro__', res);
  }
  return cls.__mro__;
}