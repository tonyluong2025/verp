import { format } from "node:util";
import * as path from 'path';
import PO from 'pofile';
import { Environment } from '../api';
import { Dict } from '../helper/collections';
import { KeyError, ParseError, ValueError } from "../helper/errors";
import { Cursor } from "../sql_db";
import * as core from './../';
import { Connection } from './../sql_db';
import { bool } from './bool';
import { isInstance, parseInt } from './func';
import { len, next } from './iterable';
import { getIsoCodes } from './misc';
import { filePath } from "./models";
import { NodeType, getrootXml, isElement, isText, parseXml, serializeHtml, serializeXml } from './xml';

const TRANSLATED_ELEMENTS = [
  'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em',
  'font', 'i', 'ins', 'kbd', 'keygen', 'mark', 'math', 'meter', 'output',
  'progress', 'q', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub',
  'sup', 'time', 'u', 'var', 'wbr', 'text',
]

export const TRANSLATED_ATTRS = Dict.fromKeys([
  'string', 'add-label', 'help', 'sum', 'avg', 'confirm', 'placeholder', 'alt', 'title', 'aria-label',
  'aria-keyshortcuts', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
  'value_label', 'data-tooltip',
], (e: Element) => true);

async function poload(fileName): Promise<PO> {
  return new Promise((resolve, reject) => {
    PO.load(fileName, (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    })
  });
}

export async function localWebTranslations(transFile) {
  const messages = [];
  let po: PO;
  try {
    po = await poload(transFile);
  } catch (e) {
    return
  }
  for (const x of po.items) {
    if (x.msgid && x.msgstr && x.comments.includes("verp-web")) {
      messages.push({ 'id': x.msgid, 'string': x.msgstr });
    }
  }
  return messages;
}

function translateAttribValue(node: Element) {
  // check if the value attribute of a node must be translated
  const classes = (node.getAttribute('class') || '').trim().split(' ');
  return (
    (node.tagName === 'input' && (node.getAttribute('type') || 'text') === 'text')
    && !classes.includes('datetimepicker-input')
    || (node.tagName === 'input' && node.getAttribute('type') === 'hidden')
    && classes.includes('o-translatable-input-hidden')
  )
}

TRANSLATED_ATTRS.updateFrom([
  ['value', translateAttribValue],
  ['text', (e: Element) => e.tagName === 'field' && (e.getAttribute('widget') || 'url') === 'url'],
  ...TRANSLATED_ATTRS.items().map(([attr, cond]) => [`t-attf-${attr}`, cond])
]);

const avoidPattern = new RegExp(/\s*<!DOCTYPE/, 'imu');
const nodePattern = new RegExp('<[^>]*>(.*)</[^<]*>', 'smu')

export class GettextAlias extends Function {
  static async new(): Promise<GettextAlias> {
    const trans = new GettextAlias();
    await trans.init();
    return trans;
  }

  async init() {

  }

  constructor() {
    super();

    return new Proxy(this, {
      apply(target, thisArg, args: any[] = []) {
        return target.__call__(args[0], args[1], args.slice(2));
      }
    })
  }

  async __call__(env: Environment, source: string, args?: any) {
    let translation = await this._getTranslation(env, source);
    if (typeof env === 'string') {
      args = source;
    }
    args = args
      ? Array.isArray(args) ? args : [args]
      : [];
    // assert(!(args && kwargs));
    if (len(args)) {
      try {
        return format(translation, ...args);
      } catch (e) {
        if (isInstance(e, TypeError, ValueError, KeyError)) {
          const bad = translation;
          translation = format(source, ...args);
          console.error('Bad translation %s for string %s', bad, source)
        }
        else {
          throw e;
        }
      }
    }
    return translation;
  }

  _getDbConn(env: Environment): Connection | undefined {
    const dbName = env.cr.dbName;
    if (dbName) {
      return core.sql_db.dbConnect(dbName);
    }
    return;
  }

