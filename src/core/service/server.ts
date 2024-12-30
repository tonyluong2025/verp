import cluster from 'cluster';
import * as http from "http";
import os from 'os';
import { KeyboardError } from '../helper';
import { Registry } from '../modules/registry';
import { dbConnect } from '../sql_db';
import { loader } from '../tests';
import { config, dumpStacks, isFile, logOrmCacheStats } from '../tools';
const core = require('./../../core');

class CommonServer {
  app: http.RequestListener;
  _onStopFuncs: any[];
  hostname: string;
  port: number;
  pid: number;

  constructor(app: http.RequestListener) {
    this.app = app;
    this._onStopFuncs = [];
    this.hostname = config.options['httpHostname'] ?? '0.0.0.0';
    this.port = config.options['httpPort'];
    this.pid = process.pid;
  }

  closeSocket(sock) {
    console.warn(`Not implemented`);
  }

  /**
   * Register a cleanup function to be executed when the server stops
   * @param func 
   */
  onStop(func) {
    this._onStopFuncs.push(func);
  }

  stop() {
    console.log(`CommonServer stop`);
    for (const func of this._onStopFuncs) {
      try {
        console.debug("onClose call %s", func);
        func();
      } catch(e) {
        console.warn("Exception in %s", func.name);
      }
    }
  }
}

const Signals = {
  SIGINT: 'SIGINT',
  SIGTERM: 'SIGTERM',
  SIGCHLD: 'SIGCHLD',
  SIGHUP: 'SIGHUP',
  SIGXCPU: 'SIGXCPU',
  SIGQUIT: 'SIGQUIT',
  SIGUSR1: 'SIGUSR1', 
}

class ThreadedServer extends CommonServer {
  mainThreadId: number;
  quitSignalsReceived: number;
  httpd: any;
  limitsReachedThreads: Set<number>;
  limitReachedTime: any;

  constructor(app) {
    super(app);
    this.mainThreadId = process.pid
    // Variable keeping track of the number of calls to the signal handler defined below. This variable is monitored by ``quit_on_signals()``.
    this.quitSignalsReceived = 0

    //self.socket = None
    this.httpd = null;
    this.limitsReachedThreads = new Set();
    this.limitReachedTime = null;
  }
  
  signalHandler(sig) {
    if ([Signals.SIGINT, Signals.SIGTERM].includes(sig)) {
      console.log('Signal SIGINT, SIGTERM', this.quitSignalsReceived);
      if (this.quitSignalsReceived < 1) {
        // logging.shutdown was already called at this point.
        process.stderr.write("Forced shutdown.\n")
        // interrupt run() to start shutdown
        process.exit(0);
        // setTimeout(() => process.exit(0), 300);
        // throw new ValueError(`signalHandler sig=${sig}, times=${this.quitSignalsReceived}`); // FIXME
      }
      this.quitSignalsReceived += 1;
    } 
    else if (sig === Signals.SIGXCPU) {
      console.log('Signal SIGXCPU');
      process.stderr.write("CPU time limit exceeded! Shutting down immediately\n");
      // process.stderr.flush()
      process.exit(0);
    }
    else if (sig === Signals.SIGHUP) {
      console.log('Signal SIGHUP');
      // restart on kill -HUP
      core.phoenix = true;
      this.quitSignalsReceived += 1;
      // interrupt run() to start shutdown
      throw new KeyboardError(`signalHandler sig=${sig}`);
    }
  }

  processLimit() {}

