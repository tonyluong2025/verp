import assert from 'assert';
import * as fs from 'fs';
import { glob } from 'glob';
import path from 'path';
import { release, upgrade } from '..';
import { getattr, hasattr } from '../api/func';
import { DefaultDict } from '../helper/collections';
import { AttributeError, ImportError } from '../helper/errors';
import { Cursor } from "../sql_db";
import { isInstance } from '../tools/func';
import { isDir } from '../tools/misc';
import { parseVersion } from '../tools/parse_version';
import { _format } from '../tools/utils';
import { Graph } from './graph';
import { getDirectories, getResourcePath, IGNORE_FOLDERS } from './modules';
import { sorted } from '../tools/iterable';


function loadScript(p: string, moduleName: string) {
  const _p = p.split(path.sep);
  const fullPath = !path.isAbsolute(p) ? getResourcePath(_p[0], ..._p.slice(1)) : p;
  return require(fullPath);
}

/**
 *This class manage the migration of modules
  Migrations files must be files containing a `migrate(cr, installed_version)`
  function. These files must respect a directory tree structure: A 'migrations' folder
  which contains a folder by version. Version can be 'module' version or 'server.module'
  version (in this case, the files will only be processed by this version of the server).
  Javascript file names must start by `pre-` or `post-` and will be executed, respectively,
  before and after the module initialisation. `end-` scripts are run after all modules have
  been updated.
  A special folder named `0.0.0` can contain scripts that will be run on any version change.
  In `pre` stage, `0.0.0` scripts are run first, while in `post` and `end`, they are run last.
  Example:
      <moduledir>
      `-- migrations
          |-- 1.0
          |   |-- pre-update_table_x.py
          |   |-- pre-update_table_y.py
          |   |-- post-create_plop_records.py
          |   |-- end-cleanup.py
          |   `-- README.txt                      # not processed
          |-- 9.0.1.1                             # processed only on a 9.0 server
          |   |-- pre-delete_table_z.py
          |   `-- post-clean-data.py
          |-- 0.0.0
          |   `-- end-invariants.py               # processed on all version update
          `-- foo.py                              # not processed
 */
export class MigrationManager {
  cr: Cursor;
  graph: Graph;
  migrations: DefaultDict<any, any>;

  constructor(cr: Cursor, graph: Graph) {
    this.cr = cr;
    this.graph = graph;
    this.migrations = new DefaultDict();
    this._getFiles();
  }

  _getFiles() {
    function _getUpgradePath(pkg) {
      for (const p of upgrade.paths) {
        const upgradePath = path.join(p, pkg);
        if (fs.existsSync(upgradePath)) {
          return upgradePath;
        }
      }
      return null;
    }

    function listDir(dir) {
      const listChild: string[] = [];
      const children = getDirectories(dir);
      for (const name of children) {
        listChild.push(path.join(dir, name));
      }
      return listChild;
    }

    function getScripts(p) {
      if (!p) {
        return {};
      }
      const res = {}
      for (const version of listDir(p)) {
        const dir = path.join(p, version);
        if (isDir(dir)) {
          res[version] = glob.sync(`**/*.ts`, {
            ignore: IGNORE_FOLDERS,
            cwd: dir
          });
        }
      }
      return res;
    }

    for (const pkg of this.graph) {
      if (!(hasattr(pkg, 'update') || pkg.state === 'to upgrade' ||
          getattr(pkg, 'loadState', null) === 'to upgrade')) {
        continue;
      }

      this.migrations[pkg.name] = {
        'module': getScripts(getResourcePath(pkg.name, 'migrations')),
        'moduleUpgrades': getScripts(getResourcePath(pkg.name, 'upgrades')),
        'upgrade': getScripts(_getUpgradePath(pkg.name)),
      }
    }
  }

  migrateModule(pkg: Record<string, any>, stage: string) {
    assert(['pre', 'post', 'end'].includes(stage));
    const self = this;
    const stageformat = {
      'pre': '[>%s]',
      'post': '[%s>]',
      'end': '[$%s]',
    }
    const state = ['pre', 'post'].includes(stage) ? pkg.state : getattr(pkg, 'loadSstate', null);

    if (! (hasattr(pkg, 'update') || state === 'to upgrade') || state === 'to install') {
      return;
    }
    
    function convertVersion(version: string) {
      if ((version.match(/\./g) || []).length >= 2) {
        return version  // the version number already contains the server version
      }
      return `${release.majorVersion}.${version}`;
    }

    function _getMigrationVersions(pkg, stage) {
      let versions = []
      for (const lv of Object.values(self.migrations[pkg.name])) {
        for (const [ver, lf] of Object.entries(lv)) {
          if (lf) {
            versions.push(ver);
          }
        }
      }
      versions = sorted(versions, (k) => parseVersion(convertVersion(k)));
      const index= versions.indexOf("0.0.0");
      if (index > -1) {
        // reorder versions
        versions.splice(index, 1);
        if (stage === "pre") {
          versions.unshift("0.0.0");
        }
        else {
          versions.push("0.0.0");
        }
      }
      return versions;
    }

    function _getMigrationFiles(pkg, version, stage) {
      const m = self.migrations[pkg.name];
      const lst = [];

      const mapping = {
        'module': path.join(pkg.name, 'migrations'),
        'moduleUpgrades': path.join(pkg.name, 'upgrades'),
      }

      for (const p of upgrade.paths) {
        const _p = path.join(p, pkg.name);
        if (fs.existsSync(_p)) {
          mapping['upgrade'] = _p;
          break;
        }
      }

      for (const x of Object.keys(mapping)) {
        if (version in m[x]) {
          for (const f of m[x][version]) {
            if (! f.startsWith(stage + '-'))
              continue;
            lst.push(path.join(mapping[x], version, f));
          }
        }
      }
      lst.sort();
      return lst;
    }

    const installedVersion = getattr(pkg, 'loadVersion', pkg.installedVersion) || '';
    const parsedInstalledVersion = parseVersion(installedVersion);
    const currentVersion = parseVersion(convertVersion(pkg.data['version']));

    const versions = _getMigrationVersions(pkg, stage);

    for (const version of versions) {
      const ver = parseVersion(convertVersion(version));
      if ((version === "0.0.0" && parsedInstalledVersion < currentVersion) || (parsedInstalledVersion < ver && ver <= currentVersion)) {
        const strfmt = {
          'addon': pkg.name,
          'stage': stage,
          'version': stageformat[stage] % version,
        }

        for (const scrfile of _getMigrationFiles(pkg, version, stage)) {
          const {name, ext} = path.parse(scrfile);
          if (['.ts','.js'].includes(ext.toLowerCase())) {
            continue;
          }
          let migrate, error;
          let mod: any;
          try {
            mod = loadScript(scrfile, name);
            console.info(_format('module {addon}: Running migration {version} {name}', {...strfmt, name: mod.__name__}));
            migrate = mod.migrate;
          }
          catch(e) {
            error = true;
            if (isInstance(e, ImportError)) {
              console.error(_format('module {addon}: Unable to load {stage}-migration file {file}', {...strfmt, file: scrfile}));
              throw e;
            }
            if (isInstance(e, AttributeError)) {
              console.error('module {addon}: Each {stage}-migration file must have a "migrate(cr, installedVersion)" function', strfmt);
            }
            else {
              migrate(this.cr, installedVersion);
            }
          }
          if (!error) {
            migrate(this.cr, installedVersion);
          }
          if (mod) {
            // delete mod;
          }
        }
      }
    }
  }
}