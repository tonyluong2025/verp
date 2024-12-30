import _ from "lodash";
import { StopIteration } from "../helper/errors";
import { bool } from "./bool";

export function len(obj: any): number {
  if (!obj) {
    return 0;
  }
  if (typeof obj === 'string') {
    return obj.length;
  }
  if (typeof obj === 'object' || typeof obj === 'function') {
    if ('_length' in obj) { // ModelRecords
      return obj._length;
    }
    if ('length' in obj) {
      return obj.length;
    }
    if ('size' in obj) {
      return obj.size;
    }
    return Object.keys(obj).length;
  }
  return 0;
}

export function isArray(obj: any) {
  return Array.isArray
    ? Array.isArray(obj)
    : obj instanceof Object
      ? obj instanceof Array
      : Object.prototype.toString.call(obj) === "[object Array]";
}

/**
 * Fixes itemgetter inconsistency (useful in some cases) of not returning
  a tuple if len(items) == 1: always returns an n-tuple where n = len(items)
* @param items 
* @returns 
*/
export function itemgetter(items: any[]) {
  if (items.length == 0) {
    return (obj: any) => [];
  }
  if (items.length == 1) {
    return (obj: any) => [obj[items[0]]];
  }
  return (obj: any) => items.map(item => obj[item]);
}

/**
 * takewhile(x => x<5, [1,4,6,4,1]) --> 1 4
 * @param predicate 
 * @param iterable 
 */
export function* takewhile(predicate: (x: any) => boolean, iterable: any) {
  for (const x of iterable) {
    if (predicate(x))
      yield x
    else
      break
  }
}

/**
   islice('ABCDEFG', 2) --> A B
   islice('ABCDEFG', 2, 4) --> C D
   islice('ABCDEFG', 2, None) --> C D E F G
   islice('ABCDEFG', 0, None, 2) --> A C E G 
 * @param iterable 
 * @param args 
*/
export function* islice(seq: any, ...args: number[]) {
  let start = 0;
  let stop = 0;
  let step = 1;
  if (args.length == 1) {
    stop = args[0];
  } else {
    [start, stop, step] = [args[0] || 0, args[1] ?? Number.MAX_SAFE_INTEGER, args[2] ?? 1];
  }
  const array = Array.isArray(seq) ? seq : Array.from(seq);
  stop = Math.min(stop, array.length);
  let i = -1;
  while (start < stop) {
    while (i < start) {
      i++;
    }
    start += step;
    yield array[i];
  };
}

export function isdisjoint(arrays) {
  return _.intersection(arrays).length == 0;
}

export function* range(start: number, stop?: number, step?: number) {
  let index = start;
  if (!stop) {
    stop = start;
    index = 0;
  }
  if (!step) {
    step = 1;
  }
  while (step > 0 ? index < stop : index > stop) {
    yield index;
    index += step;
  }
}

export function* rangeList(list: any[], start: number, stop?: number, step?: number) {
  for (const i of range(start, stop, step)) {
    yield list[i];
  }
}

/**
 * @param start 
 * @param end 
 * @param step 
 * @returns 
 */
export function* range2(start = 0, end = Infinity, step = 1) {
  for (let i = start; i < end; i += step) {
    yield i;
  }
}

export function choice(choices) {
  var index = Math.floor(Math.random() * choices.length);
  return choices[index];
}

export function* enumerate<T = any>(items: Iterable<T>, start: number = 0): Generator<[number, T], void, unknown> {
  let index = start;
  for (const value of items) {
    yield [index++, value];
  }
}

export function* iter(items: any) {
  const type = typeof items;
  if (type !== 'string' && type !== 'object' && type !== 'function') {
    yield items;
  }
  items = isIterable(items) ? items :
    items instanceof Map ? items.keys() : Object.keys(items);
  for (const item of items) {
    yield item;
  }
}

/**
 * chain('ABC', 'DEF') --> A B C D E F
 * @param iterables 
 */
export function* chain(...iterables: any[]) {
  for (const it of iterables) {
    for (const element of it) {
      yield element;
    }
  }
}

/**
 * repeat(10, 3) --> 10 10 10
 * @param obj 
 * @param times 
 */
export function* repeat(obj: any, times?: any) {
  if (times == null) {
    while (true) {
      yield obj;
    }
  }
  else {
    for (let i of range(times)) {
      yield obj;
    }
  }
}

/**
 * An iterable object based on a generator function, which is called each time the object is iterated over.
 */
export class IterableGenerator {
  args: any[];
  func: any;