  async cronThread(number=1) {
    console.log(`run cronThread...`);
    const {IrCron} = require('../addons/base/models/ir_cron');

    const conn = dbConnect(config.get('dbDialect'));
    const cr = conn.cursor();
    const res = await cr.execute('SELECT pg_is_in_recovery()');
    const inRecovery = res[0]['pg_is_in_recovery'];
    if (!inRecovery) {
      await cr.execute("LISTEN cron_trigger");
    } else {
      console.warn("PG cluster in recovery mode, cron trigger not activated");
    }
    await cr.commit();
    await cr.reset();

    while (true) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // loop 5s

      // console.debug('cron%s polling for jobs', number);
      const registries = Registry.registries;
      for (const [dbName, registry] of Object.entries<Registry>(registries)) {
        if (registry.ready) {
          try {
            await IrCron._processJobs(dbName);
          } catch(e) {
            console.warn('cron%s encountered an exception: %s', number, e.message);
          }
        }
      }
      // Testing run only one time
      // console.log('Finished cronThread');
      // break;
      // Testing
    }
    await cr.close();
  }

  cronSpawn() {
    console.log(`run cronSpawn...`);
    const clusterWorkerSize = os.cpus().length;
    const maxCronThreads = Number(core.tools.config.get('maxCronThreads'));
    if (maxCronThreads > 1 && clusterWorkerSize > 1 ) {
      console.log(`CPUs=${clusterWorkerSize} Threads=${maxCronThreads}`);
      if (cluster.isPrimary) {
        console.log(`Master Id=${process.pid}`);
        const numWokers = Math.min(clusterWorkerSize, maxCronThreads);
        for (let i=1; i <= numWokers; i++) {
          console.log(`cluster make worker ${i}/${numWokers}`);
          cluster.fork();
        }

        Object.keys(cluster.workers).forEach((id) => {
          console.log("I am running with ID : " + cluster.workers[id].process.pid);
        });

        cluster.on("exit", (worker) => {
          console.log("Worker", worker.id, " has exited.")
        });
      } else {
        console.log(`Spawn Id=${process.pid}`);
        // this.cronThread(); // comment for testing
      }
    } else {
      // this.cronThread(); // comment for testing
    }
  }

  httpThread() {
    console.log(`run httpThread...`);
    const server = http.createServer(this.app);
    server.listen(this.port, this.hostname, () => {
      console.warn(`Server is running on http://${this.hostname}:${this.port}`);
    });
  }

  httpSpawn() {
    console.log(`run httpSpawn...`);
    this.httpThread();
  }

  start(stop: boolean) {
    console.log("Setting signal handlers");
    if (process.platform === 'linux' || process.platform === 'win32') {
      process.on(Signals.SIGINT, () => this.signalHandler(Signals.SIGINT));
      process.on(Signals.SIGTERM, () => this.signalHandler(Signals.SIGTERM));
      process.on(Signals.SIGCHLD, () => this.signalHandler(Signals.SIGCHLD));
      process.on(Signals.SIGHUP, () => this.signalHandler(Signals.SIGHUP));
      process.on(Signals.SIGXCPU, () => this.signalHandler(Signals.SIGXCPU));
      process.on(Signals.SIGQUIT, () => dumpStacks());
      process.on(Signals.SIGUSR1, () => logOrmCacheStats());
    }

    const testMode = config.get('testEnable') || config.get('testFile');
    if (testMode || (config.get('httpEnable') && !stop)) {
      // # some tests need the http daemon to be available...
      this.httpSpawn();
    }
  }

  stop() {

  }

  async run(preload: [], stop: boolean) {
    this.start(stop);

    const rc = await preloadRegistries(preload);

    if (stop) {
      if (config.get('testEnable')) {
        let logger;
        Registry.lock.acquire('registry', (done) => {
          for (const [db, reg] of Object.entries( Registry.registries)) {
            const report = reg._assertionReport;
            const log = !report.wasSuccessful() ? logger.error 
            : !report.testsRun ? logger.warning : logger.info;
            log(`${report} when loading database ${db}`);
          }
          done();
        });
      }
      this.stop();
      return rc;
    }

    this.cronSpawn();

    this.stop();
  }

  reload() {

  }
}

export async function start(preload: any[], stop: boolean) {
  await loadServerWideModules();

  if (config.options['workers']) {
    //
  } else {
    if (process.platform == 'linux' && Number.MAX_SAFE_INTEGER > 2**32 && !process.env['MALLOC_ARENA_MAX']) {
      //
    }
    global.server = new ThreadedServer(core.service.wsgi_server.application)
  }

  const rc = await global.server.run(preload, stop);

  return rc || 0;
}

async function loadServerWideModules() {
  const serverWideModules = new Set(['base', 'web'].concat(core.conf.serverWideModules));
  for (const m of serverWideModules) {
    try {
      await core.modules.loadErpModule(m);
    } catch(e) {
      let msg = '';
      if (m === 'web') {
        msg = `The 'web' module is provided by the addons found in the 'verp-web' project. Maybe you forgot to add those addons in your addonsPpath configuration.`;
      }
      console.warn('Failed to load server-wide module `%s`.%s. \nDetail: %s', m, msg, e);
    }
  }
}

const SCRIPTFILE = ['js', 'ts', 'mjs'];

async function preloadRegistries(dbNames: string[]=[]): Promise<number> {
  let rc = 0;
  for (const dbname of dbNames) {
    try {
      const updateModule = config.get('init') ?? config.get('update');
      const registry = await Registry.new(dbname, {updateModule: updateModule});

      // run testFile if provided
      const testFile: string = config.get('testFile') || '';
      if (testFile) {
        if (!isFile(config.rcfile)) {
          console.log('test file %s cannot be found', testFile)
        } else if (!testFile.endsWith('ts') || !testFile.endsWith('js')) {
          console.log('test file %s is not a script file', testFile);
        } else {
          console.log('loading test file %s', testFile);
          loadTestFile(registry, testFile);
        }
      }

      if (config.get('testEnable')) {
        const t0 = Date.now();
        const t0Sql = global.sqlCounter;
        const moduleNames = updateModule ? registry.updatedModules : Array.from<string>(registry._initModules).sort((a, b) => a.localeCompare(b));
        console.log('Starting post tests');
        const testsBefore = registry._assertionReport.testsRun;
        const result = loader.runSuite(loader.makeSuite(moduleNames, 'portInstall'));
        registry._assertionReport.update(result);
        console.log(`${registry._assertionReport.testsRun - testsBefore} post-tests in ${Date.now() - t0}.2fs, ${global.sqlCounter - t0Sql} queries`);
      }

      if (!registry._assertionReport.wasSuccessful()) {
        rc += 1;
      }
    } catch(e) {
      console.log(`Failed to initialize database '${dbname}'.`);
      return -1;
    }
  }
  return rc;
}

function loadTestFile(registry: Registry, testFile: string) {
  const {VerpSuite} = require('./../tests/common')
  try {
    const suite = new VerpSuite('tests');
  } catch(e) {
    //
  }
}