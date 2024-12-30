import _ from "lodash";
import { DateTime } from "luxon";
import { api } from "../../../core";
import { Command, Fields, _Datetime } from "../../../core/fields";
import { DefaultDict2, Dict } from "../../../core/helper/collections";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, b64encode, bool, emailNormalize, f, getHslFromSeed, randrange, stringBase64 } from "../../../core/tools";
import { enumerate, extend, len, range, sorted } from "../../../core/tools/iterable";
import { DEFAULT_SERVER_DATETIME_FORMAT, pop, sha512 } from "../../../core/tools/misc";

const channelAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 530.06 530.06">
<circle cx="265.03" cy="265.03" r="265.03" fill="#875a7b"/>
<path d="M416.74,217.29l5-28a8.4,8.4,0,0,0-8.27-9.88H361.09l10.24-57.34a8.4,8.4,0,0,0-8.27-9.88H334.61a8.4,8.4,0,0,0-8.27,6.93L315.57,179.4H246.5l10.24-57.34a8.4,8.4,0,0,0-8.27-9.88H220a8.4,8.4,0,0,0-8.27,6.93L201,179.4H145.6a8.42,8.42,0,0,0-8.28,6.93l-5,28a8.4,8.4,0,0,0,8.27,9.88H193l-16,89.62H121.59a8.4,8.4,0,0,0-8.27,6.93l-5,28a8.4,8.4,0,0,0,8.27,9.88H169L158.73,416a8.4,8.4,0,0,0,8.27,9.88h28.45a8.42,8.42,0,0,0,8.28-6.93l10.76-60.29h69.07L273.32,416a8.4,8.4,0,0,0,8.27,9.88H310a8.4,8.4,0,0,0,8.27-6.93l10.77-60.29h55.38a8.41,8.41,0,0,0,8.28-6.93l5-28a8.4,8.4,0,0,0-8.27-9.88H337.08l16-89.62h55.38A8.4,8.4,0,0,0,416.74,217.29ZM291.56,313.84H222.5l16-89.62h69.07Z" fill="#ffffff"/>
</svg>`;

const groupAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 530.06 530.06">
<circle cx="265.03" cy="265.03" r="265.03" fill="#875a7b"/>
<path d="m184.356059,265.030004c-23.740561,0.73266 -43.157922,10.11172 -58.252302,28.136961l-29.455881,0c-12.0169,0 -22.128621,-2.96757 -30.335161,-8.90271s-12.309921,-14.618031 -12.309921,-26.048671c0,-51.730902 9.08582,-77.596463 27.257681,-77.596463c0.87928,0 4.06667,1.53874 9.56217,4.61622s12.639651,6.19167 21.432451,9.34235s17.512401,4.72613 26.158581,4.72613c9.8187,0 19.563981,-1.68536 29.236061,-5.05586c-0.73266,5.4223 -1.0991,10.25834 -1.0991,14.508121c0,20.370061 5.93514,39.127962 17.805421,56.273922zm235.42723,140.025346c0,17.585601 -5.34888,31.470971 -16.046861,41.655892s-24.912861,15.277491 -42.645082,15.277491l-192.122688,0c-17.732221,0 -31.947101,-5.09257 -42.645082,-15.277491s-16.046861,-24.070291 -16.046861,-41.655892c0,-7.7669 0.25653,-15.350691 0.76937,-22.751371s1.53874,-15.387401 3.07748,-23.960381s3.48041,-16.523211 5.82523,-23.850471s5.4955,-14.471411 9.45226,-21.432451s8.49978,-12.89618 13.628841,-17.805421c5.12906,-4.90924 11.393931,-8.82951 18.794611,-11.76037s15.570511,-4.3964 24.509931,-4.3964c1.46554,0 4.61622,1.57545 9.45226,4.72613s10.18492,6.6678 16.046861,10.55136c5.86194,3.88356 13.702041,7.40068 23.520741,10.55136s19.710601,4.72613 29.675701,4.72613s19.857001,-1.57545 29.675701,-4.72613s17.658801,-6.6678 23.520741,-10.55136c5.86194,-3.88356 11.21082,-7.40068 16.046861,-10.55136s7.98672,-4.72613 9.45226,-4.72613c8.93942,0 17.109251,1.46554 24.509931,4.3964s13.665551,6.85113 18.794611,11.76037c5.12906,4.90924 9.67208,10.844381 13.628841,17.805421s7.10744,14.105191 9.45226,21.432451s4.28649,15.277491 5.82523,23.850471s2.56464,16.559701 3.07748,23.960381s0.76937,14.984471 0.76937,22.751371zm-225.095689,-280.710152c0,15.534021 -5.4955,28.796421 -16.486501,39.787422s-24.253401,16.486501 -39.787422,16.486501s-28.796421,-5.4955 -39.787422,-16.486501s-16.486501,-24.253401 -16.486501,-39.787422s5.4955,-28.796421 16.486501,-39.787422s24.253401,-16.486501 39.787422,-16.486501s28.796421,5.4955 39.787422,16.486501s16.486501,24.253401 16.486501,39.787422zm154.753287,84.410884c0,23.300921 -8.24325,43.194632 -24.729751,59.681133s-36.380212,24.729751 -59.681133,24.729751s-43.194632,-8.24325 -59.681133,-24.729751s-24.729751,-36.380212 -24.729751,-59.681133s8.24325,-43.194632 24.729751,-59.681133s36.380212,-24.729751 59.681133,-24.729751s43.194632,8.24325 59.681133,24.729751s24.729751,36.380212 24.729751,59.681133zm126.616325,49.459502c0,11.43064 -4.10338,20.113531 -12.309921,26.048671s-18.318261,8.90271 -30.335161,8.90271l-29.455881,0c-15.094381,-18.025241 -34.511741,-27.404301 -58.252302,-28.136961c11.87028,-17.145961 17.805421,-35.903862 17.805421,-56.273922c0,-4.24978 -0.36644,-9.08582 -1.0991,-14.508121c9.67208,3.3705 19.417361,5.05586 29.236061,5.05586c8.64618,0 17.365781,-1.57545 26.158581,-4.72613s15.936951,-6.26487 21.432451,-9.34235s8.68289,-4.61622 9.56217,-4.61622c18.171861,0 27.257681,25.865561 27.257681,77.596463zm-28.136961,-133.870386c0,15.534021 -5.4955,28.796421 -16.486501,39.787422s-24.253401,16.486501 -39.787422,16.486501s-28.796421,-5.4955 -39.787422,-16.486501s-16.486501,-24.253401 -16.486501,-39.787422s5.4955,-28.796421 16.486501,-39.787422s24.253401,-16.486501 39.787422,-16.486501s28.796421,5.4955 39.787422,16.486501s16.486501,24.253401 16.486501,39.787422z" fill="#ffffff"/>
</svg>`;


/**
 * A mail.channel is a discussion group that may behave like a listener
    on documents.
 */
@MetaModel.define()
class Channel extends Model {
  static _module = module;
  static _name = 'mail.channel';
  static _description = 'Discussion Channel';
  static _mailFlatThread = false;
  static _mailPostAccess = 'read';
  static _parents = ['mail.thread', 'mail.alias.mixin'];

  MAX_BOUNCE_LIMIT = 10;

  static label = Fields.Char('Name', { required: true, translate: true });
  static active = Fields.Boolean({ default: true, help: "Set active to false to hide the channel without removing it." });
  static channelType = Fields.Selection([
    ['chat', 'Chat'],
    ['channel', 'Channel'],
    ['group', 'Group']],
    { string: 'Channel Type', default: 'channel', help: "Chat is private and unique between 2 persons. Group is private among invited persons. Channel can be freely joined (depending on its configuration)." })
  static isChat = Fields.Boolean({ string: 'Is a chat', compute: '_computeIsChat' })
  static defaultDisplayMode = Fields.Selection([['videoFullScreen', "Full screen video"]], { string: "Default Display Mode", help: "Determines how the channel will be displayed by default when opening it from its invitation link. No value means display text (no voice/video)." })
  static description = Fields.Text('Description')
  static image128 = Fields.Image("Image", { maxWidth: 128, maxHeight: 128 })
  static avatar128 = Fields.Image("Avatar", { maxWidth: 128, maxHeight: 128, compute: '_computeAvatar128' })
  static channelPartnerIds = Fields.Many2many(
    'res.partner', {
    string: 'Members',
    compute: '_computeChannelPartnerIds', inverse: '_inverseChannelPartnerIds',
    computeSudo: true, search: '_searchChannelPartnerIds',
    groups: 'base.groupUser'
  })
  static channelLastSeenPartnerIds = Fields.One2many(
    'mail.channel.partner', 'channelId', { string: 'Last Seen', groups: 'base.groupUser' })
  static rtcSessionIds = Fields.One2many('mail.channel.rtc.session', 'channelId', { groups: "base.groupSystem" })
  static isMember = Fields.Boolean('Is Member', { compute: '_computeIsMember', computeSudo: true })
  static memberCount = Fields.Integer({ string: "Member Count", compute: '_computeMemberCount', computeSudo: true, help: "Excluding guests from count." })
  static groupIds = Fields.Many2many(
    'res.groups', {
    string: 'Auto Subscription',
    help: "Members of those groups will automatically added as followers. Note that they will be able to manage their subscription manually if necessary."
  })
  // access
  static uuid = Fields.Char('UUID', { size: 50, default: self => self._generateRandomToken(), copy: false });
  static isPublic = Fields.Selection([
    ['public', 'Everyone'],
    ['private', 'Invited people only'],
    ['groups', 'Selected group of users']], {
    string: 'Privacy',
    required: true, default: 'groups',
    help: 'This group is visible by non members. Invisible groups can add members through the invite button.'
  })
  static groupPublicId = Fields.Many2one('res.groups', { string: 'Authorized Group', default: async (self) => self.env.ref('base.groupUser') })

