require('./../globals');

import { config } from './../tools/config';
import * as core from './../../core';
import { Command } from './command';
import * as server from './server';

class Shell extends Command {
  async init(args: string[]) {
    config.parseConfig(args);
    server.reportConfiguration();
    await core.service.server.start([], true);
  }

  async shell(dbName?: string) {
    console.log('Running shell...');
    const localVars = {
      'core': core
    }
    if (dbName) {
      const registry = await core.registry(dbName);
      const cr = registry.cursor();
      if (cr) {
        const uid = global.SUPERUSER_ID;
        const ctx = (await core.api.Environment.new(cr, uid)).models['res.users'].contextGet();
        const env = await core.api.Environment.new(cr, uid, ctx);
        localVars['env'] = env;
        localVars['this'] = await env.user();
        this.console(localVars);
        await cr.rollback();
      }
    } else {
      console.log('Not dbName');
    }
  }
  console(localVars: { core: typeof core; }) {
    console.warn('Method not implemented.');
  }
  
  async run(args: []) {
    await this.init(args);
    await this.shell(config.get('dbName'));
    console.log('Stop shell...');
  }
}

const shell = new Shell();

export default shell;