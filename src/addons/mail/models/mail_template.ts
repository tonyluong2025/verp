import { Command, Fields, api } from "../../../core"
import { Dict } from "../../../core/helper/collections"
import { UserError } from "../../../core/helper/errors"
import { MetaModel, Model, _super } from "../../../core/models"
import { b64encode } from "../../../core/tools"
import { bool } from "../../../core/tools/bool"
import { extend } from "../../../core/tools/iterable"
import { emailSplit, htmlSanitize } from "../../../core/tools/mail"
import { pop, update } from "../../../core/tools/misc"
import { f } from "../../../core/tools/utils"

/**
 * 
 */
@MetaModel.define()
class MailTemplate extends Model {
  static _module = module;
  static _name = "mail.template";
  static _parents = ['mail.render.mixin'];
  static _description = 'Email Templates';
  static _order = 'label';

  _unrestrictedRendering = true;

  @api.model()
  async defaultGet(fields) {
    const res = await _super(MailTemplate, this).defaultGet(fields);
    if (res['model']) {
      res['modelId'] = await this.env.items('ir.model')._get(pop(res, 'model')).id;
    }
    return res;
  }

  // description
  static label = Fields.Char('Name', {translate: true});
  static modelId = Fields.Many2one('ir.model', {string: 'Applies to', help: "The type of document this template can be used with"});
  static model = Fields.Char('Related Document Model', {related: 'modelId.model', index: true, store: true, readonly: true});
  static subject = Fields.Char('Subject', {translate: true, help: "Subject (placeholders may be used here)"});
  static emailFrom = Fields.Char('From', {help: "Sender address (placeholders may be used here). If not set, the default value will be the author's email alias if configured, or email address."});
  // recipients
  static useDefaultTo = Fields.Boolean(
    'Default recipients',
    {help: `Default recipients of the record:\n
      - partner (using id on a partner or the partnerId field) OR\n
      - email (using emailFrom or email field)`});
  static emailTo = Fields.Char('To (Emails)', {help: "Comma-separated recipient addresses (placeholders may be used here)"});
  static partnerTo = Fields.Char('To (Partners)',
    {help: "Comma-separated ids of recipient partners (placeholders may be used here)"});
  static emailCc = Fields.Char('Cc', {help: "Carbon copy recipients (placeholders may be used here)"});
  static replyTo = Fields.Char('Reply To', {help: "Email address to which replies will be redirected when sending emails in mass; only used when the reply is not logged in the original discussion thread."});
  // content
  static bodyHtml = Fields.Html('Body', {renderEngine: 'qweb', translate: true, sanitize: false});
  static attachmentIds = Fields.Many2many('ir.attachment', {relation: 'emailTemplateAttachmentRel', column1: 'emailTemplateId',
    column2: 'attachmentId', string: 'Attachments', help: "You may attach files to this template, to be added to all emails created from this template"});
  static reportName = Fields.Char('Report Filename', {translate: true, help: "Name to use for the generated report file (may contain placeholders)\n The extension can be omitted and will then come from the report type."});
  static reportTemplate = Fields.Many2one('ir.actions.report', {string: 'Optional report to print and attach'});
  // options
  static mailServerId = Fields.Many2one('ir.mail.server', {string: 'Outgoing Mail Server', readonly: false, help: "Optional preferred server for outgoing mails. If not set, the highest priority one will be used."});
  static scheduledDate = Fields.Char('Scheduled Date', {help: "If set, the queue manager will send the email after the date. If not set, the email will be send as soon as possible. You can use dynamic expressions expression."});
  static autoDelete = Fields.Boolean(
      'Auto Delete', {default: true,
      help: "This option permanently removes any track of email after it's been sent, including from the Technical menu in the Settings, in order to preserve storage space of your Verp database."});
  // contextual action
  static refIrActwindow = Fields.Many2one('ir.actions.actwindow', {string: 'Sidebar action', readonly: true, copy: false, help: "Sidebar action to make this template available on records of the related document model"});

  // access
  static canWrite = Fields.Boolean({compute: '_computeCanWrite', help: 'The current user can edit the template.'});

  // Overrides of mail.render.mixin
  @api.depends('model')
  async _computeRenderModel() {
    for (const template of this) {
      await template.set('renderModel', await template.model);
    }
  }

  @api.dependsContext('uid')
  async _computeCanWrite() {
    const writableTemplates = await this._filterAccessRules('write');
    for (const template of this) {
      await template.set('canWrite', writableTemplates.includes(template));
    }
  }

  // ------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------

  async _fixAttachmentOwnership() {
    for (const record of this) {
      await (await record.attachmentIds).write({'resModel': record._name, 'resId': record.id});
    }
    return this;
  }

  @api.modelCreateMulti()
  async create(valuesList) {
    const rec = await _super(MailTemplate, this).create(valuesList);
    return rec._fixAttachmentOwnership();
  }

  async write(vals) {
    await _super(MailTemplate, this).write(vals);
    await this._fixAttachmentOwnership();
    return true;
  }

