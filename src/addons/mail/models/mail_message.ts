import _ from "lodash";
import { Command, Fields, _Datetime, api } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { DefaultDict2, Dict } from "../../../core/helper/collections";
import { AccessError, ValueError } from "../../../core/helper/errors";
import { MetaModel, Model, _super, isSubclass } from "../../../core/models";
import { getModuleIcon } from "../../../core/modules/modules";
import { expression } from "../../../core/osv";
import { bool, extend, isInstance, len, replaceAsync } from "../../../core/tools";
import { generateTrackingMessageId, html2Text, isHtmlEmpty } from "../../../core/tools/mail";
import { cleanContext, pop, update } from "../../../core/tools/misc";
import { _f, f, ustr } from "../../../core/tools/utils";

const _imageDataUrlReg = /(data:image\/[a-z]+?);base64,(?<body>[a-z0-9+\/\n]{3,}=*)\n*(?:data-filename="([^"]*)")?/gi;

/**
 * Message model: notification (system, replacing res.log notifications),
    comment (user input), email (incoming emails) and userNotification
    (user-specific notification)

    Note:: State management / Error codes / Failure types summary

    * mail.notification
      * notification_status
        'ready', 'sent', 'bounce', 'exception', 'canceled'
      * notificationType
        'inbox', 'email', 'sms' (SMS addon), 'snail' (snailmail addon)
      * failureType
        # generic
        unknown,
        # mail
        "mail_email_invalid", "mail_smtp", "mail_email_missing"
        # sms (SMS addon)
        'sms_number_missing', 'sms_number_format', 'sms_credit',
        'sms_server', 'sms_acc'
        # snailmail (snailmail addon)
        'sn_credit', 'sn_trial', 'sn_price', 'sn_fields',
        'sn_format', 'sn_error'

    * mail.mail
      * state
        'outgoing', 'sent', 'received', 'exception', 'cancel'
      * failure_reason: text

    * sms.sms (SMS addon)
      * state
        'outgoing', 'sent', 'error', 'canceled'
      * error_code
        'sms_number_missing', 'sms_number_format', 'sms_credit',
        'sms_server', 'sms_acc',
        # mass mode specific codes
        'sms_blacklist', 'sms_duplicate'

    * snailmail.letter (snailmail addon)
      * state
        'pending', 'sent', 'error', 'canceled'
      * error_code
        'CREDIT_ERROR', 'TRIAL_ERROR', 'NO_PRICE_AVAILABLE', 'FORMAT_ERROR',
        'UNKNOWN_ERROR',

    See ``mailing.trace`` model in mass_mailing application for mailing trace
    information.
 */
@MetaModel.define()
class Message extends Model {
  static _module = module;
  static _name = 'mail.message';
  static _description = 'Message';
  static _order = 'id desc';
  static _recName = 'recordName';

  @api.model()
  async defaultGet(fields) {
    const res = await _super(Message, this).defaultGet(fields);
    const missingAuthor = 'authorId' in fields && !('authorId' in res);
    const missingEmailFrom = 'emailFrom' in fields && !('emailFrom' in res)
    if (missingAuthor || missingEmailFrom) {
      const [authorId, emailFrom] = await this.env.items('mail.thread')._messageComputeAuthor(res.get('authorId'), res.get('emailFrom'), false);
      if (missingEmailFrom) {
        res['emailFrom'] = emailFrom;
      }
      if (missingAuthor) {
        res['authorId'] = authorId;
      }
    }
    return res;
  }

  // content
  static subject = Fields.Char('Subject')
  static date = Fields.Datetime('Date', { default: () => _Datetime.now() })
  static body = Fields.Html('Contents', { default: '', sanitizeStyle: true })
  static description = Fields.Char(
    'Short description', {
    compute: "_computeDescription",
    help: 'Message description: either the subject, or the beginning of the body'
  })
  static attachmentIds = Fields.Many2many(
    'ir.attachment', {
    relation: 'messageAttachmentRel',
    column1: 'messageId', column2: 'attachmentId',
    string: 'Attachments',
    help: "Attachments are linked to a document through model / resId and to the message through this field."
  })
  static parentId = Fields.Many2one(
    'mail.message', {
    string: 'Parent Message', index: true, ondelete: 'SET NULL',
    help: "Initial thread message."
  })
  static childIds = Fields.One2many('mail.message', 'parentId', { string: 'Child Messages' });
  // related document
  static model = Fields.Char('Related Document Model', { index: true });
  static resId = Fields.Many2oneReference('Related Document ID', { index: true, modelField: 'model' })
  static recordName = Fields.Char('Message Record Name', { help: "Name get of the related document." })
  // characteristics
  static messageType = Fields.Selection([
    ['email', 'Email'],
    ['comment', 'Comment'],
    ['notification', 'System notification'],
    ['userNotification', 'User Specific Notification']],
    {
      string: 'Type', required: true, default: 'email',
      help: "Message type: email for email message, notification for system message, comment for other messages such as user replies",
    })
  static subtypeId = Fields.Many2one('mail.message.subtype', { string: 'Subtype', ondelete: 'SET NULL', index: true })
  static mailActivityTypeId = Fields.Many2one(
    'mail.activity.type', {
    string: 'Mail Activity Type',
    index: true, ondelete: 'SET NULL'
  })
  static isInternal = Fields.Boolean('Employee Only', { help: 'Hide to public / portal users, independently from subtype configuration.' })
  // origin
  static emailFrom = Fields.Char('From', { help: "Email address of the sender. This field is set when no matching partner is found and replaces the authorId field in the chatter." })
  static authorId = Fields.Many2one(
    'res.partner', {
    string: 'Author', index: true, ondelete: 'SET NULL',
    help: "Author of the message. If not set, emailFrom may hold an email address that did not match any partner."
  })
  static authorAvatar = Fields.Binary("Author's avatar", { related: 'authorId.avatar128', depends: ['authorId'], readonly: false })
  static authorGuestId = Fields.Many2one('mail.guest', { string: "Guest" })
  static isCurrentUserOrGuestAuthor = Fields.Boolean({ compute: '_computeIsCurrentUserOrGuestAuthor' })
  // recipients: include inactive partners (they may have been archived after
  // the message was sent, but they should remain visible in the relation)
  static partnerIds = Fields.Many2many('res.partner', { string: 'Recipients', context: { 'activeTest': false } })
  // list of partner having a notification. Caution: list may change over time because of notif gc cron.
  // mainly usefull for testing
  static notifiedPartnerIds = Fields.Many2many(
    'res.partner', { relation: 'mailNotification', string: 'Partners with Need Action', context: { 'activeTest': false }, depends: ['notificationIds'] })
  static needaction = Fields.Boolean(
    'Need Action', { compute: '_computeNeedaction', search: '_searchNeedaction', help: 'Need Action' })
  static hasError = Fields.Boolean(
    'Has error', { compute: '_computeHasError', search: '_searchHasError', help: 'Has error' })
  // notifications
  static notificationIds = Fields.One2many(
    'mail.notification', 'mailMessageId', { string: 'Notifications', autojoin: true, copy: false, depends: ['notifiedPartnerIds'] })
  // user interface
  static starredPartnerIds = Fields.Many2many(
    'res.partner', { relation: 'mailMessageResPartnerStarredRel', string: 'Favorited By' })
  static starred = Fields.Boolean(
    'Starred', { compute: '_computeStarred', search: '_searchStarred', computeSudo: false, help: 'Current user has a starred notification linked to this message' })
  // tracking
  static trackingValueIds = Fields.One2many(
    'mail.tracking.value', 'mailMessageId', {
    string: 'Tracking values',
    groups: "base.groupSystem",
    help: 'Tracked values are stored in a separate model. This field allow to reconstruct the tracking and to generate statistics on the model.'
  })
  // mail gateway
  static replyToForceNew = Fields.Boolean(
    'No threading for answers',
    { help: 'If true, answers do not go in the original document discussion thread. Instead, it will check for the reply_to in tracking message-id and redirected accordingly. This has an impact on the generated message-id.' })
  static messageId = Fields.Char('Message-Id', { help: 'Message unique identifier', index: true, readonly: 1, copy: false })
  static replyTo = Fields.Char('Reply-To', { help: 'Reply email address. Setting the replyTo bypasses the automatic thread creation.' })
  static mailServerId = Fields.Many2one('ir.mail.server', { string: 'Outgoing mail server' })
  // keep notification layout informations to be able to generate mail again
  static emailLayoutXmlid = Fields.Char('Layout', { copy: false }) // xml id of layout
  static addSign = Fields.Boolean({ default: true })
  // `test_adv_activity`, `test_adv_activity_full`, `test_message_assignation_inbox`,...
  // By setting an inverse for mail.mail_message_id, the number of SQL queries done by `modified` is reduced.
  // 'mail.mail' inherits from `mail.message`: `_inherits = {'mail.message': 'mail_message_id'}`
  // Therefore, when changing a field on `mail.message`, this triggers the modification of the same field on `mail.mail`
  // By setting up the inverse one2many, we avoid to have to do a search to find the mails linked to the `mail.message`
  // as the cache value for this inverse one2many is up-to-date.
  // Besides for new messages, and messages never sending emails, there was no mail, and it was searching for nothing.
  static mailIds = Fields.One2many('mail.mail', 'mailMessageId', { string: 'Mails', groups: "base.groupSystem" })
  static cannedResponseIds = Fields.One2many('mail.shortcode', 'messageIds', { string: "Canned Responses", store: false })
  static reactionIds = Fields.One2many('mail.message.reaction', 'messageId', { string: "Reactions", groups: "base.groupSsystem" })

