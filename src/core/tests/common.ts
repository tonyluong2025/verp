import { Environment } from "../api/api";
import { Registry } from "../modules/registry";
import { Cursor } from "../sql_db";

export class VerpSuite {
  constructor(tests: any) {
    
  }
}

export class TransactionCase {
  registry: Registry;
  env: Environment;
  cr: Cursor;
}