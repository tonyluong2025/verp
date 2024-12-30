import assert from 'assert';
import crypto, { BinaryToTextEncoding, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { parse as parseCsv, Parser } from 'csv-parse';
import fs from 'fs';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { spawnSync } from 'node:child_process';
import { format } from 'node:util';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { tools } from '..';
import { Dict, MultiDict, Queue } from '../helper/collections';
import { ValueError } from '../helper/errors';
import { bool } from './bool';
import { isAlpha, isInstance } from './func';
import { enumerate, iter, len, range } from './iterable';
import { stringify } from './json';
import { whichSync } from './which';

export const DEFAULT_SERVER_DATE_FORMAT = "yyyy-MM-dd";
export const DEFAULT_SERVER_TIME_FORMAT = "HH:mm:ss";
export const DEFAULT_SERVER_DATETIME_FORMAT = `${DEFAULT_SERVER_DATE_FORMAT} ${DEFAULT_SERVER_TIME_FORMAT}`;
export const DATE_LENGTH = DateTime.now().toFormat(`${DEFAULT_SERVER_DATE_FORMAT}`).length;
export const DATETIME_LENGTH = DateTime.now().toFormat(`${DEFAULT_SERVER_DATETIME_FORMAT}`).length;

export const DATETIME_FORMATS_MAP = {
  '%C': '',         //  century
  '%D': '%m/%d/%Y', //  modified %y->%Y
  '%e': '%d',
  '%E': '',         //  special modifier
  '%F': '%Y-%m-%d',
  '%g': '%Y',       //  modified %y->%Y
  '%G': '%Y',
  '%h': '%b',
  '%k': '%H',
  '%l': '%I',
  '%n': '\n',
  '%O': '',         //  special modifier
  '%P': '%p',
  '%R': '%H:%M',
  '%r': '%I:%M:%S %p',
  '%s': '',         // num of seconds since epoch
  '%T': '%H:%M:%S',
  '%t': ' ',        //  tab
  '%u': ' %w',
  '%V': '%W',
  '%y': '%Y',       //  Even if %y works, it's ambiguous, so we should use %Y
  '%+': '%Y-%m-%d %H:%M:%S',

  //  %Z is a special case that causes 2 problems at least:
  //   - the timeZone names we use (in resUser.contextTz) come
  //     from pytz, but not all these names are recognized by
  //     strptime(), so we cannot convert in both directions
  //     when such a timeZone is selected and %Z is in the format
  //   - %Z is replaced by an empty string in strftime() when
  //     there is not tzinfo in a datetime value (e.g when the user
  //     did not pick a contextTz). The resulting string does not
  //     parse back if the format requires %Z.
  //  As a consequence, we strip it completely from format strings.
  //  The user can always have a look at the contextTz in
  //  preferences to check the timeZone.
  '%z': '',
  '%Z': '',
}

export class FileDescriptor {
  name: string;
  fd: number;
  flag: string;

  constructor(name: string, fd: number, flag: string) {
    this.name = name;
    this.fd = fd;
    this.flag = flag;
  }

  seek(offset: number, whence?: number) {
    console.warn('Not Implemented');
  }
  tell() {
    console.warn('Not Implemented');
    return 0;
  }
}

/**
 * Suboptimal-but-better-than-nothing way to replace accented
  latin letters by an ASCII equivalent. Will obviously change the
  meaning of inputStr and work only for some cases
 * @param inputStr 
 * @returns 
 */
export function removeAccents(inputStr: string) {
  if (!inputStr) {
    return inputStr;
  }
  inputStr = String(inputStr);
  return inputStr.normalize('NFKD').replace(/[\u0300-\u036f]/g, "");
}

export function isDir(dirPath: string) {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

export function isFile(file: string) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

export function getMinMax(arr: any[]) {
  if (!arr) {
    return null;
  }
  var minV = arr[0];
  var maxV = arr[0];
  for (const a of arr) {
    if (a < minV) minV = a;
    if (a > maxV) maxV = a;
  }
  return [minV, maxV];
}

export function sameContent(binData: Buffer, filepath: string) {
  const BLOCK_SIZE = 1024;
  const fd = fs.openSync(filepath, 'r');
  let i = 0;
  const data = Buffer.alloc(BLOCK_SIZE);
  while (true) {
    const num = fs.readSync(fd, data, 0, BLOCK_SIZE, null);
    if (!num) {
      break;
    }
    const temp = binData.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
    const _data = num < BLOCK_SIZE ? data.subarray(0, num) : data;
    if (_data.compare(temp) !== 0) {
      return false;
    }
    i += 1;
  }
  fs.closeSync(fd);
  return true;
}

/**
 * Given a list of pathnames, returns the longest common leading component 
 * Return the longest prefix of all list elements.
 */
export function commonPrefix(m: string[]) {
  if (!m) {
    return '';
  }
  // Some people pass in a list of pathname parts to operate in an OS-agnostic
  // fashion; don't try to translate in that case as that's an abuse of the
  // API and they are already doing what they need to be OS-agnostic and so
  // they most likely won't be using an os.PathLike object in the sublists.
  if (!Array.isArray(m[0])) {
    m = m.map(p => fs.realpathSync(p));
  }
  const [min, max] = getMinMax(m) as string[];
  for (const [i, c] of enumerate(min)) {
    if (c !== max[i]) {
      return min.slice(0, i);
    }
  }
  return min
}

/**
 * Constant-time string comparison. Suitable to compare bytestrings of fixed, known length only, because length difference is optimized.
 * @param str1 
 * @param str2 
 * @returns 
 */
export function consteq(str1: string, str2: string) {
  return str1.length == str2.length && _.zip(str1, str2).map(([x, y]) => x.charCodeAt(0) ^ y.charCodeAt(0)).reduce((sum, a) => sum + a, 0) == 0;
}

export class MuteLogger {
  loggers: any[];

  constructor(...loggers: any[]) {
    this.loggers = loggers;
  }

  filter(record) {
    return 0;
  }

  __enter__() {
    for (const logger of this.loggers) {
      assert(typeof logger === 'string', `A logger name must be a string, got ${typeof logger}"`);
      console.warn('logging.getLogger(logger).addFilter(self)')
    }
  }

  __exit__(errObj?: any) {
    if (errObj) {
      console.warn(errObj.message);
    }
    for (const logger of this.loggers) {
      console.warn('logging.getLogger(logger).removeFilter(self)')
    }
  }
}

export function muteLogger(...label: string[]) {
  const mute = new MuteLogger(...label);
  return (target: any, propertyKey: string, descriptor: PropertyDescriptor) => {
    const originalFunction = descriptor.value;
    async function deco(...args: any[]) {
      mute.__enter__();
      const result = await originalFunction.apply(this, args);
      mute.__exit__();
      return result;
    };
    descriptor.value = deco;
  }
}

/**
 * A simple queue of callback functions.  Upon run, every function is
    called (in addition order), and the queue is emptied.

        callbacks = new Callbacks();

        // add foo
        function foo() {
            console.log("foo");
        }

        callbacks.add(foo);

        // add bar
        callbacks.add
        function bar() {
            console.log("bar");
        }

        // add foo again
        callbacks.add(foo);

        // call foo(), bar(), foo(), then clear the callback queue
        callbacks.run();

    The queue also provides a `'data'` dictionary, that may be freely used to
    store anything, but is mostly aimed at aggregating data for callbacks.  The
    dictionary is automatically cleared by `'run()'` once all callback functions
    have been called.

        // register foo to process aggregated data
        @callbacks.add
        function foo() {
            console.log(sum(callbacks.data['foo']));
        }

        callbacks.data.setdefault('foo', []).push(1)
        ...
        callbacks.data.setdefault('foo', []).push(2)
        ...
        callbacks.data.setdefault('foo', []).push(3)

        // call foo(), which prints 6
        callbacks.run()

    Given the global nature of `'data'`, the keys should identify in a unique
    way the data being stored.  It is recommended to use strings with a
    structure like `"{module}.{feature}"`.
 */
export class Callbacks {
  _funcs: Queue<Function>
  data: {}

  constructor() {
    this._funcs = new Queue<Function>();
    this.data = {}
  }

  /**
   * Add the given function.
   * @param func 
   */
  add(func) {
    this._funcs.enqueue(func)
  }

  /**
   * Call all the functions (in addition order), then clear associated data.
   */
  async run() {
    while (this._funcs.size) {
      const func = this._funcs.popleft();
      await func();
    }
    this.clear();
  }

  /**
   * Remove all callbacks and data from self.
   */
  clear() {
    this._funcs.clear();
    this.data = {};
  }
}

export function normalize(str: string) {
  return str ? path.resolve(expandVars(str.trim())) : '';
}

export function expandVars(str: string): string {
  return str.replace(/%([^%]+)%/g, (x, n) => process.env[n]);
}

export function unique(it: Iterable<any>) {
  const seen = new Set();
  const res = [];
  for (const e of it) {
    if (!seen.has(e)) {
      seen.add(e);
      res.push(e);
    }
  }
  return res;
}

class ConstantMapping extends Function {
  private _value;

  constructor(val) {
    super();
    this._value = val;
    return new Proxy(this, {
      get(target, p, receiver) {
        return target._value;
      },
    });
  }

  *[Symbol.iterator]() {
    return iter([]);
  }

  get size() {
    return 0;
  }

  get length() {
    return 0;
  }
}

export function constantMapping(val: number) {
  return new ConstantMapping(val);
}

/**
 * This function take a dictionary and remove each entry with its key starting with `'default_'`
 * @param context 
 */
export function cleanContext(context) {
  const res = {};
  for (const [k, v] of Object.entries(context)) {
    if (!k.startsWith('default_')) {
      res[k] = v;
    }
  }
  return res;
}

export function dumpStacks(sig?: any, frame?: any, threadIdents?: any) {
  console.warn('Not implemented');
}

export function str2bool(s: string, value?: any) {
  s = s.toLowerCase();
  const y = 'y yes 1 true t on'.split(' ');
  const n = 'n no 0 false f off'.split(' ');
  if (!y.concat(n).includes(s)) {
    if (value == null) {
      throw new ValueError('Use 0/1/yes/no/true/false/on/off');
    }
    return bool(value);
  }
  return y.includes(s);
}

export function humanSize(sz) {
  if (!sz) {
    return false;
  }
  const units = ['bytes', 'Kb', 'Mb', 'Gb', 'Tb'];
  if (typeof sz === 'string') {
    sz = len(sz);
  }
  let [s, i] = [parseFloat(sz), 0];
  while (s >= 1024 && i < units.length - 1) {
    s /= 1024;
    i += 1;
  }
  return format("%s %s", s.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }), units[i]);
}

