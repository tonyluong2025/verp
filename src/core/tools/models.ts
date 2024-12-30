import fs from 'fs';
import fsPro from 'fs/promises';
import { DateTime } from 'luxon';
import path from 'path';
import { _Datetime, addons, modules } from '..';
import { FileNotFoundError, ValueError } from '../helper/errors';
import { bool } from './bool';
import { isInstance } from './func';
import { isList, itemgetter, len, sorted } from './iterable';
import { parseLocale } from './locale';
import { DATE_LENGTH, FileDescriptor, expandVars, isFile, posixToLdml, processFileCsv } from './misc';
import { _f, f } from './utils';
import { config } from './config';
import { toFormat } from './date_utils';

const DATE_FORMATS = {
  medium: 'DD',
  short: 'D'
}

const TIME_FORMATS = {
  medium: 'tt',
  short: 't'
}

/**
 * Retrieve the first lang object installed, by checking the parameter langCode,
  the context and then the company. If no lang is installed from those variables,
  fallback on the first lang installed in the system.
 * @param env an environment
 * @param langCode the locale (i.e. en_US)
 * @returns res.lang: the first lang found that is installed on the system.
 */
export async function getLang(env, langCode = false) {
  let langs = await env.items('res.lang').getInstalled();
  langs = langs.map(([code, x]) => code);
  let lang = langs[0];
  if (langCode && langs.includes(langCode))
    lang = langCode;
  else if (langs.includes(env.context['lang']))
    lang = env.context['lang'];
  else {
    const l = await (await (await (await env.user()).companyId).partnerId).lang;
    if (langs.includes(l)) {
      lang = l;
    }
  }
  return env.items('res.lang')._langGet(lang);
}

/**
 * Formats the date in a given format.
 * @param env an environment
 * @param value Date or string value: the date to format
 * @param langCode the lang code, if not specified it is extracted from the
      environment context
 * @param dateFormat the format or the date (LDML format), if not specified the
      default format of the lang
 * @returns date formatted in the specified format
 */
export async function formatDate(env, value, langCode = false, dateFormat?: any) {
  if (!value) {
    return ''; 
  }
  if (typeof (value) === 'string') {
    if (len(value) < DATE_LENGTH) {
      return '';
    }
    if (len(value) > DATE_LENGTH) {
      // a datetime, convert to correct timeZone
      value = _Datetime.toDatetime(value);
      value = await _Datetime.contextTimestamp(env.items('res.lang'), value);
    }
    else {
      value = _Datetime.toDatetime(value);
    }
  }

  const lang = await getLang(env, langCode);
  const locale = parseLocale(await lang.code)[0];
  if (!dateFormat) {
    // "%m/%d/%Y %H:%M:%S" => "MM/dd/yyyy HH:mm:ss" // POSIX-format date and time
    dateFormat = posixToLdml(await lang.dateFormat, locale);
  } else if (['short', 'medium'].includes(dateFormat)) {
    dateFormat = posixToLdml(DATE_FORMATS[dateFormat], locale);
  }
  return toFormat(value, dateFormat, { locale: locale });
}

/**
 * Format the given time (hour, minute and second) with the current user preference (language, format, ...)
 * @param env an environment
 * @param value the time to format. `Date` instance. Could be timezoned to display tzinfo according to format (e.i.: 'full' format)
 * @param tz name of the timezone  in which the given datetime should be localized
 * @param timeFormat one of “full”, “long”, “medium”, or “short”, or a custom time pattern
 * @param langCode ISO
 * @returns 
 */
