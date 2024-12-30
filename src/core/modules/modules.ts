require('./../globals');

import { accessSync, constants, existsSync, readdirSync } from 'fs';
import * as path from 'path';
import assert from 'assert';
import _ from 'lodash';
import { addons } from '..';
import { getattr } from '../api/func';
import { Dict } from '../helper/collections';
import * as release from '../release';
import { config } from '../tools/config';
import { extend, isIterable } from '../tools/iterable';
import { commonPrefix, isDir, isFile } from '../tools/misc';
import { fileRead } from '../tools/models';

export const MANIFEST_NAMES = ['package.json', '__manifest__.json'];
export const IGNORE_FOLDERS = [
  '**/node_modules/**',
  '**/.vscode/**',
  '**/.git/**',
  '**/build/**',
  '**/dist/**',
  '**/lib/**'
];

const README = ['README.rst', 'README.md', 'README.txt'];

export function getModuleLoaded(module: string): NodeModule | undefined {
  const modPath = getModulePath(module);

  for (const ext of ['', 'index.js', 'index.ts']) {
    const modFile = path.join(modPath, ext);
    if (require.cache[modFile] && require.cache[modFile].loaded) {
      return require.cache[modFile];
    }
  }
  return;
}

export function removeModuleLoaded(module: string): NodeModule | undefined {
  const modPath = getModulePath(module);

  for (const ext of ['', 'index.js', 'index.ts']) {
    const modFile = path.join(modPath, ext);
    if (require.cache[modFile]) {
      delete require.cache[modFile];
    }
  }
  return;
}

/**
 * Tries to extract the module name and the resource's relative path
  out of an absolute resource path.

  If operation is successful, returns a tuple containing the module name, the relative path
  to the resource using '/' as filesystem seperator[1] and the same relative path using
  os.path.sep seperators.

  [1] same convention as the resource path declaration in manifests

  * @param path absolute resource path
 * @returns tuple [moduleName, relativePath, osRelativePath] if possible, else null
 */
export function getResourceFromPath(p: any) {
  if (!p)
    return null;
  let resource: string;
  for (let adpath of addons.paths) {
    // force trailing separator
    adpath = path.join(adpath, "");
    if (commonPrefix([adpath, p]) === adpath) {
      resource = p.replace(new RegExp(adpath), '');
      break;
    }
  }

  if (resource) {
    const relative = resource.split(path.sep);
    if (! relative[0]) {
      relative.shift();
    }
    const module = relative.shift();
    return [module, relative.join('/'), relative.join(path.sep)];
  }
  return null;
}

export function initializeSysPath() {
  const dd =  path.resolve(config.addonsDataDir);
  const fixedpaths = addons.paths;
  try {
    accessSync(dd, constants.R_OK | constants.W_OK);
    if (!fixedpaths.includes(dd))
      fixedpaths.push(dd);
  } catch (err) {
    console.error('no access!');
  }
  const configpaths = config.get('addonsPath').split(',');
  for (const ad of configpaths) {
    const dd =  path.resolve(ad.trim());
    try {
      accessSync(dd, constants.R_OK | constants.W_OK);
      if (!fixedpaths.includes(dd))
        fixedpaths.push(dd);
    } catch (err) {
      console.error('no access!');
    }
  }
}

export function getModulePath(module: string, downloaded?: boolean, displayWarning?: boolean): string {
  let p: string;
  for (const adp of addons.paths) {
    const files = MANIFEST_NAMES.map((manifest) =>path.join(adp, module, manifest)).concat(path.join(adp, module, '.zip'));
    for (const f of files) {
      if (existsSync(f)) {
        p = path.join(adp, module);
        break;
      }
    }
  }
  if (!p && downloaded) {
    return path.join(config.addonsDataDir, module);
  }
  if (!p && displayWarning) {
    console.log('module %s: module not found', module);
  }
  return p;
}

export function checkResourcePath(modPath: string, ...args: string[]): string {
  const resourcePath = path.join(modPath, ...args);
  if (existsSync(resourcePath)) {
    return resourcePath;
  } 
  return '';
}

export function getResourcePath(module: string, ...args: string[]): string {
  const modPath = getModulePath(module);
  if (!modPath) {
    return '';
  }
  return checkResourcePath(modPath, ...args);
}

export function getModuleIcon(module: string): string {
  const iconpath = ['static', 'description', 'icon.png'];
  if (getResourcePath(module, ...iconpath)) {
    return ('/' + module + '/') + iconpath.join('/');
  }
  return '/base/' + iconpath.join('/');
}

export function moduleManifest(modPath: string): string | undefined {
  if (!modPath) {
    return;
  }
  for (const name of MANIFEST_NAMES) {
    const file = path.join(modPath, name);
    if (isFile(file)) {
      return file;
    }
  }
}

export function readManifest(addonsPath: string, module: string) {
  const modPath = path.join(addonsPath, module);
  const manifestPath = moduleManifest(modPath);
  if (manifestPath) {
    const rawdata = fileRead(manifestPath, 'utf8') as string;
    return JSON.parse(rawdata);
  }
  return null;
}

