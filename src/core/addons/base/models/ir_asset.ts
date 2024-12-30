import glob from 'glob';
import _ from "lodash";
import pt from 'path';
import * as api from "../../../api";
import * as conf from "../../../conf";
import { Fields } from "../../../fields";
import { Dict } from '../../../helper/collections';
import { FileNotFoundError, ValueError } from "../../../helper/errors";
import { _root, addonsManifest } from "../../../http";
import { MetaModel, Model, _super } from "../../../models";
import { isInstance, rstringPart } from "../../../tools/func";
import { enumerate, extend, len, sorted } from "../../../tools/iterable";
import { filePath,  } from '../../../tools/models';
import { URI } from "../../../tools/uri";
import { bool } from '../../../tools/bool';
import { tools } from '../../..';
import { topologicalSort } from '../../../tools/misc';

export const SCRIPT_EXTENSIONS = ['js'];
export const STYLE_EXTENSIONS = ['css', 'scss', 'sass', 'less'];
export const TEMPLATE_EXTENSIONS = ['xml'];
export const DEFAULT_SEQUENCE = 16;

// Directives are stored in variables for ease of use and syntax checks.
export const APPEND_DIRECTIVE = 'append';
export const PREPEND_DIRECTIVE = 'prepend';
export const AFTER_DIRECTIVE = 'after';
export const BEFORE_DIRECTIVE = 'before';
export const REMOVE_DIRECTIVE = 'remove';
export const REPLACE_DIRECTIVE = 'replace';
export const INCLUDE_DIRECTIVE = 'include';
// Those are the directives used with a 'target' argument/field.
const DIRECTIVES_WITH_TARGET = [AFTER_DIRECTIVE, BEFORE_DIRECTIVE, REPLACE_DIRECTIVE];
const WILDCARD_CHARACTERS = ['*', "?", "[", "]"];

/**
 * Converts a file system path to a web path
 * @param path 
 * @returns 
 */
function fs2web(path: string) {
  if (pt.sep === '/') {
    return path;
  }
  return path.split(pt.sep).join('/');
}

export function canAggregate(url: string) {
  const uri = new URI(url);
  return (! uri.protocol && ! uri.auth && ! url.startsWith('/web/content'));
}

/**
 * Determine whether a path is a wildcarded glob eg: "/web/file[14].*"
    or a genuine single file path "/web/myfile.scss
 * @param path 
 * @returns 
 */
function isWildcardGlob(path: string) {
  return _.intersection(WILDCARD_CHARACTERS, [...path]).length > 0;
}

/**
 * This model contributes to two things:

      1. It provides a function returning a list of all file paths declared
      in a given list of addons (see _get_addon_paths);

      2. It allows to create 'ir.asset' records to add additional directives
      to certain bundles.
 */
@MetaModel.define()
class IrAsset extends Model {
  static _module = module;
  static _name = 'ir.asset';
  static _description = 'Asset';
  static _order = 'sequence, id';

  static label = Fields.Char({string: 'Name', required: true});
  static bundle = Fields.Char({string: 'Bundle name', required: true});
  static directive = Fields.Selection([
    [APPEND_DIRECTIVE, 'Append'],
    [PREPEND_DIRECTIVE, 'Prepend'],
    [AFTER_DIRECTIVE, 'After'],
    [BEFORE_DIRECTIVE, 'Before'],
    [REMOVE_DIRECTIVE, 'Remove'],
    [REPLACE_DIRECTIVE, 'Replace'],
    [INCLUDE_DIRECTIVE, 'Include']], {string: 'Directive', default: APPEND_DIRECTIVE});
  static path = Fields.Char({string: 'Path (or glob pattern)', required: true});
  static target = Fields.Char({string: 'Target'});
  static active = Fields.Boolean({string: 'Active', default: true});
  static sequence = Fields.Integer({string: "Sequence", default: DEFAULT_SEQUENCE, required: true});

  @api.modelCreateMulti()
  async create(valsList) {
    this.clearCaches();
    return _super(IrAsset, this).create(valsList);
  }

  async write(values) {
    this.clearCaches();
    return _super(IrAsset, this).write(values);
  }

