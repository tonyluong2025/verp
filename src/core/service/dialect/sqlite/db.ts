import { DbServiceAbstract, IDbService } from './../abstract/index';
import { config } from '../../../tools/config';
import * as path from 'path';


class DbSqLite extends DbServiceAbstract implements IDbService {
  async createEmptyDatabase(name: string) {
    const sqlite = require("sqlite3");
  
    const client = new sqlite.Database(`${path.join(config.get('dataDir'), name)}}.sqlite`, sqlite.OPEN_CREATE, 
    (err) => { 
      throw err;//console.log(err.stack);
    });
  
    // client.end();
  }
}

module.exports = new DbSqLite();
