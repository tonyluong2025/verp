import { api, tools } from "../../../core";
import { Fields } from "../../../core/fields";
import { ValueError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { len } from "../../../core/tools/iterable";
import { emailNormalize } from "../../../core/tools/mail";
import { pop } from "../../../core/tools/misc";
import { f } from "../../../core/tools/utils";
import { AWAY_TIMER, DISCONNECTION_TIMER } from "../../bus/models/bus_presence";

/**
 * Update partner to add a field about notification preferences. Add a generic opt-out field that can be used
       to restrict usage of automatic email templates.
 */
@MetaModel.define()
class Partner extends Model {
  static _module = module;
  static _name = "res.partner";
  static _parents = ['res.partner', 'mail.activity.mixin', 'mail.thread.blacklist'];
  static _mailFlatThread = false;

  // override to add and order tracking
  static email = Fields.Char({tracking: 1});
  static phone = Fields.Char({tracking: 2});
  static parentId = Fields.Many2one({tracking: 3});
  static userId = Fields.Many2one({tracking: 4});
  static vat = Fields.Char({tracking: 5});
  // channels
  static channelIds = Fields.Many2many('mail.channel', {relation: 'mailChannelPartner', column1: 'partnerId', column2: 'channelId', string: 'Channels', copy: false});

  async _computeImStatus() {
    await _super(Partner, this)._computeImStatus();
    const verpbotId = await this.env.items('ir.model.data')._xmlidToResId('base.partnerRoot');
    const verpbot = this.env.items('res.partner').browse(verpbotId);
    if (this.includes(verpbot)) {
      verpbot.imStatus = 'bot';
    }
  }

  /**
   * compute the number of needaction of the current partner
   * @returns 
   */
  async _getNeedactionCount() {
    this.ensureOne();
    await this.env.items('mail.notification').flush(['isRead', 'resPartnerId']);
    const res = await this.env.cr.execute(`
      SELECT COUNT(*)::int as "needactionCount"
      FROM "mailNotification" R
      WHERE R."resPartnerId" = %s AND (R."isRead" = false OR R."isRead" IS NULL)`, [this.id]);
    return res[0]['needactionCount'];
  }

  /**
   * compute the number of starred of the current partner
   * @returns 
   */
  async _getStarredCount() {
    this.ensureOne();
    const res = await this.env.cr.execute(`
      SELECT COUNT(*)::int as "starredCount"
      FROM "mailMessageResPartnerStarredRel" R
      WHERE R."resPartnerId" = %s`, [this.id]);
    return res[0]['starredCount'];
  }

  // ------------------------------------------------------------
  // MESSAGING
  // ------------------------------------------------------------

  async _messageGetSuggestedRecipients() {
    const recipients = await _super(Partner, this)._messageGetSuggestedRecipients();
    for (const partner of this) {
      await partner._messageAddSuggestedRecipient(recipients, {partner: partner, reason: await this._t('Partner Profile')});
    }
    return recipients;
  }

  async _messageGetDefaultRecipients() {
    const res = {};
    for (const r of this) {
      res[r.id] = {
        'partnerIds': [r.id],
        'emailTo': false,
        'emailCc': false
      }
    }
    return res;
  }

  // ------------------------------------------------------------
  // ORM
  // ------------------------------------------------------------

  /**
   * Override to use the emailNormalized field.
   * @param email 
   * @param assertValidEmail 
   * @returns 
   */
  @api.model()
  @api.returns('self', (value) => value.id)
  async findOrCreate(email, assertValidEmail: boolean=false) {
    if (! email) {
      throw new ValueError(await this._t('An email is required for findOrCreate to work'));
    }
    const [parsedName, parsedEmail] = await (this as any)._parsePartnerName(email);
    if (! parsedEmail && assertValidEmail) {
      throw new ValueError(await this._t('%(email)s is not recognized as a valid email. This is required to create a new customer.'))
    }
    if (parsedEmail) {
      const emailNormalized = emailNormalize(parsedEmail);
      if (emailNormalized) {
        const partners = await this.search([['emailNormalized', '=', emailNormalized]], {limit: 1});
        if (partners.ok) {
          return partners;
        }
      }
    }

    // We don't want to call `super()` to avoid searching twice on the email  Especially when the search `email =ilike` cannot be as efficient as a search on email_normalized with a btree index. If you want to override `find_or_create()` your module should depend on `mail`
    const createValues = {[this.cls._recName]: parsedName ?? parsedEmail}
    if (parsedEmail) {  // otherwise keep default_email in context
      createValues['email'] = parsedEmail;
    }
    return this.create(createValues);
  }

  // ------------------------------------------------------------
  // DISCUSS
  // ------------------------------------------------------------

  async mailPartnerFormat(): Promise<Map<any, any>> {
    const self: any = this;
    const partnersFormat = new Map<any, any>();
    for (const partner of self) {
      const userIds = await partner.userIds;
      const internalUsers = userIds.sub(await userIds.filtered('share'));
      const mainUser = len(internalUsers) > 0 
        ? internalUsers(0) 
        : userIds._length > 0 ? userIds(0) : self.env.items('res.users');
      const [id, displayName, label, email, active, imStatus, partnerShare] = await partner(['id', 'displayName', 'label', 'email', 'active', 'imStatus', 'partnerShare']);
      partnersFormat.set(id, {
        "id": id,
        "displayName": displayName,
        "label": label,
        "email": email,
        "active": active,
        "imStatus": imStatus,
        "userId": mainUser.id,
        "isInternalUser": !partnerShare,
      });
      if (!await (await this.env.user())._isInternal()) {
        pop(partnersFormat.get(id), 'email');
      }
    }
    return partnersFormat;
  }

  /**
   * Returns first 100 messages, sent by the current partner, that have errors, in the format expected by the web client.
   * @returns 
   */
  async _messageFetchFailed() {
    this.ensureOne();
    const messages = await this.env.items('mail.message').search([
      ['hasError', '=', true],
      ['authorId', '=', this.id],
      ['resId', '!=', 0],
      ['model', '!=', false],
      ['messageType', '!=', 'userNotification']
    ], {limit: 100});
    return messages._messageNotificationFormat();
  }

  /**
   * Returns the channels of the partner.
   * @returns 
   */
  async _getChannelsAsMember() {
    this.ensureOne();
    let channels = this.env.items('mail.channel');
    // get the channels and groups
    channels = channels.or(await this.env.items('mail.channel').search([
      ['channelType', 'in', ['channel', 'group']],
      ['channelPartnerIds', 'in', [this.id]],
    ]));
    // get the pinned direct messages
    channels = channels.or(await this.env.items('mail.channel').search([
      ['channelType', '=', 'chat'],
      ['channelLastSeenPartnerIds', 'in', await (await this.env.items('mail.channel.partner').sudo())._search([
        ['partnerId', '=', this.id],
        ['isPinned', '=', true],
      ])],
    ]));
    return channels;
  }

  /**
   * Returns partners matching search_term that can be invited to a channel.
    If the channelId is specified, only partners that can actually be invited to the channel are returned (not already members, and in accordance to the channel configuration).
   * @param searchTerm 
   * @param channelId 
   * @param limit 
   * @returns 
   */
  @api.model()
  async searchForChannelInvite(searchTerm, channelId?: any, limit: any=30) {
    let domain = expression.AND([
      expression.OR([
        [['label', 'ilike', searchTerm]],
        [['email', 'ilike', searchTerm]],
      ]),
      [['active', '=', true]],
      [['type', '!=', 'private']],
      [['userIds', '!=', false]],
      [['userIds.active', '=', true]],
      [['userIds.share', '=', false]],
    ]);
    if (channelId) {
      const channel = await this.env.items('mail.channel').search([['id', '=', parseInt(channelId)]]);
      domain = expression.AND([domain, [['channelIds', 'not in', channel.id]]]);
      if (channel.isPublic === 'groups') {
        domain = expression.AND([domain, [['userIds.groupsId', 'in', (await channel.groupPublicId).id]]]);
      }
    }
    const query = await this.env.items('res.partner')._search(domain, {order: 'label, id', isQuery: true});
    query.order = 'LOWER("resPartner"."label"), "resPartner"."id"'  // bypass lack of support for case insensitive order in search()
    query.limit = tools.parseInt(limit);
    return {
      'count': await this.env.items('res.partner').searchCount(domain),
      'partners': Array.from((await this.env.items('res.partner').browse(await query.getIds()).mailPartnerFormat()).values()),
    }
  }

  /**
   * Return 'limit'-first partners' such that the name or email matches a 'search' string.
      Prioritize partners that are also (internal) users, and then extend the research to all partners.
      If channelId is given, only members of this channel are returned.
      The return format is a list of partner data (as per returned by `mail_partner_format()`).
   * @param search 
   * @param limit 
   * @param channelId 
   * @returns 
   */
  @api.model()
  async getMentionSuggestions(search, limit: number=8, channelId?: any) {
    let searchDom = expression.OR([[['label', 'ilike', search]], [['email', 'ilike', search]]]);
    searchDom = expression.AND([[['active', '=', true], ['type', '!=', 'private']], searchDom]);
    if (channelId) {
      searchDom = expression.AND([[['channelIds', 'in', channelId]], searchDom]);
    }
    const domainIsUser = expression.AND([[['userIds.id', '!=', false], ['userIds.active', '=', true]], searchDom]);
    const priorityConditions = [
      expression.AND([domainIsUser, [['partnerShare', '=', false]]]),  // Search partners that are internal users
      domainIsUser,  // Search partners that are users
      searchDom,  // Search partners that are not users
    ]
    let partners = this.env.items('res.partner');
    for (const domain of priorityConditions) {
      const remainingLimit = limit - len(partners);
      if (remainingLimit <= 0) {
        break;
      }
      partners = partners.or(await this.search(expression.AND([[['id', 'not in', partners.ids]], domain]), {limit: remainingLimit}));
    }
    return Array.from((await partners.mailPartnerFormat()).values());
  }

  /**
   * Search partner with a name and return its id, name and imStatus.
      Note : the user must be logged
      :param name : the partner name to search
      :param limit : the limit of result to return
   * @param name 
   * @param limit 
   * @returns 
   */
  @api.model()
  async imSearch(name, limit: number=20) {
    // This method is supposed to be used only in the context of channel creation or extension via an invite. As both of these actions require the 'create' access right, we check this specific ACL.
    if (await this.env.items('mail.channel').checkAccessRights('create', false)) {
      name = '%' + name + '%'
      const excludedPartnerIds = [(await (await this.env.user()).partnerId).id];
      const res = await this.env.cr.execute(`
        SELECT
            U.id as "userId",
            P.id as id,
            P.label as label,
            P.email as email,
            CASE WHEN B."lastPoll" IS NULL THEN 'offline'
                WHEN age(now() AT TIME ZONE 'UTC', B."lastPoll") > interval '%s' THEN 'offline'
                WHEN age(now() AT TIME ZONE 'UTC', B."lastPresence") > interval '%s' THEN 'away'
                ELSE 'online'
            END as "imStatus"
        FROM "resUsers" U
            JOIN "resPartner" P ON P.id = U."partnerId"
            LEFT JOIN "busPresence" B ON B."userId" = U.id
        WHERE P.label ILIKE '%s'
            AND P.id NOT IN (%s)
            AND U.active = 't'
            AND U.share IS NOT TRUE
        ORDER BY P.label ASC, P.id ASC
        LIMIT %s
      `, [f("%s seconds", DISCONNECTION_TIMER), f("%s seconds", AWAY_TIMER), name, excludedPartnerIds.join(','), limit])
      return res;
    }
    else {
      return {}
    }
  }

  _validFieldParameter(field, name) {
    // allow specifying rendering options directly from field when using the render mixin
    return (name === 'tracking' && this.cls._abstract 
      || _super(Partner, this)._validFieldParameter(field, name)
    );
  }
}