  async unlink() {
    this.clearCaches()
    return _super(IrAsset, this).unlink();
  }

  /**
   * Fetches all asset file paths from a given list of addons matching a
    certain bundle. The returned list is composed of tuples containing the
    file path [1], the first addon calling it [0] and the bundle name.
    Asset loading is performed as follows:

    1. All 'ir.asset' records matching the given bundle and with a sequence
    strictly less than 16 are applied.

    3. The manifests of the given addons are checked for assets declaration
    for the given bundle. If any, they are read sequentially and their
    operations are applied to the current list.

    4. After all manifests have been parsed, the remaining 'ir.asset'
    records matching the bundle are also applied to the current list.

  * @param bundle name of the bundle from which to fetch the file paths
  * @param addons list of addon names as strings. The files returned will
        only be contained in the given addons.
  * @param css boolean whether or not to include style files
  * @param js boolean whether or not to include script files
  * @param xml boolean whether or not to include template files
  * @returns the list of tuples (path, addon, bundle)
   */
  async _getAssetPaths(bundle: string, options: {addons?: string[], css?: boolean, js?: boolean, xml?: boolean}={}) {
    const installed = await this._getInstalledAddonsList();
    if (options.addons == null) {
      options.addons = await this._getActiveAddonsList();
    }
    const assetPaths = new AssetPaths();
    await this._fillAssetPaths(bundle, options.addons, installed, options.css, options.js, options.xml, assetPaths, []);
    return assetPaths.list;
  }

  /**
   * Fills the given AssetPaths instance by applying the operations found in
        the matching bundle of the given addons manifests.
        See `_getAssetPaths` for more information.

   * @param bundle name of the bundle from which to fetch the file paths
   * @param addons list of addon names as strings
   * @param css boolean: whether or not to include style files
   * @param js boolean: whether or not to include script files
   * @param xml boolean: whether or not to include template files
   * @param assetPaths the AssetPath object to fill
   * @param seen a list of bundles already checked to avoid circularity
   */
  async _fillAssetPaths(bundle: string, addons: string[], installed: string[], css: boolean, js: boolean, xml: boolean, assetPaths: AssetPaths, seen: string[]=[]) {
    if (seen.includes(bundle)) {
      throw new Error(`Circular assets bundle declaration: ${seen.concat(bundle).join(" > ")}`);
    }

    if (! _root._loaded) {
      _root.loadAddons()
      _root._loaded = true;
    }
    const manifestCache = addonsManifest;
    const exts = [];
    if (js) {
      extend(exts, SCRIPT_EXTENSIONS);
    }
    if (css) {
      extend(exts, STYLE_EXTENSIONS);
    }
    if (xml) {
      extend(exts, TEMPLATE_EXTENSIONS);
    }

    // this index is used for prepending: files are inserted at the beginning of the CURRENT bundle.
    const bundleStartIndex = len(assetPaths.list);
    const self: any = this;
    /**
     * This sub function is meant to take a directive and a set of
        arguments and apply them to the current assetPaths list
        accordingly.

        It is nested inside `_getAssetPaths` since we need the current
        list of addons, extensions, assetPaths and manifestCache.

     * @param directive: string
     * @param target: string or null or false
     * @param pathDef: string
     */
    async function processPath(directive, target, pathDef) {
      if (directive === INCLUDE_DIRECTIVE) {
        // recursively call this function for each INCLUDE_DIRECTIVE directive.
        await self._fillAssetPaths(pathDef, addons, installed, css, js, xml, assetPaths, seen.concat([bundle]));
        return;
      }
      const [addon, paths] = await self._getPaths(pathDef, installed, exts);

      let targetToIndex, targetIndex, targetPaths, x;
      // retrieve target index when it applies
      if (DIRECTIVES_WITH_TARGET.includes(directive)) {
        [x, targetPaths] = await self._getPaths(target, installed, exts);
        if (! bool(targetPaths) && ! exts.includes(rstringPart(target, '.')[2])) {
          // nothing to do: the extension of the target is wrong
          return;
        }
        targetToIndex = len(targetPaths) && targetPaths[0] || target;
        targetIndex = assetPaths.index(targetToIndex, addon, bundle);
      }
      if (directive === APPEND_DIRECTIVE) {
        assetPaths.push(paths, addon, bundle);
      }
      else if (directive === PREPEND_DIRECTIVE) {
        assetPaths.insert(paths, addon, bundle, bundleStartIndex);
      }
      else if (directive === AFTER_DIRECTIVE) {
        assetPaths.insert(paths, addon, bundle, targetIndex + 1);
      }
      else if (directive === BEFORE_DIRECTIVE) {
        assetPaths.insert(paths, addon, bundle, targetIndex);
      }
      else if (directive === REMOVE_DIRECTIVE) {
        assetPaths.remove(paths, addon, bundle);
      }
      else if (directive === REPLACE_DIRECTIVE) {
        assetPaths.insert(paths, addon, bundle, targetIndex);
        assetPaths.remove(targetPaths, addon, bundle)
      }
      else {
        // this should never happen
        throw new ValueError("Unexpected directive");
      }
    }

    // 1. Process the first sequence of 'ir.asset' records
    const assets = await (await this._getRelatedAssets([['bundle', '=', bundle]])).filtered('active');
    for (const asset of await assets.filtered(async (a) => await a.sequence < DEFAULT_SEQUENCE)) {
      const [directive, target, path] = await asset(['directive', 'target', 'path']);
      await processPath(directive, target, path);
    }

    // 2. Process all addons' manifests.
    for (const addon of await this._topologicalSort(Array.from(addons))) {
      const manifest = manifestCache[addon];
      if (! bool(manifest)) {
        continue;
      }
      const manifestAssets = manifest['assets'] ?? {};
      for (const command of (manifestAssets[bundle] || [])) {
        if (typeof(command) === 'string' && command.startsWith('#')) {
          continue;
        }
        const [directive, target, pathDef] = await this._processCommand(command);
        await processPath(directive, target, pathDef);
      }
    }

    // 3. Process the rest of 'ir.asset' records
    for (const asset of await assets.filtered(async (a) => await a.sequence >= DEFAULT_SEQUENCE)) {
      const [directive, target, path] = await asset(['directive', 'target', 'path']);
      await processPath(directive, target, path);
    }
  }
  
