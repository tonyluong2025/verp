import assert from 'assert';
import commandLineArgs from 'command-line-args';
import * as fs from 'fs';
import camelCase from 'lodash.camelcase';
import { homedir, platform } from 'os';
import * as path from 'path';
import prettier from 'prettier';
import * as conf from '../../core/conf';
import { getattr } from '../api/func';
import { Dict } from '../helper/collections';
import * as modules from '../modules/modules';
import * as release from '../release';
import { bool } from './bool';
import * as context from './context';
import { stringify } from './json';
import { normalize } from './misc';
import { whichSync } from './which';

export function findInPath(name) {
  const p = (process.env['PATH'] || '').split(path.sep);
  if (config['binPath'] && config['binPath'] !== 'null') {
    p.push(config['binPath']);
  }
  return whichSync(name, { path: p.join(path.sep) });
}

const argConfig = {
  definitions: [
    // Server startup config
    { name: 'config', alias: 'c', defaultValue: null, description: 'specify alternate config file' },
    { name: 'save', alias: 's', type: Boolean, defaultValue: false, description: 'save configuration to ~/.verprc' },
    { name: 'reset', alias: 'r', type: Boolean, defaultValue: false, description: 'reset testing database if it exists)' },
    { name: 'init', alias: 'i', description: `install one or more modules (comma-separated list, use "all" for all modules), requires -d` },
    { name: 'update', alias: 'U', description: 'update one or more modules (comma-separated list, use "all" for all modules). Requires -d.' },
    { name: 'without-demo', alias: 'o', type: Boolean, myDefault: false, description: 'disable loading demo data for modules to be installed (comma-separated, use "all" for all modules). Requires -d and -i. Default is %default' },
    { name: 'import-partial', alias: 'P', myDefault: '', description: 'Use this for big data importation, if it crashes you will be able to continue at the current state. Provide a filename to store intermediate importation states.' },
    { name: 'pid-file', description: `file where the server pid will be stored` },
    { name: 'addons-path', description: 'specify additional addons paths (separated by commas).' },
    { name: 'upgrade-path', description: 'specify an additional upgrade path.' },
    { name: 'load', myDefault: 'base,web', description: 'Comma-separated list of server-wide modules.' },
    { name: 'data-dir', alias: 'D', myDefault: getDefaultDataDir(release.productName), description: 'Directory where to store Verp data' },

    // HTTP
    { name: 'http-interface', myDefault: '', description: 'Listen interface address for HTTP services. Keep empty to listen on all interfaces (0.0.0.0)' },
    { name: 'http-port', alias: 'p', myDefault: 7979, type: Number, description: 'Listen port for the main HTTP service' },

    // HTTP:for "*xmlrpc"

    // WEB
    { name: 'db-filter', alias: 'f', myDefault: '', description: 'Regular expressions for filtering available databases for Web UI. The expression can use %s (domain) and %s (host) placeholders.' },

    // Testing

    // Logging
    { name: 'log-file', description: 'file where the server log will be stored' },
    { name: 'sys-log', type: Boolean, myDefault: false, description: 'Send the log to the syslog server' },

    // SMTP

    // Database
    { name: 'db-name', alias: 'd', description: `specify the database name` },
    { name: 'db-user', alias: 'u', description: `specify the database user name` },
    { name: 'db-password', alias: 'w', description: `specify the database password` },

    // Advanced options

    // 
    { name: 'translate-in', description: `import a CSV or a PO file with translations and exit. The '-l' option is required.` },
    { name: 'translate-out', description: 'export all sentences to be translated to a CSV file, a PO file or a TGZ archive and exit' },
  ],
  usage: [
    {
      header: 'git commit',
      content: 'Commit some work.'
    },
    {
      header: 'synopsis',
      content: '$ git commit <options> [--message] <message>'
    }
  ]
}

const DEFAULT_CRYPT_CONTEXT = new context.CryptContext(['pbkdf2_sha512', 'plaintext']);

