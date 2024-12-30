// loading order is important

console.log(`*** Loading Verp core...`);

export * from './globals';

export * as addons from './addons';
export * as models from './models';
export * from './fields'
export * as modules from './modules';
export * as tests from './tests';
export * as sql_db from './sql_db';
export * as release from './release';
export * as loglevels from './loglevels';
export * as cli from './cli';
export * as tools from './tools';
export * as service from './service';
export * as conf from './conf';
export * as api from './api';
export * as helper from './helper';
export * as http from './http';
export * as upgrade from './upgrade'; 

import { registry as reg } from './modules';

export async function registry(dbName?: string) {
  if (!dbName) {
    dbName = process.env.dbName;
    if (!dbName) { 
      throw new Error(`dbName ${dbName} running`);
    }
  }
  return reg.Registry.create(dbName);
}