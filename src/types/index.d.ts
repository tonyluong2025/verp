/* eslint-disable no-var */
declare global {
  var SUPERUSER_ID: number;
  var ROOT_PATH: string;
  var CORE_PATH: string;
  var server: any;
  var sqlCounter: number;
  var loaded: Record<string, NodeModule>;
  var _Pool: any;
  var _debug: boolean;
  var log: any;
}

export {}