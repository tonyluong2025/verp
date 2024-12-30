import { format } from "util";
import { escapeRegExp } from "lodash";

const VERP_MODULE_RE = /\s*\/(\*|\/).*\s*@verp-module(\s+alias=(?<alias>[\w.]+))?(\s+default=(?<defaultValue>false|false|0))?/gm;

/**
 *  Detect if the file is a native verp module. We look for a comment containing @verp-module.
    ex: ' // @verp-module alias=web.AbstracAction default=false'
 * @param content: source code
 * @returns: is this a verp module that need transpilation ? 
 */
export function isErpModule(content: string): boolean {
  const result: any = content.match(VERP_MODULE_RE);
  return result && !!result[0];
}

function rstringPart(str: string, sub: string): [string|undefined, string, string] {
  var index = str.lastIndexOf(sub);  // Gets the first index where a space occours
  if (index < 0) {
    return [undefined, sub, str]; 
  }
  return [str.substring(0, index), sub, str.substring(index + sub.length)];
}

function partial(func: Function, ...args: any[]): Function {
  return (...rest: any[]) => func(...args, ...rest);
}

function _f(str: string, replacements: Record<string, any>={}): string {
  return str.replace(
    /<\w+>/g,
    (all) => replacements[all.substring(1, all.length-1)] ?? all
  );
}

/**
 * Transpile the code from native JS modules to custom verp modules.
 * @param url: The url of the file in the project 
 * @param content: The original source code
 * @returns: The transpiled source code 
 */
export function transpileJavascript(url: string, content: string): string {
  const modulePath = urlToModulePath(url);
  const legacyVerpDefine = getAliasedVerpDefineContent(modulePath, content);

  // The order of the operations does sometimes matter.
  const steps = [
    convertLegacyDefaultImport,
    convertBasicImport,
    convertDefaultImport,
    convertStarImport,
    convertUnnamedRelativeImport,
    convertFromExport,
    convertStarFromExport,
    partial(convertRelativeRequire, url),
    removeIndex,
    convertExportFunction,
    convertExportClass,
    convertVariableExport,
    convertObjectExport,
    convertDefaultExport,
    // removeComments, // FIX_ME
    partial(wrapWithVerpDefine, modulePath),
  ];
  for (const s of steps) {
    content = s(content);
  }
  if (legacyVerpDefine) {
    content += legacyVerpDefine;
  }
  // content = `/* Transpiled time: ${Date.now().toString()} */\n` + content;
  return content;
}

const URL_RE = /\/?(?<module>\S+)\/([\S]*\/)?static\/(?<type>src|tests|lib)(?<url>\/[\S]*)/gm;
/**
 *   Verp modules each have a name. (verp.define("<the name>", async function(require) {...});
  It is used in to be required later. (const { something } = require("<the name>").
  The transpiler transforms the url of the file in the project to this name.
  It takes the module name and add a @ on the start of it, and map it to be the source of the static/src (or
  static/tests, or static/lib) folder in that module.

  in: web/static/src/one/two/three.js
  out: @web/one/two/three.js
  #   web/static/src => @web
  so, web/static/lib => @web/../lib =>  web/static/src/../lib
  and web/static/tests => @web/../test => web/static/src/../tests
  The module would therefore be defined and required by this path.

  :param url: an url in the project
  :return: a special path starting with @<module-name>.
 * @param url 
 * @returns 
 */
export function urlToModulePath(url: any): any {
  const matches = url.matchAll(URL_RE);
  let found;
  for (const match of matches) {
    const groups = match.groups ?? {};
    url = groups["url"];
    if (url.endsWith('/index.js') || url.endsWith('/index')) { // remove /index.js or /index 
      [url, ] = rstringPart(url, '/');
    }
    if (url.endsWith('.js')) { // remove .js
      url = url.slice(0, -3);
    }
    if (groups["type"] === "src") {
      return format("@%s%s", groups['module'], url);
    }
    else if (groups["type"] === "lib") {
      return format("@%s/../lib%s", groups['module'], url);
    }
    else {
      return format("@%s/../tests%s", groups['module'], url);
    }
  }
  if (!found) {
    throw new Error(`The js file ${url} must be in the folder '/static/src' or '/static/lib' or '/static/test'`)
  }
}