  /**
   * Returns a list of sorted modules name accord to the spec in ir.module.module
    that is, application desc, sequence, name then topologically sorted
   * @param addons 
   * @returns 
   */
  @api.model()
  @tools.ormcache('addons')
  async _topologicalSort(addons) {
    const IrModule = this.env.items('ir.module.module');

    function mapper(addon) {
      const manif = Dict.from(addonsManifest[addon] ?? {});
      const fromTerp = IrModule.getValuesFromTerp(manif);
      fromTerp['label'] = addon;
      fromTerp['depends'] = manif.get('depends', ['base']);
      return fromTerp;
    }

    let manifs: any[] = addons.map(mapper);

    function sortKey(manif) {
      return String([! manif['application'], parseInt(manif['sequence']), manif['label']]);
    }

    manifs = sorted(manifs, sortKey);
    const dictManifs = {};
    for (const manif of manifs) {
      dictManifs[manif['label']] = manif['depends'];
    }
    return topologicalSort(dictManifs);
  }

  /**
   * Returns a set of assets matching the domain, regardless of their
    active state. This method can be overridden to filter the results.

   * @param domain search domain
   * @returns ir.asset recordset
   */
  async _getRelatedAssets(domain) {
    return (await (await this.withContext({activeTest: false})).sudo()).search(domain, {order: 'sequence, id'});
  }

  /**
   * Returns the first bundle directly defining a glob matching the target
    path. This is useful when generating an 'ir.asset' record to override
    a specific asset and target the right bundle, i.e. the first one
    defining the target path.

   * @param targetPathDef string: path to match.
   * @param rootBundle string: bundle from which to initiate the search.
   * @returns the first matching bundle or None
   */
  async _getRelatedBundle(targetPathDef, rootBundle) {
    const ext = targetPathDef.split('.').slice(-1)[0];
    const installed = await this._getInstalledAddonsList();
    const targetPath = (await this._getPaths(targetPathDef, installed))[1][0]

    const css = STYLE_EXTENSIONS.includes(ext);
    const js = SCRIPT_EXTENSIONS.includes(ext);
    const xml = TEMPLATE_EXTENSIONS.includes(ext);

    const assetPaths = await this._getAssetPaths(rootBundle, {css: css, js: js, xml: xml});

    for (const [path, _, bundle] of assetPaths) {
      if (path === targetPath) {
        return bundle;
      }
    }

    return rootBundle;
  }