  async _computeDescription() {
    for (const message of this) {
      const [subject, body] = await message('subject', 'body');
      if (subject) {
        await message.set('description', subject);
      }
      else {
        const plaintextCt = !body ? '' : html2Text(body);
        await message.set('description', plaintextCt.slice(0, 30) + f('%s', plaintextCt.length >= 30 ? ' [...]' : ''));
      }
    }
  }

  @api.depends('authorId', 'authorGuestId')
  @api.dependsContext('guest', 'uid')
  async _computeIsCurrentUserOrGuestAuthor() {
    const user = await this.env.user();
    for (const message of this) {
      const [authorId, authorGuestId] = await message('authorId', 'authorGuestId');
      if (!user._isPublic() && (authorId.ok && authorId.eq(await user.partnerId))) {
        await message.set('isCurrentUserOrGuestAuthor', true);
      }
      else if (user._isPublic() && (authorGuestId.ok && authorGuestId.eq(this.env.context['guest']))) {
        await message.set('isCurrentUserOrGuestAuthor', true);
      }
      else {
        await message.set('isCurrentUserOrGuestAuthor', false);
      }
    }
  }

  /**
   * Need action on a mail.message = notified on my channel
   * @param self 
   */
  async _computeNeedaction() {
    const myMessages = await (await (await this.env.items('mail.notification').sudo()).search([
      ['mailMessageId', 'in', this.ids],
      ['resPartnerId', '=', (await (await this.env.user()).partnerId).id],
      ['isRead', '=', false]])).mapped('mailMessageId');
    for (const message of this) {
      await message.set('needaction', message in myMessages);
    }
  }

  @api.model()
  async _searchNeedaction(operator, operand) {
    const isRead = operator === '=' && operand ? false : true;
    const notificationIds = await this.env.items('mail.notification')._search([['resPartnerId', '=', (await (await this.env.user()).partnerId).id], ['isRead', '=', isRead]]);
    return [['notificationIds', 'in', notificationIds]];
  }

  async _computeHasError() {
    const errorFromNotification = await (await (await this.env.items('mail.notification').sudo()).search([
      ['mailMessageId', 'in', this.ids],
      ['notificationStatus', 'in', ['bounce', 'exception']]])).mapped('mailMessageId');
    for (const message of this) {
      await message.set('hasError', message in errorFromNotification);
    }
  }

  async _searchHasError(operator, operand) {
    if (operator === '=' && operand) {
      return [['notificationIds.notificationStatus', 'in', ['bounce', 'exception']]];
    }
    return ['!', ['notificationIds.notificationStatus', 'in', ['bounce', 'exception']]]  // this wont work and will be equivalent to "not in" beacause of orm restrictions. Dont use "has_error = false"
  }

  /**
   * Compute if the message is starred by the current user.
   */
  @api.depends('starredPartnerIds')
  @api.dependsContext('uid')
  async _computeStarred() {
    // TDE FIXME: use SQL
    const partnerId = await (await this.env.user()).partnerId;
    const starred = await (await this.sudo()).filtered(async (msg) => (await msg.starredPartnerIds).includes(partnerId));
    for (const message of this) {
      await message.set('starred', starred.inlcudes(message));
    }
  }

  @api.model()
  async _searchStarred(operator, operand) {
    const partnerId = await (await this.env.user()).partnerId;
    if (operator === '=' && operand) {
      return [['starredPartnerIds', 'in', [partnerId.id]]];
    }
    return [['starredPartnerIds', 'not in', [partnerId.id]]];
  }

  // CRUD / ORM

  async init() {
    const res = await this._cr.execute(`SELECT indexname FROM pg_indexes WHERE indexname = 'mailMessageModelResIdIdx'`)
    if (!bool(res)) {
      await this._cr.execute('CREATE INDEX "mailMessageModelResIdIdx" ON "mailMessage" (model, "resId")');
    }
  }