/**
 * To allow smooth transition between the new system and the legacy one, we have the possibility to defined an alternative module name (an alias) that will act as proxy between legacy require calls and new modules.

    Example:
    If we have a require call somewhere in the verp source base being:
    > vat AbstractAction = require("web.AbstractAction")
    we have a problem when we will have converted to module to ES6: its new name will be more like
    "web/chrome/abstract_action". So the require would fail !
    So we add a second small modules, an alias, as such:
    > verp.define("web/chrome/abstract_action", async function(require) {
    >  return require('web.AbstractAction')[Symbol.for("default")];
    > });

    To generate this, change your comment on the top of the file.
      // before
      /** @verp-module */
      // after
      /** @verp-module alias=web.AbstractAction 

    Notice that often, the legacy system acted like they it did default imports. That's why we have the "[Symbol.for("default")];" bit. If your use case does not need this default import, just do:
      // before
      /** @verp-module 
      // after
      /** @verp-module alias=web.AbstractAction default=false *

    :return: the alias content to append to the source code.
 * @param modulePath 
 * @param content 
 */
function getAliasedVerpDefineContent(modulePath: string, content: string) {
  const result = content.matchAll(VERP_MODULE_RE) as any;
  for (const m of result) { 
    const groups = m.groups ?? {};
    const alias = groups['alias'];
    if (alias) {
      if (groups['defaultValue']) {
        return `
          verp.define("${alias}", async function(require) {
            return require("${modulePath}");
          })`;
      }
      else {
        return `
          verp.define("${alias}", async function(require) {
            return require("${modulePath}")[Symbol.for("default")];
          })`;
      }
    }
  }
}
        
const IMPORT_LEGACY_DEFAULT_RE = /^(?<space>\s*)import\s+(?<identifier>\w+)\s*from\s*(?<path>(?<quote>["'`])([^@\."'`][^"'`]*)(?<quote2>["'`]))/gm;
/**
 * Transpile legacy imports (that were used as they were default import). Legacy imports means that their name is not a path but a <addon_name>.<module_name>. It requires slightly different processing.
    // before
    import moduleName from "addon.moduleName"
    // after
    const moduleName = require("addon.moduleName")
 * @param content 
 */
function convertLegacyDefaultImport(content: string): string {
  function repl(matchobj: string, space: string, identifier: string, path, quote, str, quote2) {
    if (quote !== quote2) {
      return matchobj;
    }
    return `${space}const ${identifier} = require(${path})`
  }
  return content.replace(IMPORT_LEGACY_DEFAULT_RE, repl);
}

