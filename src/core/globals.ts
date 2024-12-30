import * as path from "path";

(function setup() { 
   console.log('Setup global variables');
}());

global.SUPERUSER_ID = 1;
global.ROOT_PATH = path.normalize(__dirname);             // => ./core
global.CORE_PATH = path.normalize(__dirname + '/addons'); // => ./core/addons
global._Pool = null;
global.loaded = {};
global.logDebug = false;
global.logSql = false;  // change to `console.log` to debug
global.globalSeq = 1;
global.ormcache = true;
global.ormcacheContext = true;
global._geoipResolver = null;
global._phonenumbersLibWarning = false;

console.log(`rootPath=${global.ROOT_PATH}`);

export {}