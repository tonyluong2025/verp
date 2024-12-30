import { DateTime, Interval } from "luxon";
import { api } from "../../..";
import { Fields, _Datetime } from "../../../fields";
import { UserError } from "../../../helper";
import { WebRequest } from "../../../http";
import { MetaModel, Model, TransientModel } from "../../../models";
import { b64encode, bool } from "../../../tools";
import { subDate } from "../../../tools/date_utils";
import { stringify } from "../../../tools/json";
import { makeSession } from "../../../tools/profiler";
import { Speedscope } from "../../../tools/speedscope";

@MetaModel.define()
class IrProfile extends Model {
  static _module = module;
  static _name = 'ir.profile';
  static _description = 'Profiling results';
  static _logAccess = false;  // avoid useless foreign key on res_user
  static _order = 'session desc, id desc';

  static createdAt = Fields.Datetime('Creation Date');

  static session = Fields.Char('Session', { index: true });
  static label = Fields.Char('Description');
  static duration = Fields.Float('Duration');

  static initStackTrace = Fields.Text('Initial stack trace', { prefetch: false });

  static sql = Fields.Text('Sql', { prefetch: false });
  static tracesAsync = Fields.Text('Traces Async', { prefetch: false });
  static tracesSync = Fields.Text('Traces Sync', { prefetch: false });
  static qweb = Fields.Text('Qweb', { prefetch: false });
  static entryCount = Fields.Integer('Entry count');

  static speedscope = Fields.Binary('Speedscope', { compute: '_computeSpeedscope' });
  static speedscopeUrl = Fields.Text('Open', { compute: '_computeSpeedscopeUrl' });


  @api.autovacuum()
  async _gcProfile() {
    // remove profiles older than 30 days
    const domain = [['createdAt', '<', subDate(_Datetime.now(), { days: 30 })]];
    return (await (await this.sudo()).search(domain)).unlink();
  }

  async _computeSpeedscope() {
    for (const execution of this) {
      const sp = new Speedscope(null, JSON.parse(await execution.initStackTrace));
      if (await execution.sql) {
        sp.add('sql', JSON.parse(await execution.sql));
      }
      if (await execution.tracesAsync) {
        sp.add('frames', JSON.parse(await execution.tracesAsync));
      }
      if (await execution.tracesSync) {
        sp.add('settrace', JSON.parse(await execution.tracesSync));
      }
      const result = stringify(sp.addDefault().make());
      await execution.set('speedscope', b64encode(new TextEncoder().encode(result)));
    }
  }

  async _computeSpeedscopeUrl() {
    for (const profile of this) {
      await profile.set('speedscopeUrl', `/web/speedscope/${profile.id}`);
    }
  }

  /**
   * If the profiling is enabled, return until when it is enabled.
      Otherwise return ``null``.
   * @returns 
   */
  async _enabledUntil() {
    const limit = await (await this.env.items('ir.config.parameter').sudo()).getParam('base.profilingEnabledUntil', '');
    return _Datetime.now() < limit ? limit : null;
  }

  /**
   * Enable or disable profiling for the current user.

    @param profile ``true`` to enable profiling, ``false`` to disable it.
    @param collectors optional list of collectors to use (string)
    @param params optional parameters set on the profiler object
   */
  @api.model()
  async setProfiling(req: WebRequest, profile?: any, collectors?: any, params?: any) {
    // Note: parameters are coming from a rpc calls or route param (public user),
    // meaning that corresponding session variables are client-defined.
    // This allows to activate any profiler, but can be
    // dangerous handling request.session.profileCollectors/profileParams.
    if (bool(profile)) {
      const user = await this.env.user();
      const limit = await this._enabledUntil();
      console.info("User %s started profiling", await user.label);
      if (!limit) {
        req.session.profileSession = null;
        if (await user._isSystem()) {
          return {
            'type': 'ir.actions.actwindow',
            'viewMode': 'form',
            'resModel': 'base.enable.profiling.wizard',
            'target': 'new',
            'views': [[false, 'form']],
          }
        }
        throw new UserError(await this._t('Profiling is not enabled on this database. Please contact an administrator.'));
      }
      if (!req.session.profileSession) {
        req.session.profileSession = makeSession(await user.label);
        req.session.profileExpiration = limit;
        if (req.session.profileCollectors == null) {
          req.session.profileCollectors = [];
        }
        if (req.session.profileParams == null) {
          req.session.profileParams = {};
        }
      }
    }
    else if (profile != null) {
      req.session.profileSession = null;
    }
    if (collectors != null) {
      req.session.profileCollectors = collectors;
    }
    if (params != null) {
      req.session.profileParams = params;
    }
    return {
      'session': req.session.profileSession,
      'collectors': req.session.profileCollectors,
      'params': req.session.profileParams,
    }
  }
}

@MetaModel.define()
class EnableProfilingWizard extends TransientModel {
  static _module = module;
  static _name = 'base.enable.profiling.wizard';
  static _description = "Enable profiling for some time";

  static duration = Fields.Selection([
    ['minutes_5', "5 Minutes"],
    ['hours_1', "1 Hour"],
    ['days_1', "1 Day"],
    ['months_1', "1 Month"],
  ], { string: "Enable profiling for" });
  static expiration = Fields.Datetime("Enable profiling until", { compute: '_computeExpiration', store: true, readonly: false });

  @api.depends('duration')
  async _computeExpiration() {
    const self: any = this;

    for (const record of self) {
      const [unit, quantity] = (await record.duration ?? 'days_0').split('_');
      const now = DateTime.now();
      const exp = Interval.after(now, { [unit]: parseInt(quantity) }).end;
      await record.set('expiration', exp.toJSDate());
    }
  }

  async submit() {
    await this.env.items('ir.config.parameter').setParam('base.profilingEnabledUntil', await (this as any).expiration);
    return false;
  }
}