  /**
   * Override that adds specific access rights of mail.message, to remove
    ids uid could not see according to our custom rules. Please refer to
    check_access_rule for more details about those rules.

    Non employees users see only message with subtype (aka do not see
    internal logs).

    After having received ids of a classic search, keep only:
    - if authorId == pid, uid is the author, OR
    - uid belongs to a notified channel, OR
    - uid is in the specified recipients, OR
    - uid has a notification on the message
    - otherwise: remove the id
   * @param args 
   * @param options 
   * @returns 
   */
  @api.model()
  async _search(args, options: { offset?: number, limit?: number, order?: any, count?: boolean, accessRightsUid?: any } = {}) {
    // Rules do not apply to administrator
    if (this.env.isSuperuser()) {
      return _super(Message, this)._search(args, options);
    }
    // Non-employee see only messages with a subtype and not internal
    if (!this.env.items('res.users').hasGroup('base.groupUser')) {
      args = expression.AND([this._getSearchDomainShare(), args]);
    }
    // Perform a super with count as false, to have the ids, not a counter
    const ids = await _super(Message, this)._search(args, options);
    if (!bool(ids) && options.count) {
      return 0;
    }
    else if (!bool(ids)) {
      return ids;
    }

    const pid = (await (await this.env.user()).partnerId).id;
    let [authorIds, partnerIds, allowedIds] = [[], [], []];
    const modelIds = {};

    // check read access rights before checking the actual rules on the given ids
    await (await _super(Message, await this.withUser(options.accessRightsUid || this._uid))).checkAccessRights('read');

    await this.flush(['model', 'resId', 'authorId', 'messageType', 'partnerIds']);
    await this.env.items('mail.notification').flush(['mailMessageId', 'resPartnerId']);
    for (const subIds of this._cr.splitForInConditions(ids)) {
      const res = await this._cr.execute(f(`
        SELECT DISTINCT m.id, m.model, m."resId", m."authorId", m."messageType",
            COALESCE("partnerRel"."resPartnerId", "needactionRel"."resPartnerId")
        FROM "%s" m
        LEFT JOIN "mailMessageResPartnerRel" "partnerRel"
        ON "partnerRel"."mailMessageId" = m.id AND "partnerRel"."resPartnerId" = %s
        LEFT JOIN "mailNotification" "needactionRel"
        ON "needactionRel"."mailMessageId" = m.id AND "needactionRel"."resPartnerId" = %s
        WHERE m.id IN (%s)`, this.cls._table), [pid, pid, String(subIds) || 'null']);
      for (const { id, model, resId, authorId, messageType, resPartnerId } of res) {
        if (authorId == pid) {
          authorIds.push(id);
        }
        else if (resPartnerId == pid) {
          partnerIds.push(id);
        }
        else if (model && resId && messageType !== 'userNotification') {
          const dict = setdefault(modelIds, model, {});
          setdefault(dict, resId, new Set()).add(id);
        }
      }
    }
    allowedIds = await this._findAllowedDocIds(modelIds);

    const finalIds = _.union(authorIds, partnerIds, allowedIds);

    if (options.count) {
      return finalIds.length;
    }
    else {
      // re-construct a list based on ids, because set did not keep the original order
      const idList = ids.filter(id => finalIds.includes(id))
      return idList;
    }
  }

  @api.model()
  async _findAllowedModelWise(docModel, docDict) {
    const docIds = Object.keys(docDict)
    const allowedDocIds = (await (await this.env.items(docModel).withContext({ activeTest: false })).search([['id', 'in', docIds]])).ids;
    const res = []
    for (const allowedDocId of allowedDocIds) {
      for (const messageId of docDict[allowedDocId]) {
        if (!res.includes(messageId)) {
          res.push(messageId);
        }
      }
    }
    return res;
  }

  @api.model()
  async _findAllowedDocIds(modelIds) {
    const IrModelAccess = this.env.items('ir.model.access');
    let allowedIds = [];
    for (const [docModel, docDict] of Object.entries(modelIds)) {
      if (!IrModelAccess.check(docModel, 'read', false)) {
        continue;
      }
      allowedIds = _.union(allowedIds, await this._findAllowedModelWise(docModel, docDict));
    }
    return allowedIds;
  }