/**
 * Return a collection of pairs `'(key, elements)'` from `'iterable'`. The `'key'` is a function computing a key value for each element. This function is similar to `'itertools.groupby'`, but aggregates all elements under the same key, not only consecutive elements.
 * @param inversedFields 
 * @param arg1 
 * @returns 
 */
export function groupby(iterable: Iterable<any>, fKeyObj?: Function, fKeyId?: Function): IterableIterator<[any, any]> {
  if (fKeyObj == null) {
    fKeyObj = (arg) => arg;
  }
  const groups = new Map<any, any>();
  for (const elem of iterable) {
    const obj = fKeyObj(elem);
    const key = fKeyId ? fKeyId(obj) : obj;
    if (!groups.has(key)) {
      groups.set(key, [obj, []]);
    }
    groups.get(key)[1].push(elem);
  }
  return groups.values();
}

export async function groupbyAsync(iterable: Iterable<any>, fKeyObj?: Function, fKeyId?: Function): Promise<IterableIterator<[any, any]>> {
  if (fKeyObj == null) {
    fKeyObj = (arg) => arg;
  }
  const groups = new Map<any, any>();
  for (const elem of iterable) {
    const obj = await fKeyObj(elem);
    const key = fKeyId ? await fKeyId(obj) : obj;
    if (!groups.has(key)) {
      groups.set(key, [obj, []]);
    }
    groups.get(key)[1].push(elem);
  }
  return groups.values();
}