  static _sqlConstraints = [
    ['uuid_unique', 'UNIQUE(uuid)', 'The channel UUID must be unique'],
  ]

  @api.model()
  async defaultGet(fields) {
    const res = await _super(Channel, this).defaultGet(fields);
    if (!res['aliasContact'] && (!bool(fields) || fields.includes('aliasContact'))) {
      res['aliasContact'] = res.get('isPublic', 'private') === 'public' ? 'everyone' : 'followers';
    }
    return res;
  }

  @api.model()
  _generateRandomToken() {
    // Built to be shared on invitation link. It uses non-ambiguous characters and it is of a
    // reasonable length: enough to avoid brute force, but short enough to be shareable easily.
    // This token should not contain "mail.guest"._cookieSeparator value.
    const str = 'abcdefghijkmnopqrstuvwxyzABCDEFGHIJKLMNPQRSTUVWXYZ23456789';
    return Array.from(range(1, 10)).map(val => str[randrange(0, str.length - 1)]).join('');
  }

  // CHAT CONSTRAINT

  @api.constrains('channelLastSeenPartnerIds', 'channelPartnerIds')
  async _constraintPartnersChat() {
    for (const ch of await (await this.sudo()).filtered(async (ch) => await ch.channelType === 'chat')) {
      if (len(await ch.channelLastSeenPartnerIds) > 2 || len(await ch.channelPartnerIds) > 2) {
        throw new ValidationError(await this._t("A channel of type 'chat' cannot have more than two users."));
      }
    }
  }

  // COMPUTE / INVERSE

  @api.depends('channelType')
  async _computeIsChat() {
    for (const record of this) {
      await record.set('isChat', await record.channelType === 'chat');
    }
  }

  @api.depends('channelType', 'image128', 'uuid')
  async _computeAvatar128() {
    for (const record of this) {
      await record.set('avatar128', await record.image128 || await record._generateAvatar());
    }
  }

  async _generateAvatar() {
    const channelType = await this['channelType'];
    if (!['channel', 'group'].includes(channelType)) {
      return false;
    }
    let avatar = channelType === 'group' ? groupAvatar : channelAvatar;
    const bgcolor = getHslFromSeed(await this['uuid']);
    avatar = avatar.replace('fill="#875a7b"', `fill="${bgcolor}"`);
    return b64encode(stringBase64(avatar));
  }

  @api.depends('channelLastSeenPartnerIds.partnerId')
  async _computeChannelPartnerIds() {
    for (const channel of this) {
      await channel.set('channelPartnerIds', await (await channel.channelLastSeenPartnerIds).partnerId);
    }
  }

  async _inverseChannelPartnerIds() {
    const newMembers = [];
    let outdated = this.env.items('mail.channel.partner');
    for (const channel of this) {
      const currentMembers = await channel.channelLastSeenPartnerIds;
      const partners = await channel.channelPartnerIds;
      const partnersNew = partners.sub(await currentMembers.partnerId);

      for (const partner of partnersNew) {
        newMembers.push({
          'channelId': channel.id,
          'partnerId': partner.id,
        });
      }
      outdated = outdated.add(await currentMembers.filtered(async (m) => !partners.includes(await m.partnerId)));
    }
    if (newMembers.length) {
      await this.env.items('mail.channel.partner').create(newMembers);
    }
    if (outdated.ok) {
      await (await outdated.sudo()).unlink();
    }
  }

  async _searchChannelPartnerIds(operator, operand) {
    return [[
      'channelLastSeenPartnerIds',
      'in',
      await (await this.env.items('mail.channel.partner').sudo())._search([
        ['partnerId', operator, operand]
      ])
    ]];
  }

  @api.depends('channelPartnerIds')
  async _computeIsMember() {
    const partnerId = await (await this.env.user()).partnerId;
    for (const channel of this) {
      await channel.set('isMember', (await channel.channelPartnerIds).includes(partnerId));
    }
  }

  @api.depends('channelPartnerIds')
  async _computeMemberCount() {
    const readGroupRes = await this.env.items('mail.channel.partner').readGroup([['channelId', 'in', this.ids]], ['channelId'], ['channelId']);
    const memberCountByChannelId = {};
    for (const item of readGroupRes) {
      memberCountByChannelId[item['channelId'][0]] = item['channelId_count'];
    }
    for (const channel of this) {
      await channel.set('memberCount', memberCountByChannelId[channel.id] || 0);
    }
  }

  // ONCHANGE

  @api.onchange('isPublic')
  async _onchangePublic() {
    const self: any = this;
    if (await self.isPublic !== 'public' && await self.aliasContact === 'everyone') {
      await self.set('aliasContact', 'followers');
    }
  }

  // CRUD

  @api.modelCreateMulti()
  async create(valsList) {
    const defaults = await this.defaultGet(['isPublic']);

    const accessTypes = [];
    for (const vals of valsList) {
      // find partners to add from partnerIds
      const partnerIdsCmd = vals['channelPartnerIds'] ?? [];
      if (partnerIdsCmd.some(cmd => ![4, 6].includes(cmd[0]))) {
        throw new ValidationError(await this._t('Invalid value when creating a channel with members, only 4 or 6 are allowed.'));
      }
      const partnerIds = partnerIdsCmd.filter(cmd => cmd[0] == 4).map(cmd => cmd[1]);
      extend(partnerIds, partnerIdsCmd.filter(cmd => cmd[0] == 6).map(cmd => cmd[2]));

      // find partners to add from channelLastSeenPartnerIds
      const membershipIdsCmd = vals['channelLastSeenPartnerIds'] ?? [];
      if (membershipIdsCmd.some(cmd => cmd[0] != 0)) {
        throw new ValidationError(await this._t('Invalid value when creating a channel with memberships, only 0 is allowed.'));
      }
      const membershipPids = membershipIdsCmd.filter(cmd => cmd[0] == 0).map(cmd => cmd[2]['partnerId']);

      // always add current user to new channel to have right values for isPinned + ensure he has rights to see channel
      const partnerIdsToAdd = _.union(partnerIds, [(await (await this.env.user()).partnerId).id]);
      vals['channelLastSeenPartnerIds'] = membershipIdsCmd.concat(partnerIdsToAdd.filter(pid => !membershipPids.includes(pid)).map(pid => [0, 0, { 'partnerId': pid }]));

      // save visibility, apply public visibility for create then set back after creation to avoid ACLS issue
      const accessType = vals['isPublic'] ?? defaults['isPublic'];
      accessTypes.push(accessType);
      vals['isPublic'] = 'public';
      if (!vals['aliasContact'] && accessType !== 'public') {
        vals['aliasContact'] = 'followers';
      }

      // clean vals
      pop(vals, 'channelPartnerIds', false);
    }
    // Create channel and alias
    const channels = await (await _super(Channel, await this.withContext({ mailCreateNolog: true, mailCreateNosubscribe: true }))).create(valsList);

    for (const [accessType, channel] of _.zip(accessTypes, [...channels])) {
      if (accessType !== 'public') {
        await (await channel.sudo()).set('isPublic', accessType);
      }
    }

    await channels._subscribeUsersAutomatically();

    return channels;
  }

