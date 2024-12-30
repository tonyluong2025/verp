import {glob} from 'glob';
import * as path from 'path';
import { Command } from './command';
import * as core from './../index';
import commandLineArgs from 'command-line-args';
import * as server from './server';
import { getModuleRoot, IGNORE_FOLDERS, MANIFEST_NAMES } from '../modules';
import { extend } from '../tools/iterable';
import { f } from '../tools';
import { MetaDatebase } from '../service/db';

/**
 * Quick start the Verp server for your project
 */
class Start extends Command {
  async run(cmdargs: string[]) {
    console.log('Running start...');

    const definitions = [
      { name: 'path', defaultValue: '.', description: `Directory where your project's modules are stored (will autodetect from current dir)`, group: 'main' },
      { name: 'database', alias: 'd', description: `Specify the database name (default to project's directory name` },
      { name: 'reset', alias: 'r', type: Boolean, defaultValue: false, description: 'reset testing database if it exists)' },
    ];
    let args;
    args = commandLineArgs(definitions, { argv: cmdargs, camelCase: true, stopAtFirstUnknown: false, partial: true });
    args = (args._all) ? args._all : args;
    
    if (args.path === '.' && process.env['VIRTUAL_ENV']) {
      args.path = process.env['VIRTUAL_ENV'];
    }
    const projectPath = require.main.path;
    const moduleRoot = getModuleRoot(projectPath);

    let dbName;
    if (moduleRoot) {
      dbName = projectPath.split(path.sep);
      dbName = dbName[dbName.length-1];
    }
    const mods = this.getModuleList(projectPath);
    if (mods && !cmdargs.some(arg => arg.startsWith('--addons-path'))) {
      cmdargs.push(`--addons-path=${projectPath}`);
    } 
    if (!args.dbName) {
      args.dbName = dbName ?? path.basename(projectPath);
      cmdargs = extend(cmdargs, ['-d', args.dbName]);
    }

    if (args.reset === true) {
      try {
        console.log('Drop database:', args.dbName);
        await MetaDatebase.expDrop(null, args.dbName);
      } catch(e) {
        if (e.name === 'SequelizeDatabaseError' && e.message === `database "${args.dbName}" does not exist`) {
          // pass;
        } else {
          die(f("Could not create database `%s`. (%s)", args.dbName, e));
        }
      }
    }

    try {
      await MetaDatebase.createEmptyDatabase(args.dbName);
      core.tools.config.options['init']['base'] = true;
    } catch(e) {
      if (e.name === 'SequelizeDatabaseError' && e.message === `database "${args.dbName}" already exists`) {
        console.log('Server:', e.message);
      } else {
        throw e;
      }
    }

    if (!cmdargs.includes('--db-filter')) {
      cmdargs.push(`--db-filter=^${args.dbName}$`);
    }

    // Remove --path /-p options from the command arguments
    function toRemove(i: number, l: string[]) {
      return l[i] === '-p' || l[i].startsWith('--path') || (i > 0 && ['-p', '--path'].includes(l[i-1]));
    }

    cmdargs = [...cmdargs.filter((v, i) => !toRemove(i, cmdargs))];

    console.log('Start call server.main...');

    await server.runmain(cmdargs);
  }

  getModuleList(path: string): string[] {
    const mods = new Set<string>();
    MANIFEST_NAMES.forEach((mname) => {
      const mg = glob.sync(`**/${mname}`, {
        ignore: IGNORE_FOLDERS,
        cwd: path
      })
      .map((name) => name.split('/'))
      .filter((list) => list.length > 1)
      .map((list) => list.slice(-2)[0])
      .forEach((mod) => mods.add(mod))
    });
    
    return [...mods];
  }
}

const start = new Start();

export default start;

function die(message, code:number=1) {
  console.log(message);
  process.exit(code);
}