  constructor(func: Function = (args) => args, ...args: any[]) {
    this.func = func;
    this.args = args;
  }

  *[Symbol.iterator]() {
    const result = this.func(...this.args);
    for (const res of result) {
      yield res;
    }
  }
}

export function isIterable(obj: any) {
  if (obj == null) {
    return false;
  }
  return Array.isArray(obj) || obj instanceof Set || obj instanceof IterableGenerator || typeof obj.next === 'function';
}

const dummy = new Object();

export class CountingStream implements Generator {
  stream: Generator<any, void, any>;
  index: number;

  constructor(stream: Generator, start = -1) {
    this.stream = stream;
    this.index = start;
  }

  next(...args: [] | [any]): IteratorResult<any, any> {
    this.index += 1;
    const _next = this.stream.next();
    let value = _next.value;
    value = value || dummy;
    if (value === dummy) {
      return { value: undefined, done: true };
    }
    return { value: value, done: false };
  }

  async nextAsync(...args: [] | [any]): Promise<IteratorResult<any, any>> {
    this.index += 1;
    const _next = await this.stream.next();
    let value = await _next.value;
    value = value || dummy;
    if (value === dummy) {
      return { value: undefined, done: true };
    }
    return { value: value, done: false };
  }

  *[Symbol.iterator](): Generator<any, any, unknown> {
    let item = this.stream.next();
    while (!item.done) {
      this.index += 1;
      const value = item.value ?? dummy;
      if (value === dummy) {
        break;
      }
      yield value;
      item = this.stream.next();
    }
  }

  return(value?: any): IteratorResult<any, any> {
    throw new Error("Throw not implemented.");
  }

  throw(e?: any): IteratorResult<any, any> {
    throw new Error("Throw not implemented.");
  }
}

export function some(list: Iterable<any> | Generator<any>, func: Function = (e) => bool(e)) {
  for (const rec of list) {
    if (func(rec)) {
      return true;
    }
  }
  return false;
}

export async function someAsync(list: Iterable<any> | Generator<any>, func: Function = (e) => bool(e)) {
  for (const rec of list) {
    if (await func(rec)) {
      return true;
    }
  }
  return false;
}

export function* map(list: Iterable<any> | Generator<any>, func: Function = (e) => e) {
  for (const rec of list) {
    yield func(rec);
  }
}

export function* filter(list: Iterable<any> | Generator<any>, func: Function = (e) => e) {
  for (const rec of list) {
    const res = func(rec);
    if (res) {
      yield rec;
    }
  }
}

export function all(list: Iterable<any> | Generator<any>, func: Function = (e) => bool(e)) {
  for (const rec of list) {
    const res = func(rec);
    if (res) {
      return false;
    }
  }
  return true;
}

export function includes(list: Iterable<any> | Generator<any>, item) {
  for (const rec of list) {
    if (rec == item) {
      return true;
    }
  }
  return false;
}

export function extend(list: any[], other: any[] = []) {
  for (const e of other) {
    list.push(e);
  }
  return list;
}

export function* count(firstval = 0, step = 1) {
  let x = firstval;
  while (1) {
    yield x;
    x += step;
  }
}

export function next(gen: any, defaulValue?: any) {
  if (gen == null) return defaulValue;
  if (typeof gen[Symbol.iterator] === 'function' && typeof gen.next !== 'function') {
    gen = gen[Symbol.iterator]();
  }
  try {
    const next = gen.next();
    if (next.done && defaulValue === undefined) {
      throw new StopIteration();
    }
    return next.value !== undefined ? next.value : defaulValue;
  } catch (e) {
    if (defaulValue !== undefined) {
      return defaulValue;
    }
    throw e;
  }
}

export async function nextAsync(gen: any, defaulValue?: any) {
  if (gen == null) return defaulValue;
  if (typeof gen[Symbol.iterator] === 'function' && typeof gen.next !== 'function') {
    gen = gen[Symbol.iterator]();
  }
  try {
    const next = await gen.next();
    if (next.done && defaulValue === undefined) {
      throw new StopIteration();
    }
    return next.value !== undefined ? next.value : defaulValue;
  } catch (e) {
    if (defaulValue !== undefined) {
      return defaulValue;
    }
    throw e;
  }
}

/**
 * https://gist.github.com/cybercase/db7dde901d7070c98c48
 * @param iterables 
 * @param repeat 
 * @returns 
 */