export class ConfigManager extends Function {
  options: Dict<any>;
  blacklistForSave: Set<string>;
  casts: Record<string, any>;
  misc: Record<string, any>;
  configFile: any;
  version: string;
  // LOGLEVELS: any;
  levels: string[];
  rcfile: string;
  parser = {
    parseArgs: commandLineArgs,
    log: (msg: string) => {
      console.log(`Parser error: ${msg}`);
    }
  }

  get addonsDataDir(): string {
    const addDir = path.join(this.options['dataDir'], 'addons');
    const d = path.join(addDir, release.series);
    if (!fs.existsSync(d)) {
      try {
        if (!fs.existsSync(addDir)) {
          fs.mkdirSync(addDir, { mode: 0o700, recursive: true });
        }
        fs.mkdirSync(d, { mode: 0o500, recursive: true });
      } catch (e) {
        console.log('Failed to create addons data dir %s, error: %s', d, e);
      }
    }
    return d;
  }

  get sessionDir() {
    const d = path.join(this.get('dataDir'), 'sessions');
    try {
      fs.mkdirSync(d, { mode: 0o700, recursive: true });
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
      assert(fs.accessSync(d, fs.constants.W_OK), `${d}: directory is not writable`);
    }
    return d;
  }

  constructor(fname = null) {
    super();

    this.options = new Dict<any>({
      'adminPasswd': 'admin',
      'csvInternalSep': ',',
      'publisherWarrantyUrl': 'http://services.theverp.com/publisher-warranty/',
      'reportGz': false,
      'rootPath': null
    });
    this.blacklistForSave = new Set([
      'publisherWarrantyUrl', 'loadLanguage', 'rootPath',
      'init', 'save', 'reset', 'config', 'update', 'stopAfterInit', 'devMode', 'shellInterface'
    ]);
    this.casts = {};
    this.misc = {};
    this.configFile = fname;
    // this.LOGLEVELS = ['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG', 'NOTSET'].reduce((map: any, x) => {
    //   if (loglevels.loglevels[`LOG_${x}`]) {
    //     map.x = x;
    //   }
    //   return map;
    // }, {});
    // dict([
    //   (getattr(loglevels, 'LOG_%s' % x), getattr(logging, x))
    //   for x in ('CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG', 'NOTSET')
    // ])
    this.version = `${release.description} ${release.version}`;

    // console.log(this);
    this.levels = [
      'info', 'debugRpc', 'warn', 'test', 'critical', 'runbot',
      'debugSql', 'error', 'debug', 'debugRpcAnswer', 'notset'
    ]

    // Copy all option definations (i.e. MyOption) into self.options.

    for (const option of argConfig.definitions) {
      const n = camelCase(option.name);
      if (!(n in this.options)) {
        this.options[n] = option.myDefault;
        this.casts[n] = option;
      }
    }

    // generate default config
    this._parseConfig();
  }

  setAdminPassword(newPassword) {
    this.options['adminPasswd'] = DEFAULT_CRYPT_CONTEXT.hash(newPassword);
  }

  /**
   * Verifies the super-admin password, possibly updating the stored hash if needed
   * @param password 
   */
  verifyAdminPassword(password: string): any {
    const storedHash = this.options.get('adminPasswd');
    if (!storedHash) {
      // empty password/hash => authentication forbidden
      return false;
    }

    const [valid, updatedHash] = DEFAULT_CRYPT_CONTEXT.verifyAndUpdate(password, storedHash);
    if (valid) {
      if (updatedHash) {
        this.options.set('adminPasswd', updatedHash);
      }
      return true;
    }
  }

  private load() {
    try {
      const rawdata = fs.readFileSync(this.rcfile);
      const conf = JSON.parse(rawdata.toString());
      const dict = new Dict<any>();
      for (const [key, value] of Object.entries<any>(conf)) {
        if (!key.startsWith('//')) {
          dict[camelCase(key)] = value;
        }
      }
      Dict.fill(this.options, dict);
    } catch (e) {
      console.log('Can not load config: %s', this.rcfile);
    }
  }

