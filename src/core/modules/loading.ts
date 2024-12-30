require('./../globals');
import { delattr, getattr, hasattr, setattr } from '../api/func';
import { dbFactory } from '../service/db';
import { Cursor } from '../sql_db';
import { VerpTestResult } from '../tests/runner';
import { bool, doWith, extend, len, quoteList } from '../tools';
import { loadLanguage } from '../tools/translate';
import { tools } from './..';
import * as core from './../../core';
import { Environment } from './../api/api';
import { Graph, Node } from './graph';
import { adaptVersion, getModuleLoaded, initializeSysPath, loadErpModule } from './modules';

const _logger = console;
const _testogger = console;

/**
 * Forces the `demo` flag on all modules, and installs demo data for all installed modules.
 * @param cr 
 */
export async function forceDemo(env: Environment) {
  const graph = new Graph();
  const cr = env.cr;
  await cr.execute('UPDATE "irModuleModule" SET demo=true');
  const res = await cr.execute(
    `SELECT label FROM "irModuleModule" WHERE state IN ('installed', 'to upgrade', 'to remove')`
  );
  const moduleList = res.map((rec) => rec['label']);
  graph.addModules(cr, moduleList, ['demo']);

  for (const pack of graph) {
    await loadDemo(env, pack, {}, 'init');
  }

  env = await env.clone({ user: global.SUPERUSER_ID, context: {} });
  env.items('ir.module.module').invalidateCache(['demo']);
  await env.items('res.groups')._updateUserGroupsView();
}

