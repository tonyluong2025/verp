import { DateTime } from "luxon"
import { api } from "../../../core"
import { Fields, _Datetime } from "../../../core/fields"
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool"
import { len } from "../../../core/tools/iterable"

@MetaModel.define()
class MailRtcSession extends Model {
  static _module = module;
  static _name = 'mail.channel.rtc.session';
  static _description = 'Mail RTC session';

  static channelPartnerId = Fields.Many2one('mail.channel.partner', {index: true, required: true, ondelete: 'CASCADE'});
  static channelId = Fields.Many2one('mail.channel', {related: 'channelPartnerId.channelId', store: true, readonly: true});
  static partnerId = Fields.Many2one('res.partner', {related: 'channelPartnerId.partnerId', string: "Partner"});
  static guestId = Fields.Many2one('mail.guest', {related: 'channelPartnerId.guestId'});

  static updatedAt = Fields.Datetime("Last Updated On", {index: true});

  static isScreenSharingOn = Fields.Boolean({string: "Is sharing the screen"});
  static isCameraOn = Fields.Boolean({string: "Is sending user video"});
  static isMuted = Fields.Boolean({string: "Is microphone muted"});
  static isDeaf = Fields.Boolean({string: "Has disabled incoming sound"});

  static _sqlConstraints = [
    ['channelPartner_unique', 'UNIQUE("channelPartnerId")',
      'There can only be one rtc session per channel partner']
  ]

  @api.modelCreateMulti()
  async create(valsList) {
    const rtcSessions = await _super(MailRtcSession, this).create(valsList);
    const rows = [];
    for (const [channel, sessionsData] of (await rtcSessions._mailRtcSessionFormatByChannel()).entries()) {
      rows.push([channel, 'mail.channel/rtcSessionsUpdate', {
        'id': channel.id,
        'rtcSessions': [['insert', sessionsData ?? []]],
      }])
    }
    await this.env.items('bus.bus')._sendmany(rows);
    return rtcSessions;
  }

  async unlink() {
    const channels = await (this as any).channelId;
    for (const channel of channels) {
      if (bool(await channel.rtcSessionIds) && len((await channel.rtcSessionIds).sub(this)) == 0) {
        // If there is no member left in the RTC call, all invitations are cancelled.
        // Note: invitation depends on field `rtc_inviting_session_id` so the cancel must be
        // done before the delete to be able to know who was invited.
        await channel._rtcCancelInvitations();
      }
    }
    const notifications = []
    for (const [channel, sessionsData] of (await this._mailRtcSessionFormatByChannel()).entries()) {
      notifications.push([channel, 'mail.channel/rtcSessionsUpdate', {
        'id': channel.id,
        'rtcSessions': [[
          'insert-and-unlink', sessionsData.map(sessionData => {return{'id': sessionData['id']}})
        ]],
      }]); 
    }
    for (const rtcSession of this) {
      let target = await rtcSession.guestId;
      target = bool(target) ? target : await rtcSession.partnerId;
      notifications.push([target, 'mail.channel.rtc.session/ended', {'session_id': rtcSession.id}]);
    }
    await this.env.items('bus.bus')._sendmany(notifications)
    return _super(MailRtcSession, this).unlink();
  }

  /**
   * Updates the session and notifies all members of the channel
        of the change.
   * @param values 
   */
  async _updateAndBroadcast(values) {
    const validValues = ['isScreenSharingOn', 'isCameraOn', 'isMuted', 'isDeaf'];
    await this.write(Object.fromEntries(validValues.map(key => [key, values[key]])));
    const sessionData = await this._mailRtcSessionFormat();
    await this.env.items('bus.bus')._sendone(await this['channelId'], 'mail.channel.rtc.session/insert', sessionData);
  }

  /**
   * Garbage collect sessions that aren't active anymore,
        this can happen when the server or the user's browser crash
        or when the user's verp session ends.
   */
  @api.autovacuum()
  async _gcInactiveSessions() {
    await (await this.search(await this._inactiveRtcSessionDomain())).unlink();
  }

  async actionDisconnect() {
    await this.unlink();
  }

  /**
   * Deletes the inactive sessions from self.
   */
  async _deleteInactiveRtcSessions() {
    await (await this.filteredDomain(await this._inactiveRtcSessionDomain())).unlink();
  }

  /**
   * Used for peer-to-peer communication,
        guarantees that the sender is the current guest or partner.

        :param notifications: list of tuple with the following elements:
            - target_session_ids: a list of mail.channel.rtc.session ids
            - content: a string with the content to be sent to the targets
   * @param notifications 
   * @returns 
   */
  async _notifyPeers(notifications) {
    await this.ensureOne();
    const payloadByTarget = new Map();
    let target;
    for (const [targetSessionIds, content] of notifications) {
        for (const targetSession of await this.env.items('mail.channel.rtc.session').browse(targetSessionIds).exists()) {
            target = await targetSession.guestId;
            target = target.ok ? target : await targetSession.partnerId;
            if (!payloadByTarget.has(target)) {
              payloadByTarget.set(target, {'sender': this.id, 'notifications': []});
            }
            payloadByTarget.get(target)['notifications'].push(content);
        }
    }
    return this.env.items('bus.bus')._sendmany(Array.from(payloadByTarget.entries()).map(([target, payload]) => [target, 'mail.channel.rtc.session/peerNotification', payload]));
  }

  async _mailRtcSessionFormat(completeInfo=true) {
    this.ensureOne();
    const vals = {
      'id': this.id,
    }
    const self: any =this;
    if (completeInfo) {
      Object.assign(vals, {
        'isCameraOn': await self.isCameraOn,
        'isDeaf': await self.isDeaf,
        'isMuted': await self.isMuted,
        'isScreenSharingOn': self.isScreenSharingOn,
      });
    }
    if (await self.guestId) {
      vals['guest'] = [['insert', {
        'id': (await self.guestId).id,
        'label': (await self.guestId).label,
      }]]
    }
    else {
      vals['partner'] = [['insert', {
        'id': (await self.partnerId).id,
        'label': (await self.partnerId).label,
      }]];
    }
    return vals;
  }

  async _mailRtcSessionFormatByChannel() {
    const data = new Map<any, any>();
    for (const rtcSession of this) {
      const channelId = await rtcSession.channelId;
      if (!data.has(channelId)) {
        data.set(channelId, []);
      }
      data.get(channelId).push(await rtcSession._mailRtcSessionFormat());
    }
    return data;
  }

  @api.model()
  async _inactiveRtcSessionDomain() {
    return [['updatedAt', '<', DateTime.fromJSDate(_Datetime.now()).minus({minutes: 1}).toJSDate()]];
  }
}