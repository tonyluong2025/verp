import { setattr } from "../api";
import { DefaultDict2 } from "../helper/collections";
import { getArgumentNames, isInstance } from "./func";
import { isList } from "./iterable";
import { unsafeEval } from "./save_eval";
import { f } from "./utils";

export function logOrmCacheStats(sig?: any, frame?: any) {
  console.warn('Not implemented');
}

/**
 * Statistic counters for cache entries.
 */
class OrmcacheCounter {
  hit: number;
  miss: number;
  err: number;

  constructor() {
    this.hit = 0;
    this.miss = 0;
    this.err = 0;
  }

  get ratio() {
    return 100.0 * this.hit / (this.hit + this.miss | 1);
  }
}

const STAT = new DefaultDict2(() => new OrmcacheCounter());

/**
 * LRU cache decorator for model methods.
    The parameters are strings that represent expressions referring to the
    signature of the decorated method, and are used to compute a cache key::

      @ormcache('modelName', 'mode')
      async _compute(modelName, mode="read") {
        ...
      }
    Methods implementing this decorator should never return a Recordset,
    because the underlying cursor will eventually be closed and throw a
    error.
 */
class Ormcache extends Function {
  params: any[];
  method: Function;
  key: Function;

  constructor(params: any[]) {
    super();
    this.params = params;
  }

  /**
   * Determine the function that computes a cache key from arguments.
   */
  determineKey() {
    // build a string that represents function code and evaluate it
    const args = getArgumentNames(this.method);
    let code;
    if (isList(this.params)) {
      code = f("async (self, %s) => [%s]", args.join(','), this.params.join(','));
    }
    else {
      code = f("async (self, %s) => []", args.join(','));
    }
    this.key = unsafeEval(code);
  }

  lru(model) {
    const counter = STAT[String([model.pool.dbName, model._name, this.method.name])];
    return [model.pool.__cache, String([model._name, this.method.name]), counter];
  }

  async lookup(model, ...args: any[]) {
    const [cache, key0, counter] = this.lru(model);
    const key1 = await this.key(model, ...args);
    const sKey = (key0 + '@' + key1).slice(0,256);
    try {
      if (cache.has(sKey)) {
        const result = cache.get(sKey);
        counter.hit += 1;
        // console.log('hit', this.method.name, key, counter.hit, '=', result);
        return result;
      }
      else {
        counter.miss += 1;
        // console.log('miss', this.method.name, key, counter.miss);
        const val = await this.method.apply(model, args);
        cache.set(sKey, val);
        return cache.get(sKey);
      }
    } catch (e) {
      if (isInstance(e, TypeError)) {
        console.warn("cache lookup error on %s. %s", sKey, e.message);
        counter.err += 1;
        return this.method.apply(model, args);
      }
      else {
        throw e;
      }
    }
  }

  /**
   * Clear the registry cache
   * @param model 
   * @param args 
   */
  clear(model, ...args: any[]) {
    model.pool._clearCache();
  }
}

class OrmcacheContext extends Ormcache {
  keys: string[];

  constructor(params: any[]) {
    super(params);
    this.keys = [];
  }
  /**
   * Determine the function that computes a cache key from arguments.
   */
  determineKey() {
    // build a string that represents function code and evaluate it
    const args = getArgumentNames(this.method);
    const ctxExpr = args.includes('context') ? "(context || {})" : "self._context";
    if (isList(this.params[this.params.length - 1])) {
      this.keys = this.params.pop();
    }
    const keysExpr = f("...%s.map(k => %s[k])", this.keys, ctxExpr);
    let code;
    if (isList(this.params)) {
      code = f("async (self, %s) => [%s, %s]", args.join(','), this.params.join(','), keysExpr);
    }
    else {
      code = f("async (self, %s) => [%s]", args.join(','), keysExpr);
    }
    this.key = unsafeEval(code);
  }
}

export function ormcache(...args: any[]) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    if (global.ormcache) {
      const cacher = new Ormcache(args);
      cacher.method = descriptor.value;
      cacher.determineKey();
      const wrapper = async function () {
        return cacher.lookup(this, ...arguments); // this => ModelBase object
      }
      setattr(wrapper, 'name', cacher.method.name);
      setattr(wrapper, 'clearCache', cacher.clear);
      descriptor.value = wrapper;
    };
  }
}

export function ormcacheContext(...args: any[]) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    if (global.ormcacheContext) {
      const cacher = new OrmcacheContext(args);
      cacher.method = descriptor.value;
      cacher.determineKey();
      const wrapper = async function () {
        return cacher.lookup(this, ...arguments); // this => ModelBase object
      }
      setattr(wrapper, 'name', cacher.method.name);
      setattr(wrapper, 'clearCache', cacher.clear);
      descriptor.value = wrapper;
    }
  };
}

/**
 * Decorator for a conditionally applied decorator.
    Example:
        @conditional(getConfig('useCache'), ormcache)
        async fn() {
            //
        }
 * @param condition 
 * @param decorator 
 * @returns 
 */
export function conditional(condition, decorator) {
  if (condition) {
    return decorator;
  }
  else {
    return (fn) => fn;
  }
}