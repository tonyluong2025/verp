import * as util from "node:util";
import { setattr } from "../api/func";
import { DatabaseError as SeqDatabaseError } from "@sequelize/core";

export function parseStack(e) {
  if (e instanceof Error && e.stack) {
    return e.stack.slice(e.stack.indexOf(e.name)).trim().split('\n');
  }
  return [String(e)];
}

class _Error extends Error {
  constructor(...args: any[]) {
    const msg = util.format(...args);
    super(msg);
  }
  get args() {
    return parseStack(this);
  }
}

export class DatabaseError extends SeqDatabaseError {}

export class DatabaseExistsError extends _Error {
  code: string;
  constructor(...args: any[]) {
    super(...args);
    this.code = '42';
  }
}

export class RedirectWarning extends _Error { }

export class UserError extends _Error { }

export class ValueError extends _Error { }

export class KeyError extends _Error { }

export class NotImplementedError extends _Error { }

export class AttributeError extends _Error { }

export class SQLError extends _Error { }

export class NameError extends _Error { }

export class MissingError extends UserError { }

export class AccessDenied extends UserError { }

export class SecurityError extends UserError { }

export class AccessError extends UserError { }

export class AccessNotFound extends AccessError { }

export class ValidationError extends UserError { }

export class OperationalError extends UserError { }

export class ParseError extends ValueError { }

export class XmlError extends ParseError { }

export class CacheMiss extends KeyError {
  constructor(record, field, error?: Error) {
    super(global.logDebug ? error.stack : error.message);
  }
}

export class InternalError extends _Error { }

export class StopIteration extends _Error { }

export class Warning extends _Error { }

export class ImportError extends _Error { }

export class KeyboardError extends UserError { }

export class RuntimeError extends _Error { }

export class LookupError extends _Error { }

export class FileNotFoundError extends _Error { }

export class UnicodeError extends ValueError { }

export class CompileError extends ValueError { }

export class UnicodeEncodeError extends ValueError { }