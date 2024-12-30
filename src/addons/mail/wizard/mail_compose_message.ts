import _ from "lodash";
import { Command, Fields, _Datetime, api } from "../../../core";
import { hasattr } from "../../../core/api/func";
import { Dict } from "../../../core/helper/collections";
import { MetaModel, TransientModel, _super, isSubclass } from "../../../core/models";
import { expression } from "../../../core/osv";
import { dbFactory } from "../../../core/service/db";
import { b64decode, emailNormalize, emailSplitAndFormat, len, pop, subDate, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { f, ustr } from "../../../core/tools/utils";

function _reopen(self, resId, model, context: {} = {}) {
  // save original model in context, because selecting the list of available templates requires a model in context
  context = new Dict({ ...context, default_model: model });
  return {
    'type': 'ir.actions.actwindow',
    'viewMode': 'form',
    'resId': resId,
    'resModel': self._name,
    'target': 'new',
    'context': context,
  }
}

/**
 * Generic message composition wizard. You may inherit from this wizard
    at model and view levels to provide specific features.

    The behavior of the wizard depends on the composition_mode field:
    - 'comment': post on a record. The wizard is pre-populated via ``get_record_data``
    - 'mass_mail': wizard in mass mailing mode where the mail details can
        contain template placeholders that will be merged with actual data
        before being sent to each recipient.
 */
@MetaModel.define()
class MailComposer extends TransientModel {
  static _module = module;
  static _name = 'mail.compose.message';
  static _parents = 'mail.composer.mixin';
  static _description = 'Email composition wizard';
  static _logAccess = true;
  static _batchSize = 500;

  // content
  static subject = Fields.Char('Subject', { compute: false });
  static body = Fields.Html('Contents', { renderEngine: 'qweb', compute: false, default: '', sanitizeStyle: true });
  static parentId = Fields.Many2one(
    'mail.message', { string: 'Parent Message', index: true, ondelete: 'SET NULL', help: "Initial thread message." });
  static templateId = Fields.Many2one(
    'mail.template', {
    string: 'Use template', index: true,
    domain: "[['model', '=', model]]"
  });
  static attachmentIds = Fields.Many2many('ir.attachment', { relation: 'mailComposeMessageIrAttachmentsRel', column1: 'wizardId', column2: 'attachmentId', string: 'Attachments' });
  static layout = Fields.Char('Layout', { copy: false });  // xml id of layout
  static addSign = Fields.Boolean({ default: true });
  // origin
  static emailFrom = Fields.Char('From', { help: "Email address of the sender. This field is set when no matching partner is found and replaces the authorId field in the chatter." });
  static authorId = Fields.Many2one(
    'res.partner', {
    string: 'Author', index: true,
    help: "Author of the message. If not set, emailFrom may hold an email address that did not match any partner."
  });
  // composition
  static compositionMode = Fields.Selection([
    ['comment', 'Post on a document'],
    ['massMail', 'Email Mass Mailing'],
    ['massPost', 'Post on Multiple Documents']], { string: 'Composition mode', default: 'comment' });
  static model = Fields.Char('Related Document Model', { index: true });
  static resId = Fields.Integer('Related Document ID', { index: true });
  static recordName = Fields.Char('Message Record Name', { help: "Name get of the related document." });
  static useActiveDomain = Fields.Boolean('Use active domain');
  static activeDomain = Fields.Text('Active domain', { readonly: true });
  // characteristics
  static messageType = Fields.Selection([
    ['comment', 'Comment'],
    ['notification', 'System notification']],
    {
      string: 'Type', required: true, default: 'comment',
      help: "Message type: email for email message, notification for system message, comment for other messages such as user replies"
    });
  static subtypeId = Fields.Many2one(
    'mail.message.subtype', { string: 'Subtype', ondelete: 'SET NULL', index: true, default: async (self) => self.env.items('ir.model.data')._xmlidToResId('mail.mtComment') });
  static mailActivityTypeId = Fields.Many2one(
    'mail.activity.type', {
    string: 'Mail Activity Type',
    index: true, ondelete: 'SET NULL'
  });
  // destination
  static replyTo = Fields.Char('Reply To', { help: 'Reply email address. Setting the reply_to bypasses the automatic thread creation.' });
  static replyToForceNew = Fields.Boolean(
    {
      string: 'Considers answers as new thread',
      help: 'Manage answers as new incoming emails instead of replies going to the same thread.'
    });
  static replyToMode = Fields.Selection([
    ['update', 'Log in the original discussion thread'],
    ['new', 'Redirect to another email address']],
    {
      string: 'Replies', compute: '_computeReplyToMode', inverse: '_inverseReplyToMode',
      help: "Original Discussion: Answers go in the original document discussion thread. \n Another Email Address: Answers go to the email address mentioned in the tracking message-id instead of original document discussion thread. \n This has an impact on the generated message-id."
    });
  static isLog = Fields.Boolean('Log an Internal Note',
    { help: 'Whether the message is an internal note (comment mode only)' });
  static partnerIds = Fields.Many2many(
    'res.partner', {
    relation: 'mailComposeMessageResPartnerRel',
    column1: 'wizardId', column2: 'partnerId', string: 'Additional Contacts', domain: [['type', '!=', 'private']]
  });
  // mass mode options
  static notify = Fields.Boolean('Notify followers', { help: 'Notify followers of the document (mass post only)' });
  static autoDelete = Fields.Boolean('Delete Emails',
    { help: 'This option permanently removes any track of email after it\'s been sent, including from the Technical menu in the Settings, in order to preserve storage space of your Verp database.' });
  static autoDeleteMessage = Fields.Boolean('Delete Message Copy', { help: 'Do not keep a copy of the email in the document communication history (mass mailing only)' });
  static mailServerId = Fields.Many2one('ir.mail.server', { string: 'Outgoing mail server' });

  /**
   * Handle composition mode. Some details about context keys:
    - comment: default mode, model and ID of a record the user comments
        - default_model or activeModel
        - default_resId or activeId
    - mass_mail: model and IDs of records the user mass-mails
        - activeIds: record IDs
        - default_model or activeModel
   * @param fields 
   * @returns 
   */
  @api.model()
  async defaultGet(fields) {
    const result = await _super(MailComposer, this).defaultGet(fields);

    // author
    const missingAuthor = 'authorId' in fields && !('authorId' in result);
    const missingEmailFrom = 'emailFrom' in fields && !('emailFrom' in result);
    if (missingAuthor || missingEmailFrom) {
      const [authorId, emailFrom] = await this.env.items('mail.thread')._messageComputeAuthor(result['authorId'], result['emailFrom'], false);
      if (missingEmailFrom) {
        result['emailFrom'] = emailFrom;
      }
      if (missingAuthor) {
        result['authorId'] = authorId;
      }
    }

    if ('model' in fields && !('model' in result)) {
      result['model'] = this._context['activeModel'];
    }
    if ('resId' in fields && !('resId' in result)) {
      result['resId'] = this._context['activeId'];
    }
    if ('replyToMode' in fields && !('replyToMode' in result) && result['model']) {
      // doesn't support threading
      if (!(result['model'] in this.env.models) || !hasattr(this.env.models[result['model']], 'messagePost')) {
        result['replyToMode'] = 'new';
      }
    }

    if ('activeDomain' in this._context) {  // not context.get() because we want to keep global [] domains
      result['activeDomain'] = f('%s', this._context['activeDomain']);
    }
    if (result['compositionMode'] === 'comment' && _.intersection(fields, ['model', 'resId', 'partnerIds', 'recordName', 'subject']).length) {
      Object.assign(result, await (this as any).getRecordData(result));
    }

    // when being in new mode, createdUid is not granted -> ACLs issue may arise
    if (fields.includes('createdUid') && !('createdUid' in result)) {
      result['createdUid'] = this.env.uid;
    }

    const filteredResult = Dict.from(Object.keys(result)
      .filter(fname => fields.includes(fname))
      .map(fname => [fname, result[fname]])
    );
    return filteredResult;
  }

  _partnerIdsDomain() {
    return expression.OR([
      [['type', '!=', 'private']],
      [['id', 'in', this.env.context['default_partnerIds'] ?? []]]
    ]);
  }

  @api.depends('replyToForceNew')
  async _computeReplyToMode() {
    for (const composer of this) {
      await composer.set('replyToMode', await composer.replyToForceNew ? 'new' : 'update');
    }
  }

  async _inverseReplyToMode() {
    for (const composer of this) {
      await composer.set('replyToForceNew', await composer.replyToMode === 'new');
    }
  }

  // Overrides of mail.render.mixin
  @api.depends('model')
  async _computeRenderModel() {
    for (const composer of this) {
      await composer.set('renderModel', await composer.model);
    }
  }

  // Onchanges
  @api.onchange('templateId')
  async _onchangeTemplateIdWrapper() {
    this.ensureOne();
    const self: any = this;
    const [templateId, compositionMode, model, resId] = await self('templateId', 'compositionMode', 'model', 'resId');
    const values = (await this._onchangeTemplateId(templateId.id, compositionMode, model, resId))['value'];
    for (const [fname, value] of Object.entries(values)) {
      await self.set(fname, value);
    }
  }

  /**
   * Can edit the body if we are not in "mass_mail" mode because the template is rendered before it's modified.
   */
  async _computeCanEditBody() {
    const nonMassMail = await this.filtered(async (m) => await m.compositionMode !== 'massMail');
    await nonMassMail.set('canEditBody', true);
    await _super(MailComposer, this.sub(nonMassMail))._computeCanEditBody();
  }

  /**
   * Returns a defaults-like dict with initial values for the composition wizard when sending an email related a previous email (parentId) or a document (model, resId). This is based on previously computed default values.
   * @param values 
   * @returns 
   */
  @api.model()
  async getRecordData(values) {
    const result = {}
    let subject;
    if (values['parentId']) {
      const parent = this.env.items('mail.message').browse(values.get('parentId'));
      result['recordName'] = await parent.recordName;
      subject = ustr(await parent.subject || await parent.recordName || '');
      if (!values['model']) {
        result['model'] = await parent.model;
      }
      if (!values['resId']) {
        result['resId'] = await parent.resId;
      }
      const partnerIds = (values['partnerIds'], []).concat((await parent.partnerIds).ids);
      result['partnerIds'] = partnerIds;
    }
    else if (values['model'] && values['resId']) {
      const docNameGet = await this.env.items(values['model']).browse(values['resId']).nameGet();
      result['recordName'] = bool(docNameGet) && docNameGet[0][1] || '';
      subject = ustr(result['recordName']);
    }
    const rePrefix = await this._t('Re:');
    if (subject && !(subject.startsWith('Re:') || subject.startsWith(rePrefix))) {
      subject = f("%s %s", rePrefix, subject);
    }
    result['subject'] = subject;

    return result;
  }

  // CRUD / ORM
  // ------------------------------------------------------------

  /**
   * Garbage collect lost mail attachments. Those are attachments
    - linked to resModel 'mail.compose.message', the composer wizard
    - with resId 0, because they were created outside of an existing
        wizard (typically user input through Chatter or reports
        created on-the-fly by the templates)
    - unused since at least one day (createdAt and updatedAt)
   */
  @api.autovacuum()
  async _gcLostAttachments() {
    const limitDate = subDate(_Datetime.now(), { days: 1 });
    await (await this.env.items('ir.attachment').search([
      ['resModel', '=', this._name],
      ['resId', '=', 0],
      ['createdAt', '<', limitDate],
      ['updatedAt', '<', limitDate]]
    )).unlink();
  }

  // ACTIONS
  // ------------------------------------------------------------

  /**
   * Used for action button that do not accept arguments.
   * @returns 
   */
  async actionSendMail() {
    this._actionSendMail(false);
    return { 'type': 'ir.actions.actwindow.close' }
  }

  async _actionSendMail(autoCommit: boolean) {
    console.warn("Send email not implemented.");
  }

  /**
   * hit save as template button: current form value will be a new
      template attached to the current document.
   * @returns 
   */
  async actionSaveAsTemplate() {
    for (const record of this) {
      const model = await this.env.items('ir.model')._get(await record.model || 'mail.message');
      const modelName = await model.label || '';
      const templateName = f("%s: %s", modelName, ustr(await record.subject));
      const values = {
        'label': templateName,
        'subject': await record.subject || false,
        'bodyHtml': await record.body || false,
        'modelId': model.id || false,
        'useDefaultTo': true,
      }
      const template = await this.env.items('mail.template').create(values);

      const attachmentIds = await record.attachmentIds;
      if (attachmentIds.ok) {
        const attachments = await (await this.env.items('ir.attachment').sudo()).browse((await record['attachmentIds']).ids).filtered(
          async (a) => await a.resModel === 'mail.compose.message' && (a.createdUid).id == this._uid);
        if (attachments.ok) {
          await attachments.write({ 'resModel': template._name, 'resId': template.id });
        }
        await template.set('attachmentIds', (await template.attachmentIds).or(attachmentIds));
      }
      // generate the saved template
      await record.write({ 'templateId': template.id });
      await record._onchangeTemplateIdWrapper();
      return _reopen(this, record.id, await record.model, this._context);
    }
  }

  // RENDERING / VALUES GENERATION

  /**
   * Generate the values that will be used by send_mail to create mail_messages
        or mail_mails.
   * @param resIds 
   */
  async getMailValues(resIds) {
    this.ensureOne();
    const self = this as any;
    let results = Dict.fromKeys(resIds, false);
    let renderedValues = {}
    const massMailMode = await this['compositionMode'] === 'massMail';

    // render all template-based value at once
    if (massMailMode && await this['model']) {
      renderedValues = await self.renderMessage(resIds);
    }
    // compute alias-based reply-to in batch
    let replyToValue = Dict.fromKeys(resIds, null);
    if (massMailMode && ! await self.replyToForceNew) {
      const records = this.env.items(await self.model).browse(resIds);
      replyToValue = await records._notifyGetReplyTo(false);
      // when having no specific reply-to, fetch rendered email_from value
      for (const [resId, replyTo] of Object.entries(replyToValue)) {
        if (!replyTo) {
          replyToValue[resId] = (renderedValues[resId] ?? {})['emailFrom'] ?? false;
        }
      }
    }
    for (const resId of resIds) {
      // static wizard (mail.message) values
      const mailValues = {
        'subject': await self.subject,
        'body': await self.body || '',
        'parentId': bool(await self.parentId) && (await self.parentId).id,
        'partnerIds': await (await self.partnerIds).map(p => p.id),
        'attachmentIds': await (await self.attachmentIds).map(att => att.id),
        'authorId': (await self.authorId).id,
        'emailFrom': await self.emailFrom,
        'recordName': await self.recordName,
        'replyToForceNew': await self.replyToForceNew,
        'mailServerId': (await self.mailServerId).id,
        'mailActivityTypeId': (await self.mailActivityTypeId).id,
      }

      // mass mailing: rendering override wizard static values
      if (massMailMode && await self.model) {
        const record = self.env.items(await self.model).browse(resId);
        mailValues['headers'] = await record._notifyEmailHeaders();
        // keep a copy unless specifically requested, reset record name (avoid browsing records)
        update(mailValues, { isNotification: ! await self.autoDeleteMessage, model: await self.model, resId: resId, recordName: false });
        // auto deletion of mail_mail
        if (await self.autoDelete || await (await self.templateId).autoDelete) {
          mailValues['autoDelete'] = true;
        }
        // rendered values using template
        const emailDict = renderedValues[resId];
        mailValues['partnerIds'] = mailValues['partnerIds'].concat(pop(emailDict, 'partnerIds', []));
        update(mailValues, emailDict);
        if (! await self.replyToForceNew) {
          pop(mailValues, 'replyTo');
          if (replyToValue[resId]) {
            mailValues['replyTo'] = replyToValue[resId];
          }
        }
        if (await self.replyToForceNew && !mailValues['replyTo']) {
          mailValues['replyTo'] = mailValues['emailFrom'];
        }
        // mail_mail values: body -> body_html, partner_ids -> recipient_ids
        mailValues['bodyHtml'] = mailValues['body'] || '';
        mailValues['recipientIds'] = pop(mailValues, 'partnerIds', []).map(id => Command.link(id));

        // process attachments: should not be encoded before being processed by message_post / mail_mail create
        mailValues['attachments'] = pop(emailDict, 'attachments', []).map(([name, encCont]) => [name, b64decode(encCont)]);
        const attachmentIds = [];
        for (const attachId of pop(mailValues, 'attachmentIds')) {
          const newAttachId = await self.env.items('ir.attachment').browse(attachId).copy({ 'resModel': self._name, 'resId': self.id });
          attachmentIds.push(newAttachId.id);
        }
        attachmentIds.reverse();
        mailValues['attachmentIds'] = (await (await self.env.items('mail.thread').withContext({ attachedTo: record }))._messagePostProcessAttachments(
          pop(mailValues, 'attachments', []),
          attachmentIds,
          { 'model': 'mail.message', 'resId': 0 }
        ))['attachmentIds'];
      }

      results[resId] = mailValues;
    }

    results = await this._processState(results);
    return results;
  }

  async _processRecipientValues(mailValuesDict: Dict<any>) {
    // Preprocess res.partners to batch-fetch from db if recipient_ids is present
    // it means they are partners (the only object to fill get_default_recipient this way)
    const recipientPids = [];
    for (const mailValues of mailValuesDict.values()) {
      // recipient_ids is a list of x2m command tuples at this point
      for (const recipientCommand of mailValues['recipientIds'] ?? []) {
        if (recipientCommand[1]) {
          recipientPids.push(recipientCommand[1]);
        }
      }
    }

    const recipientEmails = recipientPids.length ? Object.fromEntries(await this.env.items('res.partner').browse(recipientPids).map(async (p) => [p.id, await p.email])) : {};

    const recipientsInfo = {};
    for (const [recordId, mailValues] of mailValuesDict.items()) {
      // add email from emailTo; if unrecognized email in emailTo keep
      // it as used for further processing
      let mailTo = emailSplitAndFormat(mailValues['emailTo']);
      if (!bool(mailTo) && mailValues['emailTo']) {
        mailTo.push(mailValues['emailTo']);
      }
      // add email from recipients (res.partner)
      for (const recipientCommand of mailValues['recipientIds'] ?? []) {
        if (recipientCommand[1]) {
          mailTo.push(recipientEmails[recipientCommand[1]]);
        }
      }
      // uniquify, keep ordering
      const seen = new Set<string>();
      mailTo = mailTo.filter(email => !seen.has(email) && seen.add(email));

      recipientsInfo[recordId] = {
        'mailTo': mailTo,
        'mailToNormalized': mailTo.filter(email => emailNormalize(email, false)).map(email => emailNormalize(email, false))
      }
    }
    return recipientsInfo;
  }

  async _processState(mailValuesDict: Dict<any>) {
    const recipientsInfo = await this._processRecipientValues(mailValuesDict);
    const blacklistIds = await this._getBlacklistRecordIds(mailValuesDict, recipientsInfo);
    const optoutEmails = await this._getOptoutEmails(mailValuesDict);
    const doneEmails = await this._getDoneEmails(mailValuesDict);
    // in case of an invoice e.g.
    const mailingDocumentBased = this.env.context['mailingDocumentBased'];

    for (const [recordId, mailValues] of mailValuesDict.items()) {
      const recipients = recipientsInfo[recordId];
      // when having more than 1 recipient: we cannot really decide when a single
      // email is linked to several to -> skip that part. Mass mailing should
      // anyway always have a single recipient per record as this is default behavior.
      if (len(recipients['mailTo']) > 1) {
        continue;
      }

      const mailTo = recipients['mailTo'] ? recipients['mailTo'][0] : '';
      const mailToNormalized = recipients['mailToNormalized'] ? recipients['mailToNormalized'][0] : '';

      // prevent sending to blocked addresses that were included by mistake
      // blacklisted or optout or duplicate -> cancel
      if (blacklistIds.has(recordId)) {
        mailValues['state'] = 'cancel';
        mailValues['failureType'] = 'mailBl';
        // Do not post the mail into the recipient's chatter
        mailValues['isNotification'] = false;
      }
      else if (optoutEmails && optoutEmails.includes(mailTo)) {
        mailValues['state'] = 'cancel';
        mailValues['failureType'] = 'mailOptout';
      }
      else if (doneEmails && doneEmails.includes(mailTo) && !mailingDocumentBased) {
        mailValues['state'] = 'cancel';
        mailValues['failureType'] = 'mailDup';
      }
      // void of falsy values -> error
      else if (!mailTo) {
        mailValues['state'] = 'cancel';
        mailValues['failureType'] = 'mailEmailMissing';
      }
      else if (!mailToNormalized) {
        mailValues['state'] = 'cancel';
        mailValues['failureType'] = 'mailEmailInvalid';
      }
      else if (doneEmails != null && !mailingDocumentBased) {
        doneEmails.push(mailTo);
      }
    }

    return mailValuesDict;
  }

  /**
   * Get record ids for which at least one recipient is black listed.
 
      :param dict mail_values_dict: mail values per record id
      :param dict recipients_info: optional dict of recipients info per record id
          Optional for backward compatibility but without, result can be incomplete.
      :return set: record ids with at least one black listed recipient.
   * @param mailValuesDict 
   * @param recipientsInfo 
   * @returns 
   */
  async _getBlacklistRecordIds(mailValuesDict: Dict<any>, recipientsInfo?: {}) {
    const blacklistedRecIds = new Set<string>();
    if (await this['compositionMode'] === 'massMail') {
      await this.env.items('mail.blacklist').flush(['email']);
      const res = await this._cr.execute(`SELECT email FROM ${dbFactory.name('mailBlacklist')} WHERE active=true`);
      const blacklist = res.map(x => x['email']);
      if (!blacklist.length) {
        return blacklistedRecIds;
      }
      const model = await this['model'];
      if (isSubclass(this.env.items(model), this.pool.models['mail.thread.blacklist'])) {
        const targets = await this.env.items(model).browse(mailValuesDict.keys()).read(['emailNormalized']);
        // First extract email from recipient before comparing with blacklist
        for (const target of targets) {
          if (blacklist.includes(await target['emailNormalized'])) {
            blacklistedRecIds.add(target.id);
          }
        }
      }
      else if (bool(recipientsInfo)) {
        // Note that we exclude the record if at least one recipient is blacklisted (-> even if not all)
        // But as commented above: Mass mailing should always have a single recipient per record.
        for (const [resId, recipientInfo] of Object.entries(recipientsInfo)) {
          if (_.intersection(blacklist, recipientInfo['mailToNormalized']).length) {
            blacklistedRecIds.add(resId);
          }
        }
      }
    }
    return blacklistedRecIds;
  }

  async _getDoneEmails(mailValuesDict) {
    return [];
  }

  async _getOptoutEmails(mailValuesDict) {
    return [];
  }

  /**
   * - mass_mailing: we cannot render, so return the template values
          - normal mode: return rendered values
          /!\ for x2many field, this onchange return command instead of ids
   * @param templateId 
   * @param compositionMode 
   * @param model 
   * @param resId 
   */
  async _onchangeTemplateId(templateId: any, compositionMode: any, model: any, resId: any) {
    let values;
    if (bool(templateId) && compositionMode === 'mass_mail') {
      const template = this.env.items('mail.template').browse(templateId);
      const fields = ['subject', 'bodyHtml', 'emailFrom', 'replyTo', 'mailServerId']
      values = new Dict();
      for (const field of fields) {
        const value = await template[field];
        if (value) {
          values[field] = value;
        }
      }
      const [attachmentIds, mailServerId] = await template('attachmentIds', 'mailServerId');
      if (bool(attachmentIds)) {
        values['attachmentIds'] = await attachmentIds.map(att => att.id);
      }
      if (bool(mailServerId)) {
        values['mailServerId'] = mailServerId.id;
      }
    }
    else if (templateId) {
      values = (await (this as any).generateEmailForComposer(
        templateId, [resId],
        ['subject', 'bodyHtml', 'emailFrom', 'emailTo', 'partnerTo', 'emailCc', 'replyTo', 'attachmentIds', 'mailServerId']
      ))[resId];
      // transform attachments into attachment_ids; not attached to the document because this will
      // be done further in the posting process, allowing to clean database if email not send
      const attachmentIds = [];
      const attachment = this.env.items('ir.attachment');
      for (const [attachFname, attachDatas] of values.pop('attachments', [])) {
        const dataAttach = {
          'label': attachFname,
          'datas': attachDatas,
          'resModel': 'mail.compose.message',
          'resId': 0,
          'type': 'binary',  // override default_type from context, possibly meant for another model!
        }
        attachmentIds.push((await attachment.create(dataAttach)).id);
      }
      if (values.get('attachmentIds', null) || attachmentIds) {
        values['attachmentIds'] = [Command.set(values.get('attachmentIds', []).concat(attachmentIds))];
      }
    }
    else {
      const defaultValues = await (await this.withContext({ default_compositionMode: compositionMode, default_model: model, default_resId: resId })).defaultGet(['compositionMode', 'model', 'resId', 'parentId', 'partnerIds', 'subject', 'body', 'emailFrom', 'replyTo', 'attachmentIds', 'mailServerId']);
      values = new Dict();
      for (const key of ['subject', 'body', 'partnerIds', 'emailFrom', 'replyTo', 'attachmentIds', 'mailServerId']) {
        if (key in defaultValues) {
          values[key] = defaultValues[key];
        }
      }
    }

    if (values.get('bodyHtml')) {
      values['body'] = values.pop('bodyHtml');
    }

    // This onchange should return command instead of ids for x2many field.
    values = await this._convertToWrite(values);

    return { 'value': values };
  }

  /**
   * Generate template-based values of wizard, for the document records given
      by resIds. This method is meant to be inherited by emailTemplate that
      will produce a more complete dictionary, using qweb templates.
 
      Each template is generated for all resIds, allowing to parse the template
      once, and render it multiple times. This is useful for mass mailing where
      template rendering represent a significant part of the process.
 
      Default recipients are also computed, based on mailThread method
      _messageGetDefaultRecipients. This allows to ensure a mass mailing has
      always some recipients specified.
 
      :param browse wizard: current mail.compose.message browse record
      :param list resIds: list of record ids
 
      :return dict results: for each resId, the generated template values for
                            subject, body, Cemail_from and replyTo
   * @param resIds 
   */
  async renderMessage(resIds) {
    this.ensureOne();
    let multiMode = true;
    if (typeof resIds === 'number') {
      multiMode = false;
      resIds = [resIds];
    }

    const self = this as any;
    const subjects = await self._renderField('subject', resIds, { options: { "renderSafe": true } });
    // We want to preserve comments in emails so as to keep mso conditionals
    const bodies = await (await this.withContext({ preserveComments: await this['compositionMode'] === 'mass_mail' }))._renderField('body', resIds, { postProcess: true });
    const emailsFrom = await self._renderField('emailFrom', resIds);
    const repliesTo = await self._renderField('replyTo', resIds);
    let defaultRecipients = {};
    if (!bool(await this['partnerIds'])) {
      const records = await this.env.items(await self.model).browse(resIds).sudo();
      defaultRecipients = await records._messageGetDefaultRecipients();
    }
    const results = Dict.fromKeys(resIds, false);
    for (const resId of resIds) {
      results[resId] = {
        'subject': subjects[resId],
        'body': bodies[resId],
        'emailFrom': emailsFrom[resId],
        'replyTo': repliesTo[resId],
      }
      update(results[resId], defaultRecipients[resId] ?? {});
    }

    // generate template-based values
    let templateValues;
    if (bool(await self.templateId)) {
      templateValues = await self.generateEmailForComposer(
        (await self.templateId).id, resIds,
        ['emailTo', 'partnerTo', 'emailCc', 'attachmentIds', 'mailServerId'])
    }
    else {
      templateValues = {};
    }
    for (const resId of resIds) {
      if (templateValues.get(resId)) {
        // recipients are managed by the template
        pop(results[resId], 'partnerIds', null);
        pop(results[resId], 'emailTo', null);
        pop(results[resId], 'emailCc', null);
        // remove attachments from template values as they should not be rendered
        pop(templateValues[resId], 'attachmentIds', null);
      }
      else {
        templateValues[resId] = {};
      }
      // update template values by composer values
      Object.assign(templateValues[resId], results[resId]);
    }
    return multiMode && bool(templateValues) || templateValues[resIds[0]];
  }

  /**
   * Call email_template.generate_email(), get fields relevant for
          mail.compose.message, transform email_cc and emailTo into partner_ids
   * @param templateId 
   * @param resIds 
   * @param fields 
   * @returns 
   */
  @api.model()
  async generateEmailForComposer(templateId, resIds, fields) {
    let multiMode = true;
    if (typeof resIds === 'number') {
      multiMode = false
      resIds = [resIds]
    }

    const returnedFields = fields.concat(['partnerIds', 'attachments']);
    const values = Dict.fromKeys(resIds, false);

    const templateValues = await (await this.env.items('mail.template').withContext({ tplPartnersOnly: true })).browse(templateId).generateEmail(resIds, fields);
    for (const resId of resIds) {
      const resIdValues = {};
      for (const field of returnedFields) {
        if (templateValues[resId][field]) {
          resIdValues[field] = templateValues[resId][field];
        }
      }
      resIdValues['body'] = pop(resIdValues, 'bodyHtml', '');
      values[resId] = resIdValues;
    }
    return multiMode && bool(values) || values[resIds[0]];
  }
}