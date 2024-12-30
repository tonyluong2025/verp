import { http } from "../../..";
import { UserError } from "../../../helper";
import { WebResponse } from "../../../http";
import { f, isInstance, pop } from "../../../tools";
import { stringify } from "../../../tools/json";

@http.define()
export class Profiling extends http.Controller {
  static _module = module;

  @http.route('/web/setProfiling', { type: 'http', auth: 'public', sitemap: false })
  async profile(req, res, opts: { profile?: any, collectors?: any } = {}) {
    let collectors = pop(opts, 'collectors');
    if (collectors != null) {
      collectors = collectors.split(',');
    }
    else {
      collectors = ['sql', 'tracesAsync'];
    }
    let profile = pop(opts, 'profile');
    profile = profile && profile !== '0';
    try {
      const state = (await req.getEnv()).items('ir.profile').setProfiling(req, profile, collectors, opts);
      return new WebResponse(req, res, stringify(state), { mimetype: 'application/json' });
    } catch (e) {
      if (isInstance(e, UserError)) {
        return new WebResponse(req, res, f('error: %s', e), { status: 500, mimetype: 'text/plain' });
      }
      throw e;
    }
  }

  @http.route(['/web/speedscope', '/web/speedscope/<model("ir.profile"):profile>'], { type: 'http', sitemap: false, auth: 'user' })
  async speedscope(req, res, opts: { profile?: any } = {}) {
    const env = await req.getEnv();
    // don't server speedscope index if profiling is not enabled
    if (! await env.items('ir.profile')._enabledUntil()) {
      return req.notFound(res);
    }
    const icp = env.items('ir.config.parameter');
    const context = {
      'profile': opts.profile,
      'urlRoot': req.httpRequest.urlRoot,
      'cdn': await (await icp.sudo()).getParam('speedscopeCdn', "https://cdn.jsdelivr.net/npm/speedscope@1.13.0/dist/release/")
    }
    return req.render(res, 'web.viewSpeedscopeIndex', context);
  }
}