export async function formatTime(env, value, tz?: any, timeFormat: string = 'medium', langCode?: any) {
  if (!value) {
    return '';
  }

  let localizedDatetime;
  if (isInstance(value, Date)) {
    localizedDatetime = value;
  }
  else {
    if (typeof (value) === 'string') {
      value = _Datetime.toDatetime(value);
    }
    const tzName = tz || await (await env.user()).tz || 'UTC';
    const utcDatetime = value.toISOString();
    try {
      localizedDatetime = DateTime.fromISO(value.toISOString(), { zone: tzName }).toJSDate();
    } catch (e) {
      localizedDatetime = utcDatetime;
    }
  }
  const lang = await getLang(env, langCode);
  const locale = parseLocale(await lang.code)[0];
  if (!timeFormat) {
    timeFormat = posixToLdml(await lang.timeFormat, locale);
  } else if (['short', 'medium'].includes(timeFormat)) {
    timeFormat = posixToLdml(TIME_FORMATS[timeFormat], locale);
  }

  return toFormat(localizedDatetime, timeFormat, { locale: locale });
}

/**
 * Formats the datetime in a given format.
 * @param env an environment
 * @param value [string, Date] naive datetime to format either in string or in datetime
 * @param tz name of the timezone  in which the given datetime should be localized
 * @param dtFormat one of “full”, “long”, “medium”, or “short”, or a custom date/time pattern compatible with `babel` lib
 * @param langCode ISO code of the language to use to render the given datetime
 * @returns 
 */
export async function formatDatetime(env, value, tz?: any, dtFormat: string = 'medium', langCode?: any) {
  if (!value) {
    return '';
  }
  let timestamp, localizedDatetime;
  if (typeof (value) === 'string') {
    value = _Datetime.toDatetime(value);
  }
  else {
    timestamp = value;
  }

  const tzName = tz || await (await env.user()).tz || 'UTC';
  const utcDatetime = value.toISOString();
  try {
    localizedDatetime = DateTime.fromISO(value.toISOString(), { zone: tzName }).toJSDate();
  } catch (e) {
    localizedDatetime = utcDatetime;
  }

  const lang = await getLang(env, langCode);
  const locale = parseLocale(await lang.code)[0];
  if (!dtFormat) {
    const dateFormat = posixToLdml(await lang.dateFormat, locale);
    const timeFormat = posixToLdml(await lang.timeFormat, locale);
    dtFormat = f('%s %s', dateFormat, timeFormat);
  } else if (['short', 'medium'].includes(dtFormat)) {
    const dateFormat = posixToLdml(DATE_FORMATS[dtFormat], locale);
    const timeFormat = posixToLdml(TIME_FORMATS[dtFormat], locale);
    dtFormat = f('%s %s', dateFormat, timeFormat);
  }

  // Babel allows to format datetime in a specific language without change locale
  // So month 1 = January in English, and janvier in French
  // Be aware that the default value for format is 'medium', instead of 'short'
  //     medium:  Jan 5, 2016, 10:20:31 PM |   5 janv. 2016 22:20:31
  //     short:   1/5/16, 10:20 PM         |   5/01/16 22:20
  // Formatting available here : http://babel.pocoo.org/en/latest/dates.html#date-fields
  return toFormat(localizedDatetime, dtFormat, { locale });
}

/**
 * Verify that a file exists under a known `addonsPath` directory and return its full path.
 * Examples::
 * >>> filePath('hr')
 * >>> filePath('hr/static/description/icon.png')
 * >>> filePath('hr/static/description/icon.png', ['.png', '.jpg'])
 * @param name string: absolute file path, or relative path within any `addonsPath` directory
 * @param filterExt string[]: optional list of supported extensions (lowercase, with leading dot)
 * @returns string: the absolute path to the file
 * @throws FileNotFoundError: if the file is not found under the known `addonsPath` directories
 * @throws ValueError: if the file doesn't have one of the supported extensions (`filterExt`)
 */