async function loadModuleGraph(env: Environment, graph: Graph, options: { status?: string, performChecks?: boolean, skipModules?: string[], report?: VerpTestResult, modelsToCheck?: Set<string>, idref?: {} } = {}) {
  const performChecks = options.performChecks ?? true;
  const skipModules = options.skipModules || [];
  const report = options.report;
  let modelsToCheck = options.modelsToCheck;

  if (!modelsToCheck) {
    modelsToCheck = new Set();
  }
  const processedModules = [];
  const loadedModules = [];
  const cr = env.cr;
  const registry = await core.registry(cr.dbName);
  const migrations = new core.modules.migration.MigrationManager(cr, graph);
  const graphModules = Object.keys(graph);
  console.info(`loadModuleGraph ${graphModules.length} ordered modules: ${String(graphModules)}`);
  const loadingExtraQueryCount = global.sqlCounter;
  const loadingCursorQueryCount = cr.sqlLogCount;

  let modelsUpdated = new Set<string>();

  const t0 = new Date();
  let index = 0;
  for (const [, pack] of Object.entries<Node>(graph)) {
    const moduleName = pack.name;
    const moduleId = pack.id;
    let modul: any;

    if (skipModules && (skipModules.includes(moduleName))) {
      continue;
    }

    const moduleT0 = new Date();
    const moduleCursorQueryCount = cr.sqlLogCount;
    const moduleExtraQueryCount = global.sqlCounter;

    const needsUpdate =
      hasattr(pack, 'init')
      || hasattr(pack, 'update')
      || ['to install', 'to upgrade'].includes(pack.state);

    let moduleLogLevel = '';//logging.DEBUG;
    if (needsUpdate) {
      moduleLogLevel = '';//logging.INFO; 
    }
    // console.log(moduleLogLevel, `(${++index}/${moduleCount}) prepair to load module ${moduleName}`);

    if (needsUpdate) {
      if (pack.name !== 'base') {
        await registry.setupModels(cr);
      }
      migrations.migrateModule(pack, 'pre');
      if (pack.name !== 'base') {
        const env = await core.api.Environment.new(cr, global.SUPERUSER_ID);
        await env.items('base').flush();
      }
    }

    await loadErpModule(pack.name);

    const newInstall = pack.state === 'to install';
    let mod: any;
    if (newInstall) {
      mod = getModuleLoaded(moduleName);
      const preInit = pack.info['preInitHook'];
      if (preInit) {
        const func = mod.exports[`${preInit}`] ?? (() => { });
        await func(cr);
      }
    }

    const modelNames = registry.buildModels(cr, pack);

    let mode = 'update';
    if (hasattr(pack, 'init') || pack.state === 'to install') {
      mode = 'init';
    }

    loadedModules.push(pack.name);
    if (needsUpdate) {
      modelsUpdated = new Set([...modelsUpdated, ...modelNames]);
      modelsToCheck = new Set([...modelsToCheck].filter((x) => !modelNames.has(x)));
      try {
        await registry.setupModels(cr);
        await registry.initModels(cr, Array.from(modelNames), { 'module': pack.name }, newInstall);
      } catch (e) {
        console.log('Failed to run loadModuleGraph on db %s: ', cr.dbName);
        throw e;
      }
    } else if (pack.state !== 'to remove') {
      modelsToCheck = new Set([...modelsToCheck, ...modelNames].filter((x) => modelsUpdated.has(x)));
    }

    const idref = options.idref;
    const env = await core.api.Environment.new(cr, global.SUPERUSER_ID);
    if (needsUpdate) {
      modul = env.items('ir.module.module').browse(moduleId);

      if (performChecks) {
        await modul._check();
      }

      if (pack.state === 'to upgrade') {
        await modul.write(modul.getValuesFromTerp(pack.data));
      }
      // For debug
      // await cr.commit();
      // await cr.reset();
      // For debug
      console.log('%s: start loading data', pack.name);
      await loadData(env, idref, mode, 'data', pack);
      pack.dbdemo = await loadDemo(env, pack, idref, mode);
      const demoLoaded = pack.dbdemo;

      await cr.execute(`UPDATE "irModuleModule" SET demo=${demoLoaded} WHERE id=${moduleId}`);

      migrations.migrateModule(pack, 'post');

      await modul._updateTranslations(tools.config.options['overwriteExistingTranslations']);
    }

    if (pack.name) {
      registry._initModules.add(pack.name);
    }

    if (needsUpdate) {
      if (newInstall) {
        const postInit = pack.info['postInitHook'];
        if (postInit) {
          await getattr(mod.exports, postInit, (...args: any[]) => { })(cr, registry);
        }
      }

      if (mode === 'update') {
        await env.items('ir.ui.view')._validateModuleViews(moduleName);
      }

      await cr.commit();
      await cr.reset();
      const concreteModels = [];
      modelNames.forEach((model) => { if (!registry.models[model]._abstract) concreteModels.push(model) });

      if (concreteModels.length) {
        const models = await cr.execute(`
          SELECT model FROM "irModel" 
          WHERE id NOT IN (SELECT DISTINCT "modelId" FROM "irModelAccess") AND model IN ($1)
        `, { bind: [concreteModels] });

        if (models.length) {
          const lines = [
            `The models ${models.map(model => model.toString())} have no access rules in module ${moduleName}, consider adding some, like:`,
            `id,label,modelId:id,groupId:id,permRead,permWrite,permCreate,permUnlink`
          ]
          for (const model of models) {
            const xmlid = model['model'].replace('.', '_');
            lines.push(`${moduleName}.access_${xmlid},access_${xmlid},${moduleName}.model_${xmlid},base.groupUser,1,0,0,0`)
          }
        }
      }
    }

    const updating = core.tools.config.options['init'] ?? core.tools.config.options['update'];
    let testTime, testQueries: number;
    let testResults;
    if (core.tools.config.options['testEnable'] && (needsUpdate || updating)) {
      let env = await core.api.Environment.new(cr, global.SUPERUSER_ID);
      const loader = core.tests.loader;
      const suite = loader.makeSuite([moduleName], 'atInstall');
      if (suite.countTestCases()) {
        if (!needsUpdate) {
          registry.setupModels(cr)
        }
        env.items('ir.http').clearRoutingMap();
        const testsT0 = (new Date()).getSeconds();
        const testsQ0 = global.sqlCount;
        testResults = loader.runSuite(suite, moduleName);
        report.update(testResults);
        testTime = (new Date()).getSeconds() - testsT0;
        testQueries = global.sqlCount - testsQ0;

        env = await core.api.Environment.new(cr, global.SUPERUSER_ID);
        modul = env.items('ir.module.module').browse(moduleId);
      }
    }

    if (needsUpdate) {
      processedModules.push(pack.name);

      const ver = adaptVersion(pack.data['version']);
      await modul.write({ 'state': 'installed', 'latestVersion': ver });

      pack.loadState = pack.state;
      pack.loadVersion = pack.installedVersion;
      pack.state = 'installed';
      for (const kind of ['init', 'demo', 'update']) {
        if (hasattr(pack, kind)) {
          delattr(pack, kind);
        }
      }
      await modul.flush();
    }

    const extraQueries = global.sqlCounter - moduleExtraQueryCount - testQueries;
    const extras = [];
    if (testQueries) {
      extras.push(`${testQueries} test`);
    }
    if (extraQueries) {
      extras.push(`${extraQueries} other`);
    }
    const newTime = new Date();
    const queryCount = cr.sqlLogCount - moduleCursorQueryCount;
    console.log(/** \u2713 */`Module (${++index}/${graphModules.length}) %s loaded in %sms %s%s%s`,
      moduleName,
      (newTime.getTime() - moduleT0.getTime()) / 1000,
      testTime ? `(incl. ${testTime}ms test) ` : '',
      queryCount ? `${queryCount} queries ` : '',
      extras.length ? `(${"," + extras})` : ''
    );

    if (testResults && !testResults.wasSuccessful()) {
      console.log("Module %s: %s failures, %s errors of %s tests", moduleName, testResults.failures.length, testResults.errors.length, testResults.testsRun);
    }
  }
  const newTime = new Date();
  console.log("%s modules loaded in %sms, %s queries (+%d extra)", graph.length, (newTime.getTime() - t0.getTime()) / 1000, cr.sqlLogCount - loadingCursorQueryCount, global.sqlCounter - loadingExtraQueryCount);

  return [loadedModules, processedModules];
}