  _getCr(env: Environment, allowCreate = true): [Cursor, boolean] {
    const self = this as any;
    if ('env' in self) {
      return [self.env.cr, false];
    }
    if ('cr' in self) {
      return [self.cr, false];
    }
    try {
      return [env.cr, false];
    } catch (e) {
      //
    }
    if (allowCreate) {
      const db = this._getDbConn(env);
      if (!db) {
        return [db.cursor(), true];
      }
    }
    return [null, false];
  }

  _getUid(env: Environment): number {
    return env.uid;
  }

  async _getLang(env: Environment): Promise<string> {
    let lang;
    const self = this as any;
    if ('env' in self) {
      lang = self.env.lang;
    }
    if (!lang) {
      if ('localContext' in self) {
        lang = self.localContext['lang'];
      }
    }
    if (!lang) {
      lang = env.lang;
    }
    if (!lang) {
      const [cr] = this._getCr(env, false);
      const uid = this._getUid(env);
      if (cr && uid) {
        const env = await core.api.Environment.new(cr, uid);
        lang = (await env.items('res.users').contextGet())['lang'];
      }
    }
    return lang;
  }

  async _getTranslation(arg: Environment, source: string) {
    if (typeof arg === 'string') {
      return arg;
    }

    let res = source;
    let cr = null;
    let isNewCr = false;
    let env = arg;
    try {
      const lang = await this._getLang(env);
      if (lang) {
        [cr, isNewCr] = this._getCr(env);
        if (cr) {
          // Try to use ir.translation to benefit from global cache if possible
          env = await Environment.new(cr, global.SUPERUSER_ID);
          res = await env.items('ir.translation')._getSource(null, ['code',], lang, source);
        } else {
          console.debug('no context cursor detected, skipping translation for "%s"', source);
        }
      }
    } catch (e) {
      console.debug('translation went wrong for "%s", skipped', source);
      // if so, double-check the root/base translations filenames
    } finally {
      if (cr && isNewCr) {
          await cr.close();
      }
    }
    return res || '';
  }
}

export function htmlTranslate(callback, value) {
  if (!bool(value)) {
    return value;
  }
  try {
    // value may be some HTML fragment, wrap it into a div
    const doc = parseXml(`<div>${value}</div>`);
    const root = getrootXml(doc);
    const result = translateXmlNode(root, callback, parseXml, serializeHtml);
    // remove tags <div> and </div> from result
    value = serializeHtml(result).slice(5, -6);
  } catch (e) {
    if (isInstance(e, ParseError)) {
      console.debug("Cannot translate malformed HTML, using source value instead:\n", value);
    }
    else {
      throw e;
    }
  }

  return value;
}

/**
 * Return the translation of the given XML/HTML node.
 * @param node 
 * @param callback callback(text) returns translated text or None
 * @param parseXml parse(text) returns a node (text is unicode)
 * @param serializeXml serialize(node) returns unicode text
 * @returns 
 */