export function filePath(name: string, filterExt: string | string[] = ['']) {
  require('./../globals');

  const addonsPaths = new Set(addons.paths.slice());
  addonsPaths.add(global.ROOT_PATH);
  const isAbs = path.isAbsolute(name);
  let normalizedPath = path.normalize(expandVars(name));
  if (len(filterExt)) {
    const filter = typeof filterExt === 'string' ? [filterExt] : filterExt;
    let support = false;
    for (const ext of filter) {
      if (ext === '*.*') {
        support = true;
        break;
      }
      if (normalizedPath.toLowerCase().endsWith(ext)) {
        support = true;
        break;
      }
    }
    if (!support) {
      throw new ValueError("Unsupported file: " + name);
    }
  }
  if (normalizedPath.startsWith('addons' + path.sep)) {
    normalizedPath = normalizedPath.slice(7);
  }
  for (const addonsDir of addonsPaths) {
    const parentPath = path.normalize(expandVars(addonsDir)) + path.sep;
    const fPath = isAbs ? normalizedPath : path.normalize(expandVars(path.join(parentPath, normalizedPath)));
    if (fPath.startsWith(parentPath) && fs.existsSync(fPath)) {
      return fPath;
    }
  }

  throw new FileNotFoundError("File not found: " + name);
}


/**
 * Format a float: used to display integral or fractional values as
      human-readable time spans (e.g. 1.5 as "01:30").
 * @param value 
 * @returns 
 */
