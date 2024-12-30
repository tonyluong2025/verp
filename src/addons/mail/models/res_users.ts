import _ from "lodash"
import { Fields, _Date, api } from "../../../core"
import { isSelectionGroups } from "../../../core/addons/base"
import { DefaultDict2 } from "../../../core/helper"
import { RedirectWarning } from "../../../core/helper/errors"
import { MetaModel, Model, _super } from "../../../core/models"
import { getModuleIcon } from "../../../core/modules/modules"
import { bool } from "../../../core/tools/bool"
import { extend, len } from "../../../core/tools/iterable"
import { _f, f } from "../../../core/tools/utils"

/**
 * Update of res.users class
    - add a preference about sending emails about notifications
    - make a new user follow itself
    - add a welcome message
    - add suggestion preference
    - if adding groups to a user, check mail.channels linked to this user
        group, and the user. This is done by overriding the write method.
 */
@MetaModel.define()
class Users extends Model {
  static _module = module;
  static _name = 'res.users'
  static _parents = ['res.users']
  static _description = 'Users'

  static notificationType = Fields.Selection([
    ['email', 'Handle by Emails'],
    ['inbox', 'Handle in Verp']],
    {
      string: 'Notification', required: true, default: 'email',
      help: `Policy on how to handle Chatter notifications:\n
            - Handle by Emails: notifications are sent to your email address\n
            - Handle in Verp: notifications appear in your Verp Inbox`});
  static resUsersSettingsIds = Fields.One2many('res.users.settings', 'userId');

  // ------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------

  SELF_READABLE_FIELDS() {
    return _super(Users, this).SELF_READABLE_FIELDS().concat(['notificationType']);
  }

  SELF_WRITEABLE_FIELDS() {
    return _super(Users, this).SELF_WRITEABLE_FIELDS().concat(['notificationType']);
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const self: any = this;
    for (const values of valsList) {
      if (!(values['login'] || false)) {
        const action = await self.env.ref('base.actionResUsers');
        const msg = await this._t("You cannot create a new user from here.\n To create new user please go to configuration panel.");
        throw new RedirectWarning(msg, (await action.actionId).id, await this._t('Go to the configuration panel'));
      }
    }
    const users = await _super(Users, self).create(valsList);

    // log a portal status change (manual tracking)
    const logPortalAccess = !self._context['mailCreateNolog'] && !self._context['mailNotrack'];
    if (logPortalAccess) {
      for (const user of users) {
        if (await user.hasGroup('base.groupPortal')) {
          const body = await user._getPortalAccessUpdateBody(true);
          await (await user.partnerId).messagePost({
            body: body,
            messageType: 'notification',
            subtypeXmlid: 'mail.mtNote'
          });
        }
      }
    }
    // Auto-subscribe to channels unless skip explicitly requested
    if (!self.env.context['mailChannelNosubscribe']) {
      await (await self.env.items('mail.channel').search([['groupIds', 'in', (await users.groupsId).ids]]))._subscribeUsersAutomatically();
    }
    return users;
  }

  async write(vals) {
    const self: any = this;
    const logPortalAccess = 'groupsId' in vals && !self._context['mailCreateNolog'] && !self._context['mailNotrack']
    const userPortalAccessDict = {};
    if (logPortalAccess) {
      for (const user of self) {
        userPortalAccessDict[user.id] = await user.hasGroup('base.groupPortal');
      }
    }
    const writeRes = await _super(Users, self).write(vals);

    // log a portal status change (manual tracking)
    if (logPortalAccess) {
      for (const user of self) {
        const userHasGroup = await user.hasGroup('base.groupPortal');
        const portalAccessChanged = userHasGroup != userPortalAccessDict[user.id];
        if (portalAccessChanged) {
          const body = await user._getPortalAccessUpdateBody(userHasGroup);
          await (await user.partnerId).messagePost({
            body: body,
            messageType: 'notification',
            subtypeXmlid: 'mail.mtNote'
          });
        }
      }
    }
    if ('active' in vals && !vals['active']) {
      await self._unsubscribeFromNonPublicChannels();
    }
    const selGroups = Object.keys(vals).filter(k => isSelectionGroups(k) && vals[k]).map(k => vals[k]);
    if (bool(vals['groupsId'])) {
      // form: {'groupIds': [[3, 10], [3, 3], [4, 10], [4, 3]]} or {'groupIds': [6, 0, [ids]]}
      let userGroupIds = vals['groupsId'].filter(command => command[0] == 4).map(command => command[1]);
      extend(userGroupIds, vals['groupsId'].filter(command => command[0] == 6).map(command => command[2]).flat());
      await (await self.env.items('mail.channel').search([['groupIds', 'in', userGroupIds]]))._subscribeUsersAutomatically();
    }
    else if (bool(selGroups)) {
      await (await self.env.items('mail.channel').search([['groupIds', 'in', selGroups]]))._subscribeUsersAutomatically();
    }
    return writeRes;
  }

  async unlink() {
    await this._unsubscribeFromNonPublicChannels();
    return _super(Users, this).unlink();
  }