export function getModuleRoot(dir: string): string {
  while (!moduleManifest(dir)) {
    const newDir = path.resolve(path.join(dir, '..'));
    if (dir == newDir) {
      return;
    }
    dir = newDir;
  }
  return dir;
}

export function loadInformationFromDescriptionFile(modName: string, modPath?: string): Dict<any> | undefined {
  if (!modPath) {
    modPath = getModulePath(modName, true);
  }
  const manifestFile = moduleManifest(modPath);
  if (manifestFile) {
    // default values for descriptor
    const info = new Dict<any>({
      application: false,
      author: 'Verp S.A.',
      autoInstall: false,
      category: 'Uncategorized',
      depends: [],
      description: '',
      icon: getModuleIcon(modName),
      installable: true,
      postLoad: undefined,
      version: '1.0',
      web: false,
      sequence: 100,
      summary: '',
      website: '',
      shortdesc: 'default values for descriptor'
    });
    const list = 'depends data demo test initXml updateXml demoXml'.split(' ');
    Dict.fill(info, new Map(list.map(key => [key, null])));

    try {
      const rawdata = fileRead(manifestFile, 'utf8') as string;
      const newInfo = JSON.parse(rawdata);
      Dict.fill(info, newInfo);
    } catch(e) {
      console.log(`loadInformationFromDescriptionFile error ${e.message} in file ${manifestFile}}`);
      return new Dict();
    }
    
    if (!info['description']) {
      const readmePath = README.filter((x) => {
        const p = path.join(modPath, x);
        return isFile(p);
      });
      if (readmePath.length) {
        const rawdata = fileRead(readmePath[0], 'utf8') as string;
        info['description'] = rawdata;
      }
    }

    if (! info['license']) {
      info['license'] = 'MIT Expat';
      console.log(`Missing 'license' key in manifest for '${modName}', defaulting to MIT Expat`);
    }
    
    if (isIterable(info['autoInstall'])) {
      info['autoInstall'] = Array.from(new Set([...info['autoInstall']]));
      const nonDependencies = _.difference(info['autoInstall'], info['depends']);
      assert (!nonDependencies.length,
        `autoInstall triggers must be dependencies, found  non-dependencies [${nonDependencies}] for module ${modName}`
      );
    }
    else if (info['autoInstall']) {
      info['autoInstall'] = Array.from(new Set(info['depends']));
    }
    info['version'] = adaptVersion(info['version']);
    return info;
  }

  console.debug('module %s: no manifest file found %s', modName, MANIFEST_NAMES);
  return new Dict();
}

/** 
  Load an VERP module, if not already loaded.
  This loads the module and register all of its models, thanks to either the MetaModel metaclass, or the explicit instantiation of the model.
  This is also used to load server-wide module (i.e. it is also used
  when there is no model to register).
*/
export async function loadErpModule(name: string) {
  if (global.loaded[name]) {
    return global.loaded[name];
  }
  try {
    const modulePath = getModulePath(name);
    // console.log(`Require module '${name}' in ${modulePath}`);
    require(modulePath);
    const info = loadInformationFromDescriptionFile(name, modulePath);
    const mod = getModuleLoaded(name);
    if (mod) {
      if (info && info['postLoad']) {
        await getattr(mod.exports, `${info['postLoad']}`, (...args: any[])=>{})();
      }
      global.loaded[name] = mod;
    }
    return mod;
  } catch(e) {
    console.log(`Couldn't load module ${name}`, e);
    removeModuleLoaded(name);
    throw e;
  }
}

export function getDirectories(source: string) {
  return readdirSync(source, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
}

export function listDir(dir) {
  const listChild: string[] = [];
  const children = getDirectories(dir);
  for (const name of children) {
    listChild.push(path.join(dir, name));
  }
  return listChild;
}
/**
 * 
 * @returns List of module name
 */
export function getModules(): string[] {  
  function listDir(dir: string) {
    function isReallyModule(name: string): boolean {
      for (let i = 0; i < MANIFEST_NAMES.length; i++) {
        const p =path.join(name, MANIFEST_NAMES[i]);
        if (isFile(p)) {
          return true;
        }
      }
      return false;
    }

    if (isDir(dir)) {
      const listChild: string[] = [];
      const children = getDirectories(dir);
      for (const name of children) {
        const child =path.join(dir, name);
        if (isReallyModule(child)) {
          listChild.push(name);
        }
      }
      return listChild;
    }
  }

  let plist: string[] = [];
  for (const ad of addons.paths) {
    const list = listDir(ad)!;
    plist = extend(plist, list);
  }
  return plist;
}

export function getModulesWithVersion(): Dict<string> {
  const modules = getModules();
  const res = Dict.fromKeys(modules, adaptVersion('1.0'));
  for (const module of modules) {
    try {
      const info = loadInformationFromDescriptionFile(module);
      if (info && info['version']) {
        res[module] = info['version'];
      }
    } catch(e) {
      continue;
    }
  }
  return res;
}

export function adaptVersion(version: string): string {
  const serie = release.majorVersion;
  if (version == serie || !version.startsWith(serie + '.')) {
    version = `${serie}.${version}`;
  }
  return version;
}

export let currentTest = null;