export function formatDuration(value, opts: {} = {}) {
  const time = Math.abs(value) * 60;
  let hours = Math.round(time / 60);
  let minutes = Math.round(time % 60);
  if (minutes == 60) {
    minutes = 0;
    hours += 1;
  }
  if (value < 0) {
    return `-${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Format a number to display to nearest metrics unit next to it.
 
    Do not display digits if all visible digits are null.
    Do not display units higher then "Tera" because most of people don't know what
    a "Yotta" is.
 
    >>> formatDecimalizedNumber(123_456.789)
    123.5k
    >>> formatDecimalizedNumber(123_000.789)
    123k
    >>> formatDecimalizedNumber(-123_456.789)
    -123.5k
    >>> formatDecimalizedNumber(0.789)
    0.8
 * @param number 
 * @param decimal 
 */
export function formatDecimalizedNumber(num: number, decimal = 1) {
  for (const unit of ['', 'k', 'M', 'G']) {
    if (Math.abs(num) < 1000.0) {
      return f("%g%s", num.toFixed(decimal), unit);
    }
    num /= 1000.0;
  }
  return f("%g%s", num.toFixed(decimal), 'T');
}

/**
 * Format a amount to display the currency and also display the metric unit of the amount.
 
  >>> formatDecimalizedAmount(123_456.789, res.currency("$"))
  $123.5k
 * @param amount 
 * @param currency 
 * @returns 
 */
export function formatDecimalizedAmount(amount, currency?: { position?: any, symbol?: any }) {
  const formatedAmount = formatDecimalizedNumber(amount);

  if (!currency) {
    return formatedAmount;
  }

  if (currency.position === 'before') {
    return f("%s%s", currency.symbol || '', formatedAmount);
  }
  return f("%s %s", formatedAmount, currency.symbol || '');
}


/**
 * Returns all languages supported by VERP for translation

 * @returns [[string, unicode]]: a list of [langCode, langName] pairs
 */
export async function scanLanguages() {
  const csvpath = modules.getResourcePath('base', 'data', 'res.lang.csv');
  try {
    const [fields, data, badLines] = await processFileCsv(csvpath);
    const codeIndex = fields.indexOf("code");
    const labelIndex = fields.indexOf("label");
    if (labelIndex == -1 || codeIndex == -1) {
      console.error("Import specification does not contain 'label' and 'code'. Cannot continue.");
      return;
    }
    if (badLines.length) {
      console.warn(`Has ${badLines.length} error lines`);
    }
    let list = data ? data.map(l => [l[2], l[1]]) : [["en_US", "English"], ["vi_VN", "Tiếng Việt"]];
    list = sorted(list, itemgetter([1]));
    const codes = config.get('langCodes');
    if (isList(data) && isList(codes)) {
      for (const code of Array.from(codes).map(code => code[0]).reverse()) {
        const idx = list.findIndex(elem => elem[0] === code);
        if (idx >= 0) {
          list.unshift(list.splice(idx, 1)[0]);
        }
      }
    }
    return list;
  } catch (e) {
    console.error("Could not read %s", csvpath);
    return [];
  }
}

export function fileOpen(name: string, flag?: string, filterExt?: string | string[]): FileDescriptor {
  const file = filePath(name, filterExt);
  if (isFile(file)) {
    const fd = fs.openSync(file, flag);
    return new FileDescriptor(file, fd, flag);
  } else {
    throw new FileNotFoundError(`Not a file: ${file}`);
  }
}

export function fileRead(name: number | string, options?: BufferEncoding | { encoding?: BufferEncoding, flag?: string | undefined, binary?: boolean | undefined }) {
  return fs.readFileSync(typeof name === 'number' ? name : filePath(name), options);
}

export function fileClose(fd: number) {
  return fs.closeSync(fd);
}

export function fileWrite(name: string, buffer: Buffer, force = true) {
  const fd = fs.openSync(name, force ? 'w' : 'wx');
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
  fileClose(fd);
}

export async function fileExist(fullPath) {
  try {
    await fsPro.access(fullPath, fsPro.constants.F_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Directory tree generator.

    For each directory in the directory tree rooted at top (including top
    itself, but excluding '.' and '..'), yields a 3-tuple

        dirpath, dirnames, filenames

    dirpath is a string, the path to the directory.  dirnames is a list of
    the names of the subdirectories in dirpath (excluding '.' and '..').
    filenames is a list of the names of the non-directory files in dirpath.
    Note that the names in the lists are just names, with no path components.
    To get a full path (which begins with top) to a file or directory in
    dirpath, do os.path.join(dirpath, name).

    If optional arg 'topdown' is true or not specified, the triple for a
    directory is generated before the triples for any of its subdirectories
    (directories are generated top down).  If topdown is false, the triple
    for a directory is generated after the triples for all of its
    subdirectories (directories are generated bottom up).

    When topdown is true, the caller can modify the dirnames list in-place
    (e.g., via del or slice assignment), and walk will only recurse into the
    subdirectories whose names remain in dirnames; this can be used to prune the
    search, or to impose a specific order of visiting.  Modifying dirnames when
    topdown is false has no effect on the behavior of os.walk(), since the
    directories in dirnames have already been generated by the time dirnames
    itself is generated. No matter the value of topdown, the list of
    subdirectories is retrieved before the tuples for the directory and its
    subdirectories are generated.

    By default errors from the os.scandir() call are ignored.  If
    optional arg 'onerror' is specified, it should be a function; it
    will be called with one argument, an OSError instance.  It can
    report the error to continue with the walk, or raise the exception
    to abort the walk.  Note that the filename is available as the
    filename attribute of the exception object.

    By default, os.walk does not follow symbolic links to subdirectories on
    systems that support them.  In order to get this functionality, set the
    optional argument 'followlinks' to true.

    Caution:  if you pass a relative pathname for top, don't change the
    current working directory between resumptions of walk.  walk never
    changes the current directory, and assumes that the client doesn't
    either.

    Example:

    import os
    from os.path import join, getsize
    for root, dirs, files in os.walk('~/Lib/email'):
        print(root, "consumes", end="")
        print(sum([getsize(join(root, name)) for name in files]), end="")
        print("bytes in", len(files), "non-directory files")
        if 'CVS' in dirs:
            dirs.remove('CVS')  # don't visit CVS directories
 * @param top 
 * @param topdown 
 * @param onerror 
 * @param followlinks 
 */
export async function* walkDir(top, topdown = true, onerror?: Function, followlinks = false) {
  top = path.normalize(top);

  // We may not have read permission for top, in which case we can't
  // get a list of the files the directory contains.  os.walk
  // always suppressed the exception then, rather than blow up for a
  // minor reason when (say) a thousand readable directories are still
  // left to visit.  That logic is copied here.
  let dirents: any[] = [];
  try {
    // Note that scandir is global in this module due
    // to earlier import-*.
    dirents = await fsPro.readdir(top, { withFileTypes: true, recursive: true });
  } catch (e) {
    if (typeof onerror === 'function') {
      onerror(e);
    }
    return;
  }
  const dirs: string[] = [];
  const nondirs: string[] = [];
  const walkDirs: string[] = [];
  for (const entry of dirents) {
    const isDir = entry.isDirectory();
    if (isDir) {
      dirs.push(entry.name);
    }
    else {
      nondirs.push(entry.name);
    }
    if (!topdown && isDir) {
      // Bottom-up: recurse into sub-directory, but exclude symlinks to
      // directories if followlinks is False
      let walkInto: boolean;
      if (followlinks) {
        walkInto = true;
      }
      else {
        walkInto = !entry.isSymbolicLink();
      }
      if (walkInto) {
        walkDirs.push(entry.path);
      }
    }
  }
  // Yield before recursion if going top down
  if (topdown) {
    yield [top, dirs, nondirs];

    // Recurse into sub-directories
    for (const dirname of dirs) {
      const newPath = path.join(top, dirname);
      if (followlinks) {
        for await (const [top, dirs, nondirs] of walkDir(newPath, topdown, onerror, followlinks)) {
          yield [top, dirs, nondirs];
        }
      }
    }
  }
  else {
    // Recurse into sub-directories
    for (const newPath of walkDirs) {
      for await (const [top, dirs, nondirs] of walkDir(newPath, topdown, onerror, followlinks)) {
        yield [top, dirs, nondirs];
      }
    }
    // Yield after recursion if going bottom up
    yield [top, dirs, nondirs];
  }
}

const nbsp = ' '; //'\u00a0';
/**
 *  Assuming 'Account' decimal.precision=3:
    formatLang(value) -> digits=2 (default)
    formatLang(value, digits=4) -> digits=4
    formatLang(value, dp='Account') -> digits=3
    formatLang(value, digits=5, dp='Account') -> digits=5

 * @param env 
 * @param value 
 * @param digits 
 * @param grouping 
 * @param monetary 
 * @param dp 
 * @param currencyObj 
 * @returns 
 */
export async function formatLang(env, value, options: { digits?: any, grouping?: any, monetary?: any, dp?: any, currencyObj?: any } = {}) {
  const grouping = options.grouping ?? true;
  const currencyObj = options.currencyObj;
  const dp = options.dp;
  const monetary = options.monetary;
  let digits = options.digits;
  let decimalPrecisionObj;
  if (digits == null) {
    digits = 2;
    if (dp) {
      decimalPrecisionObj = env.items('decimal.precision');
      digits = await decimalPrecisionObj.precisionGet(dp);
    }
    else if (bool(currencyObj)) {
      digits = await currencyObj.decimalPlaces;
    }
  }

  if (typeof (value) === 'string' && !value) {
    return '';
  }

  const langObj = await getLang(env);

  let res = await langObj.format('%sf', value.toFixed(digits), grouping, monetary);

  if (bool(currencyObj) && await currencyObj.symbol) {
    const [symbol, position] = await currencyObj('symbol', 'position');
    if (position === 'after') {
      res = f('%s%s%s', res, nbsp, symbol);
    }
    else if (position === 'before') {
      res = f('%s%s%s', symbol, nbsp, res);
    }
  }
  return res;
}

export async function formatAmount(env, amount, currency, langCode: boolean = false) {
  const fmt = _f("%.{value}", { value: await currency.decimalPlaces });
  const lang = await getLang(env, langCode);

  let formattedAmount = (await lang.format(fmt, await currency.round(amount), { grouping: true, monetary: true }));
  formattedAmount = formattedAmount.replace(' ', nbsp).replace('-', '-\u200b'); //U+200B

  let pre = '', post = '';
  if (await currency.position === 'before') {
    pre = _f('{symbol}{nbsp}', { symbol: await currency.symbol || '', nbsp: nbsp }); // U+00A0
  }
  else {
    post = _f('{nbsp}{symbol}', { symbol: await currency.symbol || '', nbsp: nbsp }); // &nbsp;
  }

  return _f('{pre}{value}{post}', { value: formattedAmount, pre: pre, post: post });
}