  save(keys?: any) {
    console.log('Saved the file config.json');
    try {
      const rcExists = fs.existsSync(this.rcfile);
      let conf: Dict<any>;
      if (rcExists) {
        const rawdata = fs.readFileSync(this.rcfile);
        conf = Dict.from(JSON.parse(rawdata.toString()));
      } else {
        conf = new Dict<any>();
      }
      for (const opt of this.options.keys().sort()) {
        if (keys != null && !keys.includes(opt)) {
          continue;
        }
        if (['version', 'language', 'translateOut', 'translateIn', 'overwriteExistingTranslations', 'init', 'update'].includes(opt)) {
          continue;
        }
        if (this.blacklistForSave.has(opt)) {
          continue;
        }
        if (['logLevel',].includes(opt)) {
          conf.set(opt, this.options.get(opt));
        }
        else if (opt === 'logHandler') {
          conf.set(opt, this.options.get(opt, []).join(','));
        }
        else {
          conf.set(opt, this.options.get(opt));
        }
      }

      if (!rcExists && !fs.existsSync(path.parse(this.rcfile).dir)) {
        try {
          fs.mkdirSync(path.parse(this.rcfile).dir);
        } catch (e) {
          console.error("ERROR: couldn't create the config directory\n");
        }
      }
      prettier.format(stringify(conf), { parser: 'json' }).then(confStr => {
        fs.writeFileSync(this.rcfile, confStr);
        if (!rcExists) {
          fs.chmodSync(this.rcfile, 0o600);
        }
      }, e => {
        console.error("ERROR: couldn't write the config file. %s\n", e.message);
      });
    } catch (e) {
      console.log('Can not load config: %s', this.rcfile);
    }
  }

  parseConfig(args?: string[]) {
    // console.log(`Config.parseConfig=${args}`);
    const opt = this._parseConfig(args);
    // core.netsvc.initLogger();
    modules.initializeSysPath();
    return opt;
  }