export function repr(obj: any) {
  if (typeof (obj) === 'object' && typeof (obj['repr']) === 'function') {
    return obj.repr();
  }
  return stringify(obj);
}

export function ignore(exc: any[], func: Function) {
  try {
    func();
  } catch (e) {
    if (!isInstance(e, ...exc)) {
      throw e;
    }
  }
}

/**
 * Return a pair equivalent to:
  `'partition(pred, elems), partition(x => !pred(x), elems)'`
 * @param pred 
 * @param elems 
 * @returns 
 */
export function partition(pred, elems): any[] {
  const yes = []
  const nos = []
  for (const elem of elems) {
    (pred(elem) ? yes : nos).push(elem);
  }
  return [yes, nos]
}

/**
 * Return a list of elements sorted so that their dependencies are listed
  before them in the result.
 * @param elems specifies the elements to sort with their dependencies; it is
      a dictionary like `{element: dependencies}` where `dependencies` is a
      collection of elements that must appear before `element`. The elements
      of `dependencies` are not required to appear in `elems`; they will
      simply not appear in the result.
 * @returns a list with the keys of `elems` sorted according to their
      specification
 */
export function topologicalSort(elems: {} = {}) {
  const result = [];
  const visited = new Set<any>();

  function visit(n) {
    if (!visited.has(n)) {
      visited.add(n);
      if (n in elems) {
        // first visit all dependencies of n, then append n to result
        for (const it of elems[n]) {
          visit(it);
        }
        result.push(n);
      }
    }
  }

  for (const el of Object.keys(elems)) {
    visit(el);
  }

  return result;
}

export function getIsoCodes(lang: string) {
  if (lang.indexOf('_') !== -1) {
    if (lang.split('_')[0] === lang.split('_')[1].toLowerCase()) {
      lang = lang.split('_')[0];
    }
  }
  return lang;
}

/**
 * Merge several iterables into a list. The result is the union of the
  iterables, ordered following the partial order given by the iterables,
  with a bias towards the end for the last iterable:

      seq = merge_sequences(['A', 'B', 'C'])
      assert seq == ['A', 'B', 'C']

      seq = merge_sequences(
          ['A', 'B', 'C'],
          ['Z'],                  # 'Z' can be anywhere
          ['Y', 'C'],             # 'Y' must precede 'C';
          ['A', 'X', 'Y'],        # 'X' must follow 'A' and precede 'Y'
      )
      assert seq == ['A', 'B', 'X', 'Y', 'C', 'Z']
 */
export function mergeSequences(...iterables) {
  // we use an OrderedDict to keep elements in order by default
  const deps = new Dict<any>();                // {item: elemsBeforeItem}
  for (const iterable of iterables) {
    let prev: any = null;
    for (const [index, item] of Object.entries<any>(iterable)) {
      if (!index) {
        deps.setdefault(item, []);
      }
      else {
        deps.setdefault(item, []).push(prev);
      }
      prev = item;
    }
  }
  return topologicalSort(deps);
}

const POSIX_TO_LDML = {
  'a': 'E',
  'A': 'EEEE',
  'b': 'MMM',
  'B': 'MMMM',
  //'c': '',
  'd': 'dd',
  'H': 'HH',
  'I': 'HH',
  'j': 'DDD',
  'm': 'MM',
  'M': 'mm',
  'p': 'a',
  'S': 'ss',
  'U': 'w',
  'w': 'e',
  'W': 'w',
  'y': 'yy',
  'Y': 'yyyy',
  // see comments above, and babel's format_datetime assumes an UTC timezone
  // for naive datetime objects
  //'z': 'Z',
  //'Z': 'z',
}

/**
 * Converts a posix/strftime pattern into an LDML date format pattern.

  :param fmt: non-extended C89/C90 strftime pattern
  :param locale: babel locale used for locale-specific conversions (e.g. %x and %X)
  :return: unicode
 * @param fmt 
 * @param locale 
 * @returns 
 */
