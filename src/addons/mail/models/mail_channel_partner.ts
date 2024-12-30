import { api } from "../../../core";
import { Fields, _Datetime } from "../../../core/fields";
import { AccessError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { NotFound } from "../../../core/service/middleware/exceptions";
import { bool, len } from "../../../core/tools";
import { _f, f } from "../../../core/tools/utils";

@MetaModel.define()
class ChannelPartner extends Model {
  static _module = module;
  static _name = 'mail.channel.partner';
  static _description = 'Listeners of a Channel';
  static _table = 'mailChannelPartner';

  // identity
  static partnerId = Fields.Many2one('res.partner', {string: 'Recipient', ondelete: 'CASCADE', index: true});
  static guestId = Fields.Many2one('mail.guest', {string: "Guest", ondelete: 'CASCADE', readonly: true, index: true});
  static partnerEmail = Fields.Char('Email', {related: 'partnerId.email', readonly: false});
  // channel
  static channelId = Fields.Many2one('mail.channel', {string: 'Channel', ondelete: 'CASCADE', readonly: true, required: true});
  // state
  static customChannelName = Fields.Char('Custom channel name')
  static fetchedMessageId = Fields.Many2one('mail.message', {string: 'Last Fetched'})
  static seenMessageId = Fields.Many2one('mail.message', {string: 'Last Seen'})
  static foldState = Fields.Selection([['open', 'Open'], ['folded', 'Folded'], ['closed', 'Closed']], {string: 'Conversation Fold State', default: 'open'})
  static isMinimized = Fields.Boolean("Conversation is minimized")
  static isPinned = Fields.Boolean("Is pinned on the interface", {default: true})
  static lastInterestDt = Fields.Datetime("Last Interest", {default: () => _Datetime.now(), help: "Contains the date and time of the last interesting event that happened in this channel for this partner. This includes: creating, joining, pinning, and new message posted."})
  // RTC
  static rtcSessionIds = Fields.One2many('mail.channel.rtc.session', 'channelPartnerId', { string: "RTC Sessions"})
  static rtcInvitingSessionId = Fields.Many2one('mail.channel.rtc.session', {string: 'Ringing session'})

  async nameGet() {
    const res = [];
    for (const record of this) {
      res.push([record.id, await (await record.partnerId).label || await (await record.guestId).label]);
    }
    return res;
  }

  async _nameSearch(name='', args=null, operator='ilike', {limit=100, nameGetUid=false}={}) {
    let domain = [[['partnerId', operator, name]], [['guestId', operator, name]]];
    if (operator.includes('!') || operator.includes('not')) {
      domain = expression.AND(domain);
    }
    else {
      domain = expression.OR(domain);
    }
    return this._search(expression.AND([domain, args]), {limit, accessRightsUid: nameGetUid});
  }

  async init() {
    await this.env.cr.execute(f('CREATE UNIQUE INDEX IF NOT EXISTS "mailChannelPartner_partner_unique" ON "%s" ("channelId", "partnerId") WHERE "partnerId" IS NOT NULL', this.cls._table));
    await this.env.cr.execute(f('CREATE UNIQUE INDEX IF NOT EXISTS "mailChannelPartner_guest_unique" ON "%s" ("channelId", "guestId") WHERE "guestId" IS NOT NULL', this.cls._table));
  }

  static _sqlConstraints = [
    ["partner_or_guest_exists", 'CHECK(("partnerId" IS NOT NULL AND "guestId" IS NULL) OR ("partnerId" IS NULL AND "guestId" IS NOT NULL))', "A channel member must be a partner or a guest."],
  ]

  /**
   * Similar access rule as the access rule of the mail channel.

    It can not be implemented in XML, because when the record will be created, the
    partner will be added in the channel and the security rule will always authorize
    the creation.
   * @param valsList 
   * @returns 
   */
  @api.modelCreateMulti()
  async create(valsList) {
    if (! await this.env.isAdmin()) {
      for (const vals of valsList) {
        if ('channelId' in vals) {
          const channelId = this.env.items('mail.channel').browse(vals['channelId']);
          if (! await channelId._canInvite(vals['partnerId'])) {
            throw new AccessError(await this._t('This user can not be added in this channel'))
          }
        }
      }
    }
    return _super(ChannelPartner, this).create(valsList);
  }

  async write(vals) {
    for (const channelPartner of this) {
      for (const fieldName of ['channelId', 'partnerId', 'guestId']) {
        if (fieldName in vals && vals[fieldName] !== (await channelPartner[fieldName]).id) {
          throw new AccessError(_f(await this._t('You can not write on {fieldName}.'), {fieldName: fieldName}));
        }
      }
    }
    return _super(ChannelPartner, this).write(vals);
  }

  async unlink() {
    await (await (await this.sudo()).rtcSessionIds).unlink();
    return _super(ChannelPartner, this).unlink();
  }

  @api.model()
  async _getAsSudoFromRequestOrRaise(req, channelId) {
    const channelPartner = await this._getAsSudoFromRequest(req, channelId);
    if (! bool(channelPartner)) {
      throw new NotFound();
    }
    return channelPartner;
  }

  
  /**
   * Seeks a channel partner matching the provided `channelId` and the
    current user or guest.

    :param channelId: The id of the channel of which the user/guest is
        expected to be member.
    :type channelId: int
    :return: A record set containing the channel partner if found, or an
        empty record set otherwise. In case of guest, the record is returned
        with the 'guest' record in the context.
    :rtype: mail.channel.partner
   */
  @api.model()
  async _getAsSudoFromRequest(req, channelId) {
    if (req.session.uid) {
      return (await this.env.items('mail.channel.partner').sudo()).search([['channelId', '=', channelId], ['partnerId', '=', (await (await this.env.user()).partnerId).id]], {limit: 1});
    }
    const guest = await this.env.items('mail.guest')._getGuestFromRequest(req);
    if (bool(guest)) {
      return (await guest.env.items('mail.channel.partner').sudo()).search([['channelId', '=', channelId], ['guestId', '=', guest.id]], {limit: 1});
    }
    return this.env.items('mail.channel.partner').sudo();
  }

  // RTC (voice/video)

  async _rtcJoinCall(checkRtcSessionIds: any) {
    this.ensureOne();
    const self: any = this;
    const channelId = await self.channelId;
    checkRtcSessionIds = (checkRtcSessionIds ?? []).concat((await self.rtcSessionIds)).ids;
    await channelId._rtcCancelInvitations((await self.partnerId).ids, (await self.guestId).ids);
    await (await self.rtcSessionIds).unlink();
    const rtcSession = await this.env.items('mail.channel.rtc.session').create({'channelPartnerId': self.id});
    const [currentRtcSessions, outdatedRtcSessions] = await self._rtcSyncSessions(checkRtcSessionIds);
    const res = {
      'iceServers': await self.env.items('mail.ice.server')._getIceServers() ?? false,
      'rtcSessions': [
        ['insert', await Promise.all(currentRtcSessions.map(rtcSessionSudo => rtcSessionSudo._mailRtcSessionFormat()))],
        ['insert-and-unlink', Object.fromEntries(outdatedRtcSessions.map(missingRtcSessionSudo => ['id', missingRtcSessionSudo.id]))]
      ],
      'session_id': rtcSession.id,
    }
    if (len(await channelId.rtcSessionIds) == 1 && ['chat', 'group'].includes(await channelId.channelType)) {
      await channelId.messagePost(await this._t("%s started a live conference", await (await self.partnerId).label || await (await self.guestId).label), 'notification');
      const [invitedPartners, invitedGuests] = await self._rtcInviteMembers();
      if (bool(invitedGuests)) {
        res['invitedGuests'] = [['insert', await Promise.all(invitedGuests.map(async guest => {return {'id': guest.id, 'label': await guest.label}}))]]
      }
      if (bool(invitedPartners)) {
        res['invitedPartners'] = [['insert', await Promise.all(invitedPartners.map(async partner => {return {'id': partner.id, 'label': await partner.label}}))]]
      }
    }
    return res;
  }

  async _rtcLeaveCall() {
    const self: any = this;
    self.ensureOne();
    const rtcSessionIds = await self.rtcSessionIds;
    if (bool(rtcSessionIds)) {
      await rtcSessionIds.unlink();
    }
    else {
      return (await self.channelId)._rtcCancelInvitations((await self.partnerId).ids, (await self.guestId).ids)
    }
  }

  /**
   * Synchronize the RTC sessions for self channel partner.
    - Inactive sessions of the channel are deleted.
    - Current sessions are returned.
    - Sessions given in check_rtc_session_ids that no longer exists
      are returned as non-existing.
    :param list check_rtc_session_ids: list of the ids of the sessions to check
    :returns tuple: (current_rtc_sessions, outdated_rtc_sessions)
   * @param checkRtcSessionIds 
   * @returns 
   */
  async _rtcSyncSessions(checkRtcSessionIds: any) {
    const self: any = this;
    self.ensureOne();
    const channelId = await self.channelId;
    const rtcSessionIds = await channelId.rtcSessionIds;
    await rtcSessionIds._deleteInactiveRtcSessions();
    const checkRtcSessions = this.env.items('mail.channel.rtc.session').browse((checkRtcSessionIds ?? []).map(checkRtcSessionId => parseInt(checkRtcSessionId)));
    return [rtcSessionIds, checkRtcSessions.sub(rtcSessionIds)]
  }

  /**
   * Sends invitations to join the RTC call to all connected members of the thread who are not already invited.
        :param list partnerIds: list of the partner ids to invite
        :param list guest_ids: list of the guest ids to invite

        if either partnerIds or guest_ids is set, only the specified ids will be invited.
   * @param partnerIds 
   * @param guestIds 
   */
  async _rtcInviteMembers(partnerIds: any[]=[], guestIds: any[]=[]) {
    const self: any = this;
    self.ensureOne();
    const channelId = await self.channelId;
    let channelPartnerDomain = [
      ['channelId', '=', channelId.id],
      ['rtcInvitingSessionId', '=', false],
      ['rtcSessionIds', '=', false],
    ]
    if (partnerIds || guestIds) {
      channelPartnerDomain = expression.AND([channelPartnerDomain, [
        '|',
        ['partnerId', 'in', partnerIds ?? []],
        ['guestId', 'in', guestIds ?? []],
      ]])
    }
    const invitationNotifications = []
    let invitedPartners = self.env.items('res.partner');
    let invitedGuests = self.env.items('mail.guest');
    let target;
    for (const member of await self.env.items('mail.channel.partner').search(channelPartnerDomain)) {
      await member.set('rtcInvitingSessionId', (await self.rtcSessionIds).id);
      const [memPartnerId, memGuestId] = await member('partnerId', 'guestId');
      if (bool(memPartnerId)) {
        invitedPartners = invitedPartners.or(memPartnerId);
        target = memPartnerId;
      }
      else {
        invitedGuests = invitedGuests.or(memGuestId);
        target = memGuestId;
      }
      invitationNotifications.push([target, 'mail.channel/insert', {
        'id': channelId.id,
        'rtcInvitingSession': [['insert', await (await self.rtcSessionIds)._mailRtcSessionFormat()]],
      }]);
    }
    await self.env.items('bus.bus')._sendmany(invitationNotifications);
    if (invitedGuests.ok || invitedPartners.ok) {
      const channelData = {'id': channelId.id}
      if (invitedGuests.ok) {
        channelData['invitedGuests'] = [['insert', await Promise.all([...invitedGuests].map(async guest => {return {'id': guest.id, 'label': await guest.label}}))]]
      }
      if (invitedPartners.ok) {
        channelData['invitedPartners'] = [['insert', await Promise.all([...invitedPartners].map(async partner => {return {'id': partner.id, 'label': await partner.label}}))]]
      }
      await self.env.items('bus.bus')._sendone(channelId, 'mail.channel/insert', channelData);
    }
    return [invitedPartners, invitedGuests];
  }
}