/**
 * Load the modules for a registry object that has just been created. 
 * This function is part of Registry.new() and should not be used anywhere else.
 * @param registry 
 * @param forceDemo 
 * @param status 
 * @param updateModule 
 */
export async function loadModules(env: Environment, forceDemo?: boolean, status?: string, updateModule?: boolean, idref = {}) {
  initializeSysPath();

  const force = [];
  if (forceDemo) {
    force.push('demo');
  }
  const config = tools.config;
  const modelsToCheck = new Set<string>();
  let registry = env.registry;
  const cr = env.cr;
  await cr.query(dbFactory.sqlSetSessionTimeout());
  await cr.reset();
  try {
    const isInstailized = await core.modules.db.isInstailized(cr);
    if (!isInstailized) {
      if (!updateModule) {
        console.log("Database %s not initialized, you can force it with `-i base`", cr.dbName);
      }
      console.log('init database %s', cr.dbName);
      await core.modules.db.initialize(cr);
      // For debug
      // await cr.commit();
      // await cr.reset();
      // For debug
      updateModule = true;
      config.get('init')['all'] = 1;
      if (!config.get('withoutDemo')) {
        config.get('demo')['all'] = 1;
      }
    }

    if (config.get('update')['base'] || config.get('update')['all']) {
      await cr.execute(`UPDATE "irModuleModule" SET state=$1 WHERE label=$2 AND state=$3`, { bind: ['to upgrade', 'base', 'installed'] });
    }

    // STEP 1: LOAD BASE (must be done before module dependencies can be computed for later steps)
    const graph = new core.modules.graph.Graph();
    await graph.addModule(cr, 'base', force);
    if (!graph.has('base')) {
      console.log('Module `base` cannot be loaded! (hint: verify addons-path)');
    }

    // processedModules: for cleanup step after install loadedModules: to avoid double loading
    const report = registry._assertionReport;
    let [loadedModules, processedModules] = await loadModuleGraph(env, graph, { status: status, performChecks: updateModule, report: report, modelsToCheck: modelsToCheck, idref: idref });

    const loadLang = config.options.pop('loadLanguage');
    if (loadLang || updateModule) {
      await registry.setupModels(cr);
    }

    if (loadLang) {
      for (const lang of `${loadLang}`.split(',')) {
        await loadLanguage(cr, lang);
      }
    }

    // STEP 2: Mark other modules to be loaded/updated
    if (updateModule) {
      env = await core.api.Environment.new(cr, global.SUPERUSER_ID, {}, false, env.req);
      const Module = env.items('ir.module.module');
      console.log('Updating modules list');
      await Module.updateList();

      await checkModuleNames(cr, Object.keys(config.get('init')).concat(Object.keys(config.get('update'))));

      let moduleNames = Object.entries(config.get('init')).filter((v) => v[1]).map((v) => v[0]);
      if (moduleNames.length) {
        const modules = await Module.search([['state', '=', 'uninstalled'], ['label', 'in', moduleNames]]);
        if (modules.ok) {
          await modules.buttonInstall();
        }
      }

      moduleNames = Object.entries(config.get('update')).filter((v) => v[1]).map((v) => v[0]);
      if (moduleNames.length) {
        const modules = await Module.search([['state', 'in', ['installed', 'to upgrade']], ['label', 'in', moduleNames]]);
        if (modules.length) {
          await modules.buttonUpgrade();
        }
      }

      await cr.execute('update "irModuleModule" set state=$1 where label=$2', { bind: ['installed', 'base'] });
      Module.invalidateCache(['state']);
      await Module.flush();
    }

    // STEP3:
    let previouslyProcessed = -1;
    while (previouslyProcessed < processedModules.length) {
      previouslyProcessed = processedModules.length;
      processedModules = processedModules.concat(await loadMarkedModules(env, graph, { states: ['installed', 'to upgrade', 'to remove'], force: force, progressDict: status, report: report, loadedModules: loadedModules, performChecks: updateModule, modelsToCheck: modelsToCheck, idref: idref }));

      if (updateModule) {
        processedModules = processedModules.concat(await loadMarkedModules(env, graph, {
          states:
            ['to install'], force: force, progressDict: status, report: report, loadedModules: loadedModules, performChecks: updateModule, modelsToCheck: modelsToCheck, idref: idref
        }));
      }
    }

    // check that all installed modules have been loaded by the registry after a migration/upgrade
    let res = await cr.execute(`SELECT label from "irModuleModule" WHERE state = 'installed' AND label != 'studioCustomization'`);
    let moduleList = res.map((e) => e['label']).filter((e) => !graph[e]);
    if (moduleList.length) {
      console.error("Some modules are not loaded, some dependencies or manifest may be missing: %s", moduleList.sort());
    }

    registry.loaded = true;
    await registry.setupModels(cr);

    // STEP 3.5: execute migration end-scripts
    const migrations = new core.modules.migration.MigrationManager(cr, graph);
    for (const pack of graph) {
      migrations.migrateModule(pack, 'end');
    }

    // check that new module dependencies have been properly installed after a migration/upgrade
    env = await core.api.Environment.new(cr, global.SUPERUSER_ID, {}, false, env.req);
    res = await cr.execute(`SELECT label from "irModuleModule" WHERE state IN ('to install', 'to upgrade')`);
    moduleList = res.map((e) => e['label']);
    if (moduleList.length) {
      console.error("Some modules have inconsistent states, some dependencies may be missing: %s", moduleList.sort());
    }

    // STEP 3.6: apply remaining constraints in case of an upgrade
    await registry.finalizeConstraints();

    // STEP4: Finish and cleanup installations
    if (processedModules.length) {
      env = await core.api.Environment.new(cr, global.SUPERUSER_ID, {}, false, env.req);
      const res = await cr.execute('SELECT model from "irModel"');
      for (const model of res) {
        const name = model['model'];
        if (registry.models[name]) {
          await env.items(name)._checkRemovedColums(true);
          // } else if (_logger.isEnabledFor(logging.INFO)) {
          //   _logger.runbot("Model %s is declared but cannot be loaded! (Perhaps a module was partially removed or renamed)", name);
        }
      }
      await env.items('ir.model.data')._processEnd(processedModules);
      await env.items('base').flush();
    }

    for (const kind of ['init', 'demo', 'update']) {
      config.options[kind] = {};
    }

    // STEP 5: Uninstall modules to remove
    if (updateModule) {
      const res = await cr.execute(`SELECT label, id from "irModuleModule" WHERE state = 'to remove'`);
      const modulesToRemove = Object.fromEntries<any>(res.map(r => [r['label'], r['id']]));
      if (bool(modulesToRemove)) {
        env = await core.api.Environment.new(cr, global.SUPERUSER_ID, {}, false, env.req);
        const pkgs = Object.values(graph).filter(p => p.name in modulesToRemove).reverse();
        for (const pack of pkgs) {
          const mod = getModuleLoaded(pack.name);
          const uninstallHook = pack.info.get('uninstallHook');
          if (uninstallHook) {
            await getattr(mod.exports, `${uninstallHook}`, (...args: any[]) => { })(cr, registry);
          }
        }
        const modul = env.items('ir.module.module');
        await modul.browse(Object.values(modulesToRemove)).moduleUninstall();
        // Recursive reload, should only happen once, because there should be no modules to remove next time
        await cr.commit();
        console.log('Reloading registry once more after uninstalling modules');
        registry = await core.modules.registry.Registry.new(cr.dbName, { req: env.req, forceDemo, status, updateModule });
        await cr.reset(true);

        await registry.checkTablesExist(cr);
        await cr.commit();
        await cr.reset();
        return registry;
      }
    }

    // STEP 5.5: Verify extended fields on every model
    // This will fix the schema of all models in a situation such as:
    //   - module A is loaded and defines model M;
    //   - module B is installed/upgraded and extends model M;
    //   - module C is loaded and extends model M;
    //   - module B and C depend on A but not on each other;
    // The changes introduced by module C are not taken into account by the upgrade of B.
    if (modelsToCheck.size) {
      await registry.initModels(cr, Array.from(modelsToCheck), { 'modelsToCheck': true })
    }

    //STEP6: verify custom views on every model
    if (updateModule) {
      env = await core.api.Environment.new(cr, global.SUPERUSER_ID, {}, false, env.req);
      await env.items('res.groups')._updateUserGroupsView();
      const view = env.items('ir.ui.view');
      for (const modelName of Object.keys(registry.models)) {
        try {
          await view._validateCustomViews(modelName);
        } catch (e) {
          console.log('invalid custom view(s) for model %s: %s', modelName, e)
        }
      }
    }

    if (processedModules.length) {
      if (report.wasSuccessful()) {
        console.log(`Modules loaded: ${processedModules.join(', ')}`)
      } else {
        console.log(`At least one test failed when loading the modules: ${processedModules.join(', ')}`)
      }
    }

    env = await core.api.Environment.new(cr, global.SUPERUSER_ID, {}, false, env.req);
    const models = Object.keys(env.models).map((k) => env.items(k));
    for (const model of models) {
      model._registerHook();
    }
    await env.items('base').flush();

    // STEP 9: save installed/updated modules for post-install tests
    registry.updatedModules = registry.updatedModules.concat(processedModules);
    await cr.commit();
  } catch (e) {
    console.log(e, e.sql ? '\nSQL: ' + e.sql : '');
    await cr.rollback();
  } finally {
    await cr.close();
  }
}