export function posixToLdml(fmt: string, locale: any): string {
  const buf = [];
  let pc = false;
  let quoted = [];

  for (const c of fmt) {
    // LDML date format patterns uses letters, so letters must be quoted
    if (!pc && isAlpha(c)) {
      quoted.push(c !== "'" ? c : "''");
      continue;
    }
    if (quoted.length) {
      buf.push(quoted.join(''));
      quoted = [];
    }

    if (pc) {
      if (c === '%') // escaped percent
        buf.push('%');
      else if (c === 'x') // date format, short seems to match
        buf.push(locale.dateFormats['short'].pattern);
      else if (c === 'X') // time format, seems to include seconds. short does not
        buf.push(locale.timeFormats['medium'].pattern);
      else // look up format char in static mapping
        buf.push(POSIX_TO_LDML[c]);
      pc = false;
    }
    else if (c === '%')
      pc = true;
    else
      buf.push(c);
  }
  // flush anything remaining in quoted buffer
  if (quoted.length) {
    buf.push(quoted.join(''));
  }
  return buf.join('');
}

export const allTimezones =
  ['Africa/Abidjan',
    'Africa/Accra',
    'Africa/Addis_Ababa',
    'Africa/Algiers',
    'Africa/Asmara',
    'Africa/Asmera',
    'Africa/Bamako',
    'Africa/Bangui',
    'Africa/Banjul',
    'Africa/Bissau',
    'Africa/Blantyre',
    'Africa/Brazzaville',
    'Africa/Bujumbura',
    'Africa/Cairo',
    'Africa/Casablanca',
    'Africa/Ceuta',
    'Africa/Conakry',
    'Africa/Dakar',
    'Africa/Dar_es_Salaam',
    'Africa/Djibouti',
    'Africa/Douala',
    'Africa/El_Aaiun',
    'Africa/Freetown',
    'Africa/Gaborone',
    'Africa/Harare',
    'Africa/Johannesburg',
    'Africa/Juba',
    'Africa/Kampala',
    'Africa/Khartoum',
    'Africa/Kigali',
    'Africa/Kinshasa',
    'Africa/Lagos',
    'Africa/Libreville',
    'Africa/Lome',
    'Africa/Luanda',
    'Africa/Lubumbashi',
    'Africa/Lusaka',
    'Africa/Malabo',
    'Africa/Maputo',
    'Africa/Maseru',
    'Africa/Mbabane',
    'Africa/Mogadishu',
    'Africa/Monrovia',
    'Africa/Nairobi',
    'Africa/Ndjamena',
    'Africa/Niamey',
    'Africa/Nouakchott',
    'Africa/Ouagadougou',
    'Africa/Porto-Novo',
    'Africa/Sao_Tome',
    'Africa/Timbuktu',
    'Africa/Tripoli',
    'Africa/Tunis',
    'Africa/Windhoek',
    'America/Adak',
    'America/Anchorage',
    'America/Anguilla',
    'America/Antigua',
    'America/Araguaina',
    'America/Argentina/Buenos_Aires',
    'America/Argentina/Catamarca',
    'America/Argentina/ComodRivadavia',
    'America/Argentina/Cordoba',
    'America/Argentina/Jujuy',
    'America/Argentina/La_Rioja',
    'America/Argentina/Mendoza',
    'America/Argentina/Rio_Gallegos',
    'America/Argentina/Salta',
    'America/Argentina/San_Juan',
    'America/Argentina/San_Luis',
    'America/Argentina/Tucuman',
    'America/Argentina/Ushuaia',
    'America/Aruba',
    'America/Asuncion',
    'America/Atikokan',
    'America/Atka',
    'America/Bahia',
    'America/Bahia_Banderas',
    'America/Barbados',
    'America/Belem',
    'America/Belize',
    'America/Blanc-Sablon',
    'America/Boa_Vista',
    'America/Bogota',
    'America/Boise',
    'America/Buenos_Aires',
    'America/Cambridge_Bay',
    'America/Campo_Grande',
    'America/Cancun',
    'America/Caracas',
    'America/Catamarca',
    'America/Cayenne',
    'America/Cayman',
    'America/Chicago',
    'America/Chihuahua',
    'America/Coral_Harbour',
    'America/Cordoba',
    'America/Costa_Rica',
    'America/Creston',
    'America/Cuiaba',
    'America/Curacao',
    'America/Danmarkshavn',
    'America/Dawson',
    'America/Dawson_Creek',
    'America/Denver',
    'America/Detroit',
    'America/Dominica',
    'America/Edmonton',
    'America/Eirunepe',
    'America/El_Salvador',
    'America/Ensenada',
    'America/Fort_Nelson',
    'America/Fort_Wayne',
    'America/Fortaleza',
    'America/Glace_Bay',
    'America/Godthab',
    'America/Goose_Bay',
    'America/Grand_Turk',
    'America/Grenada',
    'America/Guadeloupe',
    'America/Guatemala',
    'America/Guayaquil',
    'America/Guyana',
    'America/Halifax',
    'America/Havana',
    'America/Hermosillo',
    'America/Indiana/Indianapolis',
    'America/Indiana/Knox',
    'America/Indiana/Marengo',
    'America/Indiana/Petersburg',
    'America/Indiana/Tell_City',
    'America/Indiana/Vevay',
    'America/Indiana/Vincennes',
    'America/Indiana/Winamac',
    'America/Indianapolis',
    'America/Inuvik',
    'America/Iqaluit',
    'America/Jamaica',
    'America/Jujuy',
    'America/Juneau',
    'America/Kentucky/Louisville',
    'America/Kentucky/Monticello',
    'America/Knox_IN',
    'America/Kralendijk',
    'America/La_Paz',
    'America/Lima',
    'America/Los_Angeles',
    'America/Louisville',
    'America/Lower_Princes',
    'America/Maceio',
    'America/Managua',
    'America/Manaus',
    'America/Marigot',
    'America/Martinique',
    'America/Matamoros',
    'America/Mazatlan',
    'America/Mendoza',
    'America/Menominee',
    'America/Merida',
    'America/Metlakatla',
    'America/Mexico_City',
    'America/Miquelon',
    'America/Moncton',
    'America/Monterrey',
    'America/Montevideo',
    'America/Montreal',
    'America/Montserrat',
    'America/Nassau',
    'America/New_York',
    'America/Nipigon',
    'America/Nome',
    'America/Noronha',
    'America/North_Dakota/Beulah',
    'America/North_Dakota/Center',
    'America/North_Dakota/New_Salem',
    'America/Ojinaga',
    'America/Panama',
    'America/Pangnirtung',
    'America/Paramaribo',
    'America/Phoenix',
    'America/Port-au-Prince',
    'America/Port_of_Spain',
    'America/Porto_Acre',
    'America/Porto_Velho',
    'America/Puerto_Rico',
    'America/Punta_Arenas',
    'America/Rainy_River',
    'America/Rankin_Inlet',
    'America/Recife',
    'America/Regina',
    'America/Resolute',
    'America/Rio_Branco',
    'America/Rosario',
    'America/Santa_Isabel',
    'America/Santarem',
    'America/Santiago',
    'America/Santo_Domingo',
    'America/Sao_Paulo',
    'America/Scoresbysund',
    'America/Shiprock',
    'America/Sitka',
    'America/St_Barthelemy',
    'America/St_Johns',
    'America/St_Kitts',
    'America/St_Lucia',
    'America/St_Thomas',
    'America/St_Vincent',
    'America/Swift_Current',
    'America/Tegucigalpa',
    'America/Thule',
    'America/Thunder_Bay',
    'America/Tijuana',
    'America/Toronto',
    'America/Tortola',
    'America/Vancouver',
    'America/Virgin',
    'America/Whitehorse',
    'America/Winnipeg',
    'America/Yakutat',
    'America/Yellowknife',
    'Antarctica/Casey',
    'Antarctica/Davis',
    'Antarctica/DumontDUrville',
    'Antarctica/Macquarie',
    'Antarctica/Mawson',
    'Antarctica/McMurdo',
    'Antarctica/Palmer',
    'Antarctica/Rothera',
    'Antarctica/South_Pole',
    'Antarctica/Syowa',
    'Antarctica/Troll',
    'Antarctica/Vostok',
    'Arctic/Longyearbyen',
    'Asia/Aden',
    'Asia/Almaty',
    'Asia/Amman',
    'Asia/Anadyr',
    'Asia/Aqtau',
    'Asia/Aqtobe',
    'Asia/Ashgabat',
    'Asia/Ashkhabad',
    'Asia/Atyrau',
    'Asia/Baghdad',
    'Asia/Bahrain',
    'Asia/Baku',
    'Asia/Bangkok',
    'Asia/Barnaul',
    'Asia/Beirut',
    'Asia/Bishkek',
    'Asia/Brunei',
    'Asia/Calcutta',
    'Asia/Chita',
    'Asia/Choibalsan',
    'Asia/Chongqing',
    'Asia/Chungking',
    'Asia/Colombo',
    'Asia/Dacca',
    'Asia/Damascus',
    'Asia/Dhaka',
    'Asia/Dili',
    'Asia/Dubai',
    'Asia/Dushanbe',
    'Asia/Famagusta',
    'Asia/Gaza',
    'Asia/Harbin',
    'Asia/Hebron',
    'Asia/Ho_Chi_Minh',
    'Asia/Hong_Kong',
    'Asia/Hovd',
    'Asia/Irkutsk',
    'Asia/Istanbul',
    'Asia/Jakarta',
    'Asia/Jayapura',
    'Asia/Jerusalem',
    'Asia/Kabul',
    'Asia/Kamchatka',
    'Asia/Karachi',
    'Asia/Kashgar',
    'Asia/Kathmandu',
    'Asia/Katmandu',
    'Asia/Khandyga',
    'Asia/Kolkata',
    'Asia/Krasnoyarsk',
    'Asia/Kuala_Lumpur',
    'Asia/Kuching',
    'Asia/Kuwait',
    'Asia/Macao',
    'Asia/Macau',
    'Asia/Magadan',
    'Asia/Makassar',
    'Asia/Manila',
    'Asia/Muscat',
    'Asia/Nicosia',
    'Asia/Novokuznetsk',
    'Asia/Novosibirsk',
    'Asia/Omsk',
    'Asia/Oral',
    'Asia/Phnom_Penh',
    'Asia/Pontianak',
    'Asia/Pyongyang',
    'Asia/Qatar',
    'Asia/Qostanay',
    'Asia/Qyzylorda',
    'Asia/Rangoon',
    'Asia/Riyadh',
    'Asia/Saigon',
    'Asia/Sakhalin',
    'Asia/Samarkand',
    'Asia/Seoul',
    'Asia/Shanghai',
    'Asia/Singapore',
    'Asia/Srednekolymsk',
    'Asia/Taipei',
    'Asia/Tashkent',
    'Asia/Tbilisi',
    'Asia/Tehran',
    'Asia/Tel_Aviv',
    'Asia/Thimbu',
    'Asia/Thimphu',
    'Asia/Tokyo',
    'Asia/Tomsk',
    'Asia/Ujung_Pandang',
    'Asia/Ulaanbaatar',
    'Asia/Ulan_Bator',
    'Asia/Urumqi',
    'Asia/Ust-Nera',
    'Asia/Vientiane',
    'Asia/Vladivostok',
    'Asia/Yakutsk',
    'Asia/Yangon',
    'Asia/Yekaterinburg',
    'Asia/Yerevan',
    'Atlantic/Azores',
    'Atlantic/Bermuda',
    'Atlantic/Canary',
    'Atlantic/Cape_Verde',
    'Atlantic/Faeroe',
    'Atlantic/Faroe',
    'Atlantic/Jan_Mayen',
    'Atlantic/Madeira',
    'Atlantic/Reykjavik',
    'Atlantic/South_Georgia',
    'Atlantic/St_Helena',
    'Atlantic/Stanley',
    'Australia/ACT',
    'Australia/Adelaide',
    'Australia/Brisbane',
    'Australia/Broken_Hill',
    'Australia/Canberra',
    'Australia/Currie',
    'Australia/Darwin',
    'Australia/Eucla',
    'Australia/Hobart',
    'Australia/LHI',
    'Australia/Lindeman',
    'Australia/Lord_Howe',
    'Australia/Melbourne',
    'Australia/NSW',
    'Australia/North',
    'Australia/Perth',
    'Australia/Queensland',
    'Australia/South',
    'Australia/Sydney',
    'Australia/Tasmania',
    'Australia/Victoria',
    'Australia/West',
    'Australia/Yancowinna',
    'Brazil/Acre',
    'Brazil/DeNoronha',
    'Brazil/East',
    'Brazil/West',
    'CET',
    'CST6CDT',
    'Canada/Atlantic',
    'Canada/Central',
    'Canada/Eastern',
    'Canada/Mountain',
    'Canada/Newfoundland',
    'Canada/Pacific',
    'Canada/Saskatchewan',
    'Canada/Yukon',
    'Chile/Continental',
    'Chile/EasterIsland',
    'Cuba',
    'EET',
    'EST',
    'EST5EDT',
    'Egypt',
    'Eire',
    'Etc/GMT',
    'Etc/GMT+0',
    'Etc/GMT+1',
    'Etc/GMT+10',
    'Etc/GMT+11',
    'Etc/GMT+12',
    'Etc/GMT+2',
    'Etc/GMT+3',
    'Etc/GMT+4',
    'Etc/GMT+5',
    'Etc/GMT+6',
    'Etc/GMT+7',
    'Etc/GMT+8',
    'Etc/GMT+9',
    'Etc/GMT-0',
    'Etc/GMT-1',
    'Etc/GMT-10',
    'Etc/GMT-11',
    'Etc/GMT-12',
    'Etc/GMT-13',
    'Etc/GMT-14',
    'Etc/GMT-2',
    'Etc/GMT-3',
    'Etc/GMT-4',
    'Etc/GMT-5',
    'Etc/GMT-6',
    'Etc/GMT-7',
    'Etc/GMT-8',
    'Etc/GMT-9',
    'Etc/GMT0',
    'Etc/Greenwich',
    'Etc/UCT',
    'Etc/UTC',
    'Etc/Universal',
    'Etc/Zulu',
    'Europe/Amsterdam',
    'Europe/Andorra',
    'Europe/Astrakhan',
    'Europe/Athens',
    'Europe/Belfast',
    'Europe/Belgrade',
    'Europe/Berlin',
    'Europe/Bratislava',
    'Europe/Brussels',
    'Europe/Bucharest',
    'Europe/Budapest',
    'Europe/Busingen',
    'Europe/Chisinau',
    'Europe/Copenhagen',
    'Europe/Dublin',
    'Europe/Gibraltar',
    'Europe/Guernsey',
    'Europe/Helsinki',
    'Europe/Isle_of_Man',
    'Europe/Istanbul',
    'Europe/Jersey',
    'Europe/Kaliningrad',
    'Europe/Kiev',
    'Europe/Kirov',
    'Europe/Lisbon',
    'Europe/Ljubljana',
    'Europe/London',
    'Europe/Luxembourg',
    'Europe/Madrid',
    'Europe/Malta',
    'Europe/Mariehamn',
    'Europe/Minsk',
    'Europe/Monaco',
    'Europe/Moscow',
    'Europe/Nicosia',
    'Europe/Oslo',
    'Europe/Paris',
    'Europe/Podgorica',
    'Europe/Prague',
    'Europe/Riga',
    'Europe/Rome',
    'Europe/Samara',
    'Europe/San_Marino',
    'Europe/Sarajevo',
    'Europe/Saratov',
    'Europe/Simferopol',
    'Europe/Skopje',
    'Europe/Sofia',
    'Europe/Stockholm',
    'Europe/Tallinn',
    'Europe/Tirane',
    'Europe/Tiraspol',
    'Europe/Ulyanovsk',
    'Europe/Uzhgorod',
    'Europe/Vaduz',
    'Europe/Vatican',
    'Europe/Vienna',
    'Europe/Vilnius',
    'Europe/Volgograd',
    'Europe/Warsaw',
    'Europe/Zagreb',
    'Europe/Zaporozhye',
    'Europe/Zurich',
    'GB',
    'GB-Eire',
    'GMT',
    'GMT+0',
    'GMT-0',
    'GMT0',
    'Greenwich',
    'HST',
    'Hongkong',
    'Iceland',
    'Indian/Antananarivo',
    'Indian/Chagos',
    'Indian/Christmas',
    'Indian/Cocos',
    'Indian/Comoro',
    'Indian/Kerguelen',
    'Indian/Mahe',
    'Indian/Maldives',
    'Indian/Mauritius',
    'Indian/Mayotte',
    'Indian/Reunion',
    'Iran',
    'Israel',
    'Jamaica',
    'Japan',
    'Kwajalein',
    'Libya',
    'MET',
    'MST',
    'MST7MDT',
    'Mexico/BajaNorte',
    'Mexico/BajaSur',
    'Mexico/General',
    'NZ',
    'NZ-CHAT',
    'Navajo',
    'PRC',
    'PST8PDT',
    'Pacific/Apia',
    'Pacific/Auckland',
    'Pacific/Bougainville',
    'Pacific/Chatham',
    'Pacific/Chuuk',
    'Pacific/Easter',
    'Pacific/Efate',
    'Pacific/Enderbury',
    'Pacific/Fakaofo',
    'Pacific/Fiji',
    'Pacific/Funafuti',
    'Pacific/Galapagos',
    'Pacific/Gambier',
    'Pacific/Guadalcanal',
    'Pacific/Guam',
    'Pacific/Honolulu',
    'Pacific/Johnston',
    'Pacific/Kiritimati',
    'Pacific/Kosrae',
    'Pacific/Kwajalein',
    'Pacific/Majuro',
    'Pacific/Marquesas',
    'Pacific/Midway',
    'Pacific/Nauru',
    'Pacific/Niue',
    'Pacific/Norfolk',
    'Pacific/Noumea',
    'Pacific/Pago_Pago',
    'Pacific/Palau',
    'Pacific/Pitcairn',
    'Pacific/Pohnpei',
    'Pacific/Ponape',
    'Pacific/Port_Moresby',
    'Pacific/Rarotonga',
    'Pacific/Saipan',
    'Pacific/Samoa',
    'Pacific/Tahiti',
    'Pacific/Tarawa',
    'Pacific/Tongatapu',
    'Pacific/Truk',
    'Pacific/Wake',
    'Pacific/Wallis',
    'Pacific/Yap',
    'Poland',
    'Portugal',
    'ROC',
    'ROK',
    'Singapore',
    'Turkey',
    'UCT',
    'US/Alaska',
    'US/Aleutian',
    'US/Arizona',
    'US/Central',
    'US/East-Indiana',
    'US/Eastern',
    'US/Hawaii',
    'US/Indiana-Starke',
    'US/Michigan',
    'US/Mountain',
    'US/Pacific',
    'US/Samoa',
    'UTC',
    'Universal',
    'W-SU',
    'WET',
    'Zulu']