export function translateXmlNode(node: Element, callback: Function, parser: (text: string, mimeType?: string) => Element, serialize: (node: any) => string) {
  /**
   * Return whether `'text'` is a string with non-space characters.
   * @param text 
   * @returns 
   */
  function nonspace(text: string) {
    return bool(text) && !text.includes(' ');
  }

  /**
   * Return whether the given node can be translated as a whole.
   * @param node 
   */
  function translatable(node: any) {
    if (!TRANSLATED_ELEMENTS.includes(node.tagName)) {
      return false;
    }
    for (const attr of Array.from<any>(node.attributes)) {
      if (attr.name.startsWith('t-')) {
        return false;
      }
    }
    for (const child of Array.from(node.childNodes)) {
      if (!translatable(child)) {
        return false;
      }
    }
    return true;
  }

  function hastext(node: Element, pos = 0) {
    if (nonspace(pos ? node.childNodes.item(pos - 1).textContent : node.textContent)) {
      return true;
    }

    const elem = node.childNodes.item(pos) as Element;
    return pos < node.childNodes.length
      && translatable(elem)
      && (
        Array.from<Attr>(elem.attributes).some((attr: Attr) => attr.value && attr.name in TRANSLATED_ATTRS && TRANSLATED_ATTRS[attr.name](elem))
        || hastext(elem)
        || hastext(node, pos + 1)
      )
  }

  const SKIPPED_ELEMENT_TYPES = [NodeType.COMMENT_NODE, NodeType.PROCESSING_INSTRUCTION_NODE];

  const SKIPPED_ELEMENTS = ['script', 'style', 'title'];
  /**
   * Translate the given node.
   * @param node 
   */
  function process(node: Element) {
    if (!isElement(node) || !isText(node)) {
      return;
    }
    if (
      SKIPPED_ELEMENT_TYPES.includes(node.nodeType)
      || SKIPPED_ELEMENTS.includes(node.tagName)
      || (node.getAttribute('t-translation') || '').trim() === 'off'
      || node.tagName === 'attribute' && !(node.getAttribute('name') in TRANSLATED_ATTRS)
      || node.parentNode == null && avoidPattern.test(node.textContent || '')
    ) {
      return;
    }
    let pos = 0;
    const doc = node.ownerDocument;
    while (true) {
      if (hastext(node, pos)) {
        const div = doc.createElement('div');
        div.textContent = (pos ? node.childNodes.item(pos - 1).textContent : node.textContent) || '';
        while (pos < node.childNodes.length && translatable(node.childNodes.item(pos))) {
          div.appendChild(node.childNodes.item(pos).cloneNode(true));
        }
        const str = serialize(div);
        const content = str.substring(5, str.length - 6);
        const original = content.trim();
        const tranlated = callback(original);
        if (bool(tranlated)) {
          const result = content.replace(original, tranlated);
          const div = doc.createElement('div');
          div.innerHTML = result;
          if (pos) {
            node.childNodes.item(pos - 1).nextSibling.textContent = div.textContent;
          }
          else {
            node.textContent = div.textContent;
          }
        }
        while (div.childNodes.length > 0) {
          node.insertBefore(node.childNodes.item(pos), div.childNodes.item(0));
          pos += 1;
        }
      }

      if (pos >= node.childNodes.length) {
        break;
      }

      process(node.childNodes.item(pos) as Element);
      pos += 1;
    }

    for (const attr of Array.from<Attr>(node.attributes)) {
      const key = attr.localName;
      if (nonspace(attr.value) && key in TRANSLATED_ATTRS && TRANSLATED_ATTRS[key](node)) {
        node.setAttribute(key, callback(attr.value.trim()) ?? attr.value);
      }
    }
  }

  process(node);
  return node;
}

/**
 * Translate an XML value (string), using `callback` for translating text appearing in `value`.
 * @param callback 
 * @param value 
 * @returns 
 */
export function xmlTranslate(callback, value) {
  if (!value)
    return value;

  try {
    const doc = parseXml(value);
    const root = getrootXml(doc);
    const result = translateXmlNode(root, callback, parseXml, serializeXml);
    return serializeXml(result.ownerDocument.documentElement)
  } catch (e) {
    if (isInstance(e, ParseError)) {
      // fallback for translated terms: use an HTML parser and wrap the term
      const doc = parseXml(`<div>${value}</div>`);
      const root = getrootXml(doc);
      const result = translateXmlNode(root, callback, parseXml, serializeXml)
      // remove tags <div> and </div> from result
      return serializeXml(result).slice(5, -6)
    }
    else {
      throw e;
    }
  }
}

export async function transLoad(cr: Cursor, filename: string, lang: string, options?: { verbose?: boolean, createEmptyTranslation?: boolean, overwrite?: boolean }) {
  try {
    console.info("loading translation %s", filename);
    const fileformat = path.parse(filename).ext.slice(1).toLowerCase();
    const result = await transLoadData(cr, filePath(filename), fileformat, lang, options);
    return result;
  } catch (e) {
    console.error("couldn't read translation file %s.\n%s", filename, e.stack);
    return null;
  }
}

