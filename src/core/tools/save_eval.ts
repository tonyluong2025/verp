import vm from 'vm'
import { parseStack, ValueError } from '../helper/errors'
import { isInstance } from './func'
import { range } from './iterable'
import { f } from './utils'

export const _BUILTINS = {
  // '__import__': require,
  // 'true': true,
  // 'false': false,
  // 'null': null,
  // 'bytes': Buffer.from,
  // 'str': String,
  // 'unicode': String,
  // 'bool': bool,
  // 'int': int,
  // 'float': float,
  // 'enumerate': enumerate,
  // 'dict': dict,
  // 'list': list,
  // 'tuple': tuple,
  // 'map': map,
  // 'abs': abs,
  // 'min': min,
  // 'max': max,
  // 'sum': sum,
  // 'reduce': functools.reduce,
  // 'filter': filter,
  // 'sorted': sorted,
  // 'round': round,
  // 'len': len,
  // 'repr': repr,
  // 'set': set,
  // 'all': all,
  // 'any': any,
  // 'ord': ord,
  // 'chr': chr,
  // 'divmod': divmod,
  // 'isinstance': isinstance,
  // 'range': range,
  // 'xrange': range,
  // 'zip': zip,
  // 'Exception': Exception,
}

export const SAFE_GLOBALS = () => {
  return {
    Function,
    console: {
      debug: console.debug,
      error: console.error,
      info: console.info,
      log: console.log,
      table: console.table,
      warn: console.warn,
    },
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,
    escape,
    unescape,
    Boolean,
    Number,
    BigInt,
    String,
    Object,
    Array,
    Symbol,
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Intl,
    JSON,
    Math,
    Date,
    RegExp,
  };
}

export const SAFE_PROTOTYPES = () => {
  const protos = [
    // SandboxGlobal,
    Function,
    Boolean,
    Number,
    BigInt,
    String,
    Date,
    Error,
    Array,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Date,
    RegExp,
  ];
  const map = new Map<any, Set<string>>();
  protos.forEach((proto) => {
    map.set(proto, new Set());
  });
  map.set(
    Object,
    new Set([
      'entries',
      'fromEntries',
      'getOwnPropertyNames',
      'is',
      'keys',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      'toString',
      'valueOf',
      'values',
    ])
  );
  return map;
}

function* toOpcodes(opnames, _opmap = {}) {
  for (const x of opnames) {
    if (x in _opmap)
      yield _opmap[x]
  }
}

export const _BLACKLIST = new Set(toOpcodes([
  // can't provide access to accessing arbitrary modules
  'IMPORT_STAR', 'IMPORT_NAME', 'IMPORT_FROM',
  // could allow replacing or updating core attributes on models & al, setitem
  // can be used to set field values
  'STORE_ATTR', 'DELETE_ATTR',
  // no reason to allow this
  'STORE_GLOBAL', 'DELETE_GLOBAL',
]))

export function safeEval(code: string, context?: {}, options?: {}) {
  const sandbox = {};
  const resultKey = 'SAFE_EVAL_' + Math.floor(Math.random() * 1000000);
  sandbox[resultKey] = {};
  const clearContext = `
    (function(){
      Function = undefined;
      const keys = Object.getOwnPropertyNames(this).concat(['constructor']);
      keys.forEach((key) => {
        const item = this[key];
        if(!item || (item.constructor && typeof item.constructor !== 'function')) {
          return;
        }
        if (Array.isArray(item)) {
          return;
        }
        this[key].constructor = undefined; 
      });
    })();
  `
  code = clearContext + resultKey + '=' + code;
  if (context) {
    Object.keys(context).forEach(function (key) {
      sandbox[key] = context[key];
    })
  }
  vm.runInNewContext(code, sandbox, options);
  return sandbox[resultKey];
}

const opname = Array.from(range(256)).map(op => `<${op}>`)

export function unsafeEval(code: string, context?: {}, options?: {}) {
  const sandbox = {};
  const resultKey = 'SAFE_EVAL_' + Math.floor(Math.random() * 1000000);
  sandbox[resultKey] = {};
  code = resultKey + '=' + code;
  if (context) {
    Object.keys(context).forEach(function (key) {
      sandbox[key] = context[key];
    })
  }
  vm.runInNewContext(code, sandbox, options);
  return sandbox[resultKey];
}

export async function safeAsync(codeLines: string|string[], evalContext: {} = {}, options: {} = {}) {
  async function compile() {
    const wrapFunc = [
      `async function* __defName__(values) {\n`,
      `\n}`
    ];
    const code = wrapFunc[0]
      + (Array.isArray(codeLines) ? codeLines : [codeLines]).join(';\n')
      + wrapFunc[1];
    const context = Object.assign({}, evalContext, options);
    const compiledFn = safeEval(code, context);

    async function* _runCodeAsync(values: {} = {}) {
      try {
        for await (const val of compiledFn(values)) {
          yield val;
        }
      } catch (e) {
        throw e;
      }
    }
    return _runCodeAsync;
  }

  try {
    const rendering = (await compile())();
    let result = <any>[];
    for await (const str of rendering) {
      if (str) {
        result.push(str);
      }
    }

    return Array.isArray(codeLines) ? result : result[0];
  } catch(e) {
    console.log(e);
    throw e;
  }
}