export function timezone(tz) {
  return allTimezones.includes(tz) ? tz : false;
}

export function getTimezoneInfo(locale: string, zone?: any) {
  const tzinfo = Intl.DateTimeFormat([locale], { timeZone: zone }).resolvedOptions();
  return tzinfo;
}

export function setOptions(target: any, source: any, override: boolean = false) {
  source = source || {};
  target = target || {};

  let iterable = (source instanceof Map)
    ? source.entries()
    : Object.entries(source);

  let gFunc: Function = (k) => target[k];
  let sFunc: Function = (k, v) => target[k] = v;
  if (isInstance(target, Map, MultiDict, Dict)) {
    gFunc = (k) => target.get(k);
    sFunc = (k, v) => target.set(k, v);
  }
  for (const [k, v] of iterable) {
    if (v !== undefined && (override || gFunc(k) == undefined)) {
      sFunc(k, v);
    }
  }
  return target;
}

export function update(target: any, source: any, override: boolean = false) {
  return setOptions(target, source, override);
}

/**
 * Like enumerate but in the other direction

  Usage::
  >>> a = ['a', 'b', 'c']
  >>> it = reverse_enumerate(a)
  >>> it.next()
  (2, 'c')
  >>> it.next()
  (1, 'b')
  >>> it.next()
  (0, 'a')
  >>> it.next()
  Traceback (most recent call last):
    File "<stdin>", line 1, in <module>
  StopIteration
 * @param l 
 * @returns 
 */
