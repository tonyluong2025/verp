import * as path from 'path';

import { config, isDir } from '../tools';

import * as api from '../api';
import { getModulePath, getModules, initializeSysPath } from '../modules';

const commands = new Map<string, any>();

class Command {
  label: string;
  /**
   * Constructs the CommanderError class
   * @param {string} label suggested exit code which could be used with process.exit
   * @param {Array} bases an id string representing the error
   * @param {Map} attrs human-readable description of the error
   * @constructor
   */
  constructor(name?: string, bases?: [], attrs?: {}) {
    let n: any = typeof name === 'string' ? name : api.getattr(this, 'label', this.constructor.name);
    this.label = n;
    n = n.toLowerCase();
    if (n !== 'command') {
      commands.set(n, this);
    }
  }
}

async function main() {
  let args = process.argv.slice(2);

  if ((args.length > 1) && args[0].startsWith('--addons-path=') && !(args[1].startsWith('-'))
  ) {
    config._parseConfig([args[0]]);
    args = args.slice(1);
  }

  let command = 'server';

  if ((args.length > 0) && !(args[0].startsWith('-'))) {
    initializeSysPath();
    const modules = getModules();
    for (const mod of modules) {
      const modulePath = getModulePath(mod);
      if (isDir(path.join(modulePath, 'cli'))) {
        require(modulePath);
      }
    }
    command = args[0];
    args = args.slice(1);
  }

  if (commands.has(command)) {
    const o: any = commands.get(command);
    await o.run(args);
  } else {
    process.exit();
  }
}

const program = new Command('Command', [], { 'run': () => null });
export default program;
export {
  Command, main, program
};