  /**
   * Access rules of mail.message:
    - read: if
        - authorId == pid, uid is the author OR
        - uid is in the recipients (partnerIds) OR
        - uid has been notified (needaction) OR
        - uid have read access to the related document if model, resId
        - otherwise: raise
    - create: if
        - no model, no resId (private message) OR
        - pid in messageFollowerIds if model, resId OR
        - uid can read the parent OR
        - uid have write or create access on the related document if model, resId, OR
        - otherwise: raise
    - write: if
        - authorId == pid, uid is the author, OR
        - uid is in the recipients (partnerIds) OR
        - uid has write or create access on the related document if model, resId
        - otherwise: raise
    - unlink: if
        - uid has write or create access on the related document
        - otherwise: raise

    Specific case: non employee users see only messages with subtype (aka do
    not see internal logs).
   * @param operation 
   * @returns 
   */
  async checkAccessRule(operation) {
    /**
     * :param modelRecordIds: {'model': {'resId': [msgId, msgId]}, ... }
            :param messageValues: {'msgId': {'model': .., 'resId': .., 'authorId': ..}}
     */
    async function _generateModelRecordIds(msgVal, msgIds) {
      const modelRecordIds = {};
      for (const id of msgIds) {
        const vals = msgVal[id] ?? {};
        if (vals['model'] && vals['resId']) {
          setdefault(modelRecordIds, vals['model'], []).push(vals['resId']);
        }
      }
      return modelRecordIds;
    }

    if (this.env.isSuperuser()) {
      return;
    }
    // Non employees see only messages with a subtype (aka, not internal logs)
    if (! await this.env.items('res.users').hasGroup('base.groupUser')) {
      const res = await this._cr.execute(f(`
        SELECT DISTINCT message.id, message."subtypeId", subtype.internal
          FROM "%s" AS message
          LEFT JOIN "mailMessageSubtype" as subtype
          ON message."subtypeId" = subtype.id
          WHERE message."messageType" = '%s' AND
              (message."isInternal" IS TRUE OR message."subtypeId" IS NULL OR subtype.internal IS TRUE) AND
              message.id IN (%s)`, this.cls._table), ['comment', String(this.ids)]);
      if (res.length) {
        throw new AccessError(f(
          await this._t('The requested operation cannot be completed due to security restrictions. Please contact your system administrator.\n\n(Document type: %s, Operation: %s)', this.cls._description, operation)
          + ' - (%s %s, %s %s)', await this._t('Records:'), this.ids.slice(0, 6), await this._t('User:'), this._uid)
        );
      }
    }
    // Read mail_message.ids to have their values
    const messageValues = Object.fromEntries(this.ids.map(id => [id, {}]));

    await this.flush(['model', 'resId', 'authorId', 'parentId', 'messageType', 'partnerIds']),
    await this.env.items('mail.notification').flush(['mailMessageId', 'resPartnerId'])

    const partnerId = (await (await this.env.user()).partnerId).id;
    if (operation === 'read') {
      const res = await this._cr.execute(`
          SELECT DISTINCT m.id, m.model, m."resId", m."authorId", m."parentId",
              COALESCE("partnerRel"."resPartnerId", "needactionRel"."resPartnerId") as "resPartnerId",
              m."messageType" as "messageType"
          FROM "%s" m
          LEFT JOIN "mailMessageResPartnerRel" "partnerRel"
          ON "partnerRel"."mailMessageId" = m.id AND "partnerRel"."resPartnerId" = %s
          LEFT JOIN "mailNotification" "needactionRel"
          ON "needactionRel"."mailMessageId" = m.id AND "needactionRel"."resPartnerId" = %s
          WHERE m.id IN (%s)`, [this.cls._table, partnerId, partnerId, String(this.ids) || 'null']);
      for (const { id, model, resId, authorId, parentId, resPartnerId, messageType } of res) {
        messageValues[id] = {
          'model': model,
          'resId': resId,
          'authorId': authorId,
          'parentId': parentId,
          'notified': [messageValues[id]['notified'], resPartnerId].some(id => id),
          'messageType': messageType,
        }
      }
    }
    else if (operation === 'write') {
      const res = await this._cr.execute(`
          SELECT DISTINCT m.id, m.model, m."resId", m."authorId", m."parentId",
              COALESCE("partnerRel"."resPartnerId", "needactionRel"."resPartnerId") as "resPartnerId",
              m."messageType" as "messageType"
          FROM "%s" m
          LEFT JOIN "mailMessageResPartnerRel" "partnerRel"
          ON "partnerRel"."mailMessageId" = m.id AND "partnerRel"."resPartnerId" = %s
          LEFT JOIN "mailNotification" "needactionRel"
          ON "needactionRel"."mailMessageId" = m.id AND "needactionRel"."resPartnerId" = %s
          WHERE m.id IN (%s)`, [this.cls._table, partnerId, (await this.env.user()).id, String(this.ids) || 'null']);
      for (const { id, model, resId, authorId, parentId, resPartnerId, messageType } of res) {
        messageValues[id] = {
          'model': model,
          'resId': resId,
          'authorId': authorId,
          'parentId': parentId,
          'notified': [messageValues[id]['notified'], resPartnerId].some(id => id),
          'messageType': messageType,
        }
      }
    }
    else if (['create', 'unlink'].includes(operation)) {
      const res = await this._cr.execute(`SELECT DISTINCT id, model, "resId", "authorId", "parentId", "messageType" FROM "%s" WHERE id IN (%s)`, [this.cls._table, String(this.ids)]);
      for (const { id, model, resId, authorId, parentId, messageType } of res) {
        messageValues[id] = {
          'model': model,
          'resId': resId,
          'authorId': authorId,
          'parentId': parentId,
          'messageType': messageType,
        }
      }
    }
    else {
      throw new ValueError(await this._t('Wrong operation name (%s)', operation));
    }

    // Author condition (READ, WRITE, CREATE (private))
    let authorIds = [];
    const messageItems = Object.entries(messageValues);
    if (operation === 'read') {
      authorIds = messageItems.filter(([, message]) => message['authorId'] && message['authorId'] === partnerId).map(([mid]) => parseInt(mid));
    }
    else if (operation === 'write') {
      authorIds = messageItems.filter(([, message]) => message['authorId'] === partnerId).map(([mid]) => parseInt(mid));
    }
    else if (operation === 'create') {
      // authorIds = (await Promise.all(messageItems.filter(async ([, message]) => ! await this.isThreadMessage(message)))).map(([mid]) => mid);
      authorIds = (await Promise.all(messageItems.map(async ([id, m]) => ({
        id: id,
        filter: !await this.isThreadMessage(m)
      })))).filter(v => v.filter).map(data => parseInt(data.id));
    }

    let messagesToCheck = this.ids;
    messagesToCheck = _.difference(messagesToCheck, authorIds);
    if (!messagesToCheck.length) {
      return;
    }

    // Recipients condition, for read and write (partnerIds)
    // keep on top, usefull for systray notifications
    let notifiedIds = [];
    let modelRecordIds = await _generateModelRecordIds(messageValues, messagesToCheck);
    if (['read', 'write'].includes(operation)) {
      notifiedIds = messageItems.filter(([, message]) => message['notified']).map(([mid]) => mid);
    }

    messagesToCheck = _.difference(messagesToCheck, notifiedIds);
    if (!messagesToCheck.length) {
      return;
    }

    // CRUD: Access rights related to the document
    let documentRelatedIds = [];
    const documentRelatedCandidateIds = messageItems.filter(([, message]) => message['model'] && message['resId'] && message['messageType'] !== 'userNotification').map(([mid]) => mid);
    modelRecordIds = await _generateModelRecordIds(messageValues, documentRelatedCandidateIds);
    for (const [model, docIds] of Object.entries(modelRecordIds)) {
      let checkOperation;
      const DocumentModel = this.env.items(model);
      if ('_getMailMessageAccess' in DocumentModel) {
        checkOperation = await DocumentModel._getMailMessageAccess(docIds, operation)  // why not giving model here?
      }
      else {
        checkOperation = await this.env.items('mail.thread')._getMailMessageAccess(docIds, operation, model);
      }
      const records = DocumentModel.browse(docIds);
      await records.checkAccessRights(checkOperation);
      const mids = await records.browse(docIds)._filterAccessRules(checkOperation);
      documentRelatedIds = documentRelatedIds.concat(messageItems.filter(([, message]) => message['model'] === model && mids.ids.includes(message['resId']) && message['messageType'] !== 'userNotification').map(([mid]) => mid));
    }
    messagesToCheck = _.difference(messagesToCheck, documentRelatedIds);

    if (!messagesToCheck.length) {
      return;
    }

    // Parent condition, for create (check for received notifications for the created message parent)
    notifiedIds = [];
    if (operation === 'create') {
      // TDE: probably clean me
      const parentIds = messageItems.filter(([, message]) => message['parentId']).map(([, message]) => message['parentId']);
      const res = await this._cr.execute(`SELECT DISTINCT m.id, "partnerRel"."resPartnerId" FROM "%s" m
          LEFT JOIN "mailMessageResPartnerRel" "partnerRel"
          ON "partnerRel"."mailMessageId" = m.id AND "partnerRel"."resPartnerId" = %s
          WHERE m.id IN (%s)`, [this.cls._table, partnerId, String(parentIds) || 'null']);
      const notParentIds = res.filter(row => row['resPartnerId']).map(row => row['id']);
      notifiedIds = notifiedIds.concat(
        messageItems.filter(([, message]) => notParentIds.includes(message['parentId'])).map(([mid]) => mid)
      )
    }
    messagesToCheck = _.difference(messagesToCheck, notifiedIds);
    if (!messagesToCheck.length) {
      return;
    }

    // Recipients condition for create (messageFollowerIds)
    if (operation === 'create') {
      for (const [docModel, docIds] of Object.entries(modelRecordIds)) {
        const followers = await (await this.env.items('mail.followers').sudo()).search([
          ['resModel', '=', docModel],
          ['resId', 'in', docIds],
          ['partnerId', '=', partnerId],
        ]);
        const folMids = []
        for (const follower of followers) {
          folMids.push(await follower.resId);
        }
        notifiedIds = notifiedIds.concat(messageItems.filter(([, message]) => message['model'] === docModel &&
          folMids.includes(message['resId']) && message['messageType'] !== 'userNotification').map(([mid]) => mid));
      }
    }
    messagesToCheck = _.difference(messagesToCheck, notifiedIds);
    if (!messagesToCheck.length) {
      return;
    }

    if (!bool(await this.browse(messagesToCheck).exists())) {
      return;
    }
    throw new AccessError(
      await this._t('The requested operation cannot be completed due to security restrictions. Please contact your system administrator.\n\n(Document type: %s, Operation: %s)', this.cls._description, operation)
      + f(' - (%s %s, %s %s)', await this._t('Records:'), messagesToCheck.slice(0, 6), await this._t('User:'), this._uid)
    )
  }