export function reverseEnumerate<T>(l: any) {
  return _.zip<number, T>(Array.from(range(len(l) - 1, -1, -1)), Array.from<any>(l).reverse());
}

export function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Pop item with key
 * @param obj 
 * @param key 
 * @param defaultValue 
 * @returns 
 */
export function pop(obj: Object, key: string, defaultValue?: any) {
  const value = obj[key];
  delete obj[key];
  return value !== undefined ? value : defaultValue;
}

/**
 * Pop the last item
 * @param obj 
 * @param defaultValue 
 * @returns 
 */
export function popitem(obj: Object, defaultValue?: any) {
  const keys = Object.keys(obj);
  if (keys.length) {
    const key = keys[keys.length - 1];
    const value = obj[key];
    delete obj[key];
    return value !== undefined ? value : defaultValue;
  }
  return defaultValue;
}

export function md5(key, encoding: BinaryToTextEncoding = 'hex') {
  return crypto.createHmac('md5', key)
    .digest(encoding);
}

export function sha256(key, encoding: BinaryToTextEncoding = 'hex') {
  return crypto.createHmac('sha256', key)
    .digest(encoding);
}

export function sha512(key, encoding: BinaryToTextEncoding = 'hex') {
  return crypto.createHmac('sha512', key)
    .digest(encoding);
}

