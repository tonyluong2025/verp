import { Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { MetaModel, Model } from "../../../core/models";
import { f } from "../../../core/tools/utils";
import { AWAY_TIMER, DISCONNECTION_TIMER } from "./bus_presence";

@MetaModel.define()
class ResUsers extends Model {
  static _module = module;
  static _parents = "res.users";

  static imStatus = Fields.Char('IM Status', {compute: '_computeImStatus'});

  /**
   * Compute the imStatus of the users
   */
  async _computeImStatus() {
    const rows = await this.env.cr.execute(`
      SELECT
        "userId" as id,
        CASE WHEN age(now() AT TIME ZONE 'UTC', "lastPoll") > interval '%s' THEN 'offline'
          WHEN age(now() AT TIME ZONE 'UTC', "lastPresence") > interval '%s' THEN 'away'
          ELSE 'online'
        END as status
      FROM "busPresence"
      WHERE "userId" IN (%s)
    `, [f("%s seconds", DISCONNECTION_TIMER), f("%s seconds", AWAY_TIMER), String(this.ids) || 'NULL']);
    
    const res = Dict.from(rows.map(status => [status['id'], status['status']]));

    for (const user of this) {
      await user.set('imStatus', res.get(user.id, 'offline'));
    }
  }
}