  /**
   * Returns the list of all installed addons.
   * @returns string[]: list of module names
   */
  @api.model()
  @tools.ormcacheContext(['installModule'])
  async _getInstalledAddonsList() {
    // Main source: the current registry list
    // Second source of modules: server wide modules
    // Third source: the currently loading module from the context (similar to ir_ui_view)
    return _.union(Array.from(this.env.registry._initModules), conf.serverWideModules || [], this.env.context['installModule'] || []);
  }

  /**
   * Can be overridden to filter the returned list of active modules.
   * @param self 
   * @returns 
   */
  async _getActiveAddonsList() {
    return this._getInstalledAddonsList();
  }

  /**
   * Returns a list of file paths matching a given glob (path_def) as well as
    the addon targeted by the path definition. If no file matches that glob,
    the path definition is returned as is. This is either because the path is
    not correctly written or because it points to a URL.

   * @param pathDef the definition (glob) of file paths to match
   * @param installed the list of installed addons
   * @param extensions a list of extensions that found files must match
   * @returns a tuple: the addon targeted by the path definition [0] and the
        list of file paths matching the definition [1] (or the glob itself if
        none). Note that these paths are filtered on the given `extensions`.
   */
  async _getPaths(pathDef: string, installed: any[], extensions?: any) {
    let paths: string[] = [];
    const pathUrl = fs2web(pathDef);
    const pathParts = pathUrl.split('/').filter(part => !!part);
    let addon = pathParts[0];
    const addonManifest = addonsManifest[addon];

    let safePath = true;
    if (bool(addonManifest)) {
        if (!installed.includes(addon)) {
          // Assert that the path is in the installed addons
          throw new Error(`Unallowed to fetch files from addon ${addon}`);
        }
        const addonsPath = pt.join(addonManifest['addonsPath'], '');
        const fullPath = pt.normalize(pt.join(addonsPath, ...pathParts));
        // first security layer: forbid escape from the current addon
        // "/mymodule/../myothermodule" is forbidden
        // the condition after the or is to further guarantee that we won't access
        // a directory that happens to be named like an addon (web....)
        let dir, ext;
        if (!fullPath.includes(addon) || ! fullPath.includes(addonsPath)) {
          addon = null;
          safePath = false;
        }
        else {
          const sub1 = `${pt.sep}*${pt.sep}`;
          const sub2 = `${pt.sep}**${pt.sep}`;
          let sub = sub2;
          const nocurdir = fullPath.indexOf(sub) >= 0;
          let index = fullPath.indexOf(sub);  // Gets the first index where a space occours
          if (index < 0) {
            sub = sub1;
            index = fullPath.indexOf(sub);
          }
          if (index < 0) {
            dir = pt.dirname(fullPath);
            ext = pt.basename(fullPath);
          }
          else {
            dir = fullPath.substring(0, index);
            ext = `${sub === sub1 ? '*' : '**'}/${fullPath.substring(index + sub.length)}`;
          }
          paths = glob.sync(ext.replace(`${pt.sep}`, `/`), {
            nodir: true,
            noglobstar: sub === sub1,
            ignore: [],
            cwd: dir
          });
          // if (nocurdir) {
          //   paths = paths.filter(name => name.indexOf('/') >= 0);
          // }
          paths = paths.map(path => pt.normalize(dir+pt.sep+path));
        }
        // second security layer: do we have the right to access the files
        // that are grabbed by the glob ?
        // In particular we don't want to expose data in xmls of the module
        function isSafePath(path) {
          try {
            filePath(path, SCRIPT_EXTENSIONS.concat(STYLE_EXTENSIONS).concat(TEMPLATE_EXTENSIONS));
          } catch(e) {
            if (isInstance(e, ValueError, FileNotFoundError)) {
              return false;
            }
            else {
              throw e;
            }
          }
          if (TEMPLATE_EXTENSIONS.includes(rstringPart(path, '.')[2])) {
            // normpath will strip the trailing /, which is why it has to be added afterwards
            const staticPath = pt.normalize(`${addon}/static`) + pt.sep;
            // Forbid xml to leak
            return path.includes(staticPath);
          }
          return true;
        }

        const lenPaths = paths.length;
        paths = Array.from(paths.filter(isSafePath));
        safePath = safePath && lenPaths === paths.length;

        // When fetching template file paths, we need the full paths since xml
        // files are read from the file system. But web assets (scripts and
        // stylesheets) must be loaded using relative paths, hence the trimming
        // for non-xml file paths.
        paths = paths.map(path => TEMPLATE_EXTENSIONS.includes(path.split('.').slice(-1)[0]) ? path : fs2web(path.slice(addonsPath.length)));
    }
    else {
      addon = null;
    }
    if (! paths.length && (! canAggregate(pathUrl) || (safePath && ! isWildcardGlob(pathUrl)))) {
      // No file matching the path; the pathDef could be a url.
      paths = [pathUrl];
    }

    if (! paths.length) {
      let msg = `IrAsset: the path "${pathDef}" did not resolve to anything.`
      if (! safePath) {
        msg += " It may be due to security reasons."
      }
      console.warn(msg);
    }
    // Paths are filtered on the extensions (if any).
    return [addon, paths.filter(path => !bool(extensions) || extensions.includes(path.split('.').slice(-1)[0]))]
  }
  