export function sha1(key, encoding: BinaryToTextEncoding = 'hex') {
  return crypto.createHmac('sha1', key)
    .digest(encoding);
}

export function hash(key, data?: any, algorithm: string = 'sha256', encoding: BinaryToTextEncoding = 'hex') {
  return crypto.createHmac(algorithm, key)
    .update(data ? Buffer.from(data) : 'I love verp')
    .digest(encoding);
}

/**
 * Compute HMAC with `database.secret` config parameter as key.   
  @param env sudo environment to use for retrieving config parameter
  @param message message to authenticate
  @param scope scope of the authentication, to have different signature for the same
      message in different usage
  @param data 
 */
export async function hmac(env, scope, data, algorithm = 'sha256', encoding: BinaryToTextEncoding = 'hex') {
  if (!scope) {
    throw new ValueError('Non-empty scope required');
  }

  const key = await env.items('ir.config.parameter').getParam('database.secret');
  data = repr([scope, data]);

  return crypto.createHmac(algorithm, Buffer.from(key, 'ascii'))
    .update(data, 'utf-8')
    .digest(encoding);
}

/**
 * Return a float with the magnitude (absolute value) of x but the sign of y.
  On platforms that support signed zeros, copysign(1.0, -0.0) returns -1.0.
 * @param x 
 * @param y 
 */