  @api.modelCreateMulti()
  async create(valuesList) {
    const trackingValuesList = [];
    for (const values of valuesList) {
      if (!('emailFrom' in values)) {  // needed to compute replyTo
        const [authorId, emailFrom] = await this.env.items('mail.thread')._messageComputeAuthor(values['authorId'], null, false);
        values['emailFrom'] = emailFrom;
      }
      if (!values['messageId']) {
        values['messageId'] = await this._getMessageId(values);
      }
      if (!('replyTo' in values)) {
        values['replyTo'] = await this._getReplyTo(values);
      }
      if (!('recordName' in values) && !('default_recordName' in this.env.context)) {
        values['recordName'] = await this._getRecordName(values);
      }

      if (!('attachmentIds' in values)) {
        values['attachmentIds'] = [];
      }
      // extract base64 images
      if ('body' in values) {
        const Attachments = await this.env.items('ir.attachment').withContext(cleanContext(this._context));
        const dataToUrl = {};
        async function base64ToBoundary(...groups: string[]) {
          const key = groups[1]; // 	data:image/???
          if (!dataToUrl[key]) {
            const name = groups[4] ? groups[4] : f('image%s', len(dataToUrl));
            let err, attachment;
            try {
              attachment = await Attachments.create({
                'label': name,
                'datas': groups[1],
                'resModel': values['model'],
                'resId': values['resId'],
              });
            } catch (e) {
              err = true;
              // except binascii_error:
              console.warn("Impossible to create an attachment out of badly formated base64 embedded image. Image has been removed.")
              return groups[3]  // body. group(3) is the url ending single/double quote matched by the regexp
            }
            if (!err) {
              await attachment.generateAccessToken();
              values['attachmentIds'].push([4, attachment.id]);
              dataToUrl[key] = [f('/web/image/%s?accessToken=%s', attachment.id, await attachment.accessToken), name]
            }
          }
          return f('%s%s alt="%s"', dataToUrl[key][0], groups[3], dataToUrl[key][1])
        }
        values['body'] = await replaceAsync(ustr(values['body']), _imageDataUrlReg, base64ToBoundary);
      }
      // delegate creation of tracking after the create as sudo to avoid access rights issues
      trackingValuesList.push(pop(values, 'trackingValueIds', false));
    }
    const messages = await _super(Message, this).create(valuesList);

    let checkAttachmentAccess = [];
    let all = true;
    for (const values of valuesList) {
      for (const command of values['attachmentIds']) {
        if (typeof (command) === 'number') {
          extend(checkAttachmentAccess, [command]);
        }
        else if (command[0] == 6) {
          extend(checkAttachmentAccess, command[2]);
        }
        else if (command[0] == 4) {
          extend(checkAttachmentAccess, [command[1]]);
        }
        else {
          all = false;
          break;
        }
      }
      if (!all) {
        break;
      }
    }
    if (!all) {
      checkAttachmentAccess = (await messages.mapped('attachmentIds')).ids  // fallback on read if any unknow command
    }
    if (checkAttachmentAccess.length) {
      await this.env.items('ir.attachment').browse(checkAttachmentAccess).check('read');
    }

    for (const [message, values, trackingValuesCmd] of _.zip<any>([...messages], valuesList, trackingValuesList)) {
      if (bool(trackingValuesCmd)) {
        const valsLst = trackingValuesCmd.filter(cmd => len(cmd) == 3 && cmd[0] == 0).map(cmd => { return { ...cmd[2], mailMessageId: message.id } });
        const otherCmd = trackingValuesCmd.filter(cmd => len(cmd) != 3 || cmd[0] != 0);
        if (valsLst.length) {
          await (await this.env.items('mail.tracking.value').sudo()).create(valsLst);
        }
        if (otherCmd.length) {
          await (await message.sudo()).write({ 'trackingValueIds': trackingValuesCmd });
        }
      }
      if (await message.isThreadMessage(values)) {
        await message._invalidateDocuments(values['model'], values['resId']);
      }
    }
    return messages;
  }

  /**
   * Override to explicitely call check_access_rule, that is not called
        by the ORM. It instead directly fetches ir.rules and apply them.
   * @param fields 
   * @param load 
   * @returns 
   */
  async read(fields?: any[], load: string = '_classicRead') {
    this.checkAccessRule('read');
    return _super(Message, this).read(fields, load);
  }

  async write(vals) {
    const recordChanged = 'model' in vals || 'resId' in vals;
    if (recordChanged || 'messageType' in vals) {
      await this._invalidateDocuments();
    }
    const res = await _super(Message, this).write(vals);
    if (vals['attachmentIds']) {
      for (const mail of this) {
        await (await mail.attachmentIds).check('read');
      }
    }
    if ('notificationIds' in vals || recordChanged) {
      this._invalidateDocuments();
    }
    return res;
  }

  async unlink() {
    // cascade-delete attachments that are directly attached to the message (should only happen
    // for mail.messages that act as parent for a standalone mail.mail record).
    if (!this.ok) {
      return true;
    }
    await this.checkAccessRule('unlink');
    await (await (await this.mapped('attachmentIds')).filtered(
      async (attach) => await attach.resModel == this._name && (this.ids.includes(await attach.resId) || await attach.resId == 0)
    )).unlink();
    for (const elem of this) {
      if (await elem.isThreadMessage()) {
        await elem._invalidateDocuments();
      }
    }
    return _super(Message, this).unlink();
  }