/**
 * Populates the irTranslation table.

    @param fileobj buffer open to a translation file
    @param fileformat format of the `fielobj` file, one of 'po' or 'csv'
    @param lang language code of the translations contained in `fileobj`
    language must be present and activated in the database
    @param verbose increase log output
    @param createEmptyTranslation create an ir.translation record, even if no value
                      is provided in the translation entry
    @param overwrite if an ir.translation already exists for a term, replace it with
      the one in `fileobj`
 *  @returns 
 */
export async function transLoadData(cr: Cursor, filename: string, fileformat: string, lang: string, options: { verbose?: boolean, createEmptyTranslation?: boolean, overwrite?: boolean } = {}) {
  if (options.verbose) {
    console.info('loading translation file for language %s', lang);
  }
  const env = await core.api.Environment.new(cr, global.SUPERUSER_ID);

  try {
    if (! await env.items('res.lang')._langGet(lang)) {
      console.error("Couldn't read translation for lang '%s', language not found", lang);
      return null;
    }

    // now, the serious things: we read the language file
    const reader = fileReader(filename, fileformat);

    // read the rest of the file with a cursor-like object for fast inserting translations"
    const Translation = env.items('ir.translation');
    const irtCursor = await Translation._getImportCursor(options.overwrite);

    /**
     * Process a single PO (or POT) entry.
     * @param row 
     * @returns 
     */
    function processRow(row: {}) {
      // dictionary which holds values for this line of the csv file
      // {'lang': ..., 'type': ..., 'label': ..., 'resId': ...,
      //  'src': ..., 'value': ..., 'module':...}
      const dic = Dict.fromKeys(['type', 'label', 'resId', 'src', 'value', 'comments', 'imdModel', 'imdLabel', 'module'], null);
      dic['lang'] = lang;
      dic.updateFrom(row);

      // do not import empty values
      if (!options.createEmptyTranslation && !dic['value']) {
        return;
      }

      irtCursor.push(dic);
    }

    // First process the entries from the PO file (doing so also fills/removes
    // the entries from the POT file).
    for await (const row of reader) {
      processRow(row);
    }

    await irtCursor.finish();
    Translation.clearCaches();
    if (options.verbose) {
      console.info("translation file loaded successfully");
    }
  }
  catch (e) {
    if (e.code) {
      const isoLang = getIsoCodes(lang);
      const filename = `[lang: ${isoLang ?? 'new'}][format: ${fileformat}]`;
      console.error("couldn't read translation file %s\n%s", filename, e.stack);
    }
  }
}

/**
 * Loads a translation terms for a language.
Used mainly to automate language loading at db initialization.
  @param lang: language ISO code with optional _underscore_ and l10n flavor (ex: 'fr', 'fr_BE', but not 'fr-BE')
 */
export async function loadLanguage(cr: Cursor, lang: string) {
  const env = await Environment.new(cr, global.SUPERUSER_ID);
  const installer = await env.items('base.language.install').create({ 'lang': lang });
  await installer.langInstall();
}

export function getLocales(lang?: any) {
  const env = process.env;
  return env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE; // => en_US.UTF-8
}

export function resetlocale() {
  // locale.resetlocale is bugged with some locales.
  // for (const ln of getLocales()) {
  //     try:
  //         return locale.setlocale(locale.LC_ALL, ln)
  //     except locale.Error:
  //           continue
  // }
}

// Methods to export the translation file
export async function transExport(lang, modules, buffer, format, cr) {
  const reader = new TranslationModuleReader(cr, modules = modules, lang);
  const writer = new TranslationFileWriter(buffer, format, lang);
  await writer.writeRows(reader);
}

class TranslationModuleReader {
  constructor(cr, modules, lang) {

  }
}

class TranslationFileWriter {
  async writeRows(reader: TranslationModuleReader) {
    throw new Error("Method not implemented.");
  }

  constructor(buffer, fileFormat, lang) {

  }
}