  async unlink() {
    await this.unlinkAction();
    return _super(MailTemplate, this).unlink();
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue: any) {
    defaultValue = Dict.from<any>(defaultValue ?? {}).updateFrom({name: await this._t("%s (copy)", await this['label'])});
    return _super(MailTemplate, this).copy(defaultValue);
  }

  async unlinkAction() {
    for (const template of this) {
      const refIrActwindow = await template.refIrActwindow;
      if (refIrActwindow.ok) {
        await refIrActwindow.unlink();
      }
    }
    return true;
  }

  async createAction() {
    const Actwindow = this.env.items('ir.actions.actwindow');
    const view = await this.env.ref('mail.emailComposeMessageWizardForm');

    for (const template of this) {
      const buttonName = await this._t('Send Mail (%s)', await template.label);
      const action = await Actwindow.create({
        'label': buttonName,
        'type': 'ir.actions.actwindow',
        'resModel': 'mail.compose.message',
        'context': f("{'default_compositionMode': 'massMail', 'default_templateId' : %s, 'default_useTemplate': true}", template.id),
        'viewMode': 'form,tree',
        'viewId': view.id,
        'target': 'new',
        'bindingModelId': (await template.modelId).id,
      })
      await template.write({'refIrActwindow': action.id});
    }
    return true;
  }

  // ------------------------------------------------------------
  // MESSAGE/EMAIL VALUES GENERATION
  // ------------------------------------------------------------

  /**
   * Generates the recipients of the template. Default values can ben generated
    instead of the template values if requested by template or context.
    Emails (emailTo, emailCc) can be transformed into partners if requested
    in the context.
   * @param results 
   * @param resIds 
   * @returns 
   */
  async generateRecipients(results, resIds) {
    this.ensureOne();

    const thisModel = await this['model'];

    if (await this['useDefaultTo'] || this._context['tplForceDefaultTo']) {
      const records = await this.env.items(thisModel).browse(resIds).sudo();
      const defaultRecipients = await records._messageGetDefaultRecipients();
      for (const [resId, recipients] of defaultRecipients.items()) {
        pop(results[resId], 'partnerTo', null);
        Object.assign(results[resId], recipients);
      }
    }

    let recordsCompany = null;
    if (this._context['tplPartnersOnly'] && thisModel && bool(results) && 'companyId' in this.env.models[thisModel]._fields) {
      const records = await this.env.items(thisModel).browse(Object.keys(results)).read(['companyId']);
      recordsCompany = {};
      for (const rec of records) {
        recordsCompany[rec['id']] = (await rec['companyId']).ok ? await (await rec['companyId'])(0) : null;
      }
    }

    for (const [resId, values] of Object.entries(results)) {
      const partnerIds = values['partnerIds'] ?? [];
      if (this._context['tplPartnersOnly']) {
        const mails = emailSplit(pop(values, 'emailTo', '')).concat(emailSplit(pop(values, 'emailCc', '')));
        let Partner = this.env.items('res.partner');
        if (recordsCompany) {
          Partner = await Partner.withContext({default_companyId: recordsCompany[resId]});
        }
        for (const mail of mails) {
          const partner = await Partner.findOrCreate(mail);
          partnerIds.push(partner.id);
        }
      }
      const partnerTo = pop(values, 'partnerTo', '');
      if (partnerTo) {
        // placeholders could generate '', 3, 2 due to some empty field values
        const tplPartnerIds = partnerTo.split(',').filter(pip => !!pip).map(pip => parseInt);
        extend(partnerIds, (await (await this.env.items('res.partner').sudo()).browse(tplPartnerIds).exists()).ids);
      }
      results[resId]['partnerIds'] = partnerIds;
    }
    return results;
  }

  /**
   * Generates an email from the template for given the given model based on
    records given by resIds.

    :param resId: id of the record to use for rendering the template (model
                    is taken from template definition)
    :returns: a dict containing all relevant fields for creating a new
              mail.mail entry, with one extra key ``attachments``, in the
              format [(reportName, data)] where data is base64 encoded.
   * @param resIds 
   * @param fields 
   * @returns 
   */
  async generateEmail(resIds, fields) {
    this.ensureOne();
    let multiMode = true;
    if (typeof(resIds) === 'number') {
      resIds = [resIds];
      multiMode = false;
    }

    let results = new Dict<any>();
    for (const [lang, [template, templateResIds]] of Object.entries<any>(await (this as any)._classifyPerLang(resIds))) {
      for (const field of fields) {
        const generatedFieldValues = await template._renderField(
          field, templateResIds,
          {options: {'renderSafe': field === 'subject'},
          postProcess: field === 'bodyHtml'}
        )
        for (const [resId, fieldValue] of Object.entries(generatedFieldValues)) {
          results.setdefault(resId, new Dict())[field] = fieldValue;
        }
      }
      // compute recipients
      if (fields.some(field => ['emailTo', 'partnerTo', 'emailCc'].includes(field))) {
        results = await template.generateRecipients(results, templateResIds);
      }
      // update values for all resIds
      for (const resId of templateResIds) {
        const values = results[resId];
        if (values['bodyHtml']) {
          values['body'] = htmlSanitize(values['bodyHtml']);
        }
        // technical settings
        Object.assign(values,
          {mailServerId: (await template.mailServerId).id || false,
          autoDelete: await template.autoDelete,
          model: await template.model,
          resId: resId || false,
          attachmentIds: [...await template.attachmentIds].map(attach => attach.id)},
        );
      }

      // Add report in attachments: generate once for all template_resIds
      const report = await template.reportTemplate;
      if (report.ok) {
        for (const resId of templateResIds) {
          const attachments = [];
          let reportName = (await template._renderField('reportName', [resId]))[resId];
          const reportService = await report.reportName;

          let result, format;
          if (['qweb-html', 'qweb-pdf'].includes(await report.reportType)) {
            [result, format] = await report._renderQwebPdf([resId]);
          }
          else {
            const res = await report._render([resId]);
            if (! res) {
              throw new UserError(await this._t('Unsupported report type %s found.', await report.reportType));
            }
            [result, format] = res;
          }

          // TODO in trunk, change return format to binary to match messagePost expected format
          result = b64encode(result);
          if (! reportName) {
            reportName = 'report.' + reportService;
          }
          const ext = "." + format;
          if (! reportName.endsWith(ext)) {
            reportName += ext;
          }
          attachments.push([reportName, result]);
          results[resId]['attachments'] = attachments;
        }
      }
    }
    return multiMode ? results : results[resIds[0]];
  }
  