export async function resetModulesState(dbName: string) {
  const db = core.sql_db.dbConnect(dbName);
  const cr = db.cursor();

  await doWith(cr, async () => {
    await cr.execute(
      `UPDATE "irModuleModule" SET state='installed' WHERE state IN ('to remove', 'to upgrade')`
    );
    await cr.execute(
      `UPDATE "irModuleModule" SET state='uninstalled' WHERE state='to install'`
    );
    console.debug("Transient module states were reset");
  });
}

async function loadMarkedModules(env: Environment, graph: Graph, options: { states?: string[], force?: any[], progressDict?: string, report?: core.tests.runner.VerpTestResult, loadedModules?: any[], performChecks?: boolean, modelsToCheck?: Set<string>, idref?: {} }): Promise<any> {
  options = options ?? {};
  if (!options.modelsToCheck) {
    options.modelsToCheck = new Set();
  }

  let processedModules = [];
  const _true = true;
  const cr = env.cr;
  while (_true) {
    const res = await cr.execute(`SELECT label from "irModuleModule" WHERE state IN (${quoteList(options.states)})`);
    const moduleList = res.filter((x) => !graph.has(x['label'])).map((x) => x['label']);
    if (!moduleList.length) {
      break;
    }
    await graph.addModules(cr, moduleList, options.force);
    console.log('updating graph with %s modules:', moduleList.length, moduleList.join(','));
    const [loaded, processed] = await loadModuleGraph(env, graph, options);
    processedModules = extend(processedModules, processed);
    options.loadedModules = extend(options.loadedModules, loaded);
    if (!processed.length) {
      break;
    }
  }
  return processedModules;
}