  @api.ondelete(false)
  async _unlinkExceptAllEmployeeChannel() {
    // Delete mail.channel
    let allEmpGroup;
    try {
      allEmpGroup = await this.env.ref('mail.channelAllEmployees');
    } catch (e) {
      // except ValueError:
      allEmpGroup = null;
    }
    if (allEmpGroup && this.includes(allEmpGroup)) {
      throw new UserError(await this._t('You cannot delete those groups, as the Whole Company group is required by other modules.'));
    }
  }

  async write(vals) {
    const result = await _super(Channel, this).write(vals);
    if (vals['groupIds']) {
      await this._subscribeUsersAutomatically();
    }
    if ('image128' in vals) {
      const notifications = [];
      for (const channel of this) {
        notifications.push([channel, 'mail.channel/insert', {
          'id': channel.id,
          'avatarCacheKey': await channel._getAvatarCacheKey(),
        }])
      }
      await this.env.items('bus.bus')._sendmany(notifications);
    }
    return result;
  }

  async init() {
    const res = await this._cr.execute(`SELECT indexname FROM pg_indexes WHERE indexname = '%s'`, ['mailChannelPartnerSeenMessageIdIdx']);
    if (!res.length) {
      await this._cr.execute('CREATE INDEX "mailChannelPartnerSeenMessageIdIdx" ON "mailChannelPartner" ("channelId","partnerId","seenMessageId")');
    }
  }

  // MEMBERS MANAGEMENT

  async _subscribeUsersAutomatically() {
    const newMembers = await this._subscribeUsersAutomaticallyGetMembers();
    if (newMembers.length) {
      const toCreate = [];
      for (const channelId of newMembers.keys()) {
        for (const partnerId of newMembers[channelId]) {
          toCreate.push({ 'channelId': channelId, 'partnerId': partnerId });
        }
      }
      await (await this.env.items('mail.channel.partner').sudo()).create(toCreate);
    }
  }

  /**
   * Return new members per channel ID
   * @returns 
   */
  async _subscribeUsersAutomaticallyGetMembers() {
    const res = new Dict<any>();
    for (const channel of this) {
      res[channel.id] = (await (await (await channel.groupIds).users).partnerId).sub(await channel.channelPartnerIds).ids;
    }
    return res;
  }

  async actionUnfollow() {
    return (this as any)._actionUnfollow(await (await this.env.user()).partnerId);
  }

  async _actionUnfollow(partner) {
    // const self: any = this;
    await (this as any).messageUnsubscribe(partner.ids);
    if (!(await (await this.withContext({ activeTest: false })).channelPartnerIds).includes(partner)) {
      return true;
    }
    const channelInfo = (await this.channelInfo())[0]  // must be computed before leaving the channel (access rights)
    const result = await this.write({ 'channelPartnerIds': [Command.unlink(partner.id)] });
    // side effect of unsubscribe that wasn't taken into account because channelInfo is called before actually unpinning the channel
    channelInfo['isPinned'] = false;
    await this.env.items('bus.bus')._sendone(partner, 'mail.channel/leave', channelInfo);
    const notification = await this._t('<div class="o-mail-notification">left the channel</div>');
    // post 'channel left' message as root since the partner just unsubscribed from the channel
    await (await this.sudo()).messagePost(notification, "mail.mtComment", partner.id);
    await this.env.items('bus.bus')._sendone(this, 'mail.channel/insert', {
      'id': this.id,
      'memberCount': await (this as any).memberCount,
      'members': [['insert-and-unlink', { 'id': partner.id }]],
    });
    return result;
  }

  /**
   * Adds the given partnerIds and guestIds as member of self channels.
   * @param partnerIds 
   * @param guestIds 
   * @param inviteToRtcCall 
   */
  async addMembers(partnerIds?: any, guestIds?: any, inviteToRtcCall?: boolean) {
    // await Promise.all([
    await this.checkAccessRights('write'),
      await this.checkAccessRule('write')
    // ]);
    const partners = await this.env.items('res.partner').browse(partnerIds ?? []).exists();
    const guests = await this.env.items('mail.guest').browse(guestIds ?? []).exists();
    for (const channel of this) {
      const groupPublicId = await channel.groupPublicId;
      const membersToCreate = [];
      if (await channel.isPublic === 'groups') {
        const invalidPartners = await partners.filtered(async (partner) => !(await (await partner.userIds).groupsId).includes(groupPublicId));
        if (invalidPartners.ok) {
          throw new UserError(_f(await this._t(
            'Channel "{channelName}" only accepts members of group "{groupName}". Forbidden for: {partnerNames}'),
            {
              channelName: await channel.label,
              groupName: await groupPublicId.label,
              partnerNames: (await invalidPartners.mapped('label')).join(',')
            }
          ));
        }
        if (guests.ok) {
          throw new UserError(_f(await this._t(
            'Channel "{channelName}" only accepts members of group "{groupName}". Forbidden for: {guestNames}'),
            {
              channelName: await channel.label,
              groupName: await groupPublicId.label,
              guestNames: (await guests.mapped('label')).join(',')
            }
          ))
        }
      }
      const existingPartners = await this.env.items('res.partner').search([['id', 'in', partners.ids], ['channelIds', 'in', channel.id]]);
      for (const partner of partners.sub(existingPartners)) {
        membersToCreate.push({
          'partnerId': partner.id,
          'channelId': channel.id,
        });
      }
      const existingGuests = await this.env.items('mail.guest').search([['id', 'in', guests.ids], ['channelIds', 'in', channel.id]]);
      for (const partner of guests.sub(existingGuests)) {
        membersToCreate.push({
          'guestId': partner.id,
          'channelId': channel.id,
        });
      }
      const newMembers = await (await this.env.items('mail.channel.partner').sudo()).create(membersToCreate);
      const membersData = [];
      const guestMembersData = [];
      for (const channelPartner of await newMembers.filtered(async (channelPartner) => (await channelPartner.partnerId).ok)) {
        const partnerId = await channelPartner.partnerId;
        const channelId = await channelPartner.channelId;
        const userIds = await partnerId.userIds;
        const user = userIds.ok ? userIds(0) : this.env.items('res.users');
        // notify invited members through the bus
        if (user.ok) {
          await this.env.items('bus.bus')._sendone(partnerId, 'mail.channel/joined', {
            'channel': (await (await (await (await channelId.withUser(user)).withContext({ allowedCompanyIds: (await user.companyIds).ids })).sudo()).channelInfo())[0],
            'invitedByUserId': (await this.env.user()).id,
          })
        }
        // notify existing members with a new message in the channel
        let notification;
        if (partnerId.eq(await (await this.env.user()).partnerId)) {
          notification = await this._t('<div class="o-mail-notification">joined the channel</div>');
        }
        else {
          notification = _f(await this._t(
            '<div class="o-mail-notification">invited <a href="#" data-oe-model="res.partner" data-oe-id="%(newPartnerId)d">%(newPartnerName)s</a> to the channel</div>',
            {
              newPartnerId: partnerId.id,
              newPartnerName: await partnerId.label
            },
          ));
        }
        await channelId.messagePost(notification, "notification", "mail.mtComment", false);
        membersData.push({
          'id': partnerId.id,
          'imStatus': await partnerId.imStatus,
          'labe': await partnerId.label,
        });
      }
      for (const channelPartner of await newMembers.filtered(async (channelPartner) => (await channelPartner.guestId).ok)) {
        const channelId = await channelPartner.channelId;
        const guestId = await channelPartner.guestId;
        await channelId.messagePost(await this._t('<div class="o-mail-notification">joined the channel</div>'), "notification", "mail.mtComment", false);
        guestMembersData.push({
          'id': guestId.id,
          'label': await guestId.label,
        })
        if (guestId.ok) {
          await this.env.items('bus.bus')._sendone(guestId, 'mail.channel/joined', {
            'channel': (await (await channelId.sudo()).channelInfo())[0],
          })
        }
      }
      await this.env.items('bus.bus')._sendone(channel, 'mail.channel/insert', {
        'id': channel.id,
        'guestMembers': [['insert', guestMembersData]],
        'memberCount': await channel.memberCount,
        'members': [['insert', membersData]],
      })
    }
    if (inviteToRtcCall) {
      let guest, partner;
      if (await (await this.env.user())._isPublic() && 'guest' in this.env.context) {
        guest = this.env.context['guest'];
        partner = this.env.items('res.partner');
      }
      else {
        guest = this.env.items('mail.guest');
        partner = await (await this.env.user()).partnerId;
      }
      for (const channel of this) {
        const currentChannelPartner = await (await this.env.items('mail.channel.partner').sudo()).search([['channelId', '=', channel.id], ['partnerId', '=', partner.id], ['guestId', '=', guest.id]]);
        if (currentChannelPartner.ok && await currentChannelPartner.rtcSessionIds) {
          await currentChannelPartner._rtcInviteMembers(partners.ids, guests.ids);
        }
      }
    }
  }