  @api.model()
  async _readGroupRaw(domain, fields, groupby, options: { offset?: number, limit?: number, orderby?: any, lazy?: boolean } = {}) {
    options.lazy = options.lazy ?? true;
    if (! await this.env.isAdmin()) {
      throw new AccessError(await this._t("Only administrators are allowed to use grouped read on message model"));
    }
    return _super(Message, this)._readGroupRaw(
      domain, fields, groupby, options
    );
  }

  async exportData(fieldsToExport) {
    if (! await this.env.isAdmin()) {
      throw new AccessError(await this._t("Only administrators are allowed to export mail message"));
    }

    return _super(Message, this).exportData(fieldsToExport);
  }

  async _updateContent(body, attachmentIds) {
    this.ensureOne();
    const self: any = this;
    const [model, resId] = await self('model', 'resId');
    const thread = this.env.items(model).browse(resId);
    await thread._checkCanUpdateMessageContent(self);
    await self.set('body', body);
    if (!bool(attachmentIds)) {
      await (await self.attachmentIds)._deleteAndNotify();
    }
    else {
      const messageValues = {
        'model': model,
        'body': body,
        'resId': resId,
      }
      const attachementValues = await thread._messagePostProcessAttachments([], attachmentIds, messageValues);
      await self.update(attachementValues);
    }
    // Cleanup related message data if the message is empty
    await (await (await self.sudo())._filterEmpty())._cleanupSideRecords();
    await thread._messageUpdateContentAfterHook(self);
  }

  /**
   * Opens the related record based on the model and ID
   * @returns 
   */
  async actionOpenDocument() {
    this.ensureOne();
    const [model, resId] = await this('model', 'resId');
    return {
      'resId': resId,
      'resModel': model,
      'target': 'current',
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
    }
  }

  //# DISCUSS API

  @api.model()
  async markAllAsRead(kw: { domain?: any[] } = {}) {
    // not really efficient method: it does one db request for the
    // search, and one for each message in the result set is_read to true in the
    // current notifications from the relation.
    const partner = await (await this.env.user()).partnerId;
    const notifDomain = [
      ['resPartnerId', '=', partner.id],
      ['isRead', '=', false]];
    if (bool(kw.domain)) {
      const messages = await this.search(kw.domain);
      await messages.setMessageDone();
      return messages.ids;
    }
    const notifications = await (await this.env.items('mail.notification').sudo()).search(notifDomain);
    await notifications.write({ 'isRead': true });

    const ids = (await notifications.read(['mailMessageId'])).map(n => n['mailMessageId']);

    await this.env.items('bus.bus')._sendone(partner, 'mail.message/markAsRead', {
      'messageIds': ids.map(id => id[0]),
      'needactionInboxCounter': await partner._getNeedactionCount(),
    })

    return ids;
  }

  /**
   * Remove the needaction from messages for the current partner. 
   * @returns 
   */
  async setMessageDone() {
    const partner = await (await this.env.user()).partnerId;

    const notifications = await (await this.env.items('mail.notification').sudo()).search([
      ['mailMessageId', 'in', this.ids],
      ['resPartnerId', '=', partner.id],
      ['isRead', '=', false]]);

    if (!notifications.ok) {
      return;
    }

    await notifications.write({ 'isRead': true });

    // notifies changes in messages through the bus.
    await this.env.items('bus.bus')._sendone(partner, 'mail.message/markAsRead', {
      'messageIds': (await notifications.mailMessageId).ids,
      'needactionInboxCounter': await partner._getNeedactionCount(),
    });
  }

  /**
   * Unstar messages for the current partner.
   */
  @api.model()
  async unstarAll() {
    const partner = await (await this.env.user()).partnerId;

    const starredMessages = await this.search([['starredPartnerIds', 'in', partner.id]]);
    await starredMessages.write({ 'starredPartnerIds': [Command.unlink(partner.id)] });

    const ids = await starredMessages.map(m => m.id);
    await this.env.items('bus.bus')._sendone(partner, 'mail.message/toggleStar', {
      'messageIds': ids,
      'starred': false,
    })
  }

  /**
   * Toggle messages as (un)starred. Technically, the notifications related to uid are set to (un)starred.
   */
  async toggleMessageStarred() {
    // a user should always be able to star a message he can read
    await this.checkAccessRule('read');
    const partner = await (await this.env.user()).partnerId;
    const starred = ! await this['starred'];
    const sudo = await this.sudo();
    if (starred) {
      await sudo.write({ 'starredPartnerIds': [Command.link(partner.id)] });
    }
    else {
      await sudo.write({ 'starredPartnerIds': [Command.unlink(partner.id)] })
    }
    await this.env.items('bus.bus')._sendone(partner, 'mail.message/toggleStar', {
      'messageIds': [this.id],
      'starred': starred,
    })
  }

  async _messageAddReaction(content) {
    this.ensureOne();
    await this.checkAccessRule('write');
    await this.checkAccessRights('write');
    let guest = await this.env.items('mail.guest')._getGuestFromContext();
    let partner;
    if (await (await this.env.user())._isPublic() && bool(guest)) {
      partner = this.env.items('res.partner');
    }
    else {
      guest = this.env.items('mail.guest');
      partner = await (await this.env.user()).partnerId;
    }
    let reaction = await (await this.env.items('mail.message.reaction').sudo()).search([['messageId', '=', this.id], ['partnerId', '=', partner.id], ['guestId', '=', guest.id], ['content', '=', content]]);
    if (!reaction.ok) {
      reaction = await (await this.env.items('mail.message.reaction').sudo()).create({
        'messageId': this.id,
        'content': content,
        'partnerId': partner.id,
        'guestId': guest.id,
      });
    }
    await this.env.items(await this['model']).browse(await this['resId'])._messageAddReactionAfterHook(this, await reaction.content);
  }

  async _messageRemoveReaction(content) {
    this.ensureOne();
    await this.checkAccessRule('write');
    await this.checkAccessRights('write');
    let guest = await this.env.items('mail.guest')._getGuestFromContext();
    let partner;
    if (await (await this.env.user())._isPublic() && bool(guest)) {
      partner = this.env.items('res.partner');
    }
    else {
      guest = this.env.items('mail.guest');
      partner = await (await this.env.user()).partnerId;
    }
    const reaction = await (await this.env.items('mail.message.reaction').sudo()).search([['messageId', '=', this.id], ['partnerId', '=', partner.id], ['guestId', '=', guest.id], ['content', '=', content]]);
    await reaction.unlink();
    await this.env.items(await this['model']).browse(await this['resId'])._messageRemoveReactionAfterHook(this, content);
  }

  // MESSAGE READ / FETCH / FAILURE API