export async function unsafeAsync(codeLines: string|string[], evalContext: {} = {}, options: {mode?: any, return?: any} = {}) {
  options.return = options.return ?? true;
  async function compile() {
    const wrapFunc = [
      `async function* __defName__(values) {\n`,
      `\n}`
    ];

    const _get = (c: any) => options.return ? `yield await ${c}` : `await ${c}`;
    let code = wrapFunc[0]
      + (Array.isArray(codeLines) ? codeLines.map(c => _get(c)) : [_get(codeLines)]).join(';\n')
      + wrapFunc[1];    
    const context = Object.assign({}, evalContext, options);
    let compiledFn;
    try{
      compiledFn = await unsafeEval(code, context);
    } catch(e) {
      console.error('compile unsafeEval error code:\n%s', codeLines);
      throw e;
    }
    async function* _runCodeAsync(values: {} = {}) {
      try {
        for await (const val of compiledFn(values)) {
          yield val;
        }
      } catch (e) {
        throw e;
      }
    }
    return _runCodeAsync;
  }

  try {
    const rendering = (await compile())();
    let result = <any>[];
    for await (const str of rendering) {
      if (options.return) {
        result.push(str);
      }
    }
    if (options.return) {
      return Array.isArray(codeLines) ? result : result[0];
    }
  } catch(e) {
    console.log('unsafeAsync', e);
    throw e;
  }
}

export function assertValidCodeobj(allowedCodes, codeObj, expr) {
  /*
  assertNoDunderName(codeObj, expr);

  // set operations are almost twice as fast as a manual iteration + condition
  // when loading /web according to line_profiler
  const codeCodes = new Set<any>();
  for (const i of dis.getInstructions(codeObj)) {
    codeCodes.add(i.opcode);
  }
  if (! allowedCodes >= codeCodes) {
    throw new ValueError(format("forbidden opcode(s) in %s: %s", expr, _.difference(Array.from(codeCodes), Array.from(allowedCodes)).map(x => opname[x]).join(', ')))
  }

  for (const c of codeObj.coConsts) {
    if (isInstance(c, CodeType))
      assertValidCodeobj(allowedCodes, c)
  }
  */
}

export function checkValues(d: any) {
  if (!d) {
    return d;
  }
  console.warn('Not implemented');
  for (const v of Object.values(d)) {
    // if (isInstance(v, ModuleType)) {
    throw new TypeError(`Module {v} can not be used in evaluation contexts

Prefer providing only the items necessary for your intended use.

If a "module" is necessary for backwards compatibility, use
'core.tools.safe_eval.wrapModule' to generate a wrapper recursively
whitelisting allowed attributes.

Pre-wrapped modules are provided as attributes of 'core.tools.safe_eval'.
      `)
    // }
  }
  return d;
}

const _SAFE_OPCODES = [];

export function testRawExpr(expr, mode='eval') {
  try {
    testExpr(expr, _SAFE_OPCODES, mode);
  } catch (err) {
    if (isInstance(err, SyntaxError, TypeError, ValueError)) {
      return err.stack;
    }
  }
  return false;
}

/**
 * testExpr(expression, allowed_codes[, mode]) -> codeObject

    Test that the expression contains only the allowed opcodes.
    If the expression is valid and contains only allowed codes,
    return the compiled code object.
    Otherwise raise a ValueError, a Syntax Error or TypeError accordingly.
 * @param expr 
 * @param allowedCodes 
 * @param mode 
 * @returns 
 */
export function testExpr(expr: string, allowedCodes?: any[], mode="eval") {
  let codeObj;
  try {
    if (mode === 'eval') {
      expr = expr.trim();
    }
    const code = `async function __() { ${expr} }`
    codeObj = compile(code, expr);
  } catch (e) {
    if (isInstance(e, SyntaxError, TypeError, ValueError)) {
      throw e;
    }
    else {
      throw new ValueError(f('"%s" while compiling\n%s', e.message, expr));
    }
  }
  assertValidCodeobj(allowedCodes, codeObj, expr);
  return codeObj;
}

export function compile(code, expr?: string, func?: string) {
  try {
    const script = new vm.Script(code);
    return code;
  } catch (e) {
    const stack = parseStack(e);
    const message = stack.shift();
    console.debug(`Compile ${e.name}: ${message}\n${stack.join('\n')}`);
    return code;
  }
}