  /**
   * Private implementation to remove members from channels. Done as sudo to avoid ACLs issues with channel partners.
   */
  async _actionRemoveMembers(partners) {
    await (await (await this.env.items('mail.channel.partner').sudo()).search([
      ['partnerId', 'in', partners.ids],
      ['channelId', 'in', this.ids]
    ])).unlink();
    this.invalidateCache(['channelPartnerIds', 'channelLastSeenPartnerIds']);
  }

  /**
   * Return true if the current user can invite the partner to the channel.

      * public: ok;
      * private: must be member;
      * group: both current user and target must have group;

    :return boolean: whether inviting is ok
   * @param partnerId 
   * @returns 
   */
  async _canInvite(partnerId) {
    const partner = this.env.items('res.partner').browse(partnerId);

    for (const channel of await this.sudo()) {
      const isPublic = await channel.isPublic;
      const groupPublicId = await channel.groupPublicId;
      if (isPublic === 'private' && ! await channel.isMember) {
        return false;
      }
      if (isPublic === 'groups') {
        const userIds = await partner.userIds;
        if (!userIds.ok || !(await userIds.groupsId).includes(groupPublicId)) {
          return false;
        }
        if (!(await (await this.env.user()).groupsId).incluse(groupPublicId)) {
          return false;
        }
      }
    }
    return true;
  }

  // RTC

  /**
   * Cancels the invitations of the RTC call from all invited members (or the specified partnerIds).
        :param list partnerIds: list of the partner ids from which the invitation has to be removed
        :param list guestIds: list of the guest ids from which the invitation has to be removed
        if either partnerIds or guestIds is set, only the specified ids will be invited.
   * @param partnerIds 
   * @param guestIds 
   */
  async _rtcCancelInvitations(partnerIds?: number[], guestIds?: number[]) {
    this.ensureOne();
    let channelPartnerDomain = [
      ['channelId', '=', this.id],
      ['rtcInvitingSessionId', '!=', false],
    ];
    if (bool(partnerIds) || bool(guestIds)) {
      channelPartnerDomain = expression.AND([channelPartnerDomain, [
        '|',
        ['partnerId', 'in', partnerIds ?? []],
        ['guestId', 'in', guestIds ?? []],
      ]]);
    }
    let invitedPartners = this.env.items('res.partner');
    let invitedGuests = this.env.items('mail.guest');
    const invitationNotifications = [];
    for (const member of await this.env.items('mail.channel.partner').search(channelPartnerDomain)) {
      await member.set('rtcInvitingSessionId', false);
      const [partnerId, guestId] = await member('partnerId', 'guestId');
      let target;
      if (partnerId.ok) {
        invitedPartners = invitedPartners.or(partnerId)
        target = [this._cr.dbName, 'res.partner', partnerId.id];
      }
      else {
        invitedGuests = invitedGuests.or(guestId);
        target = [this._cr.dbName, 'mail.guest', guestId.id];
      }
      invitationNotifications.push([target, {
        'type': 'mail.channelUpdate',
        'payload': {
          'id': this.id,
          'rtcInvitingSession': [['unlink',]],
        },
      }]);
    }
    await this.env.items('bus.bus')._sendmany(invitationNotifications);
    const channelData = { 'id': this.id }
    if (invitedGuests.ok) {
      const guests = [];
      for (const guest of invitedGuests) {
        guests.push({ 'id': guest.id });
      }
      channelData['invitedGuests'] = [['insert-and-unlink', guests]];
    }
    if (invitedPartners.ok) {
      const partners = [];
      for (const partner of invitedPartners) {
        partners.push({ 'id': partner.id });
      }
      channelData['invitedPartners'] = [['insert-and-unlink', partners]];
    }
    if (invitedPartners.ok || invitedGuests.ok) {
      await this.env.items('bus.bus')._sendone([this._cr.dbName, 'mail.channel', this.id], {
        'type': 'mail.channelUpdate',
        'payload': channelData,
      });
    }
    return channelData;
  }

  // MAILING

  async _aliasGetCreationValues() {
    const values = await _super(Channel, this)._aliasGetCreationValues();
    values['aliasModelId'] = (await this.env.items('ir.model')._get('mail.channel')).id;
    if (bool(this.id)) {
      values['aliasForceThreadId'] = this.id;
    }
    return values;
  }

  async _aliasGetErrorMessage(message, messageDict, alias) {
    if (await alias.aliasContact === 'followers' && bool(this.ids)) {
      const author = this.env.items('res.partner').browse(messageDict['authorId'] || false);
      if (!author.ok || !(await this['channelPartnerIds']).includes(author)) {
        return this._t('restricted to channel members');
      }
      return false;
    }
    return _super(Channel, this)._aliasGetErrorMessage(message, messageDict, alias);
  }

  /**
   * Override recipients computation as channel is not a standard
      mail.thread document. Indeed there are no followers on a channel.
      Instead of followers it has members that should be notified.

      :param message: see ``MailThread._notifyComputeRecipients()``;
      :param msgVals: see ``MailThread._notifyComputeRecipients()``;

      :return recipients: structured data holding recipients data. See
        ``MailThread._notifyThread()`` for more details about its content
        and use;
   * @param message 
   * @param msgVals 
   * @returns 
   */
  async _notifyComputeRecipients(message, msgVals?: any) {
    // get values from msgVals or from message if msgVals doen't exists
    const msgSudo = await message.sudo();
    const messageType = msgVals ? msgVals['messageType'] ?? 'email' : await msgSudo.messageType;
    const pids = msgVals ? msgVals['partnerIds'] ?? [] : (await msgSudo.partnerIds).ids;

    // notify only user input (comment or incoming emails)
    if (!['comment', 'email'].includes(messageType)) {
      return [];
    }
    // notify only mailing lists or if mentioning recipients
    if (!bool(pids)) {
      return [];
    }

    const emailFrom = emailNormalize(msgVals['emailFrom'] || await msgSudo.emailFrom);
    const authorId = msgVals['authorId'] || (await msgSudo.authorId).id;

    const recipientsData = [];
    if (bool(pids)) {
      await this.env.items('res.partner').flush(['active', 'email', 'partnerShare']);
      await this.env.items('res.users').flush(['notificationType', 'partnerId']);
      const sqlQuery = `
              SELECT DISTINCT ON (partner.id) partner.id,
                      partner."partnerShare",
                      users."notificationType"
                FROM "resPartner" partner
            LEFT JOIN "resUsers" users on partner.id = users."partnerId"
                WHERE partner.active IS TRUE
                      AND partner.email != '$s'
                      AND partner.id IN (%s) AND partner.id NOT IN (%s)`;
      const res = await this.env.cr.execute(
        sqlQuery, [emailFrom || '', String(pids), authorId ? String([authorId]) : 'null']);
      for (const [partnerId, partnerShare, notif] of res) {
        // ocnClient: will add partners to recipient recipientData. more ocn notifications. We neeed to filter them maybe
        recipientsData.push({
          'id': partnerId,
          'share': partnerShare,
          'active': true,
          'notif': notif || 'email',
          'type': !partnerShare && notif ? 'user' : 'customer',
          'groups': [],
        })
      }
    }
    return recipientsData;
  }

  /**
   * All recipients of a message on a channel are considered as partners.
      This means they will receive a minimal email, without a link to access
      in the backend. Mailing lists should indeed send minimal emails to avoid
      the noise.
   * @param msgVals 
   * @returns 
   */
  async _notifyGetGroups(msgVals?: any) {
    const groups = await _super(Channel, this)._notifyGetGroups(msgVals);
    for (const [index, [groupName, groupFunc, groupData]] of enumerate(groups)) {
      if (groupName !== 'customer') {
        groups[index] = [groupName, async (partner) => false, groupData];
      }
    }
    return groups;
  }

  async _notifyEmailHeaderDict() {
    const headers = await _super(Channel, this)._notifyEmailHeaderDict();
    headers['Precedence'] = 'list';
    // avoid out-of-office replies from MS Exchange
    // http://blogs.technet.com/b/exchange/archive/2006/10/06/3395024.aspx
    headers['X-Auto-Response-Suppress'] = 'OOF';
    const [aliasDomain, aliasName] = await this('aliasDomain', 'aliasName');
    if (aliasDomain && aliasName) {
      headers['List-Id'] = f('<%s.%s>', aliasName, aliasDomain);
      headers['List-Post'] = f('<mailto:%s@%s>', aliasName, aliasDomain);
      // Avoid users thinking it was a personal message
      // X-Forge-To: will replace To: after SMTP envelope is determined by ir.mail.server
      const listTo = f('"%s" <%s@%s>', await this['label'], aliasName, aliasDomain);
      headers['X-Forge-To'] = listTo;
    }
    return headers;
  }