export function product(...items: any[]) {
  if (items.length == 1 && Array.isArray(items[0])) {
    items = items[0];
  }

  return items.reduce((prevAccumulator, currentArray) => {
    let newAccumulator = [];
    prevAccumulator.forEach(prevAccumulatorArray => {
      currentArray.forEach(currentValue => {
        newAccumulator.push(prevAccumulatorArray.concat(currentValue));
      });
    });
    return newAccumulator;
  }, [[]]);
}

export function sum(...items) {
  if (items.length == 1 && Array.isArray(items[0])) {
    items = items[0];
  }
  return items.reduce((prev, current) => {
    return Array.isArray(current) ? prev + sum(...current) : prev + current;
  }, 0);
}

export function remove(list: any[], elem: any) {
  const index = list.indexOf(elem);
  if (index > -1) {         // only splice array when item is found
    list.splice(index, 1);  // 2nd parameter means remove one item only
  }
  return list;
}

export function isList(list: any[]) {
  return isArray(list) && list.length > 0;
}

/**
 * zip('ABCD', 'xy') --> Ax By
 * @param items 
 * @returns 
 */
export function* zip(...items: any[]) {
  const iterators = items.map(it => iter(it));
  while (iterators.length) {
    const values = [];
    for (const it of iterators) {
      const next = it.next();
      if (next.done) {
        return;
      }
      values.push(next.value);
    }
    yield values;
  }
}

/**
 * zipLongest('ABCD', 'xy', fillvalue='-') --> Ax By C- D-
 * @param args 
 * @returns 
 */
export function* zipLongest(...args: any[]) {
  let fillvalue;
  let iterators = Array.from(args);
  // fillvalue is last if it is string
  if (!isIterable(iterators[iterators.length - 1])) {
    fillvalue = iterators.pop();
  }
  iterators = iterators.map(it => iter(it));
  let length = iterators.length;
  if (!length) {
    return;
  }
  while (true) {
    const values = [];
    for (const [i, it] of enumerate(iterators)) {
      const next = it.next();
      if (!next.done) {
        values.push(next.value);
      }
      else {
        length -= 1;
        if (!length) {
          return;
        }
        iterators[i] = repeat(fillvalue);
        values.push(fillvalue);
      }
    }
    yield values;
  }
}

export function* splitEvery(size: number, iterable: any) {
  iterable = Array.from(iterable);
  let piece = iterable.splice(0, size);
  while (piece.length) {
    yield piece;
    piece = iterable.splice(0, size);
  }
}

/**
 * chunk([1, 2, 3, 4, 5], 2); => [[1, 2], [3, 4], [5]]
 * @param arr 
 * @param size 
 * @returns 
 */
export function chunk(arr: any[], size: number) {
  return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );
}

/**
 * chunkIntoN([1, 2, 3, 4, 5, 6, 7], 4); => [[1, 2], [3, 4], [5, 6], [7]]
 * @param arr 
 * @param n 
 * @returns 
 */
export function chunkIntoN(arr, n) {
  const size = Math.ceil(arr.length / n);
  return Array.from({ length: n }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );
}

export function sorted(list: Iterable<any>, func = (item: any) => item, reverse = false) {
  const comparableArray = Array.from(list).map(x => [func(x), x]);
  if (reverse) {
    comparableArray.sort((a, b) => +(a[0] < b[0]) || -(a[0] > b[0]));
  }
  else {
    comparableArray.sort((a, b) => +(a[0] > b[0]) || -(a[0] < b[0]));
  }
  return comparableArray.map(x => x[1]);
}

export async function sortedAsync(list: Iterable<any>, key: Function = (item) => item, reverse = false) {
  const comparableArray = await Promise.all(Array.from(list).map(async x => [await key(x), x]));
  if (reverse) {
    comparableArray.sort((a, b) => +(a[0] < b[0]) || -(a[0] > b[0]));
  }
  else {
    comparableArray.sort((a, b) => +(a[0] > b[0]) || -(a[0] < b[0]));
  }
  return comparableArray.map(x => x[1]);
}

/**
 * Return running totals
    accumulate([1,2,3,4,5]) → 1 3 6 10 15
    accumulate([1,2,3,4,5], initial=100) → 100 101 103 106 110 115
    accumulate([1,2,3,4,5], operator.mul) → 1 2 6 24 120
 * @param iterable 
 * @param func 
 * @param 
 * @param initial 
 * @returns 
 */
export function* accumulate(iterable, func: Function = (a, b) => a + b, initial?: any) {
  let iterator = iter(iterable);
  let total = initial;
  if (initial == null) {
    try {
      total = next(iterator);
    } catch (e) {
      return;
    }
  }
  yield total;
  for (const element of iterator) {
    total = func(total, element);
    yield total;
  }
}