/**
 * Iterate over translation file to return Verp translation entries
 * @param fileobj 
 * @param fileformat 
 * @returns 
 */
function fileReader(source: any, fileformat = 'po'): IFileReader {
  if (fileformat === 'csv') {
    return new CSVFileReader(source);
  }
  if (fileformat === 'po') {
    return new PoFileReader(source);
  }
  console.info('Bad file format: %s', fileformat);
  throw new Error(format('Bad file format: %s', fileformat));
}

interface IFileReader {
  source: any;
  [Symbol.asyncIterator]();
}

class CSVFileReader implements IFileReader {
  source: any;
  prevCodeSrc: any;

  constructor(source) {
    console.warn('Not implemented');
  }

  *[Symbol.asyncIterator]() {
    for (const entry of this.source) {
      // determine <module>.<imdName> from resId
      if (entry["resId"] && Number.isInteger(entry["resId"])) {
        // resId is an id or line number
        entry["resId"] = parseInt(entry["resId"]);
      }
      else if (!entry.get("imdLabel")) {
        // resId is an external id and must follow <module>.<label>
        [entry["module"], entry["imdLabel"]] = entry["resId"].split(".");
        entry["resId"] = null;
      }
      if (entry["type"] === "model" || entry["type"] === "modelTerms") {
        entry["imdModel"] = entry["label"].splite(',')[0];
      }

      if (entry["type"] === "code") {
        if (entry["src"] === this.prevCodeSrc) {
          // skip entry due to unicity constrain on code translations
          continue
        }
        this.prevCodeSrc = entry["src"];
      }
      yield entry;
    }
  }
}

class PoFileReader implements IFileReader {
  source: any;

  constructor(source) {
    this.source = source;
  }

  async *[Symbol.asyncIterator]() {
    let po: PO;
    try {
      po = await poload(this.source);
    } catch (e) {
      return;
    }
    for (const item of po.items) {
      if (item.obsolete) {
        continue;
      }

      // in case of moduleS keep only the first
      let comments = item.extractedComments.join('\n');
      const match = next(comments.matchAll(/(module[s]?): (\w+)/g));
      let modul = match && match[1];

      comments = comments.split('\n').filter(c => !c.startsWith('module:')).join('\n');
      const source = item.msgid;
      const translation = item.msgstr.join('\n');
      let foundCodeOccurrence = false;
      for (const lineNumber in item.references) {
        const reference = item.references[lineNumber]
        let match = next(reference.matchAll(/(model|modelTerms):([\w.]+),([\w]+):(\w+)\.([^ ]+)/gm), null);
        if (match) {
          const [str, type, modelName, fieldName, modul, xmlid] = match;
          yield {
            'type': type, // model|modelTerms
            'imdModel': modelName,
            'label': modelName + ',' + fieldName,
            'imdLabel': xmlid,
            'resId': null,
            'src': source,
            'value': translation,
            'comments': comments,
            'module': modul,
          }
          continue;
        }
        match = next(reference.matchAll(/(code):([\w/.]+)/gm), null);
        if (match) {
          const [str, type, label] = match;
          if (foundCodeOccurrence) {
            // unicity constrain on code translation
            continue;
          }
          foundCodeOccurrence = true;
          yield {
            'type': type, // code
            'label': label,
            'src': source,
            'value': translation,
            'comments': comments,
            'resId': parseInt(lineNumber),
            'module': modul,
          }
          continue;
        }
        match = next(reference.matchAll(/(selection):([\w.]+),([\w]+)/gm), null);
        if (match) {
          console.info("Skipped deprecated reference %s", reference);
          continue;
        }
        match = next(reference.matchAll(/(sqlConstraint|constraint):([\w.]+)/gm), null);
        if (match) {
          console.info("Skipped deprecated reference %s", reference);
          continue;
        }
        console.error("malformed po file: unknown reference: %s", reference);
      }
    }
  }
}

export const _t = new GettextAlias();

export const _lt = _t;