  async _notifyThread(message, msgVals?: any, kwargs: {} = {}) {
    // link message to channel
    const rdata = await _super(Channel, this)._notifyThread(message, msgVals, kwargs);

    const messageFormatValues = (await message.messageFormat())[0];
    const busNotifications = await this._channelMessageNotifications(message, messageFormatValues);
    await (await this.env.items('bus.bus').sudo())._sendmany(busNotifications);
    // Last interest is updated for a chat when posting a message.
    // So a notification is needed to update UI.
    const [isChat, channelType] = await this('isChat', 'channelType');
    if (isChat || channelType === 'group') {
      const notifications = []
      for (const channelPartners of await (await this['channelLastSeenPartnerIds']).filtered('partnerId')) {
        const [partnerId, lastInterestDt] = await channelPartners('partnerId', 'lastInterestDt');
        const notif = {
          'type': 'mail.channelLastInterestDtChanged',
          'payload': {
            'id': this.id,
            'lastInterestDt': lastInterestDt,
          }
        }
        notifications.push([[this._cr.dbName, 'res.partner', partnerId.id], notif]);
      }
      await this.env.items('bus.bus')._sendmany(notifications);
    }
    return rdata;
  }

  /**
   * Override bounce management to unsubscribe bouncing addresses
   * @param email 
   * @param partner 
   * @returns 
   */
  async _messageReceiveBounce(email, partner) {
    for (const p of partner) {
      if (await p.messageBounce >= this.MAX_BOUNCE_LIMIT) {
        await this._actionUnfollow(p);
      }
    }
    return _super(Channel, this)._messageReceiveBounce(email, partner);
  }

  async _messageComputeAuthor(authorId?: any, emailFrom?: any, raiseException: boolean = false) {
    return _super(Channel, this)._messageComputeAuthor(authorId, emailFrom, false);
  }

  @api.returns('mail.message', (value) => value.id)
  async messagePost(options: string | {}) {
    await (await (await (await this.filtered((channel) => channel.isChat)).mapped('channelLastSeenPartnerIds')).sudo()).write({
      'isPinned': true,
      'lastInterestDt': _Datetime.now(),
    })

    // mailPostAutofollow=false is necessary to prevent adding followers
    // when using mentions in channels. Followers should not be added to
    // channels, and especially not automatically (because channel membership
    // should be managed with channel.partner instead).
    // The current client code might be setting the key to true on sending
    // message but it is only useful when targeting customers in chatter.
    // This value should simply be set to false in channels no matter what.
    return _super(Channel, await this.withContext({ mailCreateNosubscribe: true, mailPostAutofollow: false })).messagePost(options);
  }

  /**
   * Automatically set the message posted by the current user as seen for himself.
   * @param message 
   * @param msgVals 
   * @returns 
   */
  async _messagePostAfterHook(message, msgVals) {
    await this._setLastSeenMessage(message);
    return _super(Channel, this)._messagePostAfterHook(message, msgVals);
  }

  /**
    * We don't call super in this override as we want to ignore the
      mail.thread behavior completely
    * @param message 
    */
  async _checkCanUpdateMessageContent(message) {
    if (await message.messageType !== 'comment') {
      throw new UserError(await this._t("Only messages type comment can have their content updated on model 'mail.channel'"));
    }
  }

  async _messageUpdateContentAfterHook(message) {
    this.ensureOne();
    await this.env.items('bus.bus')._sendone([this._cr.dbName, 'mail.channel', this.id], {
      'type': 'mail.messageUpdate',
      'payload': {
        'id': message.id,
        'body': await message.body,
        'attachments': [['insert-and-replace', await (await message.attachmentIds)._attachmentFormat(true)]],
      },
    })
    return _super(Channel, this)._messageUpdateContentAfterHook(message);
  }

  async _messageAddReactionAfterHook(message, content) {
    this.ensureOne();
    let guests, partners;
    if (await (await this.env.user())._isPublic() && 'guest' in this.env.context) {
      guests = [['insert', { 'id': this.env.context['guest'].id }]];
      partners = [];
    }
    else {
      guests = [];
      partners = [['insert', { 'id': (await (await this.env.user()).partnerId).id }]];
    }
    const reactions = await (await this.env.items('mail.message.reaction').sudo()).search([['messageId', '=', message.id], ['content', '=', content]]);
    await this.env.items('bus.bus')._sendone([this._cr.dbName, 'mail.channel', this.id], {
      'type': 'mail.messageUpdate',
      'payload': {
        'id': message.id,
        'messageReactionGroups': [[len(reactions) > 0 ? 'insert' : 'insert-and-unlink', {
          'messageId': message.id,
          'content': content,
          'count': len(reactions),
          'guests': guests,
          'partners': partners,
        }]],
      },
    })
    return _super(Channel, this)._messageAddReactionAfterHook(message, content);
  }

  async _messageRemoveReactionAfterHook(message, content) {
    this.ensureOne();
    let guests, partners;
    if (await (await this.env.user())._isPublic() && 'guest' in this.env.context) {
      guests = [['insert-and-unlink', { 'id': this.env.context['guest'].id }]];
      partners = [];
    }
    else {
      guests = [];
      partners = [['insert-and-unlink', { 'id': (await (await this.env.user()).partnerId).id }]];
    }
    const reactions = await (await this.env.items('mail.message.reaction').sudo()).search([['messageId', '=', message.id], ['content', '=', content]]);
    await this.env.items('bus.bus')._sendone([this._cr.dbName, 'mail.channel', this.id], {
      'type': 'mail.messageUpdate',
      'payload': {
        'id': message.id,
        'messageReactionGroups': [[len(reactions) > 0 ? 'insert' : 'insert-and-unlink', {
          'messageId': message.id,
          'content': content,
          'count': len(reactions),
          'guests': guests,
          'partners': partners,
        }]],
      },
    })
    return _super(Channel, this)._messageRemoveReactionAfterHook(message, content);
  }

  /**
    * Do not allow follower subscription on channels. Only members are
      considered.
    * @param partnerIds 
    * @param subtypeIds 
    * @param customerIds 
    */
  async _messageSubscribe(partnerIds: any, subtypeIds: any, customerIds: any) {
    throw new UserError(await this._t('Adding followers on channels is not possible. Consider adding members instead.'))
  }


  // BROADCAST

  // Anonymous method
  /**
   * Broadcast the current channel header to the given partner ids
          :param partnerIds : the partner to notify
   * @param partnerIds 
   */
  async _broadcast(partnerIds) {
    const notifications = await this._channelChannelNotifications(partnerIds);
    await this.env.items('bus.bus')._sendmany(notifications);
  }

  /**
   * Generate the bus notifications of current channel for the given partner ids
          :param partnerIds : the partner to send the current channel header
          :returns list of bus notifications (tuple (busChanne, messageContent))
   * @param partnerIds 
   * @returns 
   */
  async _channelChannelNotifications(partnerIds) {
    const notifications = [];
    for (const partner of this.env.items('res.partner').browse(partnerIds)) {
      const userIds = await partner.userIds;
      const userId = userIds.ok && bool(userIds[0]) ? userIds[0] : false;
      if (bool(userId)) {
        const userChannels = await (await this.withUser(userId)).withContext({
          allowedCompanyIds: (await userId.companyIds).ids
        })
        for (const channelInfo of await userChannels.channelInfo()) {
          notifications.push([partner, 'mail.channel/legacyInsert', channelInfo]);
        }
      }
    }
    return notifications;
  }

  /**
   * Generate the bus notifications for the given message
          :param message : the mail.message to sent
          :returns list of bus notifications (tuple (busChanne, messageContent))
   * @param message 
   * @param messageFormat 
   * @returns 
   */
  async _channelMessageNotifications(message, messageFormat?: any) {
    messageFormat = messageFormat || (await message.messageFormat())[0];
    const notifications = [];
    for (const channel of this) {
      const payload = {
        'id': channel.id,
        'message': new Dict(messageFormat),
      }
      notifications.push([channel, 'mail.channel/newMessage', payload]);
      // add uuid to allow anonymous to listen
      if (await channel.isPublic === 'public') {
        notifications.push([await channel.uuid, 'mail.channel/newMessage', payload]);
      }
    }
    return notifications;
  }

  // INSTANT MESSAGING API