async function checkModuleNames(cr: Cursor, moduleNames: string[]) {
  const modNames = new Set(moduleNames);
  if (modNames.has('base')) {
    if (modNames.has('all')) {
      modNames.delete('all');
    }
  }
  if (modNames.size) {
    const res = await cr.execute(`SELECT COUNT(id)::int AS count FROM "irModuleModule" WHERE label IN (%s)`, [quoteList(modNames)]);
    const count = res.length && res[0]['count'] || 0;
    if (count != modNames.size) {
      const all = await cr.execute('SELECT label FROM "irModuleModule"');
      const incorrectNames = all.filter((x) => !modNames.has(x['label'])).map(x => x['label']);
      console.warn('invalid modules (%s/%s): %s', incorrectNames.length, all.length, String(incorrectNames));
    }
  }
}

async function loadDemo(env: Environment, pack: Node, idref: {}, mode: string) {
  if (!pack.shouldHaveDemo()) {
    return false;
  }
  try {
    if (len(pack.info['demo'])) {
      console.log('%s: start loading demo', pack.name);
      await env.cr.savepoint(false, async () => {
        await loadData(env, idref, mode, 'demo', pack);
      });
    }
    return true;
  } catch (e) {
    console.log(e.toString());
    console.warn("Module %s demo data failed to install, installed without demo data", pack.name);
    env = await env.clone({ user: global.SUPERUSER_ID, context: {} });
    const todo = await env.ref('base.demoFailureTodo', false);
    if (todo && todo.ok && env.models['ir.demoFailure']) {
      todo.state = 'open';
      await env.items('ir.demoFailure').create({ 'moduleId': pack.id, 'error': e.toString() });
    }
    return false;
  }
}

