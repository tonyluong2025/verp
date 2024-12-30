import { Command } from './command';
import * as core from './../index';
import * as fs from 'fs';
import { fileWrite, isFile } from '../tools';
import { MetaDatebase } from '../service/db';

function checkRootUser() {
  if (process.platform != 'win32' && process.platform != 'darwin') {
    if (process.env['USER'] === 'root') {
      console.log("Running as user 'root' is a security risk.");
      // SUDO_UID is undefined when not root
    }
  }
}

function checkPostgresUser() {
  const config = core.tools.config;
  if (config.options['dbUser'] === 'postgres' || process.env['PGUSER'] === 'postgres') {
    console.log("Using the database user 'postgres' is a security risk, aborting.");
    process.exit(1);
  }
}

export function reportConfiguration() {
  // Log the server version and some configuration values.
  // This function assumes the configuration has been initialized.
  
  const config = core.tools.config;
  console.info("Verp version %s", core.release.version);
  if (isFile(config.rcfile)) {
    console.info("using configuration file at %s", config.rcfile);
  }
  console.info(`addons paths: [${core.addons.paths}]`);
  if (config.get('upgradePath')) {
    console.info('upgrade path: %s', config.get('upgradePath'));
  }
  const host = config.get('dbHost') ?? process.env['PGHOST'] ?? 'default';
  const port = config.get('dbPort') ?? process.env['PGPORT'] ?? 'default';
  const user = config.get('dbUser') ?? process.env['PGUSER'] ?? 'default';
  console.info('database: %s@%s:%s', user, host, port);
}

function setupPidFile() {
  const config = core.tools.config;
  if (config.get('pidFile')) {
    const pid = Buffer.from(process.pid + '\n');
    fileWrite(config.get('pidFile'), pid);
    process.on('exit', () => {
      try {
        fs.unlinkSync(config.get('pidFile'));
        return true;
      } catch (err) {
        return false;
      }
    });
  }
}

export async function runmain(args: string[]) {
  console.log('Running server main...');

  checkRootUser();
  core.tools.config.parseConfig(args);
  checkPostgresUser();
  reportConfiguration();

  const config = core.tools.config;

  let preload = [];
  if (config.options['dbName']) {
    preload = config.options['dbName'].split(',');
    for (const dbName of preload) {
      try {
        await MetaDatebase.createEmptyDatabase(dbName);
        config.options['init']['base'] = true;
      } catch(e) {
        if (e.name === 'SequelizeDatabaseError') {
          // console.log('Server: ', e.message);
        } else {
          throw e;
        }
      }
    }
  }

  const stop = config.get("stopAfterInit") || false;
  setupPidFile();
  const rc = await core.service.server.start(preload, stop);
}

class Server extends Command {
  reportConfiguration() {
    console.warn('Server.reportConfiguration not implemented.');
  }
  async run(args: string[]) {
    await runmain(args);
  }
}

export const server = new Server();