  // ------------------------------------------------------------
  // A channel header should be broadcasted:
  //   - when adding user to channel (only to the new added partners)
  //   - when folding/minimizing a channel (only to the user making the action)
  // A message should be broadcasted:
  //   - when a message is posted on a channel (to the channel, using _notify() method)
  // ------------------------------------------------------------

  /**
   *  Get the informations header for the current channels
    :returns a list of channels values
    :rtype : list(dict)
   * @returns 
   */
  async channelInfo() {
    if (!this.ok) {
      return [];
    }
    const user = await this.env.user();
    const partnerId = await user.partnerId;
    const channelInfos = [];
    const rtcSessionsByChannel = await (await (await this.sudo()).rtcSessionIds)._mailRtcSessionFormatByChannel();
    const channelLastMessageIds = Dict.from((await this._channelLastMessageIds()).map(r => [r['id'], r['messageId']]));
    const allNeededMembersDomain = expression.OR([
      [['channelId.channelType', '!=', 'channel']],
      [['rtcInvitingSessionId', '!=', false]],
      bool(user) && bool(partnerId) ? [['partnerId', '=', partnerId.id]] : expression.FALSE_LEAF,
    ]);
    const allNeededMembers = await this.env.items('mail.channel.partner').search(expression.AND([[['channelId', 'in', this.ids]], allNeededMembersDomain]));
    const partnerFormatByPartner = await (await allNeededMembers.partnerId).mailPartnerFormat();
    const membersByChannel = new DefaultDict2(() => this.env.items('mail.channel.partner'));
    const invitedMembersByChannel = new DefaultDict2(() => this.env.items('mail.channel.partner'));
    const memberOfCurrentUserByChannel = new DefaultDict2(() => this.env.items('mail.channel.partner'));
    for (const member of allNeededMembers) {
      const channelId = await member.channelId;
      membersByChannel[channelId] = membersByChannel[channelId].or(member);
      if (bool(await member.rtcInvitingSessionId)) {
        invitedMembersByChannel[channelId] = invitedMembersByChannel[channelId].or(member);
      }
      if (bool(user) && bool(partnerId) && (await member.partnerId).eq(partnerId)) {
        memberOfCurrentUserByChannel[channelId] = member;
      }
    }
    for (const channel of this) {
      const info = {
        'avatarCacheKey': await channel._getAvatarCacheKey(),
        'id': channel.id,
        'label': await channel.label,
        'defaultDisplayMode': await channel.defaultDisplayMode,
        'description': await channel.description,
        'uuid': await channel.uuid,
        'state': 'open',
        'isMinimized': false,
        'channelType': await channel.channelType,
        'isPublic': await channel.isPublic,
        'groupBasedSubscription': bool(await channel.groupIds),
        'createdUid': (await channel.createdUid).id,
      }
      // add last message preview (only used in mobile)
      info['lastMessageId'] = channelLastMessageIds.get(channel.id, false);
      info['memberCount'] = await channel.memberCount;
      // find the channel partner state, if logged user
      if (bool(user) && bool(partnerId)) {
        info['messageNeedactionCounter'] = await channel.messageNeedactionCounter;
        info['messageUnreadCounter'] = await channel.messageUnreadCounter;
        let partnerChannel = memberOfCurrentUserByChannel.get(channel, this.env.items('mail.channel.partner'));
        if (bool(partnerChannel)) {
          partnerChannel = partnerChannel(0);
          info['state'] = await partnerChannel.foldState ?? 'open';
          info['isMinimized'] = await partnerChannel.isMinimized;
          info['seenMessageId'] = (await partnerChannel.seenMessageId).id;
          info['customChannelName'] = await partnerChannel.customChannelName;
          info['isPinned'] = await partnerChannel.isPinned;
          info['lastInterestDt'] = DateTime.fromJSDate(await partnerChannel.lastInterestDt).toFormat(DEFAULT_SERVER_DATETIME_FORMAT);
          const rtcInvitingSessionId = await partnerChannel.rtcInvitingSessionId;
          if (bool(rtcInvitingSessionId)) {
            info['rtcInvitingSession'] = { 'id': rtcInvitingSessionId.id };
          }
        }
      }
      // add members info
      if (await channel.channelType !== 'channel') {
        // avoid sending potentially a lot of members for big channels
        // exclude chat and other small channels from this optimization because they are
        // assumed to be smaller and it's important to know the member list for them
        let list = [];
        for (const member of membersByChannel[channel]) {
          const partnerId = await member.partnerId;
          if (bool(partnerId)) {
            list.push(await channel._channelInfoFormatMember(partnerId, partnerFormatByPartner.get(partnerId.id)));
          }
        }
        info['members'] = sorted(list, (p) => p['id']);

        list = [];
        for (const member of membersByChannel[channel]) {
          const partnerId = await member.partnerId;
          if (bool(partnerId)) {
            list.push({
              'id': member.id,
              'partnerId': partnerId.id,
              'fetchedMessageId': (await member.fetchedMessageId).id,
              'seenMessageId': (await member.seenMessageId).id,
            });
          }
        }
        info['seenPartnersInfo'] = sorted(list, (p) => p['partnerId']);

        list = [];
        for (const member of membersByChannel[channel]) {
          const guestId = await member.parguestIdnerId;
          if (bool(guestId)) {
            list.push({
              'id': guestId.id,
              'label': await guestId.label,
            });
          }
        }
        info['guestMembers'] = sorted(list, (p) => p['id']);
      }
      // add RTC sessions info
      const invitedGuests = [];
      for (const member of invitedMembersByChannel[channel]) {
        const guestId = await member.guestId;
        if (bool(guestId)) {
          invitedGuests.push({ 'id': guestId.id, 'label': await guestId.label })
        }
      }
      const invitedPartners = [];
      for (const member of invitedMembersByChannel[channel]) {
        const partnerId = await member.partnerId;
        if (bool(partnerId)) {
          invitedPartners.push({ 'id': partnerId.id, 'label': await partnerId.label })
        }
      }
      Object.assign(info, {
        'invitedGuests': [['insert', invitedGuests]],
        'invitedPartners': [['insert', invitedPartners]],
        'rtcSessions': [['insert', rtcSessionsByChannel.get(channel) ?? []]],
      });

      channelInfos.push(info);
    }
    return channelInfos;
  }

  /**
   * Return message values of the current channel.
      :param lastId : last message id to start the research
      :param limit : maximum number of messages to fetch
      :returns list of messages values
      :rtype : list(dict)
   * @param lastId 
   * @param limit 
   * @returns 
   */
  async _channelFetchMessage(lastId?: number, limit: number = 20) {
    this.ensureOne();
    const domain: any[] = ["&", ["model", "=", "mail.channel"], ["resId", "in", this.ids]];
    if (lastId) {
      domain.push(["id", "<", lastId]);
    }
    return this.env.items('mail.message')._messageFetch(domain, null, null, limit);
  }

  // User methods
  /**
   * Get the canonical private channel between some partners, create it if needed.
      To reuse an old channel (conversation), this one must be private, and contains
      only the given partners.
      :param partners_to : list of res.partner ids to add to the conversation
      :param pin : true if getting the channel should pin it for the current user
      :returns: channel_info of the created or existing channel
      :rtype: dict
   * @param partnersTo 
   * @param pin 
   * @returns 
   */
  @api.model()
  async channelGet(partnersTo: number[], pin = true) {
    const partnerId = await (await this.env.user()).partnerId;
    if (!partnersTo.includes(partnerId.id)) {
      partnersTo.push(partnerId.id);
    }
    if (partnersTo.length > 2) {
      throw new UserError(await this._t("A chat should not be created with more than 2 persons. Create a group instead."));
    }
    // determine type according to the number of partner in the channel
    this.flush();
    const result = await this.env.cr.execute(`
              SELECT P."channelId"
              FROM "mailChannel" C, "mailChannelPartner" P
              WHERE P."channelId" = C.id
                  AND C."isPublic" LIKE 'private'
                  AND P."partnerId" IN ($1)
                  AND C."channelType" LIKE 'chat'
                  AND NOT EXISTS (
                      SELECT *
                      FROM "mailChannelPartner" P2
                      WHERE P2."channelId" = C.id
                          AND P2."partnerId" NOT IN ($2)
                  )
              GROUP BY P."channelId"
              HAVING ARRAY_AGG(DISTINCT P."partnerId" ORDER BY P.partnerId) = ($3)
              LIMIT 1
          `, { bind: [partnersTo, partnersTo, partnersTo.sort()] });

    let channel;
    if (result.length) {
      // get the existing channel between the given partners
      channel = this.browse(result[0]['channelId']);
      // pin up the channel for the current partner
      if (pin) {
        await (await this.env.items('mail.channel.partner').search([['partnerId', '=', partnerId.id], ['channelId', '=', channel.id]])).write({
          'isPinned': true,
          'lastInterestDt': _Datetime.now(),
        })
      }
      await channel._broadcast(partnerId.ids);
    }
    else {
      // create a new one
      channel = await this.create({
        'channelPartnerIds': partnersTo.map(partnerId => Command.link(partnerId)),
        'isPublic': 'private',
        'channelType': 'chat',
        'label': (await (await this.env.items('res.partner').sudo()).browse(partnersTo).mapped('label')).join(', ')
      });
      await channel._broadcast(partnersTo);
    }
    return (await channel.channelInfo())[0];
  }

