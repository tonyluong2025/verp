import assert from "assert";
import { isAsyncFunction } from "util/types";
import { delattr, getattr, hasattr, setattr } from "../api/func";

export function resetAll(obj: any) {
  const list = Object.getOwnPropertyNames(obj).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(obj))).filter(name => !name.startsWith('__'));
  for (const name of list) {
    const key = '__lazy__' + name;
    if (hasattr(obj, key)) {
      delattr(obj, key);
    }
  }
}

export function define(...args) {
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    assert(!(propertyKey.startsWith('__')), 'Lazy property does not support mangled names');
    const originalFunc = descriptor.value ?? descriptor.get;
    const wrapperSync = function (...args: any[]) {
      const key = '__lazy__' + propertyKey;
      if (hasattr(this, key)) {
        return getattr(this, key);
      }
      const value = originalFunc.apply(this, args);
      setattr(this, key, value);
      return value;
    }
    const wrapperAsync = async function (...args: any[]) {
      const key = '__lazy__' + propertyKey;
      if (hasattr(this, key)) {
        return getattr(this, key);
      }
      const value = await originalFunc.apply(this, args);
      setattr(this, key, value);
      return value;
    }
    const wrapper = isAsyncFunction(originalFunc) ? wrapperAsync : wrapperSync;
    setattr(wrapper, 'name', originalFunc.name);
    if (descriptor.value) {
      descriptor.value = wrapper;
    }
    if (descriptor.get) {
      descriptor.get = wrapper;
    }
  }
}