const IMPORT_BASIC_RE = /^(?<space>\s*)import\s+(?<object>{(\s*\w+\s*,?\s*)+})\s*from\s*(?<path>(?<quote>["'`])([^"'`]+)(?<quote2>["'`]))/gm;
/**
 * Transpile the simpler import call.
    // before
    import { a, b, c as x } from "some/path"
    // after
    const {a, b, c: x} = require("some/path")
 * @param content 
 */
function convertBasicImport(content: string) {
  function repl(matchobj: string, space: string, object: string, objectIn, path, quote, str, quote2) {
    if (quote !== quote2) {
      return matchobj;
    }
    const newObject = object?.replace(/(\s)as(\s)/g, ": ");
    return `${space}const ${newObject} = require(${path})`
  }
  return content.replace(IMPORT_BASIC_RE, repl);
}

const IMPORT_DEFAULT = /^(?<space>\s*)import\s+(?<identifier>\w+)\s*from\s*(?<path>(?<quote>["'`])([^"'`]+)(?<quote2>["'`]))/gm;
/**
 * Transpile the default import call.
    // before
    import something from "some/path" // egacy alias file ("addon_name.module_name" or "some/path")
    // after
    const something = require("some/path")[Symbol.for("default")]
 * @param content 
 * @returns 
 */
function convertDefaultImport(content: string): string {
  function repl(matchobj: string, space: string, identifier: string, path, quote, str, quote2) {
    if (quote !== quote2) {
      return matchobj;
    }
    return `${space}const ${identifier} = require(${path})[Symbol.for("default")]`;
  }
  return content.replace(IMPORT_DEFAULT, repl);
}

const IMPORT_STAR = /^(?<space>\s*)import\s+\*\s+as\s+(?<identifier>\w+)\s*from\s*(?<path>[^;\n]+)/gm;
/**
 * Transpile import star.
    // before
    import * as name from "some/path"
    // after
    const name = require("some/path")
 * @param content 
 * @returns 
 */
function convertStarImport(content) {
  function repl(matchobj: string, space: string, identifier: string, path) {
    return `${space}const ${identifier} = require(${path})`;
  }
  return content.replace(IMPORT_STAR, repl);
}

const IMPORT_UNNAMED_RELATIVE_RE = /^(?<space>\s*)import\s+(?<path>[^;\n]+)/gm;
/**
 * Transpile relative "direct" imports. Direct meaning they are not store in a variable.
    // before
    import "some/path"
    // after
    require("some/path")
 * @param content 
 * @returns 
 */
function convertUnnamedRelativeImport(content: string): string {
  function repl(matchobj: string, space: string, path: string) {
    return `require(${path})`;
  }
  return content.replace(IMPORT_UNNAMED_RELATIVE_RE, repl);
}

const EXPORT_FROM_RE = /^(?<space>\s*)export\s*(?<object>{[\w\s,]+})\s*from\s*(?<path>(?<quote>["'`])([^"'`]+)(?<quote2>["'`]))/gm;
/**
 * Transpile exports coming from another source
    // before
    export { a, b, c as x } from "some/path.js"
    // after
    const { a, b, c } = require("some/path.js"); Object.assign(__exports, { a, b, x: c });
 * @param content 
 * @returns 
 */
function convertFromExport(content) {
  function repl(matchobj, space, object, path, quote, str, quote2) {
    if (quote !== quote2) {
      return matchobj;
    }
    const objectClean = "{" + object.slice(1,-1).split(",").map(val => removeAs(val)).join(',') + "}";
    const objectProcess = "{" + object.slice(1,-1).split(",").map(val => convertAs(val)).join(', ') + "}"
    return _f("<space>{const <objectClean> = require(<path>); Object.assign(__exports, <objectProcess>)}", {
      'objectClean': objectClean,
      'objectProcess': objectProcess,
      'space': space,
      'path': path,
    });
  }
  return content.replace(EXPORT_FROM_RE, repl);
}

const EXPORT_STAR_FROM_RE = /^(?<space>\s*)export\s*\*\s*from\s*(?<path>(?<quote>["'`])([^"'`]+)(?<quote2>["'`]))/gm;
/**
 * Transpile exports star coming from another source
    // before
    export * from "some/path.js"
    // after
    Object.assign(__exports, require("some/path.js"))
 * @param content 
 * @returns 
 */
function convertStarFromExport(content: string): string {  
  function repl(matchobj, space, path, quote, str, quote2) {
    if (quote !== quote2) {
      return matchobj;
    }
    return `${space}Object.assign(__exports, require(${path}))`;
  }
  return content.replace(EXPORT_STAR_FROM_RE, repl);
}

const RELATIVE_REQUIRE_RE = /require\((?<quote>["'`])([^@"'`]+)(?<quote2>["'`])\)/gm;
/**
 *  Convert the relative path contained in a 'require()' to the new path system (@module/path)
    // Relative path:
    // before
    require("./path")
    // after
    require("@module/path")
 * @param url 
 * @param content 
 * @returns 
 */
function convertRelativeRequire(url: string, content: string): string {
  function repl(matchobj: string, quote, path, quote2) {
    if (quote === quote2) {
      if (path.startsWith(".") && path.includes('/')) {
        let newContent = matchobj;
        const pattern = new RegExp(escapeRegExp(`require(${quote}${path}${quote})`));
        const newStr = `require("${relativePathToModulePath(url, path)}")`;
        return newContent.replace(pattern, newStr);
      }
    }
    return matchobj;
  }
  return content.replace(RELATIVE_REQUIRE_RE, repl);
}

const URL_INDEX_RE = /require\s*\(\s*(?<path>(?<quote>["'`])([^"'`]*\/index\/?))(?<quote2>["'`])\s*\)/gm;
/**
 *  Remove in the paths the /index.js.
    We want to be able to import a module just trough its directory name if it contains an index.js.
    So we no longer need to specify the index.js in the paths.
 * @param content 
 */
function removeIndex(content: string): string {
  function repl(matchobj, path, quote, str, quote2) {
    if (quote !== quote2) {
      return matchobj;
    }
    const newPath = path.slice(0, path.lastIndexOf("/index")) + path[0];
    return `require(${newPath})`;
  }
  return content.replace(URL_INDEX_RE, repl);
}

const EXPORT_FCT_RE = /^(?<space>\s*)export\s+(?<type>(async\s+)?function)\s+(?<identifier>\w+)/gm;
/**
 *  Transpile functions that are being exported.
      // before
      export function name
      // after
      __exports.name = name; function name

      // before
      export async function name
      // after
      __exports.name = name; async function name
 * @param content 
 * @returns 
 */
function convertExportFunction(content: string): string {
  function repl(matchobj: string, space: string, type: string, strType: string, identifier: string) {
    if (!identifier) {
      identifier = strType;
    }
    return `${space}__exports.${identifier} = ${identifier}; ${type} ${identifier}`;
  }
  return content.replace(EXPORT_FCT_RE, repl);
}

const EXPORT_CLASS_RE = /^(?<space>\s*)export\s+(?<type>class)\s+(?<identifier>\w+)/gm;
/**
 * Transpile classes that are being exported.
      // before
      export class name
      // after
      const name = __exports.name = class name
 * @param content 
 * @returns 
 */
function convertExportClass(content: string): string {
  function repl(matchobj: string, space: string, type: string, identifier: string) {
    return `${space}const ${identifier} = __exports.${identifier} = ${type} ${identifier}`;
  }
  return content.replace(EXPORT_CLASS_RE, repl);
}

const EXPORT_VAR_RE = /^(?<space>\s*)export\s+(?<type>let|const|var)\s+(?<identifier>\w+)/gm;
/**
 * Transpile variables that are being exported.
      // before
      export let name
      // after
      let name = __exports.name
      // (same with var and const)
 * @param content 
 * @returns 
 */
function convertVariableExport(content: string): string {
  function repl(matchobj: string, space: string, type: string, identifier: string) {
    return `${space}${type} ${identifier} = __exports.${identifier}`;
  }
  return content.replace(EXPORT_VAR_RE, repl);
}

const EXPORT_OBJECT_RE = /^(?<space>\s*)export\s*(?<object>{[\w\s,]+})/gm;
/**
 * Transpile exports of multiple elements
      // before
      export { a, b, c as x }
      // after
      Object.assign(__exports, { a, b, x: c })
 * @param content 
 * @returns 
 */
function convertObjectExport(content: string): string {
  function repl(matchobj, space, object) {
    const objectProcess = "{" + object.slice(1,-1).split(",").map(val => convertAs(val)).join(', ') + "}";
    return `${space}Object.assign(__exports, ${objectProcess})`;
  }
  return content.replace(EXPORT_OBJECT_RE, repl);
}

const EXPORT_FCT_DEFAULT_RE = /^(?<space>\s*)export\s+default\s+(?<type>(async\s+)?function)\s+(?<identifier>\w+)/gm;
/**
 * Transpile functions that are being exported as default value.
      // before
      export default function name
      // after
      __exports[Symbol.for("default")] = name; function name

      // before
      export default async function name
      // after
      __exports[Symbol.for("default")] = name; async function name
 * @param content 
 * @returns 
 */
function convertExportFunctionDefault(content: string): string {
  function repl(matchobj: string, space: string, type: string, identifier: string) {
    return `${space}__exports[Symbol.for("default")] = ${identifier}; ${type} ${identifier}`;
  }
  return content.replace(EXPORT_FCT_DEFAULT_RE, repl);
}

const EXPORT_CLASS_DEFAULT_RE = /^(?<space>\s*)export\s+default\s+(?<type>(async\s+)?class)\s+(?<identifier>\w+)/gm;
/**
 * Transpile classes that are being exported as default value.
      // before
      export default class name
      // after
      const name = __exports[Symbol.for("default")] = class name
 * @param content 
 * @returns 
 */
function convertExportClassDefault(content: string): string {
  function repl(matchobj: string, space: string, type: string, identifier: string) {
    return `${space}const ${identifier} = __exports[Symbol.for("default")] = ${type} ${identifier}`;
  }
  return content.replace(EXPORT_CLASS_DEFAULT_RE, repl);
}

const EXPORT_DEFAULT_VAR_RE = /^(?<space>\s*)export\s+default\s+(?<type>let|const|var)\s+(?<identifier>\w+)\s*/gm;
/**
 * Transpile the variables that are exported as default values.
      // before
      export default let name
      // after
      let name = __exports[Symbol.for("default")]
 * @param content 
 * @returns 
 */
function convertVariableExportDefault(content: string): string {
  function repl(matchobj: string, space: string, type: string, identifier: string) {
    return `${space}${type} ${identifier} = __exports[Symbol.for("default")]`;
  }
  return content.replace(EXPORT_DEFAULT_VAR_RE, repl);
}

const EXPORT_DEFAULT_RE = /^(?<space>\s*)export\s+default(\s+\w+\s*=)?/gm;
/**
 * This function handles the default exports.
    Either by calling another operation with a TRUE flag, and if any default is left, doing a simple replacement.

    (see convertExportFunctionOrClassDefault and convertVariableExportDefault).
        // before
        export default
        // after
        __exports[Symbol.for("default")] =

        // before
        export default something =
        // after
        __exports[Symbol.for("default")] =
 * @param content 
 * @returns 
 */
function convertDefaultExport(content: string): string {
  let newContent = convertExportFunctionDefault(content);
  newContent = convertExportClassDefault(newContent);
  newContent = convertVariableExportDefault(newContent);

  function repl(matchobj, space, optional) {
    return `${space}__exports[Symbol.for("default")] =`;
  }
  return content.replace(EXPORT_DEFAULT_RE, repl);
}

/**
 * Wraps the current content (source code) with the verp.define call.
Should logically be called once all other operations have been performed.
 * @param modulePath 
 * @param content 
 */
function wrapWithVerpDefine(modulePath: string, content: string): string {
  return `verp.define("${modulePath}", async function(require) {
  'use strict';
  let __exports = {};
  ${content}
  return __exports;
})`
}

/**
 *   Convert the relative path into a module path, which is more generic and fancy.
 * @param url 
 * @param pathRel a relative path to the current url
 * @returns module path (@module/...) 
 */
function relativePathToModulePath(url: string, pathRel: string) {
  const urlSplit = url.split("/");
  const pathRelSplit = pathRel.split("/");
  const nbBack = pathRelSplit.filter(v => v === "..").length + 1;
  const result = urlSplit.slice(0, -nbBack).concat(pathRelSplit.filter(v => ! ["..", "."].includes(v))).join('/');
  return urlToModulePath(result);
}

const BLOCKS_RE = new RegExp([
  /\/(\*)[^*]*\*+(?:[^*\/][^*]*\*+)*\//.source,             // $1: multi-line comment
  /\/(\/)[^\n]*$/.source,                                   // $2 single-line comment
  /"(?:[^"\\]*|\\[\S\s])*"|'(?:[^'\\]*|\\[\S\s])*'/.source, // - string, don't care about embedded eols
  /(?:[$\w\)\]]|\+\+|--)\s*\/(?![*\/])/.source,             // - division operator
  /\/(?=[^*\/])[^[/\\]*(?:(?:\[(?:\\.|[^\]\\]*)*\]|\\.)[^[/\\]*)*?\/[gim]*/.source,
  ].join('|'),                                              // - regex
  'gm'  // note: global+multiline with replace() need test
);

const EMPTY_RE = /^\s*\n/gm;

// remove comments, keep other blocks
function removeComments(str: string) {
  return str.replace(BLOCKS_RE, function (match, mlc, slc) {
    return mlc ? ' ' :         // multiline comment (replace with space)
           slc ? '' :          // single/multiline comment
           match;              // divisor, regex, or string, return as-is
  }).replace(EMPTY_RE, '');
}

function convertAs(val: string): string {
  const parts = val.split(" as ");
  return parts.length < 2 ? val : format("%s: %s", ...parts.reverse());
}

function removeAs(val: string): string {
  const parts = val.split(" as ");
  return parts.length < 2 ? val : parts[0];
}

/**
 * Minify js with a clever regex.
  Taken from http://opensource.perlig.de/rjsmin (version 1.1.0)
  Apache License, Version 2.0 
 * @param script 
 * @returns 
 */
function rjsmin(script) {
  /**
   * Substitution callback
   * @param match 
   * @returns 
   */
  function subber(groups) {
    return (
      groups[0] ||
      groups[1] ||
      (groups[3] && (groups[2] + '\n')) ||
      groups[2] ||
      (groups[5] && format("%s%s%s",
        groups[4] && '\n' || '',
        groups[5],
        groups[6] && '\n' || '',
      )) ||
      (groups[7] && '\n') ||
      (groups[8] && ' ') ||
      (groups[9] && ' ') ||
      (groups[10] && ' ') ||
      ''
    )
  }

  const reg = /([^\x27"\x60\/\x00-\x20]+)|((?:(?:\x27[^\x27\\\r\n]*(?:\\(?:[^\r\n]|\r?\n|\r)[^\x27\\\r\n]*)*\x27)|(?:"[^"\\\r\n]*(?:\\(?:[^\r\n]|\r?\n|\r)[^"\\\r\n]*)*")|(?:\x60[^\x60\\]*(?:\\(?:[^\r\n]|\r?\n|\r)[^\x60\\]*)*\x60))[^\x27"\x60\/\x00-\x20]*)|(?<=[(,=:\[!&|?{};\r\n+*-])(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*(?:(?:(?:\/\/[^\r\n]*)?[\r\n])(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*)*((?:\/(?![\r\n\/*])[^\/\\\[\r\n]*(?:(?:\\[^\r\n]|(?:\[[^\\\]\r\n]*(?:\\[^\r\n][^\\\]\r\n]*)*\]))[^\/\\\[\r\n]*)*\/))((?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*(?:(?:(?:\/\/[^\r\n]*)?[\r\n])(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*)+(?=[^\x00-\x20&)+,.:;=?\]|}-]))?|(?<=[\x00-#%-,.\/:-@\[-^\x60{-~-]return)(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*(?:((?:(?:\/\/[^\r\n]*)?[\r\n]))(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*)*((?:\/(?![\r\n\/*])[^\/\\\[\r\n]*(?:(?:\\[^\r\n]|(?:\[[^\\\]\r\n]*(?:\\[^\r\n][^\\\]\r\n]*)*\]))[^\/\\\[\r\n]*)*\/))((?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*(?:(?:(?:\/\/[^\r\n]*)?[\r\n])(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*)+(?=[^\x00-\x20&)+,.:;=?\]|}-]))?|(?<=[^\x00-!#%&(*,.\/:-@\[\\^{|~])(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*(?:((?:(?:\/\/[^\r\n]*)?[\r\n]))(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*)+(?=[^\x00-\x20"#%-\x27)*,.\/:-@\\-^\x60|-~])|(?<=[^\x00-#%-,.\/:-@\[-^\x60{-~-])((?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/)))+(?=[^\x00-#%-,.\/:-@\[-^\x60{-~-])|(?<=\+)((?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/)))+(?=\+)|(?<=-)((?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/)))+(?=-)|(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))+|(?:(?:(?:\/\/[^\r\n]*)?[\r\n])(?:[\x00-\x09\x0b\x0c\x0e-\x20]|(?:\/\*[^*]*\*+(?:[^\/*][^*]*\*+)*\/))*)+/gm;

  const result = `\n${script}\n`.replace(reg, subber);
  return result;
}