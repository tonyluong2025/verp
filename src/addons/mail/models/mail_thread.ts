import assert from "assert";
import _ from "lodash";
import { encode } from "utf8";
import { api, registry, tools } from "../../../core";
import { Environment } from "../../../core/api";
import { getattr, setdefault } from "../../../core/api/func";
import { Command, Field, Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { AccessError, UnicodeEncodeError, UserError, ValueError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel, _super, isSubclass } from "../../../core/models";
import { expression } from "../../../core/osv";
import { urlEncode } from "../../../core/service/middleware/utils";
import { b64encode, bool, doWith, isInstance, setOptions, split } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { documentFromString } from "../../../core/tools/html";
import { enumerate, isList, len, next, splitEvery } from "../../../core/tools/iterable";
import { EmailMessage, decodeMessageHeader, emailNormalize, emailSplit, formataddr, generateTrackingMessageId, mailHeaderMsgidRe } from "../../../core/tools/mail";
import { cleanContext, hash, pop, update } from "../../../core/tools/misc";
import { slug } from "../../../core/tools/slug";
import { _f, f, ustr } from "../../../core/tools/utils";
import { getAttribute, isElement, iterchildren, markup, parseHtml, serializeHtml } from "../../../core/tools/xml";

class _Attachment {
  fname: string;
  content: any;
  info: {};
  constructor(fname: string, content: any, info: any) {
    this.fname = fname;
    this.content = content;
    this.info = info;
  }
};

/**
 * mail_thread model is meant to be inherited by any model that needs to
        act as a discussion topic on which messages can be attached. Public
        methods are prefixed with ``message_`` in order to avoid name
        collisions with methods of the models that will inherit from this class.

        ``mail.thread`` defines fields used to handle and display the
        communication history. ``mail.thread`` also manages followers of
        inheriting classes. All features and expected behavior are managed
        by mail.thread. Widgets has been designed for the 7.0 and following
        versions of Verp.

        Inheriting classes are not required to implement any method, as the
        default implementation will work for any model. However it is common
        to override at least the ``message_new`` and ``message_update``
        methods (calling ``super``) to add model-specific behavior at
        creation and update of a thread when processing incoming emails.

        Options:
            - _mail_flat_thread: if set to true, all messages without parentId
                are automatically attached to the first message posted on the
                ressource. If set to false, the display of Chatter is done using
                threads, and no parentId is automatically set.

    MailThread features can be somewhat controlled through context keys :

     - ``mail_create_nosubscribe``: at create or messagePost, do not subscribe
       uid to the record thread
     - ``mail_create_nolog``: at create, do not log the automatic '<Document>
       created' message
     - ``mail_notrack``: at create and write, do not perform the value tracking
       creating messages
     - ``tracking_disable``: at create and write, perform no MailThread features
       (auto subscription, tracking, post, ...)
     - ``mail_notify_force_send``: if less than 50 email notifications to send,
       send them directly instead of using the queue; true by default
 */
@MetaModel.define()
class MailThread extends AbstractModel {
  static _module = module;
  static _name = 'mail.thread';
  static _description = 'Email Thread';
  static _mailFlatThread = true;    // flatten the discussino history
  static _mailPostAccess = 'write'; // access required on the document to post on it

  static messageIsFollower = Fields.Boolean('Is Follower', { compute: '_computeMessageIsFollower', search: '_searchMessageIsFollower' });
  static messageFollowerIds = Fields.One2many('mail.followers', 'resId', { string: 'Followers', groups: 'base.groupUser' });
  static messagePartnerIds = Fields.Many2many('res.partner', { string: 'Followers (Partners)', compute: '_computeMessagePartnerIds', search: '_searchMessagePartnerIds', groups: 'base.groupUser' });
  static messageIds = Fields.One2many('mail.message', 'resId', { string: 'Messages', domain: [['messageType', '!=', 'userNotification']], autojoin: true });
  static hasMessage = Fields.Boolean({ compute: "_computeHasMessage", search: "_searchHasMessage", store: false });
  static messageUnread = Fields.Boolean('Unread Messages', { compute: '_computeMessageUnread', help: "If checked, new messages require your attention." })
  static messageUnreadCounter = Fields.Integer('Unread Messages Counter', {
    compute: '_computeMessageUnread',
    help: "Number of unread messages"
  })
  static messageNeedaction = Fields.Boolean('Action Needed', { compute: '_computeMessageNeedaction', search: '_searchMessageNeedaction', help: "If checked, new messages require your attention." })
  static messageNeedactionCounter = Fields.Integer('Number of Actions', { compute: '_computeMessageNeedaction', help: "Number of messages which requires an action" })
  static messageHasError = Fields.Boolean('Message Delivery error', { compute: '_computeMessageHasError', search: '_searchMessageHasError', help: "If checked, some messages have a delivery error." })
  static messageHasErrorCounter = Fields.Integer('Number of errors', { compute: '_computeMessageHasError', help: "Number of messages with delivery error" })
  static messageAttachmentCount = Fields.Integer('Attachment Count', { compute: '_computeMessageAttachmentCount', groups: "base.groupUser" })
  static messageMainAttachmentId = Fields.Many2one('ir.attachment', { string: "Main Attachment", index: true, copy: false });

  @api.depends('messageFollowerIds')
  async _computeMessagePartnerIds() {
    for (const thread of this) {
      await thread.set('messagePartnerIds', await (await thread.messageFollowerIds).mapped('partnerId'));
    }
  }

  /**
   * Search function for messageFollowerIds
    Do not use with operator 'not in'. Use instead messageIsFollowers
   * @param operator 
   * @param operand 
   * @returns 
   */
  @api.model()
  async _searchMessagePartnerIds(operator, operand) {
    // TOFIX make it work with not in
    assert(operator !== "not in", "Do not search messageFollowerIds with 'not in'")
    const followers = await (await this.env.items('mail.followers').sudo()).search([
      ['resModel', '=', this._name],
      ['partnerId', operator, operand]])
    // using read() below is much faster than followers.mapped('resId')
    return [['id', 'in', (await followers.read(['resId'])).map(res => res['resId'])]];
  }

  @api.depends('messageFollowerIds')
  async _computeMessageIsFollower() {
    const followers = await (await this.env.items('mail.followers').sudo()).search([
      ['resModel', '=', this._name],
      ['resId', 'in', this.ids],
      ['partnerId', '=', (await (await this.env.user()).partnerId).id],
    ]);
    // using read() below is much faster than followers.mapped('resId')
    const followingIds = (await followers.read(['resId'])).map(res => res['resId']);
    for (const record of this) {
      await record.set('messageIsFollower', followingIds.includes(record.id));
    }
  }

  @api.model()
  async _searchMessageIsFollower(operator, operand) {
    const followers = await (await this.env.items('mail.followers').sudo()).search([
      ['resMmodel', '=', this._name],
      ['partnerId', '=', (await (await this.env.user()).partnerId).id],
    ]);
    // Cases ('message_is_follower', '=', true) or  ('message_is_follower', '!=', false)
    if ((operator === '=' && operand) || (operator === '!=' && !operand)) {
      // using read() below is much faster than followers.mapped('resId')
      return [['id', 'in', (await followers.read(['resId'])).map(res => res['resId'])]];
    }
    else {
      // using read() below is much faster than followers.mapped('resId')
      return [['id', 'not in', (await followers.read(['resId'])).map(res => res['resId'])]];
    }
  }

  async _computeHasMessage() {
    await this.flush();
    const res = await this.env.cr.execute(`
      SELECT distinct "resId"
        FROM "mailMessage" mm
        WHERE "resId" = any($1)
          AND mm.model=$2
    `, { bind: [this.ids, this._name] });
    const channelIds = res.map(r => r['resId']);
    for (const record of this) {
      await record.set('hasMessage', channelIds.includes(record.id));
    }
  }

  async _searchHasMessage(operator, value) {
    let operatorNew;
    if ((operator == '=' && value == true) || (operator == '!=' && value === false)) {
      operatorNew = 'inselect';
    }
    else {
      operatorNew = 'not inselect';
    }
    return [['id', operatorNew, ['SELECT "resId" FROM "mailMessage" WHERE model=%s', [this._name]]]];
  }

  async _computeMessageUnread() {
    const partnerId = (await (await this.env.user()).partnerId).id;
    const res = Dict.fromKeys(this.ids, 0);
    if (bool(this.ids)) {
      // search for unread messages, directly in SQL to improve performances
      const rows = await this._cr.execute(`SELECT msg."resId" FROM "mailMessage" msg
          RIGHT JOIN "mailChannelPartner" cp
          ON (cp."channelId" = msg."resId" AND cp."partnerId" = %s AND
            (cp."seenMessageId" IS NULL OR cp."seenMessageId" < msg.id))
          WHERE msg.model = '%s' AND msg."resId" IN (%s) AND
                msg."messageType" != 'userNotification' AND
                (msg."authorId" IS NULL OR msg."authorId" != %s) AND
                (msg."messageType" not in ('notification', 'userNotification') OR msg.model != 'mail.channel')`,
        { params: [partnerId, this._name, String(this.ids) || 'NULL', partnerId] });
      for (const row of rows) {
        res[row['resId']] += 1;
      }
    }

    for (const record of this) {
      const messageUnreadCounter = res.get(record._origin.id, 0);
      // await Promise.all([
      await record.set('messageUnreadCounter', messageUnreadCounter),
        await record.set('messageUnread', bool(messageUnreadCounter))
      // ]);
    }
  }

  async _computeMessageNeedaction() {
    const res = Dict.fromKeys(this.ids, 0);
    if (bool(this.ids)) {
      // search for unread messages, directly in SQL to improve performances
      const rows = await this._cr.execute(`SELECT msg."resId" FROM "mailMessage" msg
          RIGHT JOIN "mailNotification" rel
          ON rel."mailMessageId" = msg.id AND rel."resPartnerId" = %s AND (rel."isRead" = false OR rel."isRead" IS NULL)
          WHERE msg.model = '%s' AND msg."resId" IN (%s) AND msg."messageType" != 'userNotification'`,
        [(await (await this.env.user()).partnerId).id, this._name, String(this.ids) || 'NULL']
      );
      for (const row of rows) {
        res[row['resId']] += 1;
      }
    }
    for (const record of this) {
      const messageNeedactionCounter = res.get(record._origin.id, 0);
      // await Promise.all([
      await record.set('messageNeedactionCounter', messageNeedactionCounter),
        await record.set('messageNeedaction', bool(messageNeedactionCounter))
      // ]);
    }
  }

  @api.model()
  _searchMessageNeedaction(operator, operand) {
    return [['messageIds.needaction', operator, operand]];
  }

  async _computeMessageHasError() {
    const res = new Dict();
    if (bool(this.ids)) {
      const rows = await this._cr.execute(`SELECT msg."resId", COUNT(msg."resId")::int FROM "mailMessage" msg
          RIGHT JOIN "mailNotification" rel
          ON rel."mailMessageId" = msg.id AND rel."notificationStatus" IN ('exception','bounce')
          WHERE msg."authorId" = %s AND msg.model = '%s' AND msg."resId" IN (%s) AND msg."messageType" != 'userNotification'
          GROUP BY msg."resId"`,
        [(await (await this.env.user()).partnerId).id, this._name, String(this.ids) || 'NULL']
      );
      res.updateFrom(rows);
    }

    for (const record of this) {
      const messageHasErrorCounter = res.get(record._origin.id, 0);
      await record.set('messageHasErrorCounter', messageHasErrorCounter);
      await record.set('messageHasError', bool(messageHasErrorCounter));
    }
  }

  @api.model()
  async _searchMessageHasError(operator, operand) {
    const messageIds = await this.env.items('mail.message')._search([['hasError', operator, operand], ['authorId', '=', (await (await this.env.user()).partnerId).id]]);
    return [['messageIds', 'in', messageIds]];
  }

  async _computeMessageAttachmentCount() {
    const readGroupVar = await this.env.items('ir.attachment').readGroup([['resId', 'in', this.ids], ['resModel', '=', this._name]], ['resId'], ['resId']);
    const attachmentCountDict = Dict.from(readGroupVar.map(d => [d['resId'], d['resId_count']]));
    for (const record of this) {
      await record.set('messageAttachmentCount', attachmentCountDict.get(record.id, 0));
    }
  }

  // CRUD
  // ------------------------------------------------------------

  /**
   * Chatter override :
        - subscribe uid
        - subscribe followers of parent
        - log a creation message
   * @param valsList 
   * @returns 
   */
  @api.modelCreateMulti()
  async create(valsList) {
    if (this._context['trackingDisable']) {
      const threads = await _super(MailThread, this).create(valsList);

      await threads._discardTracking();

      return threads;
    }

    const threads = await _super(MailThread, this).create(valsList);
    // subscribe uid unless asked not to
    if (!this._context['mailCreateNosubscribe']) {
      for (const thread of threads) {
        await this.env.items('mail.followers')._insertFollowers(thread._name, thread.ids, (await (await this.env.user()).partnerId).ids, { subtypes: null, customerIds: [], checkExisting: false });
      }
    }
    // autoSubscribe: take values and defaults into account
    const createValuesList = {};
    for (const [thread, values] of _.zip<any>([...threads], valsList)) {
      const createValues = Dict.from(values);
      for (const [key, val] of Object.entries(this._context)) {
        if (key.startsWith('default_') && !(key.slice(8) in createValues)) {
          createValues[key.slice(8)] = val;
        }
      }
      await thread._messageAutoSubscribe(createValues, 'update');
      createValuesList[thread.id] = createValues;
    }
    // automatic logging unless asked not to (mainly for various testing purpose)
    if (!this._context['mailCreateNolog']) {
      let threadsNoSubtype = this.env.items(this._name);
      const authorId = (await (await this.env.user()).partnerId).id
      for (const thread of threads) {
        const subtype = await thread._creationSubtype();
        if (bool(subtype)) {  // if we have a subtype, post message to notify users from _messageAutoSubscribe
          await (await thread.sudo()).messagePost({ subtypeId: subtype.id, authorId: authorId });
        }
        else {
          threadsNoSubtype = threadsNoSubtype.add(thread);
        }
      }
      if (threadsNoSubtype._length) {
        const bodies = new Dict();
        for (const thread of threadsNoSubtype) {
          bodies[thread.id] = await thread._creationMessage();
        }
        await threadsNoSubtype._messageLogBatch(bodies);
      }
    }
    // post track template if a tracked field changed

    await threads._discardTracking();

    if (!this._context['mailNotrack']) {
      const fnames = await this._getTrackedFields();
      for (const thread of threads) {
        const createValues = createValuesList[thread.id];
        const changes = fnames.filter(fname => createValues[fname]);
        // based on tracked field to stay consistent with write
        // we don't consider that a falsy field is a change, to stay consistent with previous implementation,
        // but we may want to change that behaviour later.

        await thread._messageTrackPostTemplate(changes);
      }
    }
    return threads;
  }

  async write(values) {
    if (this._context['trackingDisable']) {
      return _super(MailThread, this).write(values);
    }
    if (!this._context['mailNotrack']) {
      await this._prepareTracking(this._fields);
    }

    // Perform write
    const result = await _super(MailThread, this).write(values);

    // update followers
    await this._messageAutoSubscribe(values);

    return result;
  }

  /**
   * Override unlink to delete messages and followers. This cannot be
    cascaded, because link is done through (resModel, resId).
   * @returns 
   */
  async unlink() {
    if (!this.ok) {
      return true;
    }
    // discard pending tracking
    await this._discardTracking();
    await (await (await this.env.items('mail.message').sudo()).search([['model', '=', this._name], ['resId', 'in', this.ids]])).unlink();
    const res = await _super(MailThread, this).unlink();
    await (await (await this.env.items('mail.followers').sudo()).search(
      [['resModel', '=', this._name], ['resId', 'in', this.ids]]
    )).unlink();
    return res;
  }

  async copyData(defaultValue?: any) {
    // avoid tracking multiple temporary changes during copy
    return _super(MailThread, await (await this.withContext({ mailNotrack: true }))).copyData(defaultValue);
  }

  /**
   * Override of BaseModel.getEmptyListHelp() to generate an help message
    that adds alias information.
   * @param help 
   * @returns 
   */
  @api.model()
  async getEmptyListHelp(help) {
    const model = this._context['emptyListHelpModel'];
    const resId = this._context['emptyListHelpId'];
    const catchallDomain = await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.catchall.domain");
    const documentName = this._context['emptyListHelpDocumentName'] || await this._t('document');
    let nothingHere = !help;
    let alias = null;

    if (catchallDomain && model && resId) {  // specific resId -> find its alias (i.e. sectionId specified)
      const record = (await this.env.items(model).sudo()).browse(resId);
      const aliasId = await record.aliasId;
      // check that the alias effectively creates new records
      if (aliasId.ok && await aliasId.aliasName &&
        (await aliasId.aliasModelId).ok &&
        await (await aliasId.aliasModelId).model === this._name &&
        await aliasId.aliasForceThreadId == 0) {
        alias = aliasId;
      }
    }
    if (!bool(alias) && catchallDomain && model) {  // no resId or resId not linked to an alias -> generic help message, take a generic alias of the model
      const Alias = this.env.items('mail.alias');
      const aliases = await Alias.search([
        ["aliasParentModelId.model", "=", model],
        ["aliasName", "!=", false],
        ['aliasForceThreadId', '=', false],
        ['aliasParentThreadId', '=', false]], { order: 'id ASC' });
      if (len(aliases) == 1) {
        alias = aliases(0);
      }
    }
    if (alias) {
      const emailLink = _f("<a href='mailto:%(email)s'>{email}</a>", { 'email': await alias.displayName });
      if (nothingHere) {
        return _f("<p class='o-view-nocontent-smiling-face'>{dynHelp}</p>", {
          dynHelp: _f(await this._t("Add a new {document} or send an email to {emailLink}"), {
            document: documentName,
            emailLink: emailLink,
          })
        });
      }
      // do not add alias two times if it was added previously
      if (help.includes("oe_view_nocontent_alias")) {
        return _f("{staticHelp}<p class='oe_view_nocontent_alias'>{dynHelp}</p>", {
          staticHelp: help,
          dynHelp: _f(await this._t("Create new {document} by sending an email to {emailLink}"), {
            document: documentName,
            emailLink: emailLink,
          })
        });
      }
    }
    if (nothingHere) {
      return _f("<p class='o-view-nocontent-smiling-face'>{dynHelp}</p>", {
        dynHelp: _f(await this._t("Create new {document}"), { document: documentName }),
      });
    }

    return help;
  }

  // MODELS / CRUD HELPERS
  // ------------------------------------------------------

  async _computeFieldValue(field: Field) {
    if (!this._context['trackingDisable'] && !this._context['mailNotrack']) {
      await this._prepareTracking(this.pool.fieldComputed.get(field, []).filter(f => f.store).map(f => f.name));
    }

    return _super(MailThread, this)._computeFieldValue(field);
  }

  /**
   * Give the subtypes triggered by the creation of a record

    :returns: a subtype browse record (empty if no subtype is triggered)
   * @returns 
   */
  async _creationSubtype() {
    return this.env.items('mail.message.subtype');
  }

  /**
   * Get the creation message to log into the chatter at the record's creation.
    :returns: The message's body to log.
   * @returns 
   */
  async _creationMessage() {
    this.ensureOne();
    const docName = await (await this.env.items('ir.model')._get(this._name)).label;
    return this._t('%s created', docName);
  }

  /**
   * mail.message check permission rules for related document. This method is meant to be inherited in order to implement addons-specific behavior.
      A common behavior would be to allow creating messages when having read access rule on the document, for portal document such as issues.
   * @param resIds 
   * @param operation 
   * @param modelName 
   */
  @api.model()
  async _getMailMessageAccess(resIds, operation, modelName?: any) {
    const DocModel = modelName ? this.env.models[modelName] : this.cls;
    // const createAllow = getattr(DocModel, '_mailPostAccess', 'write');
    const createAllow = DocModel['_mailPostAccess'] ?? 'write';

    let checkOperation;
    if (['write', 'unlink'].includes(operation)) {
      checkOperation = 'write';
    }
    else if (operation === 'create' && ['create', 'read', 'write', 'unlink'].includes(createAllow)) {
      checkOperation = createAllow;
    }
    else if (operation === 'create') {
      checkOperation = 'write';
    }
    else {
      checkOperation = operation;
    }
    return checkOperation;
  }

  _validFieldParameter(field, name) {
    // allow tracking on models inheriting from 'mail.thread'
    return ['tracking', 'autojoin'].includes(name) || _super(MailThread, this)._validFieldParameter(field, name);
  }

  async _fallbackLang() {
    if (!this._context["lang"]) {
      return this.withContext({ lang: await (await this.env.user()).lang });
    }
    return this;
  }

  // WRAPPERS AND TOOLS
  // ------------------------------------------------------

  /**
   * Transfer the list of the mail thread messages from an model to another

    :param id : the old resId of the mail.message
    :param new_res_id : the new resId of the mail.message
    :param new_model : the name of the new model of the mail.message

    Example :   my_lead.message_change_thread(my_project_task)
                will transfer the context of the thread of my_lead to my_project_task

   * @param newThread 
   * @param newParentMessage 
   * @returns 
   */
  async messageChangeThread(newThread, newParentMessage?: any) {
    this.ensureOne();
    // get the subtype of the comment Message
    const subtypeComment = await this.env.items('ir.model.data')._xmlidToResId('mail.mtComment');

    // get the ids of the comment and not-comment of the thread
    // TDE check: sudo on mail.message, to be sure all messages are moved ?
    const MailMessage = this.env.items('mail.message');
    const msgComment = await MailMessage.search([
      ['model', '=', this._name],
      ['resId', '=', this.id],
      ['messageType', '!=', 'userNotification'],
      ['subtypeId', '=', subtypeComment]]);
    const msgNotComment = await MailMessage.search([
      ['model', '=', this._name],
      ['resId', '=', this.id],
      ['messageType', '!=', 'userNotification'],
      ['subtypeId', '!=', subtypeComment]]);

    // update the messages
    const msgVals = { "resId": newThread.id, "model": newThread._name }
    if (bool(newParentMessage)) {
      msgVals["parentId"] = newParentMessage.id;
    }
    await msgComment.write(msgVals);

    // other than comment: reset subtype
    msgVals["subtypeId"] = null;
    await msgNotComment.write(msgVals);
    return true;
  }

  // TRACKING / LOG
  // ------------------------------------------------------

  /**
   * Prepare the tracking of ``fields`` for ``self``.

    :param fields: iterable of fields names to potentially track
   * @param fields 
   * @returns 
   */
  async _prepareTracking(fields) {
    const fnames = _.intersection(await this._getTrackedFields(), fields);
    if (!fnames.length) {
      return;
    }
    this.env.cr.precommit.add(this._finalizeTracking);
    const initialValues = setdefault(this.env.cr.precommit.data, `mail.tracking.${this._name}`, {});
    for (const record of this) {
      if (!bool(record.id)) {
        continue;
      }
      const values = setdefault(initialValues, record.id, {});
      if (values != null) {
        for (const fname of fnames) {
          setdefault(values, fname, await record[fname]);
        }
      }
    }
  }

  /**
   * Prevent any tracking of fields on ``self``.
   * @returns 
   */
  async _discardTracking() {
    if (!(await this._getTrackedFields()).length) {
      return;
    }
    this.env.cr.precommit.add(this._finalizeTracking);
    const initialValues = setdefault(this.env.cr.precommit.data, `mail.tracking.${this._name}`, {});
    // disable tracking by setting initial values to None
    for (const id of this.ids) {
      initialValues[id] = null;
    }
  }

  /**
   * Generate the tracking messages for the records that have been
    prepared with ``_prepareTracking``.
   * @returns 
   */
  async _finalizeTracking() {
    const initialValues = pop(this.env.cr.precommit.data, `mail.tracking.${this._name}`, {});
    const _ids = Object.entries(initialValues).filter(([id, vals]) => bool(vals)).map(([id]) => id);
    if (!_ids.length) {
      return;
    }
    const records = await this.browse(_ids).sudo();
    const fnames = await this._getTrackedFields();
    const context = cleanContext(this._context);
    const tracking = await (await records.withContext(context)).messageTrack(fnames, initialValues);
    for (const record of records) {
      const [changes, trackingValueIds] = tracking[record.id] ?? [null, null];
      await record._messageTrackPostTemplate(changes);
    }
    // this method is called after the main flush() and just before commit();
    // we have to flush() again in case we triggered some recomputations
    await this.flush();
  }

  /**
   * Return the set of tracked fields names for the current model. 
   * @returns 
   */
  @tools.ormcache('self.env.uid', 'self.env.su')
  async _getTrackedFields() {
    const fields = {}
    for (const [name, field] of this._fields.items()) {
      if (getattr(field, 'tracking', null) || getattr(field, 'trackVisibility', null)) {
        fields[name] = field;
      }
    }

    return bool(fields) ? Object.keys(await this.fieldsGet(fields)) : [];
  }

  async _messageTrackPostTemplate(changes: any) {
    if (!changes) {
      return true;
    }
    // Clean the context to get rid of residual default_* keys
    // that could cause issues afterward during the mail.message
    // generation. Example: 'default_parent_id' would refer to
    // the parentId of the current record that was used during
    // its creation, but could refer to wrong parent message id,
    // leading to a traceback in case the related messageId
    // doesn't exist
    const self = await this.withContext(cleanContext(this._context));
    const templates = await this._trackTemplate(changes);
    for (const [fieldName, [template, postKwargs]] of Object.entries<any>(templates)) {
      if (!template) {
        continue;
      }
      if (typeof (template) === 'string') {
        await (await this._fallbackLang()).messagePostWithView(template, postKwargs);
      }
      else {
        await (await this._fallbackLang()).messagePostWithTemplate(template.id, postKwargs);
      }
    }
    return true;
  }

  /**
   * Optional method to override in addons inheriting from mail.thread.
    Return a list tuples containing (
      partner ID,
      subtype IDs (or false if model-based default subtypes),
      QWeb template XML ID for notification (or false is no specific
        notification is required),
      ), aka partners and their subtype and possible notification to send
    using the auto subscription mechanism linked to updated values.

    Default value of this method is to return the new responsible of
    documents. This is done using relational fields linking to res.users
    with track_visibility set. 

    Override this method to change that behavior and/or to add people to
    notify, using possible custom notification.

    :param updated_values: see ``_message_auto_subscribe``
    :param default_subtype_ids: coming from ``_get_auto_subscription_subtypes``
   * @param updatedValues 
   * @param defaultSubtypeIds 
   * @returns 
   */
  async _messageAutoSubscribeFollowers(updatedValues, defaultSubtypeIds) {
    const field = this._fields.get('userId');
    const userId = updatedValues['userId'];
    if (field && userId && field.comodelName === 'res.users' && ((field['trackVisibility'] ?? false) || (field['tracking'] ?? false))) {
      const user = (await this.env.items('res.users').sudo()).browse(userId);
      try { // avoid to make an exists, lets be optimistic and try to read it.
        if (await user.active) {
          return [[(await user.partnerId).id, defaultSubtypeIds, !user.eq(await this.env.user()) ? 'mail.messageUserAssigned' : false]];
        }
      } catch (e) {
        // except:
        // pass;
      }
    }
    return [];
  }

  async _trackTemplate(changes) {
    return new Dict<any>();
  }

  /**
   * Remove partners from the records followers.
   * @param partnerIds 
   */
  async messageUnsubscribe(partnerIds?: any) {
    // not necessary for computation, but saves an access right check
    if (!bool(partnerIds)) {
      return true;
    }
    partnerIds = Array.isArray(partnerIds) ? partnerIds : [partnerIds];
    if (_.difference(partnerIds, [(await (await this.env.user()).partnerId).id]).length == 0) {
      await this.checkAccessRights('read');
      await this.checkAccessRule('read');
    }
    else {
      await this.checkAccessRights('write');
      await this.checkAccessRule('write');
    }
    await (await (await this.env.items('mail.followers').sudo()).search([
      ['resModel', '=', this._name],
      ['resId', 'in', this.ids],
      ['partnerId', 'in', partnerIds ?? []],
    ])).unlink();
  }

  /**
   * Track updated values. Comparing the initial and current values of
    the fields given in tracked_fields, it generates a message containing
    the updated values. This message can be linked to a mail.message.subtype
    given by the ``_track_subtype`` method.

    :param tracked_fields: iterable of field names to track
    :param initial_values: mapping {recordId: {fieldName: value}}
    :return: mapping {recordId: (changed_field_names, trackingValueIds)}
        containing existing records only
   * @param trackedFields 
   * @param initialValues 
   * @returns 
   */
  async messageTrack(trackedFields, initialValues) {
    if (!trackedFields) {
      return true;
    }

    trackedFields = await this.fieldsGet(trackedFields);
    const tracking = new Dict<any>();
    for (const record of this) {
      try {
        tracking[record.id] = await record._mailTrack(trackedFields, initialValues[record.id]);
      } catch (e) {
        // except MissingError:
        continue;
      }
    }

    for (const record of this) {
      const [changes, trackingValueIds] = await tracking.get(record.id, [null, null]);
      if (!bool(changes)) {
        continue;
      }

      // find subtypes and post messages or log if no subtype found
      let subtype;
      // By passing this key, that allows to let the subtype empty and so don't sent email because partnersToNotify from mailMessage._notify will be empty
      if (!this._context['mailTrackLogOnly']) {
        subtype = await record._trackSubtype(
          Object.fromEntries(changes.map(colName => [colName, initialValues[record.id][colName]]))
        );
      }
      if (bool(subtype)) {
        if (!bool(await subtype.exists())) {
          console.debug(f('subtype "%s" not found', await subtype.label));
          continue;
        }
        await record.messagePost({ subtypeId: subtype.id, trackingValueIds: trackingValueIds });
      }
      else if (bool(trackingValueIds)) {
        await record._messageLog(trackingValueIds);
      }
    }
    return tracking;
  }

  /**
   * Give the subtypes triggered by the changes on the record according
    to values that have been updated.

    :param init_values: the original values of the record; only modified fields
                        are present in the dict
    :type init_values: dict
    :returns: a subtype browse record or false if no subtype is trigerred
   * @param initValues 
   * @returns 
   */
  async _trackSubtype(initValues) {
    return false;
  }

  @api.model()
  async _notifyEncodeLink(baseLink, params) {
    const secret = await (await this.env.items('ir.config.parameter').sudo()).getParam('database.secret');
    const token = f('%s?%s', baseLink, Object.keys(params).sort().map(key => f('%s=%s', key, params[key])).join(' '));
    return hash(secret, token, 'sha256');
  }

  /**
   * Prepare link to an action: view document, follow document, ... 
   * @param linkType 
   * @param kw 
   */
  async _notifyGetActionLink(linkType, kw: {} = {}) {
    const params = {
      'model': kw['model'] ?? this._name,
      'resId': kw['resId'] ?? (bool(this.ids) && bool(this.ids[0])) ? this.ids[0] : false,
    }
    // whitelist accepted parameters: action (deprecated), token (assign), accessToken
    // (view), auth_signup_token and auth_login (for auth_signup support)
    Object.assign(params, Dict.from(
      Object.entries<any>(kw).filter(([key]) => ['action', 'token', 'accessToken', 'authSignupToken', 'authLogin'].includes(key))
    ));

    let baseLink;
    if (['view', 'assign', 'follow', 'unfollow'].includes(linkType)) {
      baseLink = f('/mail/%s', linkType);
    }
    else if (linkType === 'controller') {
      const controller = kw['controller'];
      pop(params, 'model');
      baseLink = f('%s', controller);
    }
    else {
      return ''
    }

    if (linkType !== 'view') {
      const token = this._notifyEncodeLink(baseLink, params);
      params['token'] = token;
    }

    let link = f('%s?%s', baseLink, urlEncode(params));
    if (this.ok) {
      link = await this[0].getBaseUrl() + link;
    }
    return link;
  }

  // MAIL GATEWAY


  /**
   * Tools method used in _routingCheckRoute: whether to log a warning or throw new an error
   * @param errorMessage 
   * @param messageId 
   * @param route 
   */
  async _routingWarn(errorMessage, messageId, route, throwNewException = true) {
    const shortMessage = await this._t("Mailbox unavailable - %s", errorMessage);
    const fullMessage = f('Routing mail with Message-Id %s: route %s: %s', messageId, route, errorMessage);
    console.info(fullMessage);
    if (throwNewException) {
      // sender should not see private diagnostics info, just the error
      throw new ValueError(shortMessage);
    }
  }

  async _routingCreateBounceEmail(emailFrom, bodyHtml, message, mailValues: {} = {}) {
    const bounceTo = await decodeMessageHeader(message, 'Return-Path') || emailFrom;
    const bounceMailValues = {
      'authorId': false,
      'bodyHtml': bodyHtml,
      'subject': f('Re: %s', message['subject']),
      'emailTo': bounceTo,
      'autoDelete': true,
    }
    const bounceFrom = emailNormalize(await this.env.items('ir.mail.server')._getDefaultBounceAddress() || '');
    if (bounceFrom) {
      bounceMailValues['emailFrom'] = formataddr(['MAILER-DAEMON', bounceFrom]);
    }
    else if (!message['To'].includes(await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.catchall.alias"))) {
      bounceMailValues['emailFrom'] = decodeMessageHeader(message, 'To');
    }
    else {
      bounceMailValues['emailFrom'] = formataddr(['MAILER-DAEMON', await (await this.env.user()).emailNormalized]);
    }
    update(bounceMailValues, mailValues);
    await (await (await this.env.items('mail.mail').sudo()).create(bounceMailValues)).send();
  }

  /**
   * Handle bounce of incoming email. Based on values of the bounce (email
      and related partner, send message and its messageID)

        * find blacklist-enabled records with email_normalized = bounced email
          and call ``_messageReceiveBounce`` on each of them to propagate
          bounce information through various records linked to same email;
        * if not already done (i.e. if original record is not blacklist enabled
          like a bounce on an applicant), find record linked to bounced message
          and call ``_messageReceiveBounce``;

      :param email_message: incoming email;
      :type email_message: email.message;
      :param message_dict: dictionary holding already-parsed values and in
          which bounce-related values will be added;
      :type message_dict: dictionary;
   * @param emailMessage 
   * @param messageDict 
   */
  @api.model()
  async _routingHandleBounce(emailMessage, messageDict) {
    let [bouncedRecord, bouncedRecordDone]: any[] = [false, false];
    let [bouncedEmail, bouncedPartner] = [messageDict['bouncedEmail'], messageDict['bouncedPartner']];
    let [bouncedMsgId, bouncedMessage] = [messageDict['bouncedMsgId'], messageDict['bouncedMessage']];
    let bouncedModel, bouncedResId;
    if (bouncedEmail) {
      [bouncedModel, bouncedResId] = [await bouncedMessage.model, await bouncedMessage.resId];

      if (bouncedModel && (bouncedModel in this.env.models) && bouncedResId) {
        bouncedRecord = await (await this.env.items(bouncedModel).sudo()).browse(bouncedResId).exists();
      }
      const blModels = await (await this.env.items('ir.model').sudo()).search(['&', ['isMailBlacklist', '=', true], ['model', '!=', 'mail.thread.blacklist']]);
      for (const model of await blModels.filter(async (blModel) => await blModel.model in this.env.models)) {  // transient test mode
        const recBounceWEmail = await (await this.env.items(await model.model).sudo()).search([['emailNormalized', '=', bouncedEmail]]);
        await recBounceWEmail._messageReceiveBounce(bouncedEmail, bouncedPartner);
        bouncedRecordDone = bouncedRecordDone || (bool(bouncedRecord) && await model.model === bouncedModel && recBounceWEmail.includes(bouncedRecord));
      }
      // set record as bounced unless already done due to blacklist mixin
      if (bool(bouncedRecord) && !bouncedRecordDone && isSubclass(bouncedRecord, this.pool.models['mail.thread'])) {
        await bouncedRecord._messageReceiveBounce(bouncedEmail, bouncedPartner);
      }

      if (bool(bouncedPartner) && bool(bouncedMessage)) {
        await (await (await this.env.items('mail.notification').sudo()).search([
          ['mailMessageId', '=', bouncedMessage.id],
          ['resPartnerId', 'in', bouncedPartner.ids]]
        )).write({ 'notificationStatus': 'bounce' });
      }
    }
    if (bool(bouncedRecord)) {
      console.info('Routing mail from %s to %s with Message-Id %s: not routing bounce email from %s replying to %s (model %s ID %s)',
        messageDict['emailFrom'], messageDict['to'], messageDict['messageId'], bouncedEmail, bouncedMsgId, bouncedModel, bouncedResId);
    }
    else if (bool(bouncedEmail)) {
      console.info('Routing mail from %s to %s with Message-Id %s: not routing bounce email from %s replying to %s (no document found)',
        messageDict['emailFrom'], messageDict['to'], messageDict['messageId'], bouncedEmail, bouncedMsgId);
    }
    else {
      console.info('Routing mail from %s to %s with Message-Id %s: not routing bounce email.',
        messageDict['emailFrom'], messageDict['to'], messageDict['messageId']);
    }
  }

  /**
   * Verify route validity. Check and rules:
        1 - if threadId -> check that document effectively exists; otherwise
            fallback on a message_new by resetting threadId
        2 - check that message_update exists if threadId is set; or at least
            that message_new exist
        3 - if there is an alias, check alias_contact:
            'followers' and threadId:
                check on target document that the author is in the followers
            'followers' and alias_parent_thread_id:
                check on alias parent document that the author is in the
                followers
            'partners': check that authorId id set

    :param message: an email.message instance
    :param message_dict: dictionary of values that will be given to
                          mail_message.create()
    :param route: route to check which is a tuple (model, threadId,
                  custom_values, uid, alias)
    :param throw new_exception: if an error occurs, tell whether to throw new an error
                            or just log a warning and try other processing or
                            invalidate route
   * @param message 
   * @param messageDict 
   * @param route 
   * @param throwNewException 
   * @returns 
   */
  @api.model()
  async _routingCheckRoute(message, messageDict, route, throwNewException = true) {
    assert(isList(route), 'A route should be a list');
    assert(route.length == 5, 'A route should contain 5 elements: model, threadId, customValues, uid, alias record');

    const messageId = messageDict['messageId'];
    const emailFrom = messageDict['emailFrom'];
    const authorId = messageDict['authorId'];
    let [model, threadId, alias] = [route[0], route[1], route[4]];
    let recordSet;

    // Wrong model
    if (!model) {
      await this._routingWarn(await this._t('target model unspecified'), messageId, route, throwNewException);
      return [];
    }
    else if (!(model in this.env.models)) {
      await this._routingWarn(await this._t('unknown target model %s', model), messageId, route, throwNewException);
      return [];
    }
    recordSet = threadId ? this.env.items(model).browse(threadId) : this.env.items(model);

    // Existing Document: check if exists and model accepts the mailgateway; if not, fallback on create if allowed
    if (threadId) {
      if (!bool(await recordSet.exists())) {
        await this._routingWarn(
          _f(await this._t('reply to missing document ({model},{thread}), fall back on document creation'), { model: model, thread: threadId }),
          messageId,
          route,
          false
        )
        threadId = null;
      }
      else if (!recordSet['messageUpdate']) {
        await this._routingWarn(await this._t('reply to model %s that does not accept document update, fall back on document creation', model), messageId, route, false);
        threadId = null;
      }
    }
    // New Document: check model accepts the mailgateway
    if (!threadId && model && !recordSet['messageNew']) {
      await this._routingWarn(await this._t('model %s does not accept document creation', model), messageId, route, throwNewException);
      return [];
    }

    // Update message author. We do it now because we need it for aliases (contact settings)
    if (!authorId) {
      let authors, records;
      if (bool(recordSet)) {
        authors = await this._mailFindPartnerFromEmails([emailFrom], { records: recordSet });
      }
      else if (alias && bool(await alias.aliasParentModelId) && bool(alias.aliasParentThreadId)) {
        records = this.env.items(await (await alias.aliasParentModelId).model).browse(await alias.aliasParentThreadId);
        authors = await this._mailFindPartnerFromEmails([emailFrom], { records: records })
      }
      else {
        authors = await this._mailFindPartnerFromEmails([emailFrom], { records: null });
      }
      if (bool(authors)) {
        messageDict['authorId'] = authors[0].id;
      }
    }
    // Alias: check aliasContact settings
    if (bool(alias)) {
      let obj;
      if (threadId) {
        obj = recordSet[0];
      }
      else if (bool(await alias.aliasParentModelId) && bool(await alias.aliasParentThreadId)) {
        obj = this.env.items(await (await alias.aliasParentModelId).model).browse(await alias.aliasParentThreadId);
      }
      else {
        obj = this.env.items(model);
      }
      const errorMessage = await obj._aliasGetErrorMessage(message, messageDict, alias);
      if (errorMessage) {
        await this._routingWarn(
          _f(await this._t('alias {label}: {error}'), { label: await alias.aliasName, error: errorMessage || await this._t('unknown error') }),
          messageId,
          route,
          false
        )
        const body = await alias._getAliasBouncedBody(messageDict);
        await this._routingCreateBounceEmail(emailFrom, body, message, { references: messageId });
        return false;
      }
    }
    return [model, threadId, route[2], route[3], route[4]];
  }

  /**
   * Called by ``messageProcess`` when a new mail is received from an email address.
      If the email is related to a partner, we consider that the number of message_bounce
      is not relevant anymore as the email is valid - as we received an email from this
      address. The model is here hardcoded because we cannot know with which model the
      incomming mail match. We consider that if a mail arrives, we have to clear bounce for
      each model having bounce count.
 
      :param email_from: email address that sent the incoming email.
   * @param emailMessage 
   * @param messageDict 
   */
  @api.model()
  async _routingResetBounce(emailMessage, messageDict) {
    const validEmail = messageDict['emailFrom'];
    if (validEmail) {
      const blModels = await (await this.env.items('ir.model').sudo()).search(['&', ['isMailBlacklist', '=', true], ['model', '!=', 'mail.thread.blacklist']]);
      for (const model of await blModels.filter(async (blModel) => await blModel.model in this.env.models)) {  // transient test mode
        await (await (await this.env.items(await model.model).sudo()).search([['messageBounce', '>', 0], ['emailNormalized', '=', validEmail]]))._messageResetBounce(validEmail);
      }
    }
  }

  /**
   * Attempt to figure out the correct target model, threadId,
          custom_values and userId to use for an incoming message.
          Multiple values may be returned, if a message had multiple
          recipients matching existing mail.aliases, for example.
    
          The following heuristics are used, in this order:
    
           * if the message replies to an existing thread by having a Message-Id
             that matches an existing mail_message.messageId, we take the original
             message model/threadId pair and ignore custom_value as no creation will
             take place;
           * look for a mail.alias entry matching the message recipients and use the
             corresponding model, threadId, custom_values and userId. This could
             lead to a thread update or creation depending on the alias;
           * fallback on provided ``model``, ``threadId`` and ``custom_values``;
           * throw new an exception as no route has been found
    
          :param string message: an email.message instance
          :param dict message_dict: dictionary holding parsed message variables
          :param string model: the fallback model to use if the message does not match
              any of the currently configured mail aliases (may be None if a matching
              alias is supposed to be present)
          :type dict custom_values: optional dictionary of default field values
              to pass to ``message_new`` if a new record needs to be created.
              Ignored if the thread record already exists, and also if a matching
              mail.alias was found (aliases define their own defaults)
          :param int threadId: optional ID of the record/thread from ``model`` to
              which this mail should be attached. Only used if the message does not
              reply to an existing thread and does not match any mail alias.
          :return: list of routes [(model, threadId, custom_values, userId, alias)]
    
          :throw news: ValueError, TypeError
   * @param message 
   * @param messageDict 
   * @param model 
   * @param threadId 
   * @param customValues 
   * @returns 
   */
  @api.model()
  async messageRoute(message, messageDict, model?: any, threadId?: any, customValues?: any) {
    if (!isInstance(message, EmailMessage)) {
      throw new TypeError('message must be an email.message.EmailMessage at this point');
    }
    const catchallAlias = await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.catchall.alias");
    const catchallDomainLowered = (await (await this.env.items("ir.config.parameter").sudo()).getParam("mail.catchall.domain", "")).trim().toLowerCase();
    let catchallDomainsAllowed = await (await this.env.items("ir.config.parameter").sudo()).getParam("mail.catchall.domain.allowed");
    if (catchallDomainLowered && catchallDomainsAllowed) {
      catchallDomainsAllowed = catchallDomainsAllowed.split(',').concat([catchallDomainLowered]);
    }
    const bounceAlias = await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.bounce.alias");
    let fallbackModel = model;

    // get email.message.Message variables for future processing
    const messageId = messageDict['messageId'];

    // compute references to find if message is a reply to an existing thread
    const threadReferences = messageDict['references'] || messageDict['inReplyTo'];
    const msgReferences = [];
    for (const ref of threadReferences.matchAll(mailHeaderMsgidRe)) {
      if (!ref.includes('replyTo')) {
        msgReferences.push(ref.replace(/[\r\n\t ]+/, '')); // "Unfold" buggy references
      }
    }
    const mailMessages = await (await this.env.items('mail.message').sudo()).search([['messageId', 'in', msgReferences]], { limit: 1, order: 'id desc, messageId' });
    let isAReply = bool(mailMessages);
    const [replyModel, replyThreadId] = [await mailMessages.model, await mailMessages.resId];

    // author and recipients
    const emailFrom = emailSplit(messageDict['emailFrom']);
    const emailFromLocalpart = split(emailFrom[0] ?? '', '@', 1)[0].toLowerCase();
    const emailTo = emailSplit(messageDict['to']);
    const emailToLocalparts = (len(emailTo) ? emailTo : ['']).map(e => split(e, '@', 1)[0].toLowerCase());
    // Delivered-To is a safe bet in most modern MTAs, but we have to fallback on To + Cc values
    // for all the odd MTAs out there, as there is no standard header for the envelope's `rcpt_to` value.
    const rcptTosLocalparts = [];
    for (const recipient of emailSplit(messageDict['recipients'])) {
      const [toLocal, toDomain] = split(recipient, '@');//, maxsplit=1
      if (!bool(catchallDomainsAllowed) || catchallDomainsAllowed.includes(toDomain.toLowerCase())) {
        rcptTosLocalparts.push(toLocal.toLowerCase());
      }
    }
    let rcptTosValidLocalparts = Array.from(rcptTosLocalparts);

    // 0. Handle bounce: verify whether this is a bounced email and use it to collect bounce data and update notifications for customers
    //    Bounce alias: if any To contains bounce_alias@domain
    //    Bounce message (not alias)
    //       See http://datatracker.ietf.org/doc/rfc3462/?include_text=1
    //        As all MTA does not respect this RFC (googlemail is one of them),
    //       we also need to verify if the message come from "mailer-daemon"
    //    If not a bounce: reset bounce information
    if (bounceAlias && emailToLocalparts.some(email => email == bounceAlias)) {
      await this._routingHandleBounce(message, messageDict);
      return [];
    }
    if (await message.getContentType() === 'multipart/report' || emailFromLocalpart === 'mailer-daemon') {
      await this._routingHandleBounce(message, messageDict);
      return [];
    }
    await this._routingResetBounce(message, messageDict);

    // 1. Handle reply
    //    if destination = alias with different model -> consider it is a forward and not a reply
    //    if destination = alias with same model -> check contact settings as they still apply
    if (replyModel && replyThreadId) {
      const replyModelId = await this.env.items('ir.model')._getId(replyModel);
      const otherModelAliases = await this.env.items('mail.alias').search([
        '&', '&',
        ['aliasName', '!=', false],
        ['aliasName', 'in', emailToLocalparts],
        ['aliasModelId', '!=', replyModelId],
      ]);
      if (bool(otherModelAliases)) {
        isAReply = false;
        const aliasNames = await otherModelAliases.mapped('aliasName');
        rcptTosValidLocalparts = rcptTosValidLocalparts.filter(to => aliasNames.includes(to));
      }
    }
    if (isAReply && replyModel) {
      const replyModelId = await this.env.items('ir.model')._getId(replyModel);
      const destAliases = await this.env.items('mail.alias').search([
        ['aliasName', 'in', rcptTosLocalparts],
        ['aliasModelId', '=', replyModelId]
      ], { limit: 1 });

      const userId = (await this._mailFindUserForGateway(emailFrom, destAliases)).id || this._uid;
      const route = await this._routingCheckRoute(
        message, messageDict,
        [replyModel, replyThreadId, customValues, userId, destAliases],
        false);
      if (bool(route)) {
        console.info(
          'Routing mail from %s to %s with Message-Id %s: direct reply to msg: model: %s, threadId: %s, custom_values: %s, uid: %s',
          emailFrom, emailTo, messageId, replyModel, replyThreadId, customValues, this._uid);
        return [route];
      }
      else if (route == false) {
        return [];
      }
    }
    // 2. Handle new incoming email by checking aliases and applying their settings
    if (rcptTosLocalparts.length) {
      // no route found for a matching reference (or reply), so parent is invalid
      pop(messageDict, 'parentId', null);

      // check it does not directly contact catchall
      if (bool(catchallAlias) && bool(emailToLocalparts) && emailToLocalparts.every(emailLocalpart => emailLocalpart == catchallAlias)) {
        console.info('Routing mail from %s to %s with Message-Id %s: direct write to catchall, bounce', emailFrom, emailTo, messageId);
        const body = await (await this.env.ref('mail.mailBounceCatchall'))._render({
          'message': message,
        }, 'ir.qweb');
        await this._routingCreateBounceEmail(emailFrom, body, message, { references: messageId, replyTo: await (await this.env.company()).email });
        return [];
      }
      const destAliases = await this.env.items('mail.alias').search([['aliasName', 'in', rcptTosValidLocalparts]]);
      if (bool(destAliases)) {
        const routes = [];
        for (const alias of destAliases) {
          const userId = (await this._mailFindUserForGateway(emailFrom, alias)).id || this._uid;
          let route: any = [await (await alias.sudo()).aliasModelId.model, await alias.aliasForceThreadId, literalEval(await alias.aliasDefaults), userId, alias];
          route = await this._routingCheckRoute(message, messageDict, route, true);
          if (bool(route)) {
            console.info(
              'Routing mail from %s to %s with Message-Id %s: direct alias match: %r',
              emailFrom, emailTo, messageId, route);
            routes.push(route);
          }
        }
        return routes;
      }
    }
    // 3. Fallback to the provided parameters, if they work
    if (fallbackModel) {
      // no route found for a matching reference (or reply), so parent is invalid
      pop(messageDict, 'parentId', null);
      const userId = (await this._mailFindUserForGateway(emailFrom)).id || this._uid;
      const route = await this._routingCheckRoute(
        message, messageDict,
        [fallbackModel, threadId, customValues, userId, null],
        true);
      if (bool(route)) {
        console.info(
          'Routing mail from %s to %s with Message-Id %s: fallback to model:%s, threadId:%s, custom_values:%s, uid:%s',
          emailFrom, emailTo, messageId, fallbackModel, threadId, customValues, userId);
        return [route];
      }
    }
    // ValueError if no routes found and if no bounce occurred
    throw new ValueError(
      'No possible route found for incoming message from %s to %s (Message-Id %s:). \
              Create an appropriate mail.alias or force the destination model.',
      emailFrom, emailTo, messageId
    )
  }
  /*
    @api.model
    def _message_route_process(self, message, message_dict, routes):
        self = self.with_context(attachments_mime_plainxml=true) # import XML attachments as text
        # postpone setting message_dict.partner_ids after messagePost, to avoid double notifications
        original_partner_ids = message_dict.pop('partner_ids', [])
        threadId = false
        for model, threadId, custom_values, userId, alias in routes or ():
            subtypeId = false
            related_user = this.env.items('res.users'].browse(userId)
            Model = this.env.items(model].with_context(mail_create_nosubscribe=true, mail_create_nolog=true)
            if not (threadId and hasattr(Model, 'message_update') or hasattr(Model, 'message_new')):
                throw new ValueError(
                    "Undeliverable mail with Message-Id %s, model %s does not accept incoming emails" %
                    (message_dict['messageId'], model)
                )
  
            # disabled subscriptions during message_new/update to avoid having the system user running the
            # email gateway become a follower of all inbound messages
            ModelCtx = Model.with_user(related_user).sudo()
            if threadId and hasattr(ModelCtx, 'message_update'):
                thread = ModelCtx.browse(threadId)
                thread.message_update(message_dict)
            else:
                # if a new thread is created, parent is irrelevant
                message_dict.pop('parentId', None)
                thread = ModelCtx.message_new(message_dict, custom_values)
                threadId = thread.id
                subtypeId = thread._creation_subtype().id
  
            # replies to internal message are considered as notes, but parent message
            # author is added in recipients to ensure he is notified of a private answer
            parent_message = false
            if message_dict.get('parentId'):
                parent_message = this.env.items('mail.message'].sudo().browse(message_dict['parentId'])
            partner_ids = []
            if not subtypeId:
                if message_dict.get('isInternal'):
                    subtypeId = this.env.items('ir.model.data']._xmlidToResId('mail.mt_note')
                    if parent_message and parent_message.authorId:
                        partner_ids = [parent_message.authorId.id]
                else:
                    subtypeId = this.env.items('ir.model.data']._xmlidToResId('mail.mtComment')
  
            post_params = dict(subtypeId=subtypeId, partner_ids=partner_ids, **message_dict)
            # remove computational values not stored on mail.message and avoid warnings when creating it
            for x in ('from', 'to', 'cc', 'recipients', 'references', 'in_reply_to', 'bounced_email', 'bounced_message', 'bounced_msg_id', 'bounced_partner'):
                post_params.pop(x, None)
            new_msg = false
            if thread._name == 'mail.thread':  # message with parentId not linked to record
                new_msg = thread.message_notify(**post_params)
            else:
                # parsing should find an author independently of user running mail gateway, and ensure it is not verpbot
                partner_from_found = message_dict.get('authorId') and message_dict['authorId'] != this.env.items('ir.model.data']._xmlidToResId('base.partner_root')
                thread = thread.with_context(mail_create_nosubscribe=not partner_from_found)
                new_msg = thread.messagePost(**post_params)
  
            if new_msg and original_partner_ids:
                # postponed after messagePost, because this is an external message and we don't want to create
                # duplicate emails due to notifications
                new_msg.write({'partner_ids': original_partner_ids})
        return threadId
  
    @api.model
    def messageProcess(self, model, message, custom_values=None,
                        save_original=false, strip_attachments=false,
                        threadId=None):
        """ Process an incoming RFC2822 email message, relying on
            ``mail.message.parse()`` for the parsing operation,
            and ``message_route()`` to figure out the target model.
  
            Once the target model is known, its ``message_new`` method
            is called with the new message (if the thread record did not exist)
            or its ``message_update`` method (if it did).
  
           :param string model: the fallback model to use if the message
               does not match any of the currently configured mail aliases
               (may be None if a matching alias is supposed to be present)
           :param message: source of the RFC2822 message
           :type message: string or xmlrpclib.Binary
           :type dict custom_values: optional dictionary of field values
                to pass to ``message_new`` if a new record needs to be created.
                Ignored if the thread record already exists, and also if a
                matching mail.alias was found (aliases define their own defaults)
           :param bool save_original: whether to keep a copy of the original
                email source attached to the message after it is imported.
           :param bool strip_attachments: whether to strip all attachments
                before processing the message, in order to save some space.
           :param int threadId: optional ID of the record/thread from ``model``
               to which this mail should be attached. When provided, this
               overrides the automatic detection based on the message
               headers.
        """
        # extract message bytes - we are forced to pass the message as binary because
        # we don't know its encoding until we parse its headers and hence can't
        # convert it to utf-8 for transport between the mailgate script and here.
        if isinstance(message, xmlrpclib.Binary):
            message = bytes(message.data)
        if isinstance(message, str):
            message = message.encode('utf-8')
        message = email.message_from_bytes(message, policy=email.policy.SMTP)
  
        # parse the message, verify we are not in a loop by checking messageId is not duplicated
        msg_dict = self.message_parse(message, save_original=save_original)
        if strip_attachments:
            msg_dict.pop('attachments', None)
  
        existing_msg_ids = this.env.items('mail.message'].search([('messageId', '=', msg_dict['messageId'])], limit=1)
        if existing_msg_ids:
            _logger.info('Ignored mail from %s to %s with Message-Id %s: found duplicated Message-Id during processing',
                         msg_dict.get('email_from'), msg_dict.get('to'), msg_dict.get('messageId'))
            return false
  
        # find possible routes for the message
        routes = self.message_route(message, msg_dict, model, threadId, custom_values)
        threadId = self._message_route_process(message, msg_dict, routes)
        return threadId
 */
  /**
   * Called by ``messageProcess`` when a new message is received
       for a given thread model, if the message did not belong to
       an existing thread.
       The default behavior is to create a new record of the corresponding
       model (based on some very basic info extracted from the message).
       Additional behavior may be implemented by overriding this method.
 
       :param dict msg_dict: a map containing the email details and
                             attachments. See ``messageProcess`` and
                            ``mail.message.parse`` for details.
       :param dict custom_values: optional dictionary of additional
                                  field values to pass to create()
                                  when creating the new thread record.
                                  Be careful, these values may override
                                  any other values coming from the message.
       :rtype: int
       :return: the id of the newly created thread object
   * @param msgDict 
   * @param customValues 
   * @returns 
   */
  @api.model()
  async messageNew(msgDict, customValues?: any) {
    let data = {}
    if (typeof customValues === 'object') {
      data = structuredClone(customValues);
    }
    const fields = await this.fieldsGet();
    const nameField = this.cls._recName || 'label';
    if (nameField in fields && !data['label']) {
      data[nameField] = msgDict.get('subject', '');
    }
    return this.create(data);
  }

  /**
   * Called by ``messageProcess`` when a new message is received
         for an existing thread. The default behavior is to update the record
         with update_vals taken from the incoming email.
         Additional behavior may be implemented by overriding this
         method.
         :param dict msg_dict: a map containing the email details and
                             attachments. See ``messageProcess`` and
                             ``mail.message.parse()`` for details.
         :param dict update_vals: a dict containing values to update records
                            given their ids; if the dict is None or is
                            void, no write operation is performed.
   * @param msgDict 
   * @param updateVals 
   * @returns 
   */
  async messageUpdate(msgDict, updateVals?: any) {
    if (bool(updateVals)) {
      await this.write(updateVals);
    }
    return true;
  }

  /**
   * Called by ``messageProcess`` when a bounce email (such as Undelivered
      Mail Returned to Sender) is received for an existing thread. The default
      behavior is to do nothing. This method is meant to be overridden in various
      modules to add some specific behavior like blacklist management or mass
      mailing statistics update. check is an integer  ``message_bounce`` column exists.
      If it is the case, its content is incremented.
 
      :param string email: email that caused the bounce;
      :param record partner: partner matching the bounced email address, if any;
   * @param email 
   * @param partner 
   */
  async _messageReceiveBounce(email, partner) {
    //pass
  }

  /**
   * Called by ``messageProcess`` when an email is considered as not being
      a bounce. The default behavior is to do nothing. This method is meant to
      be overridden in various modules to add some specific behavior like
      blacklist management.
 
      :param string email: email for which to reset bounce information
   * @param email 
   */
  async _messageResetBounce(email) {
    // pass
  }

  /**
   * Perform some cleaning / postprocess in the body and attachments
      extracted from the email. Note that this processing is specific to the
      mail module, and should not contain security or generic html cleaning.
      Indeed those aspects should be covered by the html_sanitize method
      located in tools.
   * @param message 
   * @param payloadDict 
   * @returns 
   */
  async _messageParseExtractPayloadPostprocess(message, payloadDict) {
    let [body, attachments] = [payloadDict['body'], payloadDict['attachments']];
    if (!body.trim()) {
      return { 'body': body, 'attachments': attachments }
    }
    let root;
    try {
      root = parseHtml(body);
    } catch (e) {
      if (isInstance(e, ValueError)) {
        // In case the email client sent XHTML, fromstring will fail because 'Unicode strings
        // with encoding declaration are not supported'.
        root = parseHtml(encode(body));
      }
    }

    let postprocessed = false;
    const toRemove: Element[] = [];
    for (const node of iterchildren(root, isElement) as Element[]) {
      if ((node.getAttribute('class') || '').includes('o-mail-notification') || (node.getAttribute('summary') || '').includes('o-mail-notification')) {
        postprocessed = true;
        if (node.parentNode != null) {
          toRemove.push(node);
        }
      }
      if (node.tagName === 'img' && node.getAttribute('src').startsWith('cid:')) {
        const cid = split(node.getAttribute('src'), ':', 1)[1];
        const relatedAttachment = attachments.filter(attach => attach[2] && attach[2]['cid'] == cid);
        if (relatedAttachment.length) {
          node.setAttribute('data-filename', relatedAttachment[0][0]);
          postprocessed = true;
        }
      }
    }
    for (const node of toRemove) {
      node.parentNode.removeChild(node);
    }
    if (postprocessed) {
      body = serializeHtml(root, 'unicode');
    }
    return { 'body': body, 'attachments': attachments }
  }
  /*
      def _message_parse_extract_payload(self, message, save_original=false):
          """Extract body as HTML and attachments from the mail message"""
          attachments = []
          body = u''
          if save_original:
              attachments.append(self._Attachment('original_email.eml', message.as_string(), {}))
    
          # Be careful, content-type may contain tricky content like in the
          # following example so test the MIME type with startsWith()
          #
          # Content-Type: multipart/related;
          #   boundary="_004_3f1e4da175f349248b8d43cdeb9866f1AMSPR06MB343eurprd06pro_";
          #   type="text/html"
          if message.get_content_maintype() == 'text':
              encoding = message.get_content_charset()
              body = message.get_content()
              body = tools.ustr(body, encoding, errors='replace')
              if message.get_content_type() == 'text/plain':
                  # text/plain -> <pre/>
                  body = tools.append_content_to_html(u'', body, preserve=true)
              elif message.get_content_type() == 'text/html':
                  # we only strip_classes here everything else will be done in by html field of mail.message
                  body = tools.html_sanitize(body, sanitize_tags=false, strip_classes=true)
          else:
              alternative = false
              mixed = false
              html = u''
              for part in message.walk():
                  if part.get_content_type() == 'binary/octet-stream':
                      _logger.warning("Message containing an unexpected Content-Type 'binary/octet-stream', assuming 'application/octet-stream'")
                      part.replace_header('Content-Type', 'application/octet-stream')
                  if part.get_content_type() == 'multipart/alternative':
                      alternative = true
                  if part.get_content_type() == 'multipart/mixed':
                      mixed = true
                  if part.get_content_maintype() == 'multipart':
                      continue  # skip container
    
                  filename = part.get_filename()  # I may not properly handle all charsets
                  if part.get_content_type() == 'text/xml' and not part.get_param('charset'):
                      # for text/xml with omitted charset, the charset is assumed to be ASCII by the `email` module
                      # although the payload might be in UTF8
                      part.set_charset('utf-8')
                  encoding = part.get_content_charset()  # None if attachment
    
                  content = part.get_content()
                  info = {'encoding': encoding}
                  # 0) Inline Attachments -> attachments, with a third part in the tuple to match cid / attachment
                  if filename and part.get('content-id'):
                      info['cid'] = part.get('content-id').strip('><')
                      attachments.append(self._Attachment(filename, content, info))
                      continue
                  # 1) Explicit Attachments -> attachments
                  if filename or part.get('content-disposition', '').strip().startsWith('attachment'):
                      attachments.append(self._Attachment(filename or 'attachment', content, info))
                      continue
                  # 2) text/plain -> <pre/>
                  if part.get_content_type() == 'text/plain' and (not alternative or not body):
                      body = tools.append_content_to_html(body, tools.ustr(content,
                                                                           encoding, errors='replace'), preserve=true)
                  # 3) text/html -> raw
                  elif part.get_content_type() == 'text/html':
                      # mutlipart/alternative have one text and a html part, keep only the second
                      # mixed allows several html parts, append html content
                      append_content = not alternative or (html and mixed)
                      html = tools.ustr(content, encoding, errors='replace')
                      if not append_content:
                          body = html
                      else:
                          body = tools.append_content_to_html(body, html, plaintext=false)
                      # we only strip_classes here everything else will be done in by html field of mail.message
                      body = tools.html_sanitize(body, sanitize_tags=false, strip_classes=true)
                  # 4) Anything else -> attachment
                  else:
                      attachments.append(self._Attachment(filename or 'attachment', content, info))
    
          return self._message_parse_extract_payload_postprocess(message, {'body': body, 'attachments': attachments})
    
      def _message_parse_extract_bounce(self, email_message, message_dict):
          """ Parse email and extract bounce information to be used in future
          processing.
    
          :param email_message: an email.message instance;
          :param message_dict: dictionary holding already-parsed values;
    
          :return dict: bounce-related values will be added, containing
    
            * bounced_email: email that bounced (normalized);
            * bounce_partner: res.partner recordset whose email_normalized =
              bounced_email;
            * bounced_msg_id: list of message_ID references (<...@myserver>) linked
              to the email that bounced;
            * bounced_message: if found, mail.message recordset matching bounced_msg_id;
          """
          if not isinstance(email_message, EmailMessage):
              throw new TypeError('message must be an email.message.EmailMessage at this point')
    
          email_part = next((part for part in email_message.walk() if part.get_content_type() in {'message/rfc822', 'text/rfc822-headers'}), None)
          dsn_part = next((part for part in email_message.walk() if part.get_content_type() == 'message/delivery-status'), None)
    
          bounced_email = false
          bounced_partner = this.env.items('res.partner'].sudo()
          if dsn_part and len(dsn_part.get_payload()) > 1:
              dsn = dsn_part.get_payload()[1]
              final_recipient_data = tools.decode_message_header(dsn, 'Final-Recipient')
              # old servers may hold void or invalid Final-Recipient header
              if final_recipient_data and ";" in final_recipient_data:
                  bounced_email = tools.email_normalize(final_recipient_data.split(';', 1)[1].strip())
              if bounced_email:
                  bounced_partner = this.env.items('res.partner'].sudo().search([('email_normalized', '=', bounced_email)])
    
          bounced_msg_id = false
          bounced_message = this.env.items('mail.message'].sudo()
          if email_part:
              if email_part.get_content_type() == 'text/rfc822-headers':
                  # Convert the message body into a message itself
                  email_payload = message_from_string(email_part.get_content(), policy=policy.SMTP)
              else:
                  email_payload = email_part.get_payload()[0]
              bounced_msg_id = tools.mail_header_msgid_re.findall(tools.decode_message_header(email_payload, 'Message-Id'))
              if bounced_msg_id:
                  bounced_message = this.env.items('mail.message'].sudo().search([('messageId', 'in', bounced_msg_id)])
    
          return {
              'bounced_email': bounced_email,
              'bounced_partner': bounced_partner,
              'bounced_msg_id': bounced_msg_id,
              'bounced_message': bounced_message,
          }
    
      @api.model
      def message_parse(self, message, save_original=false):
          """ Parses an email.message.Message representing an RFC-2822 email
          and returns a generic dict holding the message details.
    
          :param message: email to parse
          :type message: email.message.Message
          :param bool save_original: whether the returned dict should include
              an ``original`` attachment containing the source of the message
          :rtype: dict
          :return: A dict with the following structure, where each field may not
              be present if missing in original message::
    
              { 'messageId': msg_id,
                'subject': subject,
                'email_from': from,
                'to': to + delivered-to,
                'cc': cc,
                'recipients': delivered-to + to + cc + resent-to + resent-cc,
                'partner_ids': partners found based on recipients emails,
                'body': unified_body,
                'references': references,
                'in_reply_to': in-reply-to,
                'parentId': parent mail.message based on in_reply_to or references,
                'isInternal': answer to an internal message (note),
                'date': date,
                'attachments': [('file1', 'bytes'),
                                ('file2', 'bytes')}
              }
          """
          if not isinstance(message, EmailMessage):
              throw new ValueError(await this._t('Message should be a valid EmailMessage instance'))
          msg_dict = {'messageType': 'email'}
    
          messageId = message.get('Message-Id')
          if not messageId:
              # Very unusual situation, be we should be fault-tolerant here
              messageId = "<%s@localhost>" % time.time()
              _logger.debug('Parsing Message without message-id, generating a random one: %s', messageId)
          msg_dict['messageId'] = messageId.strip()
    
          if message.get('Subject'):
              msg_dict['subject'] = tools.decode_message_header(message, 'Subject')
    
          email_from = tools.decode_message_header(message, 'From', separator=',')
          email_cc = tools.decode_message_header(message, 'cc', separator=',')
          email_from_list = tools.email_split_and_format(email_from)
          email_cc_list = tools.email_split_and_format(email_cc)
          msg_dict['email_from'] = email_from_list[0] if email_from_list else email_from
          msg_dict['from'] = msg_dict['email_from']  # compatibility for message_new
          msg_dict['cc'] = ','.join(email_cc_list) if email_cc_list else email_cc
          # Delivered-To is a safe bet in most modern MTAs, but we have to fallback on To + Cc values
          # for all the odd MTAs out there, as there is no standard header for the envelope's `rcpt_to` value.
          msg_dict['recipients'] = ','.join(set(formatted_email
              for address in [
                  tools.decode_message_header(message, 'Delivered-To', separator=','),
                  tools.decode_message_header(message, 'To', separator=','),
                  tools.decode_message_header(message, 'Cc', separator=','),
                  tools.decode_message_header(message, 'Resent-To', separator=','),
                  tools.decode_message_header(message, 'Resent-Cc', separator=',')
              ] if address
              for formatted_email in tools.email_split_and_format(address))
          )
          msg_dict['to'] = ','.join(set(formatted_email
              for address in [
                  tools.decode_message_header(message, 'Delivered-To', separator=','),
                  tools.decode_message_header(message, 'To', separator=',')
              ] if address
              for formatted_email in tools.email_split_and_format(address))
          )
          partner_ids = [x.id for x in self._mailFindPartnerFromEmails(tools.email_split(msg_dict['recipients']), records=self) if x]
          msg_dict['partner_ids'] = partner_ids
          # compute references to find if email_message is a reply to an existing thread
          msg_dict['references'] = tools.decode_message_header(message, 'References')
          msg_dict['in_reply_to'] = tools.decode_message_header(message, 'In-Reply-To').strip()
    
          if message.get('Date'):
              try:
                  date_hdr = tools.decode_message_header(message, 'Date')
                  parsed_date = dateutil.parser.parse(date_hdr, fuzzy=true)
                  if parsed_date.utcoffset() is None:
                      # naive datetime, so we arbitrarily decide to make it
                      # UTC, there's no better choice. Should not happen,
                      # as RFC2822 requires timezone offset in Date headers.
                      stored_date = parsed_date.replace(tzinfo=pytz.utc)
                  else:
                      stored_date = parsed_date.astimezone(tz=pytz.utc)
              except Exception:
                  _logger.info('Failed to parse Date header %r in incoming mail '
                               'with message-id %r, assuming current date/time.',
                               message.get('Date'), messageId)
                  stored_date = datetime.datetime.now()
              msg_dict['date'] = stored_date.strftime(tools.DEFAULT_SERVER_DATETIME_FORMAT)
    
          parent_ids = false
          if msg_dict['in_reply_to']:
              parent_ids = this.env.items('mail.message'].search(
                  [('messageId', '=', msg_dict['in_reply_to'])],
                  order='createdAt DESC, id DESC',
                  limit=1)
          if msg_dict['references'] and not parent_ids:
              references_msg_id_list = tools.mail_header_msgid_re.findall(msg_dict['references'])
              parent_ids = this.env.items('mail.message'].search(
                  [('messageId', 'in', [x.strip() for x in references_msg_id_list])],
                  order='createdAt DESC, id DESC',
                  limit=1)
          if parent_ids:
              msg_dict['parentId'] = parent_ids.id
              msg_dict['isInternal'] = parent_ids.subtypeId and parent_ids.subtypeId.internal or false
    
          msg_dict.update(self._message_parse_extract_payload(message, save_original=save_original))
          msg_dict.update(self._message_parse_extract_bounce(message, msg_dict))
          return msg_dict
    */

  // RECIPIENTS MANAGEMENT TOOLS

  /**
   * Called by _message_get_suggested_recipients, to add a suggested
          recipient in the result dictionary. The form is :
              partnerId, partner_name<partner_email> or partner_name, reason
   * @param result 
   * @param partner 
   * @param email 
   * @param reason 
   * @returns 
   */
  async _messageAddSuggestedRecipient(result, opts: { partner?: any, email?: any, reason?: any } = {}) {
    this.ensureOne();
    let partner = opts.partner;
    const email = opts.email;
    const reason = opts.reason ?? '';
    const partnerInfo = {};
    if (email && !bool(partner)) {
      // get partner info from email
      const partnerInfo = (await this._messagePartnerInfoFromEmails([email]))[0];
      if (partnerInfo['partnerId']) {
        partner = (await this.env.items('res.partner').sudo()).browse([partnerInfo['partnerId']])[0];
      }
    }
    if (email && result[this.ids[0]].map(val => val[1]).includes(email)) { // already existing email -> skip
      return result;
    }
    const hasPartner = bool(partner);
    if (hasPartner && (await this['messagePartnerIds']).includes(partner)) {  // recipient already in the followers -> skip
      return result;
    }
    if (hasPartner && result[this.ids[0]].map(val => val[0]).includes(partner.id)) {  // already existing partner ID -> skip
      return result;
    }
    if (hasPartner && await partner.email) {  // complete profile: id, name <email>
      result[this.ids[0]].push([partner.id, await partner.emailFormatted, reason]);
    }
    else if (hasPartner) {  // incomplete profile: id, name
      result[this.ids[0]].push([partner.id, await partner.label, reason]);
    }
    else {  // unknown partner, we are probably managing an email address
      result[this.ids[0]].push([false, partnerInfo['fullName'] || email, reason]);
    }
    return result;
  }

  /**
   * Returns suggested recipients for ids. Those are a list of tuple (partnerId, partner_name, reason), to be managed by Chatter.
   * @returns 
   */
  async _messageGetSuggestedRecipients() {
    const result = Object.fromEntries(this.ids.map(id => [id, []]));
    if ('userId' in this._fields) {
      for (const obj of await this.sudo()) {  // SUPERUSER because of a read on res.users that would crash otherwise
        const userId = await obj.userId;
        if (!userId.ok || !(await userId.partnerId).ok) {
          continue;
        }
        await obj._messageAddSuggestedRecipient(result, { partner: await userId.partnerId, reason: this._fields['userId'].string });
      }
    }
    return result;
  }

  /**
   * Find partners linked to users, given an email address that will
      be normalized. Search is done as sudo on res.users model to avoid domain
      on partner like ('user_ids', '!=', false) that would not be efficient.
   * @param normalizedEmails 
   * @param extraDomain 
   * @returns 
   */
  async _mailSearchOnUser(normalizedEmails: string[], extraDomain?: any[]) {
    let domain = [['emailNormalized', 'in', normalizedEmails]];
    if (bool(extraDomain)) {
      domain = expression.AND([domain, extraDomain]);
    }
    const partners = await (await (this.env.items('res.users').sudo()).search(domain)).mapped('partnerId');
    // return a search on partner to filter results current user should not see (multi company for example)
    return this.env.items('res.partner').search([['id', 'in', partners.ids]]);
  }

  async _mailSearchOnPartner(normalizedEmails: string[], extraDomain?: any[]) {
    let domain = [['emailNormalized', 'in', normalizedEmails]];
    if (bool(extraDomain)) {
      domain = expression.AND([domain, extraDomain]);
    }
    return this.env.items('res.partner').search(domain);
  }


  /**
   * Utility method to find user from email address that can create documents
        in the target model. Purpose is to link document creation to users whenever
        possible, for example when creating document through mailgateway.
  
        Heuristic
  
          * alias owner record: fetch in its followers for user with matching email;
          * find any user with matching emails;
          * try alias owner as fallback;
  
        Note that standard search order is applied.
  
        :param str email: will be sanitized and parsed to find email;
        :param mail.alias alias: optional alias. Used to fetch owner followers
          or fallback user (alias owner);
        :param fallback_model: if not alias, related model to check access rights;
  
        :return res.user user: user matching email or void recordset if none found
   * @param email 
   * @param alias 
   * @returns 
   */
  async _mailFindUserForGateway(email, alias?: any) {
    // find normalized emails and exclude aliases (to avoid subscribing alias emails to records)
    const normalizedEmail = emailNormalize(email);
    if (!normalizedEmail) {
      return this.env.items('res.users');
    }
    const catchallDomain = await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.catchall.domain");
    if (catchallDomain) {
      const leftPart = normalizedEmail.split('@')[1] === catchallDomain.toLowerCase() ? normalizedEmail.split('@')[0] : false;
      if (leftPart) {
        if (await (await this.env.items('mail.alias').sudo()).searchCount([['aliasName', '=', leftPart]])) {
          return this.env.items('res.users');
        }
      }
    }
    let followers;
    if (bool(alias) && bool(await alias.aliasParentModelId) && bool(await alias.aliasParentThreadId)) {
      followers = await (await this.env.items('mail.followers').search([
        ['resModel', '=', await (await (await alias.aliasParentModelId).sudo()).model],
        ['resId', '=', await alias.aliasParentThreadId]]
      )).mapped('partnerId');
    }
    else {
      followers = this.env.items('res.partner');
    }
    const followerUsers = bool(followers) ? await this.env.items('res.users').search([
      ['partnerId', 'in', followers.ids], ['emailNormalized', '=', normalizedEmail]
    ], { limit: 1 }) : this.env.items('res.users');
    let matchingUser = bool(followerUsers) ? followerUsers[0] : this.env.items('res.users');
    if (bool(matchingUser)) {
      return matchingUser;
    }

    if (!bool(matchingUser)) {
      const stdUsers = await (await this.env.items('res.users').sudo()).search([['emailNormalized', '=', normalizedEmail]], { limit: 1 });
      matchingUser = bool(stdUsers) ? stdUsers[0] : this.env.items('res.users');
    }
    if (bool(matchingUser)) {
      return matchingUser;
    }

    if (!bool(matchingUser) && bool(alias) && bool(await alias.aliasUserId)) {
      matchingUser = alias.and(await alias.aliasUserId);
    }
    // if (bool(matchingUser)) {
    //     return matchingUser;
    // }

    return matchingUser;
  }

  /**
   * Utility method to find partners from email addresses. If no partner is
      found, create new partners if force_create is enabled. Search heuristics

        * 0: clean incoming email list to use only normalized emails. Exclude
             those used in aliases to avoid setting partner emails to emails
             used as aliases;
        * 1: check in records (record set) followers if records is mail.thread
             enabled and if check_followers parameter is enabled;
        * 2: search for partners with user;
        * 3: search for partners;

      :param records: record set on which to check followers;
      :param list emails: list of email addresses for finding partner;
      :param boolean force_create: create a new partner if not found

      :return list partners: a list of partner records ordered as given emails.
        If no partner has been found and/or created for a given emails its
        matching partner is an empty record.
   * @param emails 
   * @param records 
   * @param forcecreate 
   * @param extraDomain 
   */
  @api.model()
  async _mailFindPartnerFromEmails(emails, options: { records?: any, forcecreate?: boolean, extraDomain?: any } = {}): Promise<any[]> {
    let followers;
    const records = options.records;
    if (records && isSubclass(records, this.pool.models['mail.thread'])) {
      followers = await records.mapped('messagePartnerIds');
    }
    else {
      followers = this.env.items('res.partner');
    }
    const catchallDomain = await (await this.env.items('ir.config.parameter').sudo()).getParam("mail.catchall.domain");

    // first, build a normalized email list and remove those linked to aliases to avoid adding aliases as partners. In case of multi-email input, use the first found valid one to be tolerant against multi emails encoding
    let normalizedEmails = emails.map(contact => emailNormalize(contact, false)).filter(contact => contact);
    if (catchallDomain) {
      const domainLeftParts = normalizedEmails.filter(email => email.split('@')[1] === catchallDomain.toLowerCase()).map(email => email.split('@')[0]);
      if (domainLeftParts.length) {
        const foundAliasNames = await (await (await this.env.items('mail.alias').sudo()).search([['aliasName', 'in', domainLeftParts]])).mapped('aliasName');
        normalizedEmails = normalizedEmails.filter(email => !foundAliasNames.includes(email.split('@')[0]));
      }
    }
    let donePartners = await followers.filter(async (follower) => normalizedEmails.includes(await follower.emailNormalized));

    async function filterEmails(): Promise<string[]> {
      let result = [];
      for (const email of normalizedEmails) {
        for (const partner of donePartners) {
          if (email !== await partner.emailNormalized) {
            result.push(email);
          }
        }
      }
      return result;
    }

    let remaining = await filterEmails();

    const userPartners = await this._mailSearchOnUser(remaining, options.extraDomain);
    donePartners = donePartners.concat(...userPartners);
    remaining = await filterEmails();

    let partners = await this._mailSearchOnPartner(remaining, options.extraDomain);
    donePartners = donePartners.concat(...partners);
    remaining = await filterEmails();

    // iterate and keep ordering
    partners = [];
    for (const contact of emails) {
      const normalizedEmail = emailNormalize(contact, false);
      let partner = next(await donePartners.filter(async (partner) => await partner.emailNormalized === normalizedEmail), this.env.items('res.partner'));
      if (!bool(partner) && options.forcecreate && normalizedEmails.includes(normalizedEmail)) {
        partner = this.env.items('res.partner').browse((await this.env.items('res.partner').nameCreate(contact))[0]);
      }
      partners.append(partner);
    }
    return partners;
  }
  /**
   * Convert a list of emails into a list partner_ids and a list
    new_partner_ids. The return value is non conventional because it is meant to be used by the mail widget.

      :return dict: partner_ids and new_partner_ids 
   * @param emails 
   * @param linkMail 
   * @returns 
   */
  async _messagePartnerInfoFromEmails(emails, linkMail: any = false) {
    this.ensureOne();
    const MailMessage = await this.env.items('mail.message').sudo();
    const partners = this._mailFindPartnerFromEmails(emails, { records: this });
    const result = [];
    for (const [idx, contact] of enumerate(emails)) {
      const partner = partners[idx];
      const partnerInfo = { 'fullName': partner.ok ? partner.emailFormatted : contact, 'partnerId': partner.id }
      result.push(partnerInfo);
      // link mail with this from mail to the new partner id
      if (linkMail && partner.ok) {
        await (await MailMessage.search([
          ['emailFrom', '=ilike', await partner.emailNormalized],
          ['authorId', '=', false]
        ])).write({ 'authorId': partner.id });
      }
    }
    return result;
  }

  // MESSAGE POST API
  // ------------------------------------------------------

  /**
   * Preprocess attachments for mail_thread.messagePost() or mail_mail.create().
 
      :param list attachments: list of attachment tuples in the form ``(name,content)``, #todo xdo update that
                               where content is NOT base64 encoded
      :param list attachmentIds: a list of attachment ids, not in tomany command form
      :param dict messageData: model: the model of the attachments parent record,
        resId: the id of the attachments parent record
   * @param attachments 
   * @param attachmentIds 
   * @param messageValues 
   */
  async _messagePostProcessAttachments(attachments: any[], attachmentIds: number[], messageValues: {} = {}) {
    const returnValues = {};
    const body = messageValues['body'];
    const model = messageValues['model'];
    const resId = messageValues['resId'];

    let m2mAttachmentIds = [];
    if (bool(attachmentIds)) {
      // taking advantage of cache looks better in this case, to check
      const filteredAttachmentIds = await (await this.env.items('ir.attachment').sudo()).browse(attachmentIds).filtered(async (a) => await a.resModel === 'mail.compose.message' && (await a.createdUid).id === this._uid);
      // update filtered (pending) attachments to link them to the proper record
      if (filteredAttachmentIds.ok) {
        await filteredAttachmentIds.write({ 'resModel': model, 'resId': resId });
      }
      // prevent public and portal users from using attachments that are not theirs
      if (! await (await this.env.user()).hasGroup('base.groupUser')) {
        attachmentIds = filteredAttachmentIds.ids;
      }

      m2mAttachmentIds = m2mAttachmentIds.concat(attachmentIds.map(id => Command.link(id)));
    }
    // Handle attachments parameter, that is a dictionary of attachments

    if (bool(attachments)) { // generate
      const cidsInBody = new Set();
      const namesInBody = new Set();
      const cidList = []
      const nameList = []

      let root: Element;
      if (body) {
        root = documentFromString(ustr(body)) as any;
        // first list all attachments that will be needed in body
        for (const node of iterchildren(root, 'img')) {
          if (getAttribute(node, 'src', '').startsWith('cid:')) {
            cidsInBody.add(node.getAttribute('src').split('cid:')[1]);
          }
          else if (node.getAttribute('data-filename')) {
            namesInBody.add(node.getAttribute('data-filename'));
          }
        }
      }
      const attachementValuesList = [];

      // generate values
      for (const attachment of attachments) {
        let label, content, info, cid;// = false
        if (attachment.length == 2) {
          [label, content] = attachment;
          info = {};
        }
        else if (attachment.length == 3) {
          [label, content, info] = attachment;
          cid = info && info['cid'];
        }
        else {
          continue;
        }
        if (typeof (content) === 'string') {
          const encoding = info && info['encoding'] || 'utf8';
          try {
            content = Buffer.from(content, encoding).toString();
          } catch (e) {
            if (isInstance(e, UnicodeEncodeError)) {
              content = Buffer.from(content).toString('utf8');
            }
          }
        }
        else if (isInstance(content, EmailMessage)) {
          content = (content as EmailMessage).asBytes();
        }
        else if (content == null) {
          continue;
        }
        const attachementValues = {
          'label': label,
          'datas': b64encode(content),
          'type': 'binary',
          'description': label,
          'resModel': model,
          'resId': resId,
        }
        if (body && (cid && cidsInBody.has(cid) || namesInBody.has(label))) {
          attachementValues['accessToken'] = await this.env.items('ir.attachment')._generateAccessToken();
        }
        attachementValuesList.push(attachementValues);
        // keep cid and name list synced with attachement_values_list length to match ids latter
        cidList.push(cid);
        nameList.push(label);
      }
      const newAttachments = await this.env.items('ir.attachment').create(attachementValuesList);
      const cidMapping = {};
      const nameMapping = {};
      for (const [counter, newAttachment] of enumerate(newAttachments)) {
        const cid = cidList[counter];
        if ('accessToken' in attachementValuesList[counter]) {
          if (cid) {
            cidMapping[cid] = [newAttachment.id, attachementValuesList[counter]['accessToken']];
          }
          const label = nameList[counter];
          nameMapping[label] = [newAttachment.id, attachementValuesList[counter]['accessToken']];
        }
        m2mAttachmentIds.push([4, newAttachment.id]);
      }
      // note: right know we are only taking attachments and ignoring attachment_ids.
      if ((bool(cidMapping) || bool(nameMapping)) && body) {
        let postprocessed = false;
        for (const node of iterchildren(root, 'img')) {
          let attachmentData = false;
          if (getAttribute(node, 'src', '').startsWith('cid:')) {
            const cid = node.getAttribute('src').split('cid:')[1];
            attachmentData = cidMapping[cid];
          }
          if (!attachmentData && node.getAttribute('data-filename')) {
            attachmentData = nameMapping[node.getAttribute('data-filename')] || false;
          }
          if (attachmentData) {
            node.setAttribute('src', f('/web/image/%s?accessToken=%s', attachmentData));
            postprocessed = true;
          }
        }
        if (postprocessed) {
          returnValues['body'] = serializeHtml(root, 'unicode');
        }
      }
    }
    returnValues['attachmentIds'] = m2mAttachmentIds
    return returnValues;
  }
  /**
   * Post a new message in an existing thread, returning the new
        mail.message ID.
        :param str body: body of the message, usually raw HTML that will
            be sanitized
        :param str subject: subject of the message
        :param str messageType: see mail_message.messageType field. Can be anything but
            user_notification, reserved for message_notify
        :param int parentId: handle thread formation
        :param int subtypeId: subtypeId of the message, used mainly use for
            followers notification mechanism;
        :param list(int) partner_ids: partner_ids to notify in addition to partners
            computed based on subtype / followers matching;
        :param list(tuple(str,str), tuple(str,str, dict) or int) attachments : list of attachment tuples in the form
            ``(name,content)`` or ``(name,content, info)``, where content is NOT base64 encoded
        :param list id attachment_ids: list of existing attachement to link to this message
            -Should only be setted by chatter
            -Attachement object attached to mail.compose.message(0) will be attached
                to the related document.
        Extra keyword arguments will be used as default column values for the
        new mail.message record.
        :return int: ID of newly created mail.message
   * @param options 
   */
  @api.returns('mail.message', (value) => value.id)
  async messagePost(options: string | any | {
    body?: string, subject?: string, messageType?: string,
    emailFrom?: string, authorId?: number, parentId?: number,
    subtypeXmlid?: number, subtypeId?: number, partnerIds?: number[],
    attachments?: any[], attachmentIds?: number[],
    addSign?: boolean, recordName?: any
  }) {
    if (typeof (options) === 'string') {
      options = { body: options }
    } else {
      options = setOptions(options, { body: '', messageType: 'notification', addSign: true });
    }
    this.ensureOne();  // should always be posted on a record, use message_notify if no record
    // split message additional values from notify additional values
    const msgOptions = {};
    const notifOptions = {};
    for (const key of Object.keys(options)) {
      if (key in this.env.models['mail.message']._fields) {
        msgOptions[key] = options[key];
      }
      else {
        notifOptions[key] = options[key];
      }
    }

    // preliminary value safety check
    const partnerIds = options.partnerIds ?? [];
    if (this._name === 'mail.thread' || !bool(this.id) || options.messageType === 'userNotification') {
      throw new ValueError(await this._t('Posting a message should be done on a business document. Use message_notify to send a notification to an user.'));
    }
    if ('channelIds' in options) {
      throw new ValueError(await this._t("Posting a message with channels as listeners is not supported since Verp 14.3+. Please update code accordingly."));
    }
    if ('model' in msgOptions || 'resId' in msgOptions) {
      throw new ValueError(await this._t("messagePost does not support model and resId parameters anymore. Please call messagePost on record."));
    }
    if ('subtype' in options) {
      throw new ValueError(await this._t("messagePost does not support subtype parameter anymore. Please give a valid subtypeId or subtypeXmlid value instead."));
    }
    if (partnerIds.some(pcId => typeof (pcId) !== 'number')) {
      throw new ValueError(await this._t('messagePost partner_ids and must be integer list, not commands.'));
    }

    const self = await this._fallbackLang(); // add lang to context imediatly since it will be usefull in various flows latter.

    // Explicit access rights check, because displayName is computed as sudo.
    await self.checkAccessRights('read');
    await self.checkAccessRule('read');
    const recordName = options.recordName || await self['displayName'];

    // Find the message's author
    const guest = await self.env.items('mail.guest')._getGuestFromContext();
    let authorGuestId;
    if (await (await self.env.user())._isPublic() && bool(guest)) {
      authorGuestId = guest.id
      [options.authorId, options.emailFrom] = [false, false];
    }
    else {
      authorGuestId = false;
      [options.authorId, options.emailFrom] = await self._messageComputeAuthor(options.authorId, options.emailFrom, true);//throw newException=true)
    }

    if (options.subtypeXmlid) {
      options.subtypeId = await self.env.items('ir.model.data')._xmlidToResId(options.subtypeXmlid);
    }
    if (!options.subtypeId) {
      options.subtypeId = await self.env.items('ir.model.data')._xmlidToResId('mail.mtNote');
    }
    // automatically subscribe recipients if asked to
    if (self._context['mailPostAutofollow'] && partnerIds.length) {
      await self.messageSubscribe(partnerIds);
    }

    const values = Object.assign({}, msgOptions);
    update(values, {
      'authorId': options.authorId,
      'authorGuestId': authorGuestId,
      'emailFrom': options.emailFrom,
      'model': self._name,
      'resId': self.id,
      'body': options.body,
      'subject': options.subject || false,
      'messageType': options.messageType,
      'parentId': await self._messageComputeParentId(options.parentId),
      'subtypeId': options.subtypeId,
      'partnerIds': partnerIds,
      'addSign': options.addSign,
      'recordName': recordName,
    })
    const attachments = options.attachments ?? [];
    const attachmentIds = options.attachmentIds ?? [];
    const attachementValues = await this._messagePostProcessAttachments(attachments, attachmentIds, values);
    update(values, attachementValues);  // attachement_ids, [body]

    const newMessage = await self._messageCreate(values);

    // Set main attachment field if necessary
    await self._messageSetMainAttachmentId(values['attachmentIds']);

    if (values['authorId'] && values['messageType'] !== 'notification' && !self._context['mailCreateNosubscribe']) {
      if (await self.env.items('res.partner').browse(values['authorId']).active) { // we dont want to add verpbot/inactive as a follower
        await self._messageSubscribe([values['authorId']]);
      }
    }
    await self._messagePostAfterHook(newMessage, values);
    await self._notifyThread(newMessage, values, notifOptions);
    return newMessage;
  }

  async _messageSetMainAttachmentId(attachmentIds: any[]) {  // todo move this out of mail.thread
    if (!this.cls._abstract && bool(attachmentIds) && !bool(await this['messageMainAttachmentId'])) {
      const allAttachments = this.env.items('ir.attachment').browse(attachmentIds.map(attachment => attachment[1]));
      const prioritaryAttachments = await allAttachments.filtered(async (x) => (await x.mimetype).endsWith('pdf'))
        || await allAttachments.filtered(async (x) => (await x.mimetype).startsWith('image')) || bool(allAttachments);
      await (await (await this.sudo()).withContext({ trackingDisable: true })).write({ 'messageMainAttachmentId': prioritaryAttachments[0].id });
    }
  }

  /**
   * Hook to add custom behavior after having posted the message. Both
        message and computed value are given, to try to lessen query count by
        using already-computed values instead of having to rebrowse things.
   * @param message 
   * @param msgVals 
   */
  async _messagePostAfterHook(message, msgVals) {
  }

  /**
   * Hook to add custom behavior after having updated the message content.
   * @param message 
   */
  async _messageUpdateContentAfterHook(message) {

  }

  /**
   * Hook to add custom behavior after having added a reaction to a message.
   * @param message 
   * @param content 
   */
  async _messageAddReactionAfterHook(message, content) {

  }

  /**
   * Hook to add custom behavior after having removed a reaction from a message.
   * @param message 
   * @param content 
   */
  async _messageRemoveReactionAfterHook(message, content) {
  }

  /**
   * Checks that the current user can update the content of the message.
   * @param message 
   */
  async _checkCanUpdateMessageContent(message) {
    const noteId = await this.env.items('ir.model.data')._xmlidToResId('mail.mtNote');
    if (!(await message.subtypeId).id == noteId) {
      throw new UserError(await this._t("Only logged notes can have their content updated on model '%s'", this._name));
    }
    if ((await message.trackingValueIds).ok) {
      throw new UserError(await this._t("Messages with tracking values cannot be modified"));
    }
    if (await message.messageType !== 'comment') {
      throw new UserError(await this._t("Only messages type comment can have their content updated"))
    }
  }

  // MESSAGE POST TOOLS

  /**
   * Helper method to send a mail / post a message / log a note using
      a viewId to render using the ir.qweb engine. This method is stand
      alone, because there is nothing in template and composer that allows
      to handle views in batch. This method should probably disappear when
      templates handle ir ui views.
   * @param viewsOrXmlid 
   * @param messageLog 
   * @param options 
   */

  async _messageComposeWithView(req, viewsOrXmlid, messageLog: boolean = false, options: {} = {}) {
    const values = pop(options, 'values', null) || {};
    try {
      // const slug = require('verp.addons.http_routing.models.ir_http');
      values['slug'] = slug;
    } catch (e) {
      // except ImportError:
      values['slug'] = (self) => self.id;
    }
    let views;
    if (typeof (viewsOrXmlid) === 'string') {
      views = await this.env.ref(viewsOrXmlid, false);
    }
    else {
      views = viewsOrXmlid;
    }
    if (bool(views)) {
      return;
    }

    let messagesAsSudo = this.env.items('mail.message');
    for (const record of this) {
      values['object'] = record
      const renderedTemplate = await views._render(values, 'ir.qweb', true);
      if (messageLog) {
        options['body'] = renderedTemplate;
        messagesAsSudo = messagesAsSudo.add(await record._messageLog(options));
      }
      else {
        options['body'] = renderedTemplate;
        await record.messagePostWithTemplate(false, options);
      }
    }

    return messagesAsSudo;
  }

  /**
   * Helper method to send a mail / post a message using a viewId 
   * @param viewsOrXmlid 
   * @param options 
   */
  async messagePostWithView(viewsOrXmlid, options: {} = {}) {
    await this._messageComposeWithView(viewsOrXmlid, options);
  }

  /**
   * Helper method to send a mail with a template
          :param template_id : the id of the template to render to create the body of the message
          :param **options : parameter to create a mail.compose.message woaerd (which inherit from mail.message)
   * @param templateId 
   * @param options 
   * @returns 
   */
  async messagePostWithTemplate(templateId, options: { emailLayoutXmlid?: any, autoCommit?: boolean } = {}) {
    // Get composition mode, or force it according to the number of record in self
    if (!options['compositionMode']) {
      options['compositionMode'] = len(this.ids) == 1 ? 'comment' : 'massMail';
    }
    if (!options['messageType']) {
      options['messageType'] = 'notification';
    }
    const resId = options['resId'] || bool(this.ids) && bool(this.ids[0]) && this.ids[0] || 0;
    const resIds = options['resId'] && [options['resId']] || this.ids;

    // Create the composer
    const composer = await (await this.env.items('mail.compose.message').withContext({
      activeId: resId,
      activeIds: resIds,
      activeModel: options['model'] || this._name,
      default_compositionMode: options['compositionMode'],
      default_model: options['model'] || this._name,
      default_resId: resId,
      default_templateId: templateId,
      customLayout: options.emailLayoutXmlid,
    })).create(options);
    // Simulate the onchange (like trigger in form the view) only
    // when having a template in single-email mode
    if (bool(templateId)) {
      const updateValues = await composer._onchangeTemplateId(templateId, options['compositionMode'], this._name, resId)['value'];
      await composer.write(updateValues);
    }
    return composer._actionSendMail(options.autoCommit);
  }

  /**
   * Shortcut allowing to notify partners of messages that shouldn't be
      displayed on a document. It pushes notifications on inbox or by email depending
      on the user configuration, like other notifications.
   * @param options 
   * @param partnerIds 
   * @param parentId 
   * @param model 
   * @param resId 
   * @param authorId 
   * @param emailFrom 
   * @param body 
   * @param subject 
   */
  async messageNotify(options: {
    partnerIds?: any, parentId?: any, model?: any, resId?: any,
    authorId?: any, emailFrom?: any, body?: string, subject?: any
  } = {}) {
    if (this.ok) {
      this.ensureOne();
    }
    // split message additional values from notify additional values
    const msgKwargs = Object.fromEntries(Object.keys(options).filter(key => key in this.env.models['mail.message']._fields).map(key => [key, options[key]]));
    const notifKwargs = Object.fromEntries(Object.keys(options).filter(key => !(key in msgKwargs)).map(key => [key, options[key]]));

    const [authorId, emailFrom] = await this._messageComputeAuthor(options.authorId, options.emailFrom, true);

    if (!bool(options.partnerIds)) {
      console.warn('Message notify called without recipient_ids, skipping');
      return this.env.items('mail.message');
    }
    if (!(options.model && options.resId)) {  // both value should be set or none should be set (record)
      options.model = false;
      options.resId = false;
    }

    const mailThread = this.env.items('mail.thread');
    const values = {
      'parentId': options.parentId,
      'model': this.ok ? this._name : options.model,
      'resId': this.ok ? this.id : options.resId,
      'messageType': 'userNotification',
      'subject': options.subject,
      'body': options.body || '',
      'authorId': authorId,
      'emailFrom': emailFrom,
      'partnerIds': options.partnerIds,
      'subtypeId': await this.env.items('ir.model.data')._xmlidToResId('mail.mtNote'),
      'isInternal': true,
      'recordName': false,
      'replyTo': (await mailThread._notifyGetReplyTo(emailFrom, null)).get(false),
      'messageId': generateTrackingMessageId('message-notify'),
    }
    update(values, msgKwargs);
    const newMessage = await mailThread._messageCreate(values);
    await mailThread._notifyThread(newMessage, values, notifKwargs);
    return newMessage;
  }

  /**
   * Helper method to log a note using a viewId without notifying followers.
   * @param viewsOrXmlid 
   * @param options 
   * @returns 
   */
  async _messageLogWithView(viewsOrXmlid, options) {
    return this._messageComposeWithView(viewsOrXmlid, true, options);
  }

  /**
   * Shortcut allowing to post note on a document. It does not perform
      any notification and pre-computes some values to have a short code
      as optimized as possible. This method is private as it does not check
      access rights and perform the message creation as sudo to speedup
      the log process. This method should be called within methods where
      access rights are already granted to avoid privilege escalation.
   * @param options 
   * @returns 
   */
  async _messageLog(options: { body?: any, authorId?: any, emailFrom?: any, subject?: any, messageType?: string } = {}) {
    this.ensureOne();
    const messageType = options.messageType || 'notification';
    const [authorId, emailFrom] = await this._messageComputeAuthor(options.authorId, options.emailFrom, false);

    const messageValues = {
      'subject': options.subject,
      'body': options.body || '',
      'authorId': authorId,
      'emailFrom': emailFrom,
      'messageType': messageType,
      'model': options['model'] || this._name,
      'resId': len(this.ids) ? this.ids[0] : false,
      'subtypeId': await this.env.items('ir.model.data')._xmlidToResId('mail.mtNote'),
      'isInternal': true,
      'recordName': false,
      'replyTo': (await this.env.items('mail.thread')._notifyGetReplyTo(emailFrom)).get(false),
      'messageId': generateTrackingMessageId('message-notify'),  // why? this is all but a notify
    }
    update(messageValues, options);
    return (await this.sudo())._messageCreate(messageValues);
  }

  /**
   * Shortcut allowing to post notes on a batch of documents. It achieve the
      same purpose as _message_log, done in batch to speedup quick note log.
 
        :param bodies: dict {record_id: body}
   * @param bodies 
   * @param options 
   * @returns 
   */
  async _messageLogBatch(bodies, options: { authorId?: any, emailFrom?: any, subject?: any, messageType?: string } = {}) {
    const messageType = options.messageType || 'notification';
    const [authorId, emailFrom] = await this._messageComputeAuthor(options.authorId, options.emailFrom, false);

    const baseMessageValues = {
      'subject': options.subject,
      'authorId': authorId,
      'emailFrom': emailFrom,
      'messageType': messageType,
      'model': this._name,
      'subtypeId': await this.env.items('ir.model.data')._xmlidToResId('mail.mtNote'),
      'isInternal': true,
      'recordName': false,
      'replyTo': (await this.env.items('mail.thread')._notifyGetReplyTo(emailFrom)).get(false),
      'messageId': generateTrackingMessageId('message-notify'),  // why? this is all but a notify
    }
    const valuesList = [];
    for (const record of this) {
      valuesList.push(Object.assign(baseMessageValues, { resId: record.id, body: bodies[record.id] || '' }));
    }
    return (await this.sudo())._messageCreate(valuesList);
  }

  /**
   * Tool method computing author information for messages. Purpose is
      to ensure maximum coherence between author / current user / email_from
      when sending emails.
   * @param authorId 
   * @param emailFrom 
   * @param newException 
   * @returns 
   */
  async _messageComputeAuthor(authorId: any, emailFrom: any, newException: boolean = true) {
    let author;
    if (authorId == null) {
      if (emailFrom) {
        author = (await this._mailFindPartnerFromEmails([emailFrom]))[0];
      }
      else {
        author = await (await this.env.user()).partnerId;
        emailFrom = await author.emailFormatted;
      }
      authorId = author.id;
    }
    if (emailFrom == null) {
      if (authorId) {
        author = this.env.items('res.partner').browse(authorId);
        emailFrom = await author.emailFormatted;
      }
    }
    // superuser mode without author email -> probably public user; anyway we don't want to crash
    if (!emailFrom && !this.env.su && newException) {
      throw new UserError(await this._t("Unable to log message, please configure the sender's email address."));
    }

    return [authorId, emailFrom];
  }

  async _messageComputeParentId(parentId?: number) {
    // parent management, depending on ``_mail_flat_thread``
    // ``_mail_flat_thread`` true: no free message. If no parent, find the first
    // posted message and attach new message to it. If parent, get back to the first
    // ancestor and attach it. We don't keep hierarchy (one level of threading).
    // ``_mail_flat_thread`` false: free message = new thread (think of mailing lists).
    // If parent get up one level to try to flatten threads without completely
    // removing hierarchy.
    const MailMessageSudo = await this.env.items('mail.message').sudo();
    if (this.cls._mailFlatThread && !parentId) {
      const parentMessage = await MailMessageSudo.search([['resId', '=', this.id], ['model', '=', this._name], ['messageType', '!=', 'userNotification']], { order: "id ASC", limit: 1 });
      // parent_message searched in sudo for performance, only used for id.
      // Note that with sudo we will match message with internal subtypes.
      parentId = parentMessage.ok ? parentMessage.id : false;
    }
    else if (parentId) {
      let currentAncestor = await MailMessageSudo.search([['id', '=', parentId], ['parentId', '!=', false]]);
      let currentAncestorParentId = await currentAncestor.parentId;
      if (this.cls._mailFlatThread) {
        if (currentAncestor.ok) {
          // avoid loops when finding ancestors
          const processedList = [];
          while (bool(currentAncestorParentId) && !processedList.includes(currentAncestorParentId.id)) {
            processedList.push(currentAncestor.id);
            currentAncestor = currentAncestorParentId;
          }
          parentId = currentAncestor.id;
        }
      }
      else {
        parentId = currentAncestorParentId.ok ? currentAncestorParentId.id : parentId;
      }
    }
    return parentId;
  }

  async _messageCreate(valuesList: any) {
    if (!isList(valuesList)) {
      valuesList = [valuesList];
    }
    const createValuesList = [];
    for (const values of valuesList) {
      const createValues = Dict.from<any>(values);
      // Avoid warnings about non-existing fields
      for (const x of ['from', 'to', 'cc', 'cannedResponseIds']) {
        createValues.pop(x, null);
      }
      createValues['partnerIds'] = createValues.get('partnerIds', []).map(pid => Command.link(pid));
      createValuesList.push(createValues);
    }
    // remove context, notably for default keys, as this thread method is not
    // meant to propagate default values for messages, only for master records
    return (await this.env.items('mail.message').withContext(cleanContext(this.env.context))).create(createValuesList);
  }

  // NOTIFICATION API
  // ------------------------------------------------------

  /**
   * Main notification method. This method basically does two things
 
       * call ``_notifyComputeRecipients`` that computes recipients to
         notify based on message record or message creation values if given
         (to optimize performance if we already have data computed);
       * performs the notification process by calling the various notification
         methods implemented;
 
      :param message: mail.message record to notify;
      :param msg_vals: dictionary of values used to create the message. If given
        it is used instead of accessing ``self`` to lessen query count in some
        simple cases where no notification is actually required;
 
      Kwargs allow to pass various parameters that are given to sub notification
      methods. See those methods for more details about the additional parameters.
      Parameters used for email-style notifications
   * @param message 
   * @param msgVals 
   * @param notifyByEmail 
   * @param options 
   * @returns 
   */
  async _notifyThread(message, msgVals?: any, options: {} = {}) {
    setOptions(options, { notifyByEmail: true });
    msgVals = msgVals ? msgVals : {};
    const rdata = await this._notifyComputeRecipients(message, msgVals);
    if (!rdata) {
      return rdata;
    }

    await this._notifyRecordByInbox(message, rdata, msgVals, options);
    if (options['notifyByEmail']) {
      await this._notifyRecordByEmail(message, rdata, msgVals, options);
    }

    return rdata;
  }

  /**
   * Notification method: inbox. Do two main things
 
      * create an inbox notification for users;
      * send bus notifications;
 
      TDE/XDO TODO: flag rdata directly, with for example r['notif'] = 'ocn_client' and r['needaction']=false
      and correctly override notify_recipients
   * @param message 
   * @param recipientsData 
   * @param msgVals 
   * @param options 
   */
  async _notifyRecordByInbox(message, recipientsData, msgVals, options: {} = {}) {
    const busNotifications = [];
    const inboxPids = recipientsData.filter(r => r['notif'] === 'inbox').map(r => r['id']);
    if (inboxPids) {
      const notifCreateValues = inboxPids.map(pid => {
        return {
          'mailMessageId': message.id,
          'resPartnerId': pid,
          'notificationType': 'inbox',
          'notificationStatus': 'sent',
        }
      });
      await (await this.env.items('mail.notification').sudo()).create(notifCreateValues);

      const messageFormatValues = (await message.messageFormat())[0];
      for (const partnerId of inboxPids) {
        busNotifications.push([this.env.items('res.partner').browse(partnerId), 'mail.message/inbox', Object.assign({}, messageFormatValues)]);
      }
    }
    await (await this.env.items('bus.bus').sudo())._sendmany(busNotifications);
  }

  /**
   * Method to send email linked to notified messages.
 
      :param message: mail.message record to notify;
      :param recipients_data: see ``_notify_thread``;
      :param msg_vals: see ``_notify_thread``;
 
      :param model_description: model description used in email notification process
        (computed if not given);
      :param mail_auto_delete: delete notification emails once sent;
      :param check_existing: check for existing notifications to update based on
        mailed recipient, otherwise create new notifications;
 
      :param force_send: send emails directly instead of using queue;
      :param send_after_commit: if force_send, tells whether to send emails after
        the transaction has been committed using a post-commit hook;
   * @param message 
   * @param recipientsData 
   * @param msgVals 
   * @param options 
   * @param modelDescription 
   * @param mail_auto_delete 
   * @param check_existing 
   * @param force_send 
   * @param send_after_commit 
   */
  async _notifyRecordByEmail(message, recipientsData: {}[], msgVals?: any, kw: { modelDescription?: boolean, mailAutoDelete?: boolean, checkExisting?: boolean, forceSend?: boolean, sendAfterCommit?: boolean } = {}) {
    setOptions(kw, { modelDescription: false, mailAutoDelete: true, checkExisting: false, forceSend: true, sendAfterCommit: true });
    const partnersData = recipientsData.filter(r => r['notif'] === 'email');
    if (partnersData.length) {
      return true;
    }
    const model = msgVals ? msgVals['model'] : await message.model;
    const modelName = kw.modelDescription || (model ? await (await (await this._fallbackLang()).env.items('ir.model')._get(model)).displayName : false) // one query for display name
    const recipientsGroupsData = await this._notifyClassifyRecipients(partnersData, modelName, msgVals);

    if (!bool(recipientsGroupsData)) {
      return true;
    }
    kw.forceSend = this.env.context['mailNotifyForceSend'] || kw.forceSend;

    const templateValues = await this._notifyPrepareTemplateContext(message, msgVals, kw.modelDescription); // 10 queries

    const emailLayoutXmlid = msgVals ? msgVals['emailLayoutXmlid'] : await message.emailLayoutXmlid;
    const templateXmlid = emailLayoutXmlid ? emailLayoutXmlid : 'mail.messageNotificationEmail';
    let baseTemplate;
    try {
      baseTemplate = await (await this.env.ref(templateXmlid, true)).withContext({ lang: templateValues['lang'] });
      // 1 query
    } catch (e) {
      if (isInstance(e, ValueError)) {
        console.warn('QWeb template %s not found when sending notification emails. Sending without layouting.', templateXmlid);
        baseTemplate = false;
      } else {
        throw e;
      }
    }

    const [subject, recordName] = await message('subject', 'recordName');
    let mailSubject = subject || (recordName && f('Re: %s', recordName)); // in cache, no queries
    // Replace new lines by spaces to conform to email headers requirements
    mailSubject = (mailSubject || '').split('\n').join(' ');
    // compute references: set references to the parent and add current message just to
    // have a fallback in case replies mess with Messsage-Id in the In-Reply-To (e.g. amazon
    // SES SMTP may replace Message-Id and In-Reply-To refers an internal ID not stored in Verp)
    const messageSudo = await message.sudo();
    let references;
    const [parentId, messageId] = await messageSudo('parentId', 'messageId');
    if (parentId.ok) {
      references = `${await parentId.messageId} ${messageId}`;
    }
    else {
      references = messageId;
    }
    // prepare notification mail values
    let baseMailValues: any = {
      'mailMessageId': message.id,
      'mailServerId': (await message.mailServerId).id, // 2 query, check acces + read, may be useless, Falsy, when will it be used?
      'autoDelete': kw.mailAutoDelete,
      // due to ir.rule, user have no right to access parent message if message is not published
      'references': references,
      'subject': mailSubject,
    }
    baseMailValues = await this._notifyByEmailAddValues(baseMailValues);

    // Clean the context to get rid of residual default_* keys that could cause issues during
    // the mail.mail creation.
    // Example: 'default_state' would refer to the default state of a previously created record
    // from another model that in turns triggers an assignation notification that ends up here.
    // This will lead to a traceback when trying to create a mail.mail with this state value that
    // doesn't exist.
    const SafeMail = await (await this.env.items('mail.mail').sudo()).withContext(cleanContext(this._context));
    const SafeNotification = await (await this.env.items('mail.notification').sudo()).withContext(cleanContext(this._context));
    let emails = await this.env.items('mail.mail').sudo();

    // loop on groups (customer, portal, user,  ... + model specific like groupSaleSalesman)
    let notifCreateValues = [];
    let recipientsMax = 50;
    for (const recipientsGroupData of recipientsGroupsData) {
      // generate notification email content
      const recipientsIds = pop(recipientsGroupData, 'recipients');
      const renderValues = { ...templateValues, ...recipientsGroupData };
      // {company, isDiscussion, lang, message, model_description, record, record_name, signature, subtype, tracking_values, websiteUrl}
      // {actions, button_access, has_button_access, recipients}

      let mailBody;
      if (bool(baseTemplate)) {
        mailBody = await baseTemplate._render(renderValues, 'ir.qweb', true);
      }
      else {
        mailBody = await message.body;
      }
      mailBody = await this.env.items('mail.render.mixin')._replaceLocalLinks(mailBody);

      // create email
      for (const recipientsIdsChunk of splitEvery(recipientsMax, recipientsIds)) {
        const recipientValues = this._notifyEmailRecipientValues(recipientsIdsChunk);
        const emailTo = recipientValues['emailTo'];
        const recipientIds = recipientValues['recipientIds'];

        const createValues = {
          'bodyHtml': mailBody,
          'subject': mailSubject,
          'recipientIds': recipientIds.map(pid => Command.link(pid)),
        }
        if (emailTo) {
          createValues['emailTo'] = emailTo;
        }
        update(createValues, baseMailValues);  // mail_message_id, mail_server_id, autoDelete, references, headers
        const email = await SafeMail.create(createValues);

        if (email && recipientIds) {
          let tocreateRecipientIds = Object.keys(recipientIds);
          if (kw.checkExisting) {
            const existingNotifications = await (await this.env.items('mail.notification').sudo()).search([
              ['mailMessageId', '=', message.id],
              ['notificationType', '=', 'email'],
              ['resPartnerId', 'in', tocreateRecipientIds]
            ]);
            if (existingNotifications.ok) {
              tocreateRecipientIds = recipientIds.filter(async (rid) => !(await existingNotifications.mapped('resPartnerId.id')).includes(rid));
              await existingNotifications.write({
                'notificationStatus': 'ready',
                'mailMailId': email.id,
              })
            }
          }
          notifCreateValues = notifCreateValues.concat([tocreateRecipientIds.map(recipientId => {
            return {
              'mailMessageId': message.id,
              'resPartnerId': recipientId,
              'notificationType': 'email',
              'mailMailId': email.id,
              'isRead': true,  // discard Inbox notification
              'notificationStatus': 'ready',
            }
          })]);
        }
        emails = emails.or(email);
      }
    }
    if (notifCreateValues.length) {
      await SafeNotification.create(notifCreateValues);
    }
    // NOTE:
    //   1. for more than 50 followers, use the queue system
    //   2. do not send emails immediately if the registry is not loaded,
    //      to prevent sending email during a simple update of the database
    //      using the command-line.
    const testMode = getattr(this.env, 'testing', false);
    if (kw.forceSend && len(emails) < recipientsMax && (!this.pool._init || testMode)) {
      // unless asked specifically, send emails after the transaction to
      // avoid side effects due to emails being sent while the transaction fails
      if (!testMode && kw.sendAfterCommit) {
        const emailIds = emails.ids;
        const dbName = this.env.cr.dbName;
        const _context = this._context;

        this.env.cr.postcommit.add(
          async () => {
            const dbRegistry = await registry(dbName);
            const cr = dbRegistry.cursor();
            await doWith(cr, async () => {
              const env = await Environment.new(cr, global.SUPERUSER_ID, _context);
              await env.items('mail.mail').browse(emailIds).send();
            });
          }
        );
      }
      else {
        await emails.send();
      }
    }
    return true;
  }

  @api.model()
  async _notifyPrepareTemplateContext(message, msgVals, modelDescription: boolean = false, mailAutoDelete: boolean = true) {
    // compute send user and its related signature
    let signature = '';
    let user = await this.env.user();
    const author = msgVals ? message.env.items('res.partner').browse(msgVals['authorId']) : await message.authorId;
    const model = msgVals ? msgVals['model'] : await message.model;
    const addSign = msgVals ? msgVals['addSign'] : await message.addSign;
    const subtypeId = msgVals ? msgVals['subtypeId'] : (await message.subtypeId).id;
    const messageId = message.id;
    const recordName = msgVals ? msgVals['recordName'] : await message.recordName;
    const authorUser = (await user.partnerId).eq(author) ? user : author.ok && (await author.userIds).ok ? (await author.userIds)[0] : false;
    // trying to use user (await self.env.user()) instead of browing user_ids if he is the author will give a sudo user,
    // improving access performances and cache usage.
    if (bool(authorUser)) {
      user = authorUser
      if (addSign) {
        signature = await user.signature;
      }
    }
    else if (addSign && await author.label) {
      signature = f(markup("<p>-- <br/>%s</p>"), await author.label);
    }
    // company value should fall back on env.company if:
    // - no companyId field on record
    // - companyId field available but not set
    const company = this.ok && 'companyId' in this._fields && (await this['companyId']).ok ? await (await this['companyId']).sudo() : await this.env.company();
    let website: string = await company.website;
    let websiteUrl;
    if (website) {
      websiteUrl = !['http:', 'https:'].some(ht => website.toLowerCase().startsWith(ht)) ? f('http://%s', website) : website;
    }
    else {
      websiteUrl = false;
    }

    // Retrieve the language in which the template was rendered, in order to render the custom
    // layout in the same language.
    // TDE FIXME: this whole brol should be cleaned !
    let lang = this.env.context['lang'];
    if (_.difference(Object.keys(this.env.context), ['default_templateId', 'default_model', 'default_resId']).length) {
      const template = this.env.items('mail.template').browse(this.env.context['default_templateId']);
      if (template.ok && await template.lang) {
        lang = (await template._renderLang([this.env.context['default_resId']]))[this.env.context['default_resId']];
      }
    }

    if (!modelDescription && model) {
      modelDescription = await (await (await this.env.items('ir.model').withContext({ lang: lang }))._get(model)).displayName;
    }
    const tracking = [];
    if (msgVals ? (msgVals['trackingValueIds'] ?? true) : bool(this)) { // could be tracking
      for (const trackingValue of await (await this.env.items('mail.tracking.value').sudo()).search([['mailMessageId', '=', message.id]])) {
        const groups = await trackingValue.fieldGroups;
        if (!bool(groups) || this.env.isSuperuser() || await this.userHasGroups(groups)) {
          tracking.push([await trackingValue.fieldDesc,
          (await trackingValue.getOldDisplayValue())[0],
          (await trackingValue.getNewDisplayValue())[0]]);
        }
      }
    }
    const isDiscussion = subtypeId === await this.env.items('ir.model.data')._xmlidToResId('mail.mtComment');

    return {
      'message': message,
      'signature': signature,
      'websiteUrl': websiteUrl,
      'company': company,
      'modelDescription': modelDescription,
      'record': this,
      'recordName': recordName,
      'trackingValues': tracking,
      'isDiscussion': isDiscussion,
      'subtype': await message.subtypeId,
      'lang': lang,
    }
  }

  /**
   * Add model-specific values to the dictionary used to create the
  notification email. Its base behavior is to compute model-specific
  headers.
 
  :param dict base_mail_values: base mail.mail values, holding message
  to notify (mail_message_id and its fields), server, references, subject.
   * @param baseMailValues 
   * @returns 
   */
  async _notifyByEmailAddValues(baseMailValues) {
    const headers = (this as any)._notifyEmailHeaders();
    if (headers) {
      baseMailValues['headers'] = headers;
    }
    return baseMailValues;
  }

  /**
   * Compute recipients to notify based on subtype and followers. This
      method returns data structured as expected for ``_notify_recipients``.
   * @param message 
   * @param msgVals 
   * @returns 
   */
  async _notifyComputeRecipients(message, msgVals) {
    const msgSudo = await message.sudo();
    // get values from msg_vals or from message if msg_vals doen't exists
    const pids = msgVals ? msgVals['partnerIds'] || [] : (await msgSudo.partnerIds).ids;
    const messageType = msgVals ? msgVals['messageType'] : await msgSudo.messageType;
    const subtypeId = msgVals ? msgVals['subtypeId'] : (await msgSudo.subtypeId).id;
    // is it possible to have record but no subtypeId ?
    const recipientsData = [];

    const result = await this.env.items('mail.followers')._getRecipientData(this, messageType, subtypeId, pids);
    if (!bool(result)) {
      return recipientsData;
    }

    const authorId = msgVals['authorId'] || (await message.authorId).id;
    for (const { pid, active, pshare, notif, groups } of result) {
      if (pid && pid == authorId && !this.env.context['mailNotifyAuthor']) {  // do not notify the author of its own messages
        continue;
      }
      if (pid) {
        if (active == false) {
          continue;
        }
        const pdata = { 'id': pid, 'active': active, 'share': pshare, 'groups': groups || [] }
        if (notif === 'inbox') {
          recipientsData.push(Object.assign(pdata, { notif: notif, type: 'user' }));
        }
        else if (!pshare && notif) {  // has an user and is not shared, is therefore user
          recipientsData.push(Object.assign(pdata, { notif: notif, type: 'user' }));
        }
        else if (pshare && notif) {  // has an user but is shared, is therefore portal
          recipientsData.push(Object.assign(pdata, { notif: notif, type: 'portal' }));
        }
        else {  // has no user, is therefore customer
          recipientsData.push(Object.assign(pdata, { notif: notif ? notif : 'email', type: 'customer' }));
        }
      }
    }
    return recipientsData;
  }

  /**
   * Return groups used to classify recipients of a notification email.
      Groups is a list of tuple containing of form (groupName, group_func,
      group_data) where
        * groupName is an identifier used only to be able to override and manipulate
          groups. Default groups are user (recipients linked to an employee user),
          portal (recipients linked to a portal user) and customer (recipients not
          linked to any user). An example of override use would be to add a group
          linked to a res.groups like Hr Officers to set specific action buttons to
          them.
        * group_func is a function pointer taking a partner record as parameter. This
          method will be applied on recipients to know whether they belong to a given
          group or not. Only first matching group is kept. Evaluation order is the
          list order.
        * group_data is a dict containing parameters for the notification email
        * has_button_access: whether to display Access <Document> in email. true
          by default for new groups, false for portal / customer.
        * button_access: dict with url and title of the button
        * actions: list of action buttons to display in the notification email.
          Each action is a dict containing url and title of the button.
      Groups has a default value that you can find in mail_thread
      ``_notify_classify_recipients`` method.
   * @param self 
   * @param msgVals 
   * @returns 
   */
  async _notifyGetGroups(msgVals?: any): Promise<[string, Function, {}][]> {
    return [
      [
        'user',
        (pdata) => pdata['type'] === 'user',
        {}
      ], [
        'portal',
        (pdata) => pdata['type'] === 'portal',
        { 'hasButtonAccess': false }
      ], [
        'customer',
        (pdata) => true,
        { 'hasButtonAccess': false }
      ]
    ]
  }

  /**
   *  Classify recipients to be notified of a message in groups to have
      specific rendering depending on their group. For example users could
      have access to buttons customers should not have in their emails.
      Module-specific grouping should be done by overriding ``_notify_get_groups``
      method defined here-under.
      :param recipient_data:todo xdo UPDATE ME
      return example:
      [{
          'actions': [],
          'button_access': {'title': 'View Simple Chatter Model',
                              'url': '/mail/view?model=mail.test.simple&resId=1497'},
          'has_button_access': false,
          'recipients': [11]
      },
      {
          'actions': [],
          'button_access': {'title': 'View Simple Chatter Model',
                          'url': '/mail/view?model=mail.test.simple&resId=1497'},
          'has_button_access': false,
          'recipients': [4, 5, 6]
      },
      {
          'actions': [],
          'button_access': {'title': 'View Simple Chatter Model',
                              'url': '/mail/view?model=mail.test.simple&resId=1497'},
          'has_button_access': true,
          'recipients': [10, 11, 12]
      }]
      only return groups with recipients
   * @param recipientData 
   * @param modelName 
   * @param msgVals 
   * @returns 
   */
  async _notifyClassifyRecipients(recipientData, modelName, msgVals?: any) {
    // keep a local copy of msg_vals as it may be modified to include more information about groups or links
    const localMsgVals = msgVals ? Object.assign({}, msgVals) : {};
    const groups = await this._notifyGetGroups(localMsgVals);
    const accessLink = await this._notifyGetActionLink('view', localMsgVals);

    let viewTitle;
    if (modelName) {
      viewTitle = await this._t('View %s', modelName);
    }
    else {
      viewTitle = await this._t('View');
    }
    // fill group_data with default_values if they are not complete
    for (const [groupName, groupFunc, groupData] of groups) {
      setdefault(groupData, 'notificationGroupName', groupName);
      setdefault(groupData, 'notificationIsCustomer', false);
      const isThreadNotification = (await this._notifyGetRecipientsThreadInfo(msgVals))['isThreadNotification'];
      setdefault(groupData, 'hasButtonAccess', isThreadNotification);
      const groupButtonAccess = setdefault(groupData, 'buttonAccess', {});
      setdefault(groupButtonAccess, 'url', accessLink);
      setdefault(groupButtonAccess, 'title', viewTitle);
      setdefault(groupData, 'actions', []);
      setdefault(groupData, 'recipients', []);
    }
    // classify recipients in each group
    for (const recipient of recipientData) {
      for (const [groupName, groupFunc, groupData] of groups) {
        if (groupFunc(recipient)) {
          groupData['recipients'].push(recipient['id']);
          break;
        }
      }
    }
    const result = [];
    for (const [groupName, groupMethod, groupData] of groups) {
      if (groupData['recipients']) {
        result.push(groupData);
      }
    }
    return result
  }

  /**
   * Tool method to compute thread info used in ``_notifyClassifyRecipients``
      and its sub-methods.
   * @param msgVals 
   * @returns 
   */
  async _notifyGetRecipientsThreadInfo(msgVals?: any) {
    const resModel = msgVals && 'model' in msgVals ? msgVals['model'] : this._name;
    const resId = msgVals && 'resId' in msgVals ? msgVals['resId'] : bool(this.ids) ? this.ids[0] : false;
    return {
      'isThreadNotification': resModel && (resModel !== 'mail.thread') && resId
    }
  }

  /**
   * Format email notification recipient values to store on the notification
          mail.mail. Basic method just set the recipient partners as mail_mail
          recipients. Override to generate other mail values like emailTo or
          email_cc.
          :param recipient_ids: res.partner recordset to notify
   * @param recipientIds 
   * @returns 
   */
  _notifyEmailRecipientValues(recipientIds) {
    return {
      'emailTo': false,
      'recipientIds': recipientIds,
    }
  }

  // FOLLOWERS API
  // ------------------------------------------------------

  /**
   * Main public API to add followers to a record set. Its main purpose is
      to perform access rights checks before calling ``_messageSubscribe``.
   * @param partnerIds 
   * @param subtypeIds 
   * @returns 
   */
  async messageSubscribe(partnerIds?: any, subtypeIds?: any) {
    if (!this.ok || !partnerIds) {
      return true;
    }

    partnerIds = partnerIds ?? [];
    const addingCurrent = _.eq(partnerIds, [(await (await this.env.user()).partnerId).id]);
    const customerIds = addingCurrent ? [] : null;

    if (partnerIds.length && addingCurrent) {
      try {
        await this.checkAccessRights('read');
        await this.checkAccessRule('read');
      } catch (e) {
        if (isInstance(e, AccessError)) {
          return false;
        }
        throw e;
      }
    }
    else {
      await this.checkAccessRights('write');
      await this.checkAccessRule('write');
    }
    // filter inactive and private addresses
    if (partnerIds.length && !addingCurrent) {
      partnerIds = (await (await this.env.items('res.partner').sudo()).search([['id', 'in', partnerIds], ['active', '=', true], ['type', '!=', 'private']])).ids;
    }

    return this._messageSubscribe(partnerIds, subtypeIds, customerIds);
  }

  /**
   * Main private API to add followers to a record set. This method adds
      partners and channels, given their IDs, as followers of all records
      contained in the record set.
 
      If subtypes are given existing followers are erased with new subtypes.
      If default one have to be computed only missing followers will be added
      with default subtypes matching the record set model.
 
      This private method does not specifically check for access right. Use
      ``message_subscribe`` public API when not sure about access rights.
 
      :param customer_ids: see ``_insertFollowers``
   * @param partnerIds 
   * @param any 
   * @param subtypeIds 
   * @param customerIds 
   * @returns 
   */
  async _messageSubscribe(partnerIds?: any, subtypeIds?: any, customerIds?: any) {
    if (!this.ok) {
      return true;
    }

    if (!bool(subtypeIds)) {
      await this.env.items('mail.followers')._insertFollowers(this._name, this.ids, partnerIds, {
        subtypes: null, customerIds: customerIds, checkExisting: true, existingPolicy: 'skip'
      });
    }
    else {
      await this.env.items('mail.followers')._insertFollowers(this._name, this.ids, partnerIds, {
        subtypes: Object.fromEntries(partnerIds.map(pid => [pid, subtypeIds])),
        customerIds: customerIds, checkExisting: true, existingPolicy: 'replace'
      });
    }
    return true;
  }

  /**
   * Notify new followers, using a template to render the content of the
            notification message. Notifications pushed are done using the standard
            notification mechanism in mail.thread. It is either inbox either email
            depending on the partner state: no user (email, customer), share user
            (email, customer) or classic user (notification_type)
      
            :param partner_ids: IDs of partner to notify;
            :param template: XML ID of template used for the notification;
   * @param partnerIds 
   * @param template 
   * @returns 
   */
  async _messageAutoSubscribeNotify(partnerIds, template) {
    if (!this.ok || this.env.context['mailAutoSubscribeNoNotify']) {
      return;
    }
    if (!this.env.registry.ready) {  // Don't send notification during install
      return;
    }

    const view = this.env.items('ir.ui.view').browse(await this.env.items('ir.model.data')._xmlidToResId(template));

    for (const record of this) {
      const modelDescription = await (await this.env.items('ir.model')._get(record._name)).displayName
      const values = {
        'object': record,
        'modelDescription': modelDescription,
        'accessLink': await record._notifyGetActionLink('view'),
      }
      let assignationMsg = await view._render(values, 'ir.qweb', { minimalQcontext: true });
      assignationMsg = await this.env.items('mail.render.mixin')._replaceLocalLinks(assignationMsg);
      await record.messageNotify({
        subject: await this._t('You have been assigned to %s', await record.displayName),
        body: assignationMsg,
        partnerIds: partnerIds,
        recordName: await record.displayName,
        emailLayoutXmlid: 'mail.mailNotificationLight',
        modelDescription: modelDescription,
      });
    }
  }

  // CONTROLLERS

  /**
   * Handle auto subscription. Auto subscription is done based on two
        main mechanisms

         * using subtypes parent relationship. For example following a parent record
           (i.e. project) with subtypes linked to child records (i.e. task). See
           mail.message.subtype ``_get_auto_subscription_subtypes``;
         * calling _message_auto_subscribe_notify that returns a list of partner
           to subscribe, as well as data about the subtypes and notification
           to send. Base behavior is to subscribe responsible and notify them;

        Adding application-specific auto subscription should be done by overriding
        ``_messageAutoSubscribeFollowers``. It should return structured data
        for new partner to subscribe, with subtypes and eventual notification
        to perform. See that method for more details.

        :param updated_values: values modifying the record trigerring auto subscription
   * @param updatedValues 
   * @param followersExistingPolicy 
   * @returns 
   */
  async _messageAutoSubscribe(updatedValues, followersExistingPolicy = 'skip') {
    if (!this.ok) {
      return true;
    }

    const newPartnerSubtypes = new Dict<any>();

    // return data related to auto subscription based on subtype matching (aka:
    // default task subtypes or subtypes from project triggering task subtypes)
    const updatedRelation = new Dict<any>();
    const [childIds, defIds, allIntIds, parent, relation] = await this.env.items('mail.message.subtype')._getAutoSubscriptionSubtypes(this._name);

    // check effectively modified relation field
    for (const [resModel, fnames] of relation.items()) {
      for (const field of Array.from<string>(fnames).filter(fname => updatedValues[fname])) {
        updatedRelation.setdefault(resModel, new Set()).add(field);
      }
    }
    const udpatedFields = []
    for (const fnames of updatedRelation.values()) {
      for (const fname of fnames) {
        if (updatedValues[fname]) {
          udpatedFields.push(fname);
        }
      }
    }

    if (udpatedFields.length) {
      // fetch "parent" subscription data (aka: subtypes on project to propagate on task)
      const docData = updatedRelation.items().map(([model, fnames]) => [model, Array.from<string>(fnames).map(fname => updatedValues[fname])]);
      const res = await this.env.items('mail.followers')._getSubscriptionData(docData, null, true, true);
      for (const { fid, rid, pid, subids, pshare, active } of res) {
        // use project.task_new -> task.new link
        let sids = subids.map(sid => parent[sid]).filter(sid => bool(sid));
        // add checked subtypes matching modelName
        sids = sids.concat(subids.filter(sid => !(sid in parent) && sid in childIds));
        if (bool(pid) && active) {  // auto subscribe only active partners
          if (pshare) {  // remove internal subtypes for customers
            newPartnerSubtypes[pid] = new Set(_.difference(sids, allIntIds));
          }
          else {
            newPartnerSubtypes[pid] = new Set(sids);
          }
        }
      }
    }

    const notifyData = new Dict<any>();
    const res = await this._messageAutoSubscribeFollowers(updatedValues, defIds);
    for (const [partnerId, sids, template] of res) {
      newPartnerSubtypes.setdefault(partnerId, sids);
      if (bool(template)) {
        const partner = this.env.items('res.partner').browse(partnerId);
        const lang = partner.ok ? await partner.lang : null;
        const key = [template, lang].join(',');
        notifyData.setdefault(key, []).push(partnerId);
      }
    }
    await this.env.items('mail.followers')._insertFollowers(
      this._name, this.ids, newPartnerSubtypes.keys(), { subtype: newPartnerSubtypes, checkExisting: true, existingPolicy: followersExistingPolicy });

    // notify people from auto subscription, for example like assignation
    for (const [key, pids] of notifyData.items()) {
      const [template, lang] = key.split(',');
      await (await this.withContext({ lang: lang }))._messageAutoSubscribeNotify(pids, template);
    }

    return true;
  }

  /**
   * Return the suggested company to be set on the context
      in case of a mail redirection to the record. To avoid multi
      company issues when clicking on a link sent by email, this
      could be called to try setting the most suited company on
      the allowedCompanyIds in the context. This method can be
      overridden, for example on the hr.leave model, where the
      most suited company is the company of the leave type, as
      specified by the ir.rule.
   */
  async _getMailRedirectSuggestedCompany() {
    if ('companyId' in this._fields) {
      return this['companyId'];
    }
    return false;
  }
}