  _parseConfig(args?: string[]) {
    if (args == null) {
      args = [];
    }
    const index = args.findIndex(val => val.startsWith('-'));
    if (index > -1) {
      args.splice(0, index);
    }
    let opt = this.parser.parseArgs(argConfig.definitions, { argv: args, camelCase: true, stopAtFirstUnknown: false, partial: true });
    opt = (opt._all) ? opt._all : opt;
    args = opt._unknown || [];

    function die(cond: any, msg: string) {
      if (cond) {
        this.parser.log(msg);
      }
    }

    // Ensures no illegitimate argument is silently discarded (avoids insidious "hyphen to dash" problem)
    die(args.length, `unrecognized parameters: ${args.join(' ')}`);

    die(Boolean(opt.sysLog) && Boolean(opt.logFile), "the syslog and logfile options are exclusive");

    die(opt.translateIn && (!opt.language || !opt.dbName), 'the i18n-import option cannot be used without the language (-l) and the database (-d) options');

    die(opt.overwriteExistingTranslations && !(opt.translateIn || opt.update), "the i18n-overwrite option cannot be used without the i18n-import option or without the update option");

    die(opt.translateOut && !opt.dbName, "the i18n-export option cannot be used without the database (-d) option");

    // Check if the config file exists (-c used, but not -s)
    function access(path: fs.PathLike, mode: number): boolean {
      try {
        fs.accessSync(path, mode);
        return true;
      }
      catch (err) {
        return false;
      }
    }

    die(!opt.save && opt.config && !access(opt.config, fs.constants.R_OK), `The config file ${opt.config} selected with -c/--config doesn't exist or is not readable, use -s/--save if you want to generate it`);

    die(Boolean(opt.osvMemoryAgeLimit) && Boolean(opt.transientMemoryAgeLimit), "the osv-memory-count-limit option cannot be used with the transient-age-limit option, please only use the latter.");

    // place/search the config file on Win32 near the server installation
    // (../etc from the server)
    // if the server is run by an unprivileged user, he has to specify location of a config file where he has the rights to write,
    // else he won't be able to save the configurations, or even to start the server...
    let rcfilepath: string;
    if (process.platform === 'win32') {
      rcfilepath = path.resolve(global.ROOT_PATH, '..', 'config.json');
    } else {
      rcfilepath = path.resolve('~/.verprc');
    }

    this.rcfile = path.resolve(this.configFile || opt.config || process.env['VERP_RC'] || rcfilepath);
    this.load();

    // Verify that we want to log or not, if not the output will go to stdout
    if (!this.options['logFile']) {
      this.options['logFile'] = false;
    }
    // the same for the pidFile
    if (!this.options['pidFile']) {
      this.options['pidFile'] = false;
    }
    // the same for the test_tags
    if (!this.options['testTags']) {
      this.options['testTags'] = null;
    }
    // and the server_wide_modules
    if (['', null, false, undefined].includes(this.options['serverWideModules'])) {
      this.options['serverWideModules'] = 'base,web';
    }

    let keys = ['httpInterface', 'httpPort',
      'longPollingPort', 'httpEnable',
      'dbDialect', 'dbName', 'dbUser', 'dbPassword', 'dbHost', 'dbSslmode',
      'dbPort', 'dbTemplate', 'logFile', 'pidFile', 'smtpPort',
      'emailFrom', 'smtpServer', 'smtpUser', 'smtpPassword', 'fromFilter',
      'smtpSslCertificateFilename', 'smtpSslPrivateKeyFilename',
      'dbMaxConn', 'importPartial', 'addonsPath', 'upgradePath',
      'sysLog', 'withoutDemo', 'screencasts', 'screenshots',
      'dbFilter', 'logLevel', 'logDb',
      'logDbLevel', 'geoIpDatabase', 'devMode', 'shellInterface'
    ];
    for (const arg of keys) {
      // Copy the command-line argument (except the special case for logHandler, due to
      // action=append requiring a real default, so we cannot use the myDefault workaround)
      if (getattr(opt, arg, null) !== null) {
        this.options[arg] = getattr(opt, arg);
      }
      // ... or keep, but cast, the config file value.
      else if ((typeof this.options[arg] === 'string') && this.casts[arg]?.type) {
        // this.options[arg] = this.casts[arg].type(...);
      }
    }

    if (typeof this.options['logHandler'] === 'string') {
      this.options['logHandler'] = this.options['logHandler'].split(',');
    }
    if (Array.isArray(this.options['logHandler'])) {
      this.options['logHandler'] = this.options['logHandler'].concat(opt.logHandler);
    }
    // if defined but None take the configfile value
    keys = [
      'language', 'translateOut', 'translateIn', 'overwriteExistingTranslations',
      'devMode', 'shellInterface', 'smtpSsl', 'loadLanguage',
      'stopAfterInit', 'withoutDemo', 'httpEnable', 'sysLog',
      'listDb', 'proxyMode',
      'testFile', 'testTags',
      'osvMemoryCountLimit', 'osvMemoryAgeLimit', 'transientAgeLimit', 'maxCronThreads', 'unaccent',
      'dataDir',
      'serverWideModules',
    ]
    const posixKeys = [
      'workers',
      'limitMemoryHard', 'limitMemorySoft',
      'limitTimeCpu', 'limitTimeReal', 'limitRequest', 'limitTimeRealCron'
    ]
    if (process.platform !== 'win32') {
      keys = [...keys, ...posixKeys]
    } else {
      Dict.fill(this.options, Dict.fromKeys(posixKeys, null));
    }

    // Copy the command-line arguments...
    // const types = new Set(Object.values(this.casts).map(arg => arg.type));
    for (const arg of keys) {
      if (getattr(opt, arg, null) !== null) {
        this.options[arg] = getattr(opt, arg);
      }
      // ... or keep, but cast, the config file value.
      else if ((typeof this.options[arg] === 'string') && this.casts[arg]?.type) {
        this.options[arg] = this.casts[arg].type(this.options[arg]);
      }
    }

    this.options['rootPath'] = global.ROOT_PATH;
    if (!this.options['addonsPath']) {
      this.options['addonsPath'] = '';
    } else {
      this.options['addonsPath'] = (this.options['addonsPath'].split(',').map((value: string) => normalize(value))).join(',');
    }

    this.options['init'] = opt.init ? Dict.fromKeys(opt.init.split(','), 1) : Dict.from({});
    this.options['demo'] = Dict.from<any>(!this.options['withoutDemo'] ? this.options['init'] : {});
    this.options['update'] = opt.update ? Dict.fromKeys<any>(opt.update.split(','), 1) : Dict.from<any>({});

    const transactionModules = opt.transactionModules && opt.translateModules.split(',').map((v: string) => v.trim());
    this.options['translateModules'] = bool(transactionModules) ? transactionModules : ['all'];
    this.options['translateModules'].sort();

    let devSplit = opt.devMode && opt.devMode.split(',').map(s => s.trim());
    devSplit = bool(devSplit) ? devSplit : [];
    this.options['devMode'] = devSplit.includes('all') ? devSplit.concat(['pdb', 'reload', 'qweb', 'theveb', 'xml']) : devSplit;

    if (opt.dbPath) {
      this.options['dbPath'] = opt.dbPath;
    }

    this.options['testEnable'] = bool(this.options['testTags']);
    this.options['reset'] = opt.reset;

    if (opt.save) {
      this.save();
    }
    // normalize path options
    for (const key of ['dataDir', 'logFile', 'pidFile', 'testFile', 'screencasts', 'screenshots', 'pgPath', 'translateOut', 'translateIn', 'geoIpDatabase']) {
      this.options[key] = normalize(this.options[key]);
    }

    conf.addonsPaths.length = 0;
    conf.addonsPaths.push(this.options['addonsPath'].split(','));

    conf.serverWideModules.length = 0;
    for (const value of this.options['serverWideModules'].split(',')) {
      const newValue = value.trim();
      if (newValue.length)
        conf.serverWideModules.push(newValue);
    }

    return opt;
  }