async function loadData(env: Environment, idref: {}, mode: string, kind: string, pack: any) {
  function _getFilesOfKind(kind: string | string[]) {
    if (kind === 'demo') {
      kind = ['demoXml', 'demo'];
    } else if (kind === 'data') {
      kind = ['initXml', 'updateXml', 'data'];
    }
    if (typeof kind === 'string') {
      kind = [kind];
    }
    const files: string[] = [];
    for (const k of kind) {
      for (const f of (pack.data[k] || [])) {
        if (f.startsWith('#') || f.startsWith('~')) {
          continue;
        }
        files.push(f);
      }
    }
    return files;
  }

  let filename = null;
  try {
    if (['demo', 'test'].includes(kind)) {
      setattr(env, 'testing', true);
    }
    for (filename of _getFilesOfKind(kind)) {
      console.info("... %s/%s", pack.name, filename);
      let noupdate = false;
      if (['demo', 'demoXml'].includes(kind) || (filename.endsWith('.csv') && ['init', 'initXml'].includes(kind))) {
        noupdate = true;
      }
      await tools.convertFile(env, pack.name, filename, idref, mode, noupdate, kind);
    }
  } finally {
    if (['demo', 'test'].includes(kind)) {
      setattr(env, 'testing', false);
    }
  }
  return Boolean(filename)
}