  /**
   * Reads values from messages and formats them for the web client.
   * @param fnames 
   * @param formatReply 
   */
  async _messageFormat(fnames, formatReply: boolean = true) {
    await this.checkAccessRule('read');
    const valsList = await this._readFormat(fnames);

    const threadIdsByModelName = new Dict<any>() //(set)
    for (const message of this) {
      const [model, resId] = await message('model', 'resId');
      if (model && resId) {
        threadIdsByModelName[model] = threadIdsByModelName[model] ?? new Set();
        threadIdsByModelName[model].add(resId);
      }
    }

    for (const vals of valsList) {
      const messageSudo = await (await this.browse(vals['id']).sudo()).withPrefetch(this.ids);

      // Author
      const [authorId, model, resId, parentId] = await messageSudo('authorId', 'model', 'resId', 'parentId');
      let author;
      if (authorId.ok) {
        author = [authorId.id, await authorId.displayName];
      }
      else {
        author = [0, await messageSudo.emailFrom];
      }

      // Tracking values
      const trackingValueIds = [];
      for (const tracking of await messageSudo.trackingValueIds) {
        const groups = await tracking.fieldGroups;
        if (!bool(groups) || this.env.isSuperuser() || await this.userHasGroups(groups)) {
          trackingValueIds.push({
            'id': tracking.id,
            'changedField': await tracking.fieldDesc,
            'oldValue': (await tracking.getOldDisplayValue())[0],
            'newValue': (await tracking.getNewDisplayValue())[0],
            'fieldType': await tracking.fieldType,
            'currencyId': (await tracking.currencyId).id,
          })
        }
      }
      let recordName;
      if (model && resId) {
        recordName = await (await (await this.env.items(model).browse(resId).sudo()).withPrefetch(threadIdsByModelName[model])).displayName;
      }
      else {
        recordName = false;
      }

      const authorGuestId = await messageSudo.authorGuestId;
      if (authorGuestId.ok) {
        vals['guestAuthor'] = [['insert', {
          'id': authorGuestId.id,
          'label': await authorGuestId.label,
        }]]
      }
      else {
        vals['authorId'] = author;
      }
      const reactionsPerContent = new DefaultDict2(() => this.env.items('mail.message.reaction'));
      for (const reaction of await messageSudo.reactionIds) {
        const content = await reaction.content;
        reactionsPerContent[content] = reactionsPerContent[content].or(reaction);
      }
      const reactionGroups = [['insert-and-replace',
        await Promise.all(Array.from(reactionsPerContent.items()).map(async ([content, reactions]) => {
          const partners = [];
          for (const partner of await reactions.partnerId) {
            partners.push({ 'id': partner.id, 'label': await partner.label })
          }
          const guests = [];
          for (const guest of await reactions.guestId) {
            guests.push({ 'id': guest.id, 'label': await guest.label })
          }
          return {
            'messageId': messageSudo.id,
            'content': content,
            'count': len(reactions),
            'partners': [['insert-and-replace', partners]],
            'guests': [['insert-and-replace', guests]],
          }
        }))
      ]];
      if (formatReply && model === 'mail.channel' && parentId.ok) {
        vals['parentMessage'] = (await parentId.messageFormat(false))[0];
      }
      Object.assign(vals, {
        'notifications': await (await (await messageSudo.notificationIds)._filteredForWebClient())._notificationFormat(),
        'attachmentIds': await (await messageSudo.attachmentIds)._attachmentFormat(),
        'trackingValueIds': trackingValueIds,
        'messageReactionGroups': reactionGroups,
        'recordName': recordName,
      })
    }
    return valsList;
  }

  /**
   * Get a limited amount of formatted messages with provided domain.
      :param domain: the domain to filter messages;
      :param min_id: messages must be more recent than this id
      :param max_id: message must be less recent than this id
      :param limit: the maximum amount of messages to get;
      :returns list(dict).
   * @param domain 
   * @param maxId 
   * @param minId 
   * @param limit 
   * @returns 
   */
  @api.model()
  async _messageFetch(domain, maxId?: any, minId?: any, limit: number = 30) {
    if (maxId) {
      domain = expression.AND([domain, [['id', '<', maxId]]]);
    }
    if (minId) {
      domain = expression.AND([domain, [['id', '>', minId]]]);
    }
    return (await this.search(domain, { limit: limit })).messageFormat();
  }

  /**
   * Get the message values in the format for web client. Since message values can be broadcasted,
    computed fields MUST NOT BE READ and broadcasted.
    :returns list(dict).
      Example :
        {
          'body': HTML content of the message
          'model': u'res.partner',
          'recordName': u'Agrolait',
          'attachmentIds': [
              {
                  'file_type_icon': u'webimage',
                  'id': 45,
                  'name': u'sample.png',
                  'filename': u'sample.png'
              }
          ],
          'needactionPartnerIds': [], # list of partner ids
          'resId': 7,
          'trackingValueIds': [
              {
                  'old_value': "",
                  'changed_field': "Customer",
                  'id': 2965,
                  'new_value': "Axelor"
              }
          ],
          'authorId': (3, u'Administrator'),
          'emailFrom': 'sacha@pokemon.com' # email address or false
          'subtypeId': (1, u'Discussions'),
          'date': '2015-06-30 08:22:33',
          'partnerIds': [[7, "Sacha Du Bourg-Palette"]], # list of partner nameGet
          'messageType': u'comment',
          'id': 59,
          'subject': false
          'isNote': true # only if the message is a note (subtype == note)
          'isDiscussion': false # only if the message is a discussion (subtype == discussion)
          'isNotification': false # only if the message is a note but is a notification aka not linked to a document like assignation
          'parentMessage': {...}, # formatted message that this message is a reply to. Only present if format_reply is true
        }
   * @param formatReply 
   * @returns 
   */
  async messageFormat(formatReply: boolean = true) {
    const valsList = await this._messageFormat(this._getMessageFormatFields(), formatReply);

    const comId = await this.env.items('ir.model.data')._xmlidToResId('mail.mtComment');
    const noteId = await this.env.items('ir.model.data')._xmlidToResId('mail.mtNote');

    for (const vals of valsList) {
      const messageSudo = await (await this.browse(vals['id']).sudo()).withPrefetch(this.ids);
      const notifs = await (await messageSudo.notificationIds).filtered((n) => n.resPartnerId)
      update(vals, {
        'needactionPartnerIds': (await (await notifs.filtered(async (n) => ! await n.isRead)).resPartnerId).ids,
        'historyPartnerIds': (await (await notifs.filtered((n) => n.isRead)).resPartnerId).ids,
        'isNote': (await messageSudo.subtypeId).id == noteId,
        'isDiscussion': (await messageSudo.subtypeId).id == comId,
        'subtypeDescription': await (await messageSudo.subtypeId).description,
        'isNotification': vals['messageType'] == 'userNotification',
        'recipients': await Promise.all([...await messageSudo.partnerIds].map(async p => { return { 'id': p.id, 'label': await p.label } }))
      });
      if (vals['model'] && this.env.items(vals['model'])._originalModule) {
        vals['moduleIcon'] = getModuleIcon(this.env.items(vals['model'])._originalModule);
      }
    }
    return valsList;
  }