  @api.model()
  async channelGetAndMinimize(partnersTo: number[]) {
    const channel = await this.channelGet(partnersTo);
    if (bool(channel)) {
      await this.channelMinimize(channel['uuid']);
    }
    return channel;
  }

  /**
   * Update the fold_state of the given session. In order to syncronize web browser
      tabs, the change will be broadcast to himself (the current user channel).
      Note: the user need to be logged
      :param state : the new status of the session for the current user.
   * @param uuid 
   * @param state 
   */
  @api.model()
  async channelFold(uuid, state?: string) {
    const partnerId = await (await this.env.user()).partnerId;
    const domain = [['partnerId', '=', partnerId.id], ['channelId.uuid', '=', uuid]];
    for (const sessionState of await this.env.items('mail.channel.partner').search(domain)) {
      if (!state) {
        state = await sessionState.foldState;
        if (state === 'open') {
          state = 'folded';
        }
        else {
          state = 'open';
        }
      }
      const isMinimized = state !== 'closed';
      const vals = {};
      if (await sessionState.foldState !== state) {
        vals['fold_state'] = state;
      }
      if (await sessionState.isMinimized != isMinimized) {
        vals['isMinimized'] = isMinimized;
      }
      if (bool(vals)) {
        await sessionState.write(vals);
      }
      await this.env.items('bus.bus')._sendone([this._cr.dbName, 'res.partner', partnerId.id], (await (await sessionState.channelId).channelInfo())[0]);
    }
  }

  @api.model()
  async channelMinimize(uuid, minimized = true) {
    const partnerId = await (await this.env.user()).partnerId;
    const values = {
      'foldState': minimized && 'open' || 'closed',
      'isMinimized': minimized
    }
    const domain = [['partnerId', '=', partnerId.id], ['channelId.uuid', '=', uuid]];
    const channelPartners = this.env.items('mail.channel.partner').search(domain, { limit: 1 });
    await channelPartners.write(values);
    await this.env.items('bus.bus')._sendone([this._cr.dbName, 'res.partner', partnerId.id], (await (await channelPartners.channelId).channelInfo())[0]);
  }

  @api.model()
  async channelPin(uuid, pinned = false) {
    // add the person in the channel, and pin it (or unpin it)
    const channel = await this.search([['uuid', '=', uuid]]);
    await channel._executeChannelPin(pinned);
  }

  /**
   * Hook for website_livechat channel unpin and cleaning
   * @param pinned 
   */
  async _executeChannelPin(pinned = false) {
    this.ensureOne();
    const partnerId = await (await this.env.user()).partnerId;
    const channelPartners = await this.env.items('mail.channel.partner').search(
      [['partnerId', '=', partnerId.id], ['channelId', '=', this.id], ['isPinned', '!=', pinned]]);
    if (channelPartners.ok) {
      await channelPartners.write({ 'isPinned': pinned });
    }
    if (!pinned) {
      await this.env.items('bus.bus')._sendone(partnerId, 'mail.channel/unpin', { 'id': this.id });
    }
    else {
      await this.env.items('bus.bus')._sendone(partnerId, 'mail.channel/legacyInsert', (await this.channelInfo())[0]);
    }
  }

  /**
   * Mark channel as seen by updating seen message id of the current logged partner
      :param last_message_id: the id of the message to be marked as seen, last message of the
      thread by default. This param SHOULD be required, the default behaviour is DEPRECATED and
      kept only for compatibility reasons.
   * @param lastMessageId 
   * @returns 
   */
  async _channelSeen(lastMessageId?: any) {
    this.ensureOne();
    let domain = ["&", ["model", "=", "mail.channel"], ["resId", "in", this.ids]];
    if (lastMessageId) {
      domain = expression.AND([domain, [['id', '<=', lastMessageId]]]);
    }
    const lastMessage = await this.env.items('mail.message').search(domain, { order: "id DESC", limit: 1 });
    if (!lastMessage.ok) {
      return;
    }
    await this._setLastSeenMessage(lastMessage);
    const partnerId = await (await this.env.user()).partnerId;
    const data = {
      'info': 'channelSeen',
      'lastMessageId': lastMessage.id,
      'partnerId': partnerId.id,
    }
    if (await this['channelType'] === 'chat') {
      await this.env.items('bus.bus')._sendmany([[[this._cr.dbName, 'mail.channel', this.id], data]]);
    }
    else {
      data['channelId'] = this.id;
      await this.env.items('bus.bus')._sendone([this._cr.dbName, 'res.partner', partnerId.id], data);
    }
    return lastMessage.id;
  }

  /**
   * Set last seen message of `self` channels for the current user.
      :param last_message: the message to set as last seen message
   * @param lastMessage 
   */
  async _setLastSeenMessage(lastMessage) {
    let channelPartnerDomain = expression.AND([
      [['channelId', 'in', this.ids]],
      [['partnerId', '=', (await (await this.env.user()).partnerId).id]],
      expression.OR([
        [['seenMessageId', '=', false]],
        [['seenMessageId', '<', lastMessage.id]]
      ])
    ])
    channelPartnerDomain = expression.AND([channelPartnerDomain, [['partnerId', '=', (await (await this.env.user()).partnerId).id]]]);
    const channelPartner = await this.env.items('mail.channel.partner').search(channelPartnerDomain);
    await channelPartner.write({
      'fetchedMessageId': lastMessage.id,
      'seenMessageId': lastMessage.id,
    });
  }

  /**
   * Broadcast the channel_fetched notification to channel members
   * @returns 
   */
  async channelFetched() {
    const partnerId = await (await this.env.user()).partnerId;
    for (const channel of this) {
      if (!(await channel.messageIds).ids.length) {
        return;
      }
      if (await channel.channelType !== 'chat') {
        return;
      }

      const lastMessageId = (await channel.messageIds).ids[0] // zero is the index of the last message
      const channelPartner = await this.env.items('mail.channel.partner').search([['channelId', '=', channel.id], ['partnerId', '=', partnerId.id]], { limit: 1 });
      if ((await channelPartner.fetchedMessageId).id == lastMessageId) {
        // last message fetched by user is already up-to-date
        return;
      }
      await channelPartner.write({
        'fetchedMessageId': lastMessageId,
      });
      const data = {
        'id': channelPartner.id,
        'info': 'channelFetched',
        'lastMessageId': lastMessageId,
        'partnerId': partnerId.id,
      }
      await this.env.items('bus.bus')._sendmany([[[this._cr.dbName, 'mail.channel', channel.id], data]]);
    }
  }

  async channelSetCustomName(name) {
    this.ensureOne();
    const partnerId = await (await this.env.user()).partnerId;
    const channelPartner = await this.env.items('mail.channel.partner').search([['partnerId', '=', partnerId.id], ['channelId', '=', this.id]]);
    await channelPartner.write({ 'customChannelName': name });
    await this._broadcast(partnerId.ids);
  }

  async channelRename(name) {
    this.ensureOne();
    await this.write({ 'label': name });
    await this.env.items('bus.bus')._sendone([this._cr.dbName, 'mail.channel', this.id], {
      'type': 'mail.channelRename',
      'payload': {
        'id': this.id,
        'label': name
      },
    });
  }

  async channelChangeDescription(description) {
    this.ensureOne();
    await this.write({ 'description': description });
    await this.env.items('bus.bus')._sendone([this._cr.dbName, 'mail.channel', this.id], {
      'type': 'mail.channelDescriptionChange',
      'payload': {
        'id': this.id,
        'description': description
      },
    });
  }

  /**
   * Broadcast the typing notification to channel members
      :param is_typing: (boolean) tells whether the current user is typing or not
   * @param isTyping 
   */
  async notifyTyping(isTyping) {
    const notifications = [];
    const partnerId = await (await this.env.user()).partnerId;
    for (const channel of this) {
      const data = {
        'info': 'typingStatus',
        'isTyping': isTyping,
        'partnerId': partnerId.id,
        'partnerName': partnerId.label,
      }
      notifications.push([[this._cr.dbName, 'mail.channel', channel.id], data]); // notify backend users
      notifications.push([channel.uuid, data]); // notify frontend users
    }
    await this.env.items('bus.bus')._sendmany(notifications);
  }

