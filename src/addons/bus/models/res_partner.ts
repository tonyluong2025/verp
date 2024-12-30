import { Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { MetaModel, Model } from "../../../core/models";
import { f } from "../../../core/tools/utils";
import { AWAY_TIMER, DISCONNECTION_TIMER } from "./bus_presence";

@MetaModel.define()
class ResPartner extends Model {
  static _module = module;
  static _parents = 'res.partner';

  static imStatus = Fields.Char('IM Status', {compute: '_computeImStatus'});

  async _computeImStatus() {
    const rows = await this.env.cr.execute(`
      SELECT
        U."partnerId" as id,
        CASE WHEN max(B."lastPoll") IS NULL THEN 'offline'
            WHEN age(now() AT TIME ZONE 'UTC', max(B."lastPoll")) > interval '%s' THEN 'offline'
            WHEN age(now() AT TIME ZONE 'UTC', max(B."lastPresence")) > interval '%s' THEN 'away'
            ELSE 'online'
        END as status
      FROM "busPresence" B
      RIGHT JOIN "resUsers" U ON B."userId" = U.id
      WHERE U."partnerId" IN (%s) AND U.active = 't'
      GROUP BY U."partnerId"
    `, [f("%s seconds", DISCONNECTION_TIMER), f("%s seconds", AWAY_TIMER), String(this.ids) || 'NULL']);

    const res = Dict.from(rows.map(status => [status['id'], status['status']]));
    
    for (const partner of this) {
      await partner.set('imStatus', res.get(partner.id, 'imPartner'));  // if not found, it is a partner, useful to avoid to refresh status in js
    }
  }
}