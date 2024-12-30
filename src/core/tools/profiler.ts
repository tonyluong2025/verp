import { DateTime } from "luxon";
import { getattr } from "../api/func";
import { doWith } from "./func";
import { bool } from "./bool";

/**
 * Force periodic profiling collectors to generate some stack trace.  This is
    useful before long calls that do not release the GIL, so that the time
    spent in those calls is attributed to a specific stack trace, instead of
    some arbitrary former frame.
 */
export async function forceHook(env?: any) {
  if (!env) {
    return;
  }
  for (const func of getattr(env, 'profileHooks', [])) {
    await func();
  }
}

export function makeSession(name: string = '') {
  return `${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss')} ${name}`;
}

function getCurrentFrame() {
  return { fBack: null };
}

function stackSize() {
  let frame = getCurrentFrame();
  let size = 0;
  while (frame) {
    size += 1;
    frame = frame.fBack;
  }
  return size;
}

/**
 * Add some context on thread at current call stack level.
    This context stored by collector beside stack and is used by Speedscope
    to add a level to the stack with this information.
 */
class ExecutionContext {
  context: {};
  previousContext: any[];
  env: any;

  constructor(context) {
    this.context = context;
    this.previousContext = null;
  }

  async __enter__() {
    this.env = getattr(this.context, 'env');
    if (this.env) {
      this.previousContext = getattr(this.env, 'execContext', []);
      this.env.execContext = this.previousContext.concat([[stackSize(), this.context],]);
    }
  }

  async __exit__(errObj) {
    if (errObj) {
      console.warn(errObj.message);
    }
    if (this.env) {
      this.env.execContext = this.previousContext;
    }
  }
}

export class QwebTracker {
  executionContextEnabled: any;
  qwebHooks: any;
  contextStack: any[];
  cr: any;
  viewId: any;

  private constructor() { }

  static async new(viewId, arch, cr, env?: any) {
    const self = new QwebTracker();
    self.executionContextEnabled = (env ? getattr(env, 'profilerParams', {}) : {})['executionContextQweb'];
    self.qwebHooks = env ? getattr(env, 'qwebHooks', []) : [];
    self.contextStack = [];
    self.cr = cr;
    self.viewId = viewId;
    for (const hook of self.qwebHooks) {
      await hook('render', self.cr.sqlLogCount, { viewId: viewId, arch: arch });
    }
    return self;
  }

  static wrapRender() {
    return function (target, prop) {
      const methodRender = target[prop];
      const wrapper = async function(template, values?: any, options?: any) {
        const env = this.env;
        const executionContextEnabled = getattr(env, 'profilerParams', {})['executionContextQweb'];
        const qwebHooks = getattr(env, 'qwebHooks', []);
        if (executionContextEnabled || bool(qwebHooks)) {
            // To have the new compilation cached because the generated code will change.
            // Therefore 'profile' is a key to the cache.
            options['profile'] = true;
        }
        return methodRender.call(this, template, values, options);
      }
      target[prop] = wrapper;
    }
  }

  static wrapCompile() {
    return function (target, prop) {
      const methodCompile = target[prop];
      const wrapper = async function (template, options) {
        if (!options['profile']) {
          return methodCompile.call(this, template, options);
        }
        const renderTemplate = await methodCompile.call(this, template, options);

        async function profiledMethodCompile(self, values) {
          const ref = options['ref'];
          const refXml = options['refXml'];
          const qwebTracker = await QwebTracker.new(ref, refXml, self.env.cr, self.env);
          self = await self.withContext({ qwebTracker: qwebTracker });
          if (qwebTracker.executionContextEnabled) {
            await doWith(new ExecutionContext({ template: ref }), async () => {
              return renderTemplate(self, values);
            });
          }
          return renderTemplate(self, values)
        }
        return profiledMethodCompile;
      }
      target[prop] = wrapper;
    }
  }

  static wrapCompileDirective() {
    return function (target, prop) {
      const methodCompileDirective = target[prop];
      const wrapper = async function (el, options, directive, indent) {
        if (! options['profile'] || ['content', 'tag'].includes(directive)) {
            return methodCompileDirective.call(el, options, directive, indent);
        }
        const enter = this._indent(`self.env.context['qwebTracker'].enterDirective(${directive}, ${el.attrib}, ${options['lastPathNode']})`, indent);
        const leave = this._indent("self.env.context['qwebTracker'].leaveDirective()", indent);
        const codeDirective = await methodCompileDirective.call(el, options, directive, indent);
        return codeDirective ? [enter, ...codeDirective, leave] : [];
      }
      target[prop] = wrapper;
    }
  }
}