  //Parses a given command to return its directive, target and path definition.
  async _processCommand(command) {
    let directive, target, pathDef;
    if (typeof(command) === 'string') {
      // Default directive: append
      [directive, target, pathDef] = [APPEND_DIRECTIVE, null, command];
    }
    else if (DIRECTIVES_WITH_TARGET.includes(command[0])) {
      [directive, target, pathDef] = command;
    }
    else {
      [directive, pathDef] = command;
      target = null;
    }
    return [directive, target, pathDef];
  }

}

/**
 * A list of asset paths (path, addon, bundle) with efficient operations.
 */
class AssetPaths {
  list: any[];
  memo: Set<string>;

  constructor() {
    this.list = [];
    this.memo = new Set();
  }

  /**
   * Returns the index of the given path in the current assets list.
   * @param path 
   * @param addon 
   * @param bundle 
   * @returns 
   */
  index(path, addon, bundle) {
    if (!this.memo.has(path)) {
      this._raiseNotFound(path, bundle);
    }
    for (const [index, asset] of enumerate(this.list)) {
      if (asset[0] === path) {
        return index;
      }
    }
  }

  /**
   * Appends the given paths to the current list.
   * @param paths 
   * @param addon 
   * @param bundle 
   */
  push(paths, addon, bundle) {
    for (const path of paths) {
      if (!this.memo.has(path)) {
        this.list.push([path, addon, bundle]);
        this.memo.add(path);
      }
    }
  }

  /**
   * Inserts the given paths to the current list at the given position.
   * @param paths 
   * @param addon 
   * @param bundle 
   * @param index 
   */
  insert(paths, addon, bundle, index) {
    const toInsert = [];
    for (const path of paths) {
      if (! this.memo.has(path)) {
        toInsert.push([path, addon, bundle]);
        this.memo.add(path);
      }
    }
    this.list.splice(index, 0, ...toInsert);
  }

  /**
   * Removes the given paths from the current list.
   * @param pathsToRemove 
   * @param addon 
   * @param bundle 
   * @returns 
   */
  remove(pathsToRemove: string[], addon, bundle) {
    const paths = pathsToRemove.filter(path => this.memo.has(path));
    if (bool(paths)) {
      this.list.splice(0, this.list.length, ...this.list.filter(asset => !paths.includes(asset[0])));
      this.memo = new Set(Array.from(this.memo).filter(path => !paths.includes(path)));
      return;
    }

    if (len(pathsToRemove)) {
      this._raiseNotFound(pathsToRemove, bundle);
    }
  }

  _raiseNotFound(path, bundle) {
    throw new ValueError("File(s) %s not found in bundle %s", path, bundle);
  }
}