  filestore(dbName) {
    return path.join(this.get('dataDir'), 'filestore', dbName);
  }

  set(key: string, value: any) {
    this.options[key] = value;
    if ((key in this.options) && (typeof this.options[key] == 'string')
      // && (key in this.casts) && (this.casts[key].type in optparse.Option.TYPE_CHECKER)
    ) {
      // this.options[key] = optparse.Option.TYPE_CHECKER[this.casts[key].type](this.casts[key], key, this.options[key])
    }
  }

  get(key: string, value?: any): any {
    if (key in this.options) {
      return this.options[key];
    }
    else {
      return value;
    }
  }
}

function getDefaultDataDir(app?: string) {
  function getForWindows() {
    return path.join(homedir(), "AppData", "Roaming");
  }

  function getForMac() {
    return path.join(homedir(), "Library", "Application Support");
  }

  function getForLinux() {
    return `/var/lib`;
  }

  function getFallback() {
    if (platform().startsWith("win")) {
      return getForWindows();
    }
    return getForLinux();
  }

  let appDataPath = process.env["APPDATA"];

  if (appDataPath === undefined) {
    switch (platform()) {
      case "win32":
        appDataPath = getForWindows();
        break;
      case "darwin":
        appDataPath = getForMac();
        break;
      case "linux":
        appDataPath = getForLinux();
        break;
      default:
        appDataPath = getFallback();
    }
  }

  if (app === undefined) {
    return appDataPath;
  }

  const normalizedAppName = appDataPath !== homedir() ? app : "." + app;

  return path.join(appDataPath, normalizedAppName);
}

const config = new ConfigManager();
export { config };

