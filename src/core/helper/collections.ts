import { setattr } from '../api/func';
import { fixJson } from '../tools/func';
import { isIterable, itemgetter, len, sorted } from '../tools/iterable';
import { KeyError, NotImplementedError } from './errors';

interface IStack<T> {
  push(item: T): void;
  pop(): T | undefined;
  peek(): T | undefined;
  get size(): number;
}

interface IQueue<T> {
  enqueue(item: T): void;
  dequeue(): T | undefined;
  get size(): number;
}

abstract class Collection<T> {
  protected storage: T[] = [];

  get size(): number {
    return this.storage.length;
  }

  abstract isFull(): boolean;
}

export class Stack<T> implements IStack<T> {
  private storage: T[] = [];

  constructor(private capacity: number = Infinity) { }

  push(item: T): void {
    if (this.size === this.capacity) {
      throw Error("Stack has reached max capacity, you cannot add more items");
    }
    this.storage.push(item);
  }

  pop(): T | undefined {
    return this.storage.pop();
  }

  peek(): T | undefined {
    return this.storage[this.size - 1];
  }

  get size(): number {
    return this.storage.length;
  }
}

export class Queue<T> implements IQueue<T> {
  private storage: T[] = [];
  private capacity: number;

  constructor(capacity?: number) {
    this.capacity = capacity ?? Number.MAX_SAFE_INTEGER
  }

  enqueue(...items: T[]): void {
    if (this.size === this.capacity) {
      throw Error("Queue has reached max capacity, you cannot add more items");
    }
    for (const item of items) {
      if (!this.storage.includes(item)) {
        this.storage.push(item);
      }
    }
  }

  dequeue(): T | undefined {
    return this.storage.shift();
  }

  popleft() {
    return this.dequeue();
  }

  clear() {
    while (this.size > 0) {
      this.popleft();
    }
  }

  get size(): number {
    return this.storage.length;
  }

  *[Symbol.iterator]() {
    for (const elem of this.storage) {
      yield elem;
    }
  }
}

export class StackCollection<T> extends Collection<T> implements IStack<T> {
  constructor(private capacity: number = Infinity) {
    super();
  }

  push(item: T) {
    if (this.isFull()) {
      throw Error("Stack has reached max capacity, you cannot add more items");
    }
    // In the derived class, we can access protected properties of the abstract class
    this.storage.push(item);
  }

  pop(): T | undefined {
    return this.storage.pop();
  }

  peek(): T | undefined {
    return this.storage[this.size - 1];
  }

  // Implementation of the abstract method
  isFull(): boolean {
    return this.capacity === this.size;
  }
}

export class QueueCollection<T> extends Collection<T> implements IQueue<T> {
  constructor(private capacity: number = Infinity) {
    super();
  }
  enqueue(item: T): void {
    if (this.isFull()) {
      throw Error("Queue has reached max capacity, you cannot add more items");
    }
    // In the derived class, we can access protected properties of the abstract class
    this.storage.push(item);
  }
  dequeue(): T | undefined {
    return this.storage.shift();
  }

  // Implementation of the abstract method
  isFull(): boolean {
    return this.capacity === this.size;
  }
}

type indexType = string | number | symbol | null;

export class Dict<T = any> {
  [index: indexType]: any;

  constructor(obj?: any) {
    if (obj) {
      Dict.fill<T>(this, obj);
    }
  }

  static from<T>(obj: any): Dict<T> {
    return new Dict<T>(obj);
  }

  static fill<T>(dict: any, obj: any): any {
    if (obj instanceof Map) {
      if (obj.size) {
        for (const [key, value] of obj) {
          dict[key] = value;
        }
      }
    }
    else if (obj instanceof Set) {
      if (obj.size) {
        let i = 0;
        for (const value of obj.values()) {
          dict[i++] = value;
        }
      }
    }
    else if (Array.isArray(obj)) {
      if (obj.length) {
        let i = 0;
        for (const value of Object.values<any>(obj)) {
          if (Array.isArray(value))
            dict[value[0]] = value[1];
          else
            dict[i++] = value;
        }
      }
    }
    else if (typeof obj === 'object') {
      if (len(obj)) {
        for (const [key, value] of Object.entries<T>(obj)) {
          dict[key] = value as T;
        }
      }
    }

    return dict;
  }