  /**
   * Return the channel info of the channel the current partner can join
      :param name : the name of the researched channels
      :param domain : the base domain of the research
      :returns dict : channel dict
   * @param name 
   * @param domain 
   * @returns 
   */
  @api.model()
  async channelSearchToJoin(name?: string, domain?: any[]) {
    if (!domain) {
      domain = [];
    }
    domain = expression.AND([
      [['channelType', '=', 'channel']],
      [['channelPartnerIds', 'not in', [(await (await this.env.user()).partnerId).id]]],
      [['isPublic', '!=', 'private']],
      domain
    ])
    if (name) {
      domain = expression.AND([domain, [['label', 'ilike', '%' + name + '%']]]);
    }
    return (await this.search(domain)).read(['label', 'isPublic', 'uuid', 'channelType']);
  }

  /**
   * Shortcut to add the current user as member of self channels.
      Prefer calling add_members() directly when possible.
   */
  async channelJoin() {
    await this.addMembers((await (await this.env.user()).partnerId).ids);
  }

  /**
   * Create a channel and add the current partner, broadcast it (to make the user directly listen to it when polling)
      :param name : the name of the channel to create
      :param privacy : privacy of the channel. Should be 'public' or 'private'.
      :return dict : channel header
   * @param name 
   * @param privacy 
   * @returns 
   */
  @api.model()
  async channelCreate(name, privacy = 'public') {
    // create the channel
    const newChannel = await this.create({
      'label': name,
      'isPublic': privacy,
    })
    const notification = await this._t('<div class="o-mail-notification">created <a href="#" class="o_channel_redirect" data-oe-id="%s">#%s</a></div>', newChannel.id, await newChannel.label);
    await newChannel.messagePost({ body: notification, messageType: "notification", subtypeXmlid: "mail.mtComment" });
    const channelInfo = (await newChannel.channelInfo('creation'))[0];
    await this.env.items('bus.bus')._sendone([this._cr.dbName, 'res.partner', (await (await this.env.user()).partnerId).id], channelInfo);
    return channelInfo;
  }

  /**
   * Create a group channel.
          :param partners_to : list of res.partner ids to add to the conversation
          :returns: channel_info of the created channel
          :rtype: dict
   * @param partnersTo 
   * @param defaultDisplayMode 
   * @returns 
   */
  @api.model()
  async createGroup({ partnersTo = null, defaultDisplayMode = false } = {}) {
    const channel = await this.create({
      'channelLastSeenPartnerIds': partnersTo.map(partnerId => Command.create({ 'partnerId': partnerId })),
      'channelType': 'group',
      'defaultDisplayMode': defaultDisplayMode,
      'label': '',  // default name is computed client side from the list of members
      'isPublic': 'private',
    })
    await channel._broadcast(partnersTo);
    return (await channel.channelInfo())[0];
  }

  /**
   * Return 'limit'-first channels' id, name and public fields such that the name matches a 'search' string. Exclude channels of type chat (DM), and private channels the current user isn't registered to.
   * @param search 
   * @param limit 
   * @returns 
   */
  @api.model()
  async getMentionSuggestions(search, limit: number = 8) {
    const domain = expression.AND([
      [['label', 'ilike', search]],
      [['channelType', '=', 'channel']],
      expression.OR([
        [['isPublic', '!=', 'private']],
        [['channelPartnerIds', 'in', [(await (await this.env.user()).partnerId).id]]]
      ])
    ]);
    return this.searchRead(domain, ['id', 'label', 'isPublic', 'channelType'], { limit: limit });
  }

  /**
   * Return the id, name and email of partners listening to the given channel
   * @param uuid 
   * @returns 
   */
  @api.model()
  async channelFetchListeners(uuid) {
    const res = await this._cr.execute(`
          SELECT P.id, P.label, P.email
          FROM "mailChannelPartner" CP
              INNER JOIN "resPartner" P ON CP."partnerId" = P.id
              INNER JOIN "mailChannel" C ON CP."channelId" = C.id
          WHERE C.uuid = '%s'`, [uuid]);
    return res;
  }

  /**
   * Return the last message of the given channels
   * @returns 
   */
  async channelFetchPreview() {
    if (!this.ok) {
      return [];
    }
    const channelsLastMessageIds = await this._channelLastMessageIds();
    const channelsPreview = Object.fromEntries(channelsLastMessageIds.map(r => [r['messageId'], r]));
    const lastMessages = await this.env.items('mail.message').browse(channelsPreview).messageFormat();
    for (const message of lastMessages) {
      const channel = channelsPreview[message['id']];
      delete channel['messageId'];
      channel['lastMessage'] = message;
    }
    return Object.values(channelsPreview)
  }

  /**
   * Return the last message of the given channels.
   * @returns 
   */
  async _channelLastMessageIds() {
    if (!this.ok) {
      return [];
    }
    await this.flush();
    const res = await this.env.cr.execute(`
      SELECT "resId" AS id, MAX(id) AS "messageId"
      FROM "mailMessage"
      WHERE model = 'mail.channel' AND "resId" IN (%s)
      GROUP BY "resId"
      `, [String(this.ids) || 'NULL']);
    return res;
  }

  async loadMoreMembers(knownMemberIds) {
    this.ensureOne();
    const partners = await (await this.env.items('res.partner').withContext({ activeTest: false })).searchRead([['id', 'not in', knownMemberIds], ['channelIds', 'in', this.id]],
      ['id', 'label', 'imStatus'], { limit: 30 });
    return [['insert', partners]];
  }

  async _getAvatarCacheKey() {
    const avatar128 = await this['avatar128'];
    if (!avatar128) {
      return 'no-avatar';
    }
    return sha512(avatar128);
  }

  // ------------------------------------------------------------
  // COMMANDS
  // ------------------------------------------------------------

  /**
   * Notifies partnerTo that a message (not stored in DB) has been
          written in this channel
   * @param partnerTo 
   * @param content 
   */
  async _sendTransientMessage(partnerTo, content) {
    await this.env.items('bus.bus')._sendone(
      [this._cr.dbName, 'res.partner', partnerTo.id],
      {
        'body': "<span class='o-mail-notification'>" + content + "</span>",
        'info': 'transientMessage',
        'model': this._name,
        'resId': this.id,
      }
    )
  }

  async executeCommandHelp(kw: {} = {}) {
    const partner = await (await this.env.user()).partnerId;
    let msg;
    if (await this['channelType'] === 'channel') {
      msg = await this._t("You are in channel <b>#%s</b>.", await this['label']);
      if (await this['isPublic'] === 'private') {
        msg += await this._t(" This channel is private. People must be invited to join it.");
      }
    }
    else {
      const allChannelPartners = await this.env.items('mail.channel.partner').withContext({ activeTest: false });
      const channelPartners = await allChannelPartners.search([['partnerId', '!=', partner.id], ['channelId', '=', this.id]]);
      msg = await this._t("You are in a private conversation with <b>@%s</b>.", channelPartners.ok ? await (await channelPartners[0].partnerId).label : await this._t('Anonymous'));
    }
    msg += await this._executeCommandHelpMessageExtra();

    this._sendTransientMessage(partner, msg);
  }

  async _executeCommandHelpMessageExtra() {
    return this._t(`<br><br>
            Type <b>@username</b> to mention someone, and grab his attention.<br>
            Type <b>#channel</b> to mention a channel.<br>
            Type <b>/command</b> to execute a command.<br>`);
  }

  async executeCommandLeave(kw: {} = {}) {
    if (['channel', 'group'].includes(await this['channelType'])) {
      this.actionUnfollow();
    }
    else {
      this.channelPin(await this['uuid'], false);
    }
  }

  async executeCommandWho(kw: {} = {}) {
    const partner = await (await this.env.user()).partnerId;
    const channelPartnerIds = await this['channelPartnerIds'];
    const members = [];
    for (const p of channelPartnerIds.slice(0, 30)) {
      if (!p.eq(partner)) {
        members.push('<a href="#" data-oe-id=' + String(p.id) + ' data-oe-model="res.partner">@' + await p.label + '</a>');
      }
    }
    let msg;
    if (members.length == 0) {
      msg = await this._t("You are alone in this channel.");
    }
    else {
      const dots = members.length != channelPartnerIds._length - 1 ? "..." : "";
      msg = _f(await this._t("Users in this channel: {members} {dots} and you."), { members: members.join(', '), dots: dots });
    }
    await this._sendTransientMessage(partner, msg);
  }
}