  // ------------------------------------------------------------
  // EMAIL
  // ------------------------------------------------------------

  async _sendCheckAccess(resIds) {
    const records = this.env.items(await this['model']).browse(resIds);
    await records.checkAccessRights('read');
    await records.checkAccessRule('read');
  }

  /**
   * Generates a new mail.mail. Template is rendered on record given by
    resId and model coming from template.

    :param int resId: id of the record to render the template
    :param bool force_send: send email immediately; otherwise use the mail
        queue (recommended);
    :param dict email_values: update generated mail with those values to further
        customize the mail;
    :param str notif_layout: optional notification layout to encapsulate the
        generated email;
    :returns: id of the mail.mail that was created 
   * @param resId 
   * @param options 
   */
  async sendMail(resId, options: {forceSend?: boolean, raiseException?: boolean, emailValues?: any, notifLayout?: string}={}) {
    // Grant access to sendMail only if access to related document
    this.ensureOne();
    await this._sendCheckAccess([resId]);

    const Attachment = this.env.items('ir.attachment');  // TDE FIXME: should remove default_type from context

    // create a mail_mail based on values, without attachments
    const values = await this.generateEmail(resId, ['subject', 'bodyHtml', 'emailFrom', 'emailTo', 'partnerTo', 'emailCc', 'replyTo', 'scheduledDate']);
    values['recipientIds'] = (values['partnerIds'] ?? []).map(pid => Command.link(pid));
    values['attachmentIds'] = (values['attachmentIds'] ?? []).map(aid => Command.link(aid));
    update(values, options.emailValues ?? {});
    const attachmentIds = pop(values, 'attachmentIds', []);
    const attachments = pop(values, 'attachments', []);
    // add a protection against void emailFrom
    if ('emailFrom' in values && ! values['emailFrom']) {
      pop(values, 'emailFrom');
    }
    // encapsulate body
    if (options.notifLayout && values['bodyHtml']) {
      let template, err;
      try {
        template = await this.env.ref(options.notifLayout, true);
      } catch(e) {
      // except ValueError:
        err = true;
        console.warn(f('QWeb template %s not found when sending template %s. Sending without layouting.', options.notifLayout, await this['label']));
      }
      if (!err) {
        const record = this.env.items(await this['model']).browse(resId);
        let model = await this.env.items('ir.model')._get(record._name);

        if (await this['lang']) {
          const lang = (await (this as any)._renderLang([resId]))[resId];
          template = await template.withContext({lang: lang});
          model = await model.withContext({lang: lang});
        }

        const templateCtx = {
          'message': await (await this.env.items('mail.message').sudo()).new(Object.assign({}, {body: values['bodyHtml'], recordName: await record.displayName})),
          'modelDescription': await model.displayName,
          'company': 'companyId' in record._fields && bool(await record['companyId']) && await record['companyId'] || await this.env.company(),
          'record': record,
        }
        const body = await template._render(templateCtx, {engine: 'ir.qweb', minimalQcontext: true});
        values['bodyHtml'] = await this.env.items('mail.render.mixin')._replaceLocalLinks(body);
      }
    }
    const mail = await (await this.env.items('mail.mail').sudo()).create(values);

    // manage attachments
    for (const attachment of attachments) {
      const attachmentData = {
        'label': attachment[0],
        'datas': attachment[1],
        'type': 'binary',
        'resModel': 'mail.message',
        'resId': (await mail.mailMessageId).id,
      }
      attachmentIds.push([4, (await Attachment.create(attachmentData)).id]);
    }
    if (attachmentIds.length) {
      await mail.write({'attachmentIds': attachmentIds});
    }

    if (options.forceSend) {
      await mail.send(false, options.raiseException);
    }
    return mail.id  // TDE CLEANME: return mail + api.returns ?
  }
}