  /**
   * This method un-subscribes users from private mail channels. Main purpose of this
          method is to prevent sending internal communication to archived / deleted users.
          We do not un-subscribes users from public channels because in most common cases,
          public channels are mailing list (e-mail based) and so users should always receive
          updates from public channels until they manually un-subscribe themselves.
   */
  async _unsubscribeFromNonPublicChannels() {
    const currentCp = await (await (this as any).env.items('mail.channel.partner').sudo()).search([
      ['partnerId', 'in', (await (this as any).partnerId).ids],
    ])
    await (await currentCp.filtered(
      async (cp) => (await cp.channelId).isPublic !== 'public' && (await cp.channelId).channelType === 'channel'
    )).unlink();
  }

  async _getPortalAccessUpdateBody(accessGranted) {
    const body = accessGranted ? await this._t('Portal Access Granted') : await this._t('Portal Access Revoked');
    const partnerId = await (this as any).partnerId;
    if (await partnerId.email) {
      return f('%s (%s)', body, await partnerId.email);
    }
    return body;
  }

  // ------------------------------------------------------------
  // DISCUSS
  // ------------------------------------------------------------

  async _initMessaging() {
    const self: any = this;
    self.ensureOne();
    const partnerRoot = await self.env.ref('base.partnerRoot');
    const partnerId = await self.partnerId;
    const values = {
      'channels': await (await partnerId._getChannelsAsMember()).channelInfo(),
      'companyName': await (await self.env.company()).label,
      'currentGuest': false,
      'currentPartner': (await partnerId.mailPartnerFormat()).get(partnerId.id),
      'currentUserId': self.id,
      'currentUserSettings': await (await self.env.items('res.users.settings')._findOrCreateForUser(self))._resUsersSettingsFormat(),
      'mailFailures': [],
      'menuId': await self.env.items('ir.model.data')._xmlidToResId('mail.menuRootDiscuss'),
      'needactionInboxCounter': await partnerId._getNeedactionCount(),
      'partnerRoot': (await (await partnerRoot.sudo()).mailPartnerFormat()).get(partnerRoot.id),
      'publicPartners': Array.from((await (await (await (await (await (await self.env.ref('base.groupPublic')).sudo()).withContext({ activeTest: false })).users).partnerId).mailPartnerFormat()).values()),
      'shortcodes': await (await self.env.items('mail.shortcode').sudo()).searchRead([],  ['source', 'substitution', 'description']),
      'starredCounter': await self.env.items('mail.message').searchCount([['starredPartnerIds', 'in', partnerId.ids]]),
    }
    return values;
  }

  @api.model()
  async systrayGetActivities() {
    const self: any = this;
    const query = `
      SELECT array_agg("resId") as "resIds", m.id, COUNT(*)::int,
        CASE
          WHEN {today}::date - act."dateDeadline"::date = 0 Then 'today'
          WHEN {today}::date - act."dateDeadline"::date > 0 Then 'overdue'
          WHEN {today}::date - act."dateDeadline"::date < 0 Then 'planned'
        END AS states
      FROM "mailActivity" AS act
      JOIN "irModel" AS m ON act."resModelId" = m.id
      WHERE "userId" = {userId}
      GROUP BY m.id, states, act."resModel";
    `;

    const activityData = await self.env.cr.execute(_f(query, {
      'today': `'${_Date.toString(await _Date.contextToday(self))}'`,
      'userId': self.env.uid,
    }))
    const recordsByStateByModel = new DefaultDict2(() => { return { "today": [], "overdue": [], "planned": [], "all": [] } });
    for (const data of activityData) {
      recordsByStateByModel[data["id"]][data["states"]] = Array.from(data["resIds"]);
      recordsByStateByModel[data["id"]]["all"] = _.union(recordsByStateByModel[data["id"]]["all"], data["resIds"]);
    }
    const userActivities = {};
    for (const [modelId, modelDic] of recordsByStateByModel) {
      const model = await (await this.env.items("ir.model").sudo()).browse(modelId).withPrefetch(recordsByStateByModel.keys());
      const modelName = await model.model;
      const allowedRecords = await this.env.items(modelName).search([["id", "in", Array.from(modelDic["all"])]]);
      if (!bool(allowedRecords)) {
        continue;
      }
      const modul = this.env.models[modelName]._originalModule;
      const icon = modul && getModuleIcon(modul);
      const today = _.intersection(modelDic["today"], allowedRecords.ids).length;
      const overdue = _.intersection(modelDic["overdue"], allowedRecords.ids).length;
      userActivities[modelName] = {
        "label": await model.label,
        "model": modelName,
        "type": "activity",
        "icon": icon,
        "totalCount": today + overdue,
        "todayCount": today,
        "overdueCount": overdue,
        "plannedCount": len(_.intersection(modelDic["planned"], allowedRecords.ids)),
        "actions": [
          {
            "icon": "fa-clock-o",
            "label": "Summary",
          }
        ],
      }
    }
    return Object.values(userActivities);
  }
}