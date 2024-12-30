import { TIMEOUT } from "./bus"

export const DISCONNECTION_TIMER = TIMEOUT + 5
export const AWAY_TIMER = 1800  // 30 minutes

import { DateTime, Interval } from "luxon";
import { api } from "../../../core";
import { Fields, _Datetime } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";
import { DEFAULT_SERVER_DATETIME_FORMAT } from "../../../core/tools/misc";
import { PG_CONCURRENCY_ERRORS_TO_RETRY } from "../../../core/service/model";

/**
 * User Presence
      Its status is 'online', 'away' or 'offline'. This model should be a one2one, but is not
      attached to resUsers to avoid database concurrence errors. Since the 'update' method is executed
      at each poll, if the user have multiple opened tabs, concurrence errors can happend, but are 'muted-logged'.
 */
@MetaModel.define()
class BusPresence extends Model {
  static _module = module;
  static _name = 'bus.presence';
  static _description = 'User Presence';
  static _logAccess = false;

  static userId = Fields.Many2one('res.users', {string: 'Users', ondelete: 'CASCADE'});
  static lastPoll = Fields.Datetime('Last Poll', {default: () => _Datetime.now()});
  static lastPresence = Fields.Datetime('Last Presence', {default: (self)=> _Datetime.now()});
  static status = Fields.Selection([['online', 'Online'], ['away', 'Away'], ['offline', 'Offline']], {string: 'IM Status', default: 'offline'});

  async init() {
    await this.env.cr.execute(`CREATE UNIQUE INDEX IF NOT EXISTS "busPresenceUser_unique" ON "%s" ("userId") WHERE "userId" IS NOT NULL`, [this.cls._table]);
  }

  /**
   * Updates the lastPoll and lastPresence of the current user
   
   * @param inactivityPeriod duration in milliseconds
   * @param identityField 
   * @param identityValue 
   * @returns 
   */
  @api.model()
  async updateBus(options: {inactivityPeriod?: any, identityField?: any, identityValue?: any} = {}) {
    // This method is called in method _poll() and cursor is closed right
    // after; see bus/controllers/main.js.
    try {
      // Hide transaction serialization errors, which can be ignored, the presence update is not essential
      // The errors are supposed from presence.write(...) call only
      // with tools.muteLogger('core.sql_db'):
        await this._updateBus(options.inactivityPeriod, options.identityField, options.identityValue);
        // commit on success
        await this.env.cr.commit();
        await this.env.cr.reset();
    } catch(e) {
      if (PG_CONCURRENCY_ERRORS_TO_RETRY.includes(e.message)) {
        // ignore concurrency error
        return await this.env.cr.rollback();
      }
      throw e;
    }
  }

  @api.model()
  async _updateBus(inactivityPeriod?: any, identityField?: any, identityValue?: any) {
    const presence = await this.search([[identityField, '=', identityValue]], {limit: 1});
    // compute lastPresence timestamp
    const lastPresence = Interval.after(DateTime.now(), {milliseconds: inactivityPeriod});
    const values = {
      'lastPoll': DateTime.now().toFormat(DEFAULT_SERVER_DATETIME_FORMAT)
    }
    // update the presence or a create a new one
    if (!presence.ok) {  // create a new presence for the user
      values[identityField] = identityValue;
      values['lastPresence'] = lastPresence;
      await this.create(values);
    }
    else {  // update the lastPresence if necessary, and write values
      if (await presence.lastPresence < lastPresence) {
        values['lastPresence'] = lastPresence;
      }
      await presence.write(values);
    }
  }
}