export function copysign(x: number, y: number) {
  return Math.abs(x) * (y >= 0 ? 1 : -1);
}

export async function processFileCsv(fileName: string, maxLines?: number): Promise<[string[], string[], string[]]> {
  const parser = fs
    .createReadStream(fileName)
    .pipe(parseCsv({
      skip_empty_lines: true
    }));

  return processParserCsv(parser, maxLines);
};

export async function processBufferCsv(buffer: Buffer, maxLines?: number): Promise<[string[], string[], string[]]> {
  const parser = Readable.from(buffer)
    .pipe(parseCsv({
      skip_empty_lines: true
    }));

  return processParserCsv(parser, maxLines);
};

async function processParserCsv(parser: Parser, maxLines?: number): Promise<[string[], string[], string[]]> {
  let lineNumber = 0;
  let fields;
  const records: any[] = [];
  const badLines: any[] = [];

  for await (const record of parser) {
    if (lineNumber == 0) {
      fields = record;
    } else {
      if (record.length != fields.length) {
        badLines.push([lineNumber, record]);
      }
      else {
        records.push(record);
      }
    }
    lineNumber++;
    if (maxLines && lineNumber > maxLines) {
      break;
    }
  }
  return [fields, records, badLines];
}

const algorithm = 'aes-192-cbc';
const salt = randomBytes(24); // 192/8
const lifetime = 25000;

export function encrypt(pass) {
  const hashedPassword = scryptSync(pass, salt, 24);
  console.log(hashedPassword.byteLength);
  const iv = randomBytes(16);
  const cipher = createCipheriv(algorithm, hashedPassword, iv);

  const encrypted = Buffer.concat([cipher.update(pass), cipher.final()]);
  return { algorithm, key: hashedPassword.toString('hex'), iv: iv.toString('hex'), encrypted: encrypted.toString('hex'), lifetime };
}

export function decrypt(info) {
  let key = Buffer.from(info.key, 'hex');
  let iv = Buffer.from(info.iv, 'hex');
  let encrypted = Buffer.from(info.encrypted, 'hex');

  let decipher = createDecipheriv(info.algorithm, key, iv);
  let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString();
}

//----------------------------------------------------------
// Postgres subprocesses
//----------------------------------------------------------

async function _execPipe(prog, args, env?: any) {
  const cmd = [prog,].concat(args);
  // on win32, passing closeFds=true is not compatible
  // with redirecting std[in/err/out]
  const closeFds = os.platform.name == "posix";
  const pop = { stdin: console, stdout: console }; //subprocess.Popen(cmd, bufsize=-1, stdin=subprocess.PIPE, stdout=subprocess.PIPE, closeFds=closeFds, env=env)
  return [pop.stdin, pop.stdout];
}

function findPgTool(name) {
  let path;
  if (tools.config.options['pgPath'] && tools.config.options['pgPath'] != 'null') {
    path = tools.config.options['pgPath'];
  }
  try {
    const result = whichSync(name, { path });
    return result;
  } catch (e) {
    throw new Error(`Command '${name}' not found.`);
  }
}

/**
 * Force the database PostgreSQL environment variables to the database
    configuration of Odoo.

    Note: On systems where pg_restore/pg_dump require an explicit password
    (i.e.  on Windows where TCP sockets are used), it is necessary to pass the
    postgres user password in the PGPASSWORD environment variable or in a
    special .pgpass file.

    See also http://www.postgresql.org/docs/8.4/static/libpq-envars.html
 * @returns 
 */
function execPgEnviron() {
  const env = Object.assign({}, process.env);
  if (tools.config.options['dbHost']) {
    env['PGHOST'] = tools.config.options['dbHost'];
  }
  if (tools.config.options['dbPort']) {
    env['PGPORT'] = String(tools.config.options['dbPort']);
  }
  if (tools.config.options['dbUser']) {
    env['PGUSER'] = tools.config.options['dbUser'];
  }
  if (tools.config.options['dbPassword']) {
    env['PGPASSWORD'] = tools.config.options['dbPassword'];
  }
  return env;
}

export async function execPgCommand(name, ...args) {
  const prog = findPgTool(name);
  const env = execPgEnviron();
  const cmd = [prog].concat(args).join(' ');
  const rc = spawnSync(
    cmd,
    {
      stdio: 'inherit',
      shell: false,
      env: env,
    }
  );
  if (rc) {
    throw new Error(`Postgres subprocess ${cmd} error ${rc}`);
  }
}

async function execPgCommandPipe(name, ...args) {
  const prog = await findPgTool(name);
  const env = execPgEnviron();
  return _execPipe(prog, args, env);
}