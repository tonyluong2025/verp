import { MultiDict } from ".";
import { getattr, setattr, setdefault } from "../api/func";
import { isInstance } from "../tools/func";
import { isIterable } from "../tools/iterable";

class _Missing {
  toString() {
    return "no value"
  }
}

const _missing = new _Missing();

type indexType = string | number | symbol | null;

class UpdateDictMixin extends Function {
  [index: indexType]: any; // Will reset

  onupdate: Function;

  constructor() {
    super();
    setattr(this, 'onupdate', null, {enumerable: false, configurable: true});

    return new Proxy(this, {
      set(target, prop, value, receiver) {
        if (target.onupdate) {
          target.onupdate(target);
        }
        return Reflect.set(target, prop, value);
      },
      deleteProperty(target, prop) {
        if (target.onupdate) {
          target.onupdate(target);
        }
        return Reflect.deleteProperty(target, prop);
      },
    });
  }

  get(key: indexType, value?: any): any {
    return this[key] !== undefined ? this[key] : value;
  }

  set(key: indexType, value: any) {
    this[key] = value;
  }

  setdefault(key, value?: any) {
    const modified = !(key in this);
    const rv = setdefault(this, key, value);
    if (modified && this.onupdate) {
      const self: any = this;
      this.onupdate(self);
    }
    return rv;
  }

  pop(key, value?: any) {
    const modified = key in this;
    const rv = getattr(this, key, value);
    Reflect.deleteProperty(this, key);
    if (modified && this.onupdate) {
      const self: any = this;
      this.onupdate(self);
    }
    return rv;
  }

  popitem() {
    const keys = Object.keys(this);
    const key = keys[keys.length - 1];
    if (this.onupdate) {
      const self: any = this;
      this.onupdate(self);
    }
    return [key, this.pop(key)];
  }

  update(key, value: any) {
    const modified = key in this;
    Reflect.set(this, key, value);
    if (modified && this.onupdate) {
      const self: any = this;
      this.onupdate(self);
    }
    return value;
  }

  clear() {
    for (const key of Object.keys(this)) {
      Reflect.deleteProperty(this, key);
    }
    if (this.onupdate) {
      const self: any = this;
      this.onupdate(self);
    }
  }
}

export class CallbackDict extends UpdateDictMixin {
  constructor() {
    super();
  }

  init(initial={}, onupdate?: any) {
    Object.assign(this, initial);
    setattr(this, 'onupdate', onupdate, {enumerable: false, configurable: true});
  }

  toString(): string {
    return this.constructor.name;
  }
}

/**
 * Iterates over the items of a mapping yielding keys and values
    without dropping any from more complex structures.
 * @param mapping 
 */
export function *iterMultiItems(mapping) {
  if (isInstance(mapping, MultiDict)) {
    for (const item of mapping.entries()) {
      yield item;
    }
  }
  else if (isInstance(mapping, Object)) {
    for (const [key, value] of Object.entries<any>(mapping)) {
      if (isIterable(value)) {
        for (const val of value) {
          yield [key, val];
        }
      }
      else {
        yield [key, value];
      }
    }
  }
  else {
    for (const item of mapping) {
      yield item;
    }
  }
}