  _getMessageFormatFields() {
    return [
      'id', 'body', 'date', 'authorId', 'emailFrom',  // base message fields
      'messageType', 'subtypeId', 'subject',  // message specific
      'model', 'resId', 'recordName',  // document related
      'partnerIds',  // recipients
      'starredPartnerIds',  // list of partner ids for whom the message is starred
    ];
  }

  /**
   * Returns the current messages and their corresponding notifications in
    the format expected by the web client.

    Notifications hold the information about each recipient of a message: if
    the message was successfully sent or if an exception or bounce occurred.
   * @returns 
   */
  async _messageNotificationFormat() {
    const res = [];
    for (const message of this) {
      const [resId, model, date, messageType, notificationIds] = await message('resId', 'model', 'date', 'messageType', 'notificationIds');
      res.push({
        'id': message.id,
        'resId': resId,
        'model': model,
        'resModelName': await (await message.env.items('ir.model')._get(model)).displayName,
        'date': date,
        'messageType': messageType,
        'notifications': await (await notificationIds._filteredForWebClient())._notificationFormat(),
      });
    }
    return res;
  }

  /** 
   * Send bus notifications to update status of notifications in the web
    client. Purpose is to send the updated status per author.
  */
  async _notifyMessageNotificationUpdate() {
    let messages = this.env.items('mail.message');
    for (const message of this) {
      // Check if user has access to the record before displaying a notification about it.
      // In case the user switches from one company to another, it might happen that he doesn't
      // have access to the record related to the notification. In this case, we skip it.
      // YTI FIXME: check allowedCompanyIds if necessary
      const [model, resId] = await message('model', 'resId');
      if (model && resId) {
        const record = this.env.items(message.model).browse(resId);
        let err;
        try {
          record.check_access_rights('read')
          record.check_access_rule('read')
        } catch (e) {
          if (isInstance(e, AccessError)) {
            continue;
          } else {
            throw e;
          }
        }
        if (!err) {
          messages = messages.or(message);
        }
      }
    }
    const messagesPerPartner = new DefaultDict2(() => this.env.items('mail.message'));
    for (const message of messages) {
      if (! await (await this.env.user())._isPublic()) {
        const partnerId = await (await this.env.user()).partnerId;
        messagesPerPartner[partnerId] = messagesPerPartner[partnerId].or(message);
      }
      const authorId = await message.authorId;
      if (authorId.ok && ! await (await (await authorId.withContext({ activeTest: false })).userIds).some(async (user) => await user._isPublic())) {
        messagesPerPartner[authorId] = messagesPerPartner[authorId].or(message);
      }
    }
    const updates = [];
    for (const [partner, messages] of messagesPerPartner.items()) {
      updates.push([partner, 'mail.message/notificationUpdate', { 'elements': await messages._messageNotificationFormat() }]);
    }
    await this.env.items('bus.bus')._sendmany(updates);
  }

  // TOOLS

  /**
   * Clean related data: notifications, stars, ... to avoid lingering notifications / unreachable counters with void messages notably.
   */
  async _cleanupSideRecords() {
    await this.write({
      'starredPartnerIds': [[5, 0, 0]],
      'notificationIds': [[5, 0, 0]],
    });
  }

  /**
   * Return subset of "void" messages
   * @returns 
   */
  async _filterEmpty() {
    return this.filtered(
      async (msg) => {
        const [body, subtypeId, attachmentIds, trackingValueIds] = await msg('body', 'subtypeId', 'attachmentIds', 'trackingValueIds');
        return (!body || isHtmlEmpty(body)) &&
          (!subtypeId.ok || ! await subtypeId.description) &&
          !attachmentIds.ok && !trackingValueIds.ok;
      }
    );
  }

  /**
   * Return the related document name, using name_get. It is done using SUPERUSER_ID, to be sure to have the record name correctly stored.
   * @param values 
   * @returns 
   */
  @api.model()
  async _getRecordName(values) {
    const model = values['model'] || this.env.context['default_model'];
    const resId = values['resId'] || this.env.context['default_resId'];
    if (!model || !resId || !(model in this.env.models)) {
      return false;
    }
    return (await this.env.items(model).sudo()).browse(resId).displayName;
  }

  /**
   * Return a specific reply_to for the document
   * @param values 
   * @returns 
   */
  @api.model()
  async _getReplyTo(values) {
    const model = values['model'] || this._context['default_model'];
    const resId = values['resId'] || this._context['default_resId'] || false;
    const emailFrom = values['emailFrom'];
    const messageType = values['messageType'];
    let records;// = None
    if (await (this as any).isThreadMessage({ 'model': model, 'resId': resId, 'messageType': messageType })) {
      records = this.env.items(model).browse([resId]);
    }
    else {
      records = model ? this.env.items(model) : this.env.items('mail.thread');
    }
    return (await records._notifyGetReplyTo(emailFrom))[resId];
  }

  @api.model()
  async _getMessageId(values) {
    let messageId;
    if ((values['replyToForceNew'] ?? false) === true) {
      messageId = generateTrackingMessageId('replyTo');
    }
    else if (await (this as any).isThreadMessage(values)) {
      messageId = generateTrackingMessageId(_f('{resId}-{model}', values));
    }
    else {
      messageId = generateTrackingMessageId('private');
    }
    return messageId;
  }

  async isThreadMessage(vals?: {}) {
    let resId, model, messageType;
    if (bool(vals)) {
      resId = vals['resId'];
      model = vals['model'];
      messageType = vals['messageType']
    }
    else {
      this.ensureOne();
      [model, resId, messageType] = await this('model', 'resId', 'messageType');
    }
    return resId && model && messageType !== 'userNotification';
  }

  /**
   * Invalidate the cache of the documents followed by ``self``.
   * @param model 
   * @param resId 
   */
  async _invalidateDocuments(model?: string, resId?: number) {
    for (const record of this) {
      model = model || await record.model;
      resId = resId || await record.resId;
      if (model && isSubclass(this.env.items(model), this.pool.models['mail.thread'])) {
        this.env.items(model).invalidateCache([
          'messageIds',
          'messageUnread',
          'messageUnreadCounter',
          'messageNeedaction',
          'messageNeedactionCounter',
        ], [resId]);
      }
    }
  }

  _getSearchDomainShare() {
    return ['&', '&', ['isInternal', '=', false], ['subtypeId', '!=', false], ['subtypeId.internal', '=', false]];
  }
} 