  static fromKeys<T>(list: any[], value: T | null = null) {
    const dict = new Dict<T>();
    for (const key of Object.values(list)) {
      dict[key] = value;
    }
    return dict;
  }

  *[Symbol.iterator]() {
    for (const entry of Object.entries<T>(this)) {
      yield entry;
    }
  }

  forEach(callbackfn: (value: T, key: string, map: Dict<T>) => void, thisArg?: any) {
    for (const [key, val] of Object.entries<T>(this)) {
      callbackfn(val, key, this);
    }
  }

  get length() {
    return Object.keys(this).length;
  }

  isEmpty() {
    return this.length == 0;
  }

  entries(): [string, T][] {
    return Object.entries<T>(this);
  }

  items(multi?: any): [string, T][] {
    return this.entries();
  }

  keys() {
    return Object.keys(this);
  }

  values() {
    return Object.values<T>(this);
  }

  get(key: indexType, value?: T): T {
    return this[key] !== undefined ? this[key] : value;
  }

  set(key: indexType, value: T) {
    this[key] = value;
  }

  setdefault(key: indexType, value: T): T {
    if (!this.has(key)) {
      this.set(key, value);
    }
    return this[key];
  }

  updateFrom(obj: any) {
    Dict.fill(this, obj);
  }

  pop(key: indexType, value?: T): T {
    const res = this[key];
    delete this[key];
    return res !== undefined ? res : value;
  }

  popitem(): [string, T] {
    const keys = Object.keys(this);
    const key = keys[keys.length - 1];
    return [key, this.pop(key)];
  }

  has(key: indexType): boolean {
    return key in this || this.hasOwnProperty(key);
  }

  includes(key: indexType) {
    return this.has(key);
  }

  clear() {
    for (const key of Object.keys(this)) {
      delete this[key];
    }
  }

  toObject() {
    const obj: Record<indexType, T> = {};
    for (const [key, value] of Object.entries<T>(this)) {
      obj[key] = value;
    }
    return obj;
  }
}


/**
 * Iterates over the items of a mapping yielding keys and values
  without dropping any from more complex structures.
 * @param mapping 
 */
function* iterMultiItems(mapping) {
  if (mapping instanceof MultiDict) {
    for (const entry of mapping.entries()) {
      yield entry;
    }
  }
  else if (mapping instanceof Dict) {
    for (const [key, value] of mapping.entries()) {
      if (value instanceof Array) {
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
    for (const entry of Object.entries(mapping)) {
      yield entry;
    }
  }
}

class List extends Array { }
class BadRequestKeyError extends KeyError { }

/**
 * A class `MultiDict` is a dictionary subclass customized to deal with
    multiple values for the same key which is for example used by the parsing
    functions in the wrappers.  This is necessary because some HTML form
    elements pass multiple values for the same key.

     class `MultiDict` implements all standard dictionary methods.
    Internally, it saves all values for a key as a list, but the standard dict
    access methods will only return the first value for a key. If you want to
    gain access to the other values, too, you have to use the `list` methods as
    explained below.

    Basic Usage:

    >>> d = MultiDict([('a', 'b'), ('a', 'c')])
    >>> d
    MultiDict([('a', 'b'), ('a', 'c')])
    >>> d['a']
    'b'
    >>> d.getlist('a')
    ['b', 'c']
    >>> 'a' in d
    True

    It behaves like a normal dict thus all dict functions will only return the
    first value when multiple values for one key are found.

    From Werkzeug 0.3 onwards, the `KeyError` raised by this class is also a
    subclass of the :exc:`~exceptions.BadRequest` HTTP exception and will
    render a page for a ``400 BAD REQUEST`` if caught in a catch-all for HTTP
    exceptions.

    A class `MultiDict` can be constructed from an iterable of
    `'[key, value]'` tuples, a dict, a class `MultiDict` or from Werkzeug 0.2
    onwards some keyword parameters.

    @param obj the initial value for the class `MultiDict`.  Either a
                    regular dict, an iterable of `'[key, value]'` tuples
                    or `null`.
 */
export class MultiDict<T = any> extends Function {
  private _data = new Dict<any>();

  constructor(obj?: any) {
    super();
    const self = new Proxy(this, {
      /**
       * Return the first data value for this key;
        raises KeyError if not found.
       * @param key The key to be looked up.
       * @returns 
       */
      get(target, key, receiver): any {
        if (key in target) {
          return Reflect.get(target, key, receiver);
        }
        if (key in target._data) {
          const list = target._data.get(key);
          if (list instanceof List && list.length > 0) {
            return list[0];
          }
        }
        return undefined;
      },
      /**
       * Like method `add` but removes an existing key first
       * @param key the key for the value.
       * @param value the value to set.
       * @returns 
       */
      set(target, key, value, receiver) {
        if (key in target) {
          return Reflect.set(target, key, value, receiver);
        }
        return Reflect.set(target._data, key, List.from([value]));
      },
      deleteProperty(target, key): boolean {
        if (key in target) {
          return Reflect.deleteProperty(target, key);
        }
        return Reflect.deleteProperty(target._data, key);
      },
      has(target, key): boolean {
        if (key in target) {
          return true;
        }
        return Reflect.has(target._data, key);
      }
    });
    if (obj) {
      MultiDict.fill<any>(self, obj);
    }
    return self;
  }

  static from<T>(obj: any): MultiDict<T> {
    return new MultiDict(obj);
  }

  static fill<T>(dict: MultiDict, obj: any): any {
    if (obj instanceof MultiDict) {
      for (const [k, l] of obj.entries()) {
        dict[k] = l.slice ? l.slice() : l;
      }
    }
    else if (obj instanceof Dict) {
      if (obj.length) {
        const tmp = {}
        for (let [key, value] of obj.entries()) {
          if (value instanceof List) {
            if (value.length == 0) {
              continue;
            }
            value = List.from(value);
          }
          else {
            value = List.from([value]);
          }
          tmp[key] = value;
        }
        dict._data.updateFrom(tmp);
      }
    }
    else if (obj instanceof Map) {
      for (const [key, value] of obj) {
        dict[key] = value;
      }
    }
    else if (obj instanceof Set) {
      if (obj.size) {
        let i = 0;
        for (const value of obj.values()) {
          dict[i++] = value;
        }
      }
    }
    else if (Array.isArray(obj)) {
      if (obj.length) {
        let i = 0;
        for (const value of Object.values<any>(obj)) {
          if (Array.isArray(value)) {
            dict[value[0]] = value[1];
          }
          else {
            dict[i++] = value;
          }
        }
      }
    }
    else if (typeof obj === 'object') {
      for (const [key, value] of Object.entries<T>(obj)) {
        dict[key] = value;
      }
    }

    return dict;
  }

  static fromKeys<T>(list: any[], value: T | null = null) {
    const dict = new MultiDict();
    for (const key of Object.values(list)) {
      dict[key] = value;
    }
    return dict;
  }

  get _length() {
    return this._data.length;
  }

  set(key, val) {
    this[key] = val;
  }

  has(key) {
    return this._data.has(key);
  }

  get(key, defaultValue?: any, type?: any) {
    let rv;
    if (key in this._data) {
      rv = this[key];
    } else {
      return defaultValue;
    }
    if (type != null) {
      try {
        rv = new type(rv);
      } catch (e) {
        rv = defaultValue;
      }
    }
    return rv;
  }

  /**
   * Adds a new value for the key.
    @param key the key for the value.
    @param value the value to add.
   */
  add(key, value) {
    this.setdefault(key, new List()).push(value);
  }

  /**
   * Return the list of items for a given key. If that key is not in the
      `MultiDict`, the return value will be an empty list.  Just like `get`,
      `getlist` accepts a `type` parameter.  All items will be converted
      with the callable defined there.
 
      @param key The key to be looked up.
      @param type A callable that is used to cast the value in the
                    class `MultiDict`. If a :exc:`ValueError` is raised
                    by this callable the value will be removed from the list.
      @return a class `list` of all the values for the key.
   */
  getlist(key, type?: any) {
    let rv;
    if (!(key in this._data)) {
      return [];
    }
    rv = this.get(key);

    if (type == null) {
      return Array.from(rv);
    }
    const result = [];
    for (const item of rv) {
      try {
        result.push(type(item));
      } catch (e) {
        // pass;
      }
    }
    return result;
  }

  /**
   * Remove the old values for a key and add new ones.  Note that the list
        you pass the values in will be shallow-copied before it is inserted in
        the dictionary.
 
        >>> d = MultiDict()
        >>> d.setlist('foo', ['1', '2'])
        >>> d['foo']
        '1'
        >>> d.getlist('foo')
        ['1', '2']
 
        :param key: The key for which the values are set.
        :param new_list: An iterable with the new values for the key.  Old values
                         are removed first.
   * @param key 
   * @param newList 
   */
  setlist(key, newList: any[]) {
    this.set(key, List.from(newList));
  }

  /**
   * Returns the value for the key if it is in the dict, otherwise it
        returns `value` and sets that value for `key`.
   * @param key The key to be looked up
   * @param defaultValue The default value to be returned if the key is not
                        in the dict.  If not further specified it's `null`
   */
  setdefault(key, defaultValue?: any) {
    if (!(key in this._data)) {
      this._data[key] = defaultValue;
    }
    else {
      defaultValue = this._data[key];
    }
    return defaultValue;
  }

  /**
   * Like `setdefault` but sets multiple values.  The list returned
        is not a copy, but the list that is actually used internally.  This
        means that you can put new values into the dict by appending items
        to the list:
 
        >>> d = MultiDict({"foo": 1})
        >>> d.setlistdefault("foo").extend([2, 3])
        >>> d.getlist("foo")
        [1, 2, 3]
   * @param key The key to be looked up
   * @param list An iterable of default values.  It is either copied
                             (in case it was a list) or converted into a list
                             before returned
   */
  setlistdefault(key, list?: any[]) {
    if (!(key in this._data)) {
      list = List.from(list ?? []);
      this.set(key, list);
    }
    else {
      list = this._data.get(key);
    }
    return list;
  }

  /**
   * Return an iterator of `'[key, value]'` pairs.
   * @param multi If set to `true` the iterator returned will have a pair
      for each value of each key.  Otherwise it will only
      contain pairs for the first value of each key 
   */
  items(multi = false) {
    const result = [];
    for (const [key, values] of this._data.entries()) {
      if (multi) {
        for (const value of values) {
          result.push([key, value]);
        }
      }
      else {
        result.push([key, values[0]]);
      }
    }
    return result;
  }

  entries() { return this.items(true); }

  /**
   * Return a iterator of `'[key, values]'` pairs, where values is the list of all values associated with the key.
   */
  lists() {
    return this._data.entries().map(([key, values]) => [key, Array.from(values)]);
  }

  keys() {
    return this._data.keys();
  }

  /**
   * Returns an iterator of the first value on every key's value list.
   */
  values() {
    return this._data.values().map(values => values[0]);
  }

  *[Symbol.iterator]() {
    for (const entry of this._data.entries()) {
      yield entry;
    }
  }

  /**
   * Return an iterator of all values associated with a key.  Zipping
      :meth:`keys` and this is the same as calling :meth:`lists`:
 
      >>> var d = new MultiDict({"foo": [1, 2, 3]})
      >>> zip(d.keys(), d.listvalues()) == d.lists()
      true
   * @returns 
   */
  listvalues() {
    return this._data.values();
  }

  /**
   * Return the contents as regular dict. If `flat` is `true` the
    returned dict will only have the first item present, if `flat` is
    `false` all values will be returned as lists.
   * @param flat If set to `False` the dict returned will have lists
      with all the values in it.  Otherwise it will only
      contain the first value for each key 
   * @returns 
   */
  toDict(flat = true) {
    if (flat) {
      return Dict.from(this.items());
    }
    return Dict.from(this.lists());
  }


  /**
   * update() extends rather than replaces existing key lists:
 
    >>> var a = new MultiDict({'x': 1})
    >>> var b = new MultiDict({'x': 2, 'y': 3})
    >>> a.updateFrom(b)
    >>> a
    MultiDict([['y', 3], ['x', 1], ['x', 2]])
 
    If the value list for a key in `'dict'` is empty, no new values
    will be added to the dict and the key will not be created:
 
    >>> x = {'emptyList': []}
    >>> y = new MultiDict()
    >>> y.updateFrom(x)
    >>> y
    MultiDict([])
   * @param dict 
   */
  updateFrom(dict) {
    for (const [key, value] of iterMultiItems(dict)) {
      this.add(key, value);
    }
  }

  /**
   * Pop the first item for a list on the dict.  Afterwards the
    key is removed from the dict, so additional values are discarded:
 
    >>> d = MultiDict({"foo": [1, 2, 3]})
    >>> d.pop("foo")
    1
    >>> "foo" in d
    false
   * @param key the key to pop
   * @param defaultValue if provided the value to return if the key was
                    not in the dictionary
   * @returns 
   */
  pop(key, defaultValue: any = '_missing') {
    try {
      const list = this._data.pop(key);

      if (len(list) == 0) {
        throw new BadRequestKeyError(key);
      }

      return list[0];
    } catch (e) {
      if (e instanceof KeyError) {
        if (defaultValue !== '_missing') {
          return defaultValue;
        }
        throw new BadRequestKeyError(key);
      }
      throw e;
    }
  }

  /**
   * Pop an item from the dict.
   */
  popitem() {
    try {
      const item = this._data.popitem();

      if (!(item[1] instanceof List) || item[1].length == 0) {
        throw new BadRequestKeyError(item);
      }
      return [item[0], item[1][0]];
    } catch (e) {
      if (e instanceof KeyError) {
        throw new BadRequestKeyError(e.message);
      }
      throw e;
    }
  }

  /**
   * Pop the list for a key from the dict.  If the key is not in the dict
    an empty list is returned.
      If the key does no longer exist a list is returned instead of
      raising an error.
   * @param key 
   * @returns 
   */
  poplist(key) {
    return this._data.pop(key, []);
  }

  /**
   * Pop a `'[key, list]'` tuple from the dict.
   * @returns 
   */
  popitemlist() {
    try {
      return this._data.popitem();
    } catch (e) {
      if (e instanceof KeyError) {
        throw new BadRequestKeyError(e.message);
      }
      throw e;
    }
  }

  /**
   * Return a shallow copy of this object.
   * @returns 
   */
  copy() {
    return new MultiDict(this);
  }

  /**
   * Return a deep copy of this object.
   * @param memo 
   * @returns 
   */
  deepcopy(memo?: any) {
    return new MultiDict(structuredClone(this.toDict(false)));
  }
}

export class CombinedMultiDict extends MultiDict<any> { }

export class OrderedMultiDict<T> extends Dict<T> { }

export class OrderedDict<T> extends Dict<T> { }

export class FrozenDict<T> extends Dict<T> {
  readonly [index: indexType]: any;

  static from<T>(obj: any): FrozenDict<T> {
    throw new NotImplementedError("static 'from' not supported on FrozenDict");
  }

  static fill<T>(dict: Dict<T>, obj: any): Dict<T> {
    throw new NotImplementedError("static 'fill' not supported on FrozenDict");
  }

  static fromKeys<T>(list: any[], value: T | null): FrozenDict<T> {
    throw new NotImplementedError("static fromKeys' not supported on FrozenDict");
  }

  set(key: indexType, value: T) {
    throw new NotImplementedError("'set' not supported on FrozenDict");
  }

  setdefault(key: indexType, value: T): T {
    throw new NotImplementedError("'setdefault' not supported on FrozenDict");
  }

  updateFrom(obj: any) {
    throw new NotImplementedError("'updateFrom' not supported on FrozenDict");
  }

  pop(key: indexType, value?: T): T {
    throw new NotImplementedError("'pop' not supported on FrozenDict");
  }

  popitem(): [string, T] {
    throw new NotImplementedError("'popitem' not supported on FrozenDict");
  }

  clear() {
    throw new NotImplementedError("'clear' not supported on FrozenDict");
  }
}

export class MapKey<K, V> extends Map<K, V> {
  constructor(fKey: Function = (item) => MapKey._hash(item)) {
    super();
    if (fKey) {
      setattr(this, 'fKey', fKey, { enumerable: false });
    }
  }

  static fromEntries(obj: any, fKey: Function = (item) => MapKey._hash(item)) {
    const self = new MapKey(fKey);
    for (const [key, val] of obj) {
      self.set(fKey(key), val);
    }
    return self;
  }

  private static _hash(item) {
    if (typeof item['_hash'] === 'function') {
      return item._hash();
    }
    else {
      return item;
    }
  }

  fKey(item) {
    return MapKey._hash(item);
  }

  has(key: K): boolean {
    return super.has(this.fKey(key));
  }

  get(key: K, value?: V): any {
    const temp = super.get(this.fKey(key));
    return temp !== undefined ? temp[1] : value;
  }

  set(key: K, value?: V): any {
    super.set(this.fKey(key), [key, value] as any);
    return this;
  }

  setdefault(key: K, value: V): V {
    if (!this.has(key)) {
      this.set(key, value);
    }
    return this.get(key);
  }

  delete(key: K) {
    return super.delete(this.fKey(key));
  }

  pop(key: K, value?: V): V {
    const res = this.get(key);
    this.delete(key);
    return res !== undefined ? res : value;
  }

  popitem() {
    const keys = this.keys();
    const key = keys[this.size - 1];
    return [key, this.pop(key as any as K)];
  }

  items() {
    return this.entries();
  }

  entries(): IterableIterator<[K, V]> {
    return super.values() as any as IterableIterator<[K, V]>;
  }

  keys() {
    return Array.from(super.values()).map(item => item[0]) as any as IterableIterator<K>;
  }

  values() {
    return Array.from(super.values()).map(item => item[1]) as any as IterableIterator<V>;
  }

  *[Symbol.iterator]() {
    for (const entry of super.values()) {
      yield entry as any;
    }
  }
}

export class MapDefaultKey<K, V> extends Map<K, any> {
  private fKey: Function;
  private fDefault: Function;

  constructor(defaultFactory: Function = () => new Object(), fKey: Function = (item) => item.id) {
    super();
    this.fDefault = defaultFactory;
    this.fKey = fKey;
  }

  has(key: K): boolean {
    return super.has(this.fKey(key));
  }

  get(key: K, value?: V): any {
    if (!super.has(this.fKey(key))) {
      super.set(this.fKey(key), [key, this.fDefault(key)]);
    }
    return super.get(this.fKey(key))[1] ?? value;
  }

  set(key: K, value?: V): any {
    super.set(this.fKey(key), [key, value] as any);
    return this;
  }

  setdefault(key: K, value: V): V {
    if (!this.has(key)) {
      this.set(key, value);
    }
    return this.get(key);
  }

  delete(key: K) {
    return super.delete(this.fKey(key));
  }

  pop(key: K, value?: V): V {
    const res = this.get(key);
    this.delete(key);
    return res !== undefined ? res : value;
  }

  popitem() {
    const keys = this.keys();
    const key = keys[this.size - 1];
    return [key, this.pop(key as any as K)];
  }

  items() {
    return this.entries();
  }

  entries(): IterableIterator<[K, V]> {
    return super.values() as any as IterableIterator<[K, V]>;
  }

  keys() {
    return Array.from(super.values()).map(item => item[0]) as any as IterableIterator<K>;
  }

  values() {
    return Array.from(super.values()).map(item => item[1]) as any as IterableIterator<V>;
  }

  *[Symbol.iterator]() {
    for (const entry of super.values()) {
      yield entry as any;
    }
  }
}

export class DefaultDict<K, V> extends Map<K, V> {
  get(key: K, value?: V): any {
    const temp = super.get(key);
    return temp !== undefined ? temp : value;
  }

  pop(key: K, value?: V): V {
    const res = this.get(key);
    this.delete(key);
    return res !== undefined ? res : value;
  }

  popitem() {
    const keys = Object.keys(this);
    const key = keys[keys.length - 1];
    return [key, this.pop(key as any as K)];
  }

  items(): IterableIterator<[K, V]> {
    return super.entries();
  }

  setdefault(key: K, value: V): V {
    if (!this.has(key)) {
      this.set(key, value);
    }
    return this.get(key);
  }
}

export class DefaultDict2 extends Function {
  private _data = new Map<any, any>();
  private _defaultFactory;

  constructor(defaultFactory: Function = () => new Object()) {
    super();
    this._defaultFactory = defaultFactory;
    return new Proxy(this, {
      get(target, prop, receiver): any {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        if (!target._data.has(prop)) {
          target._data.set(prop, target._defaultFactory(prop));
        }
        return target._data.get(prop);
      },
      set(target, prop, value, receiver) {
        if (prop in target) {
          return Reflect.set(target, prop, value, receiver);
        }
        target._data.set(prop, value);
        return true;
      },
      deleteProperty(target, prop): boolean {
        if (prop in target) {
          return Reflect.deleteProperty(target, prop);
        }
        return target._data.delete(prop);
      },
      has(target, prop): boolean {
        if (prop in target) {
          return true;
        }
        return target._data.has(prop);
      }
    });
  }

  *[Symbol.iterator]() {
    for (const entry of this._data) {
      yield entry;
    }
  }

  get size() {
    return this._data.size;
  }

  get(key, val?: any) {
    if (!this._data.has(key)) {
      this._data.set(key, this._defaultFactory(key));
    }
    return this._data.get(key) ?? val;
  }

  set(key, val) {
    return this._data.set(key, val);
  }

  has(key) {
    return this._data.has(key);
  }

  entries() {
    return this._data.entries();
  }

  items() {
    return this._data.entries();
  }

  values() {
    return this._data.values();
  }

  keys() {
    return this._data.keys();
  }
}

export class StackMap extends Map {
  private _maps: Map<any, any>[];

  constructor(m?: Map<any, any>) {
    super();
    this._maps = m != undefined ? [m] : []
  }

  get(key: any, value?: any): any {
    for (let i = this._maps.length - 1; i >= 0; i--) {
      const mapping = this._maps[i];
      if (mapping.has(key)) {
        return mapping.get(key);
      }
    }
    return value;
  }

  set(key: any, value: any): this {
    this._maps[this._maps.length - 1].set(key, value);
    return this;
  }

  delete(key: any): boolean {
    try {
      this._maps[this._maps.length - 1].delete(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  *[Symbol.iterator]() {
    for (const mapping of this._maps) {
      for (const entry of mapping.entries()) {
        yield entry;
      }
    }
  }

  forEach(callbackfn: (value: any, key: any, map: Map<any, any>) => void, thisArg?: any) {
    for (const mapping of this._maps) {
      for (const [key, val] of mapping.entries()) {
        callbackfn(val, key, mapping);
      }
    }
  }

  get size(): number {
    return this._maps.reduce((sum, value) => {
      return sum += value.size;
    }, 0);
  }

  toJson() {
    return fixJson(this._maps);
  }

  /**
   * push to Stack an empty {...}
   * @param m 
   */
  push(m?: Map<any, any>): any {
    this._maps.push(m == undefined ? new Map() : m);
  }

  /**
   * get out the last element {...}
   * @returns 
   */
  pop(): any {
    return this._maps.pop();
  }
}

export class OrderedSet extends Set {
  private _maps: Map<any, null>;

  constructor(elems: any[] = []) {
    super();
    this._maps = new Map(elems.map((e) => [e, null]));
  }

  *[Symbol.iterator]() {
    for (const [key] of this._maps) {
      yield key;
    }
  }

  forEach(callbackfn: (value: any, key: any, set: Set<any>) => void, thisArg?: any) {
    this._maps.forEach(
      (value, key) => callbackfn(key, value, this)
    );
  }

  add(elem: any): this {
    this._maps.set(elem, null);
    return elem;
  }

  pop() {
    const key = Array.from(this._maps.keys()).pop();
    this._maps.delete(key);
    return key;
  }

  discard(elem: any) {
    this._maps.delete(elem);
  }

  differenceUpdate(elems: string[]) {
    for (const elem of elems) {
      this.discard(elem)
    }
  }

  clear() {
    for (const key of Object.keys(this._maps)) {
      this._maps.delete(key);
    }
  }

  has(elem: string): boolean {
    return this._maps.has(elem)
  }

  get size() {
    return this._maps.size;
  }
}

export class OrderedSet2 extends Array {
  constructor(elems = []) {
    super();
    if (isIterable(elems)) {
      for (const elem of elems) {
        if (!this.includes(elem)) {
          this.push(elem);
        }
      }
    }
  }

  add(elem) {
    if (!this.includes(elem)) {
      this.push(elem);
    }
    return this.length;
  }

  pop() {
    return super.pop();
  }

  delete(elem) {
    return this.discard(elem);
  }

  discard(elem) {
    const index = this.indexOf(elem);
    if (index > -1) { // only splice array when item is found
      return this.splice(index, 1); // 2nd parameter means remove one item only
    }
    return this;
  }

  update(elems: []) {
    for (const elem of elems) {
      if (!this.includes(elem)) {
        this.push(elem);
      }
    }
  }

  clear() {
    const a = [];
    while (this.length > 0) {
      this.pop();
    }
  }

  get size(): number {
    return this.length
  }
}

export class Collector extends Map {

  get(key: any) {
    return super.get(key) || [];
  }

  set(key: any, val: any[] | Set<any>): any {
    if (val) {
      val = Array.from(val);
      if (val.length) {
        return super.set(key, val);
      }
    } else {
      this.delete(key);
    }
    return this;
  }

  add(key: any, val: any) {
    const vals = this.get(key);
    if (val != undefined && !vals.includes(val)) {
      this.set(key, [...vals, val])
    }
  }


  pop(key, val) {
    const res = this.get(key);
    this.delete(key);
    return val != null ? val : res;
  }

  discardKeysAndValues(excludes) {
    for (const key of excludes) {
      this.pop(key, null);
    }
    for (const [key, vals] of this) {
      this.set(key, vals.filter(val => !excludes.includes(val)));
    }
  }
}

export class CollectorSet extends Map {
  get(key: any) {
    return super.get(key) ?? new Set();
  }

  set(key: any, val: any[] | Set<any>): any {
    if (val) {
      val = val instanceof Set ? val : new Set(val);
      return super.set(key, val)
    } else {
      super.delete(key);
      return this;
    }
  }

  add(key: any, val: any) {
    const vals = this.get(key) as Set<any>;
    if (!vals.has(val)) {
      this.set(key, new Set([...vals, val]))
    }
  }
}

export class LastOrderedSet extends OrderedSet2 {
  add(elem: any) {
    super.discard(elem);
    return super.add(elem);
  }
}

export class FrozenSet<T> extends Set<T> {
  constructor(elems: Iterable<T> = []) {
    super();
    for (const e of elems) {
      super.add(e);
    }
  }
  add(value: T): this {
    throw new NotImplementedError("method 'add' not supported on FrozenSet");
  }
  clear() {
    throw new NotImplementedError("method 'clear' not supported on FrozenSet");
  }
  delete(value: T): boolean {
    throw new NotImplementedError("method 'delete' not supported on FrozenSet");
  }
}

export class Counter extends Dict<any> {
  /**
   * List the n most common elements and their counts from the most
      common to the least.  If n is None, then list all element counts.

      >>> new Counter('abcdeabcdabcaba').mostCommon(3)
      [['a', 5], ['b', 4], ['c', 3]]
    * @param n 
    * @returns 
  */
  mostCommon(n?: any) {
    // Emulate Bag.sortedByCount from Smalltalk
    if (n == null) {
      return sorted(this.entries(), itemgetter([1]), true);
    }
    return sorted(this.entries(), itemgetter([1]), true).slice(0, n);
  }
}