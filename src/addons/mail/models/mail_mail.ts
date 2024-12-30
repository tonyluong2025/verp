import _ from "lodash";
import { DateTime } from "luxon";
import { AssertionError } from "node:assert";
import nodemailer from "nodemailer";
import { Fields, api } from "../../../core";
import { MailDeliveryException } from "../../../core/addons/base/models/ir_mail_server";
import { getattr } from "../../../core/api/func";
import { UnicodeEncodeError } from "../../../core/helper";
import { Dict } from "../../../core/helper/collections";
import { MetaModel, Model, _super } from "../../../core/models";
import { AST } from "../../../core/service/middleware/ast";
import { b64decode, bool, emailSplit, emailSplitAndFormat, extend, f, formataddr, html2Text, isInstance, len, parseInt, splitEvery, ustr } from "../../../core/tools";
import { DEFAULT_SERVER_DATETIME_FORMAT, pop, update } from "../../../core/tools/misc";

/**
 * Model holding RFC2822 email messages to send. This model also provides facilities to queue and send new email messages.
 */
@MetaModel.define()
class MailMail extends Model {
  static _module = module;
  static _name = 'mail.mail';
  static _description = 'Outgoing Mails';
  static _inherits = { 'mail.message': 'mailMessageId' }
  static _order = 'id desc';
  static _recName = 'subject';

  @api.model()
  async defaultGet(fields) {
    // protection for `default_type` values leaking from menu action context (e.g. for invoices)
    // To remove when automatic context propagation is removed in web client
    let self;
    if (!this._fields['messageType'].baseField.selection.includes(this._context['default_type'])) {
      self = await this.withContext(Object.assign(this._context, { default_type: null }));
    }
    if (!this._fields['state'].baseField.selection.includes(self._context['default_state'])) {
      self = await self.withContext(Object.assign(this._context, { default_state: 'outgoing' }));
    }
    return _super(MailMail, self).defaultGet(fields);
  }

  // content
  static mailMessageId = Fields.Many2one('mail.message', { string: 'Message', required: true, ondelete: 'CASCADE', index: true, autojoin: true });
  static bodyHtml = Fields.Text('Rich-text Contents', { help: "Rich-text/HTML message" })
  static references = Fields.Text('References', { help: 'Message references, such as identifiers of previous messages', readonly: 1 })
  static headers = Fields.Text('Headers', { copy: false })
  // Auto-detected based on create() - if 'mail_message_id' was passed then this mail is a notification
  // and during unlink() we will not cascade delete the parent and its attachments
  static isNotification = Fields.Boolean('Notification Email', { help: 'Mail has been created to notify people of an existing mail.message' })
  // recipients: include inactive partners (they may have been archived after
  // the message was sent, but they should remain visible in the relation)
  static emailTo = Fields.Text('To', { help: 'Message recipients (emails)' })
  static emailCc = Fields.Char('Cc', { help: 'Carbon copy message recipients' })
  static recipientIds = Fields.Many2many('res.partner', { string: 'To (Partners)', context: { 'activeTest': false } })
  // process
  static state = Fields.Selection([
    ['outgoing', 'Outgoing'],
    ['sent', 'Sent'],
    ['received', 'Received'],
    ['exception', 'Delivery Failed'],
    ['cancel', 'Cancelled'],
  ], { string: 'Status', readonly: true, copy: false, default: 'outgoing' })
  static failureType = Fields.Selection([
    // generic
    ["unknown", "Unknown error"],
    // mail
    ["mailEmailInvalid", "Invalid email address"],
    ["mailEmailMissing", "Missing email"],
    ["mailSmtp", "Connection failed (outgoing mail server problem)"],
    // mass mode
    ["mailBl", "Blacklisted Address"],
    ["mailOptout", "Opted Out"],
    ["mailDup", "Duplicated Email"],
  ], { string: 'Failure type' })
  static failureReason = Fields.Text(
    'Failure Reason', {
    readonly: 1, copy: false,
    help: "Failure reason. This is usually the exception thrown by the email server, stored to ease the debugging of mailing issues."
  })
  static autoDelete = Fields.Boolean(
    'Auto Delete',
    { help: "This option permanently removes any track of email after it's been sent, including from the Technical menu in the Settings, in order to preserve storage space of your Verp database." })
  static scheduledDate = Fields.Char('Scheduled Send Date',
    { help: "If set, the queue manager will send the email after the date. If not set, the email will be send as soon as possible. Unless a timezone is specified, it is considered as being in UTC timezone." })

  @api.modelCreateMulti()
  async create(valuesList) {
    // notification field: if not set, set if mail comes from an existing mail.message
    for (const values of valuesList) {
      if (!('isNotification' in values) && values['mailMessageId']) {
        values['isNotification'] = true;
      }
      if (values['scheduledDate']) {
        const parsedDatetime = this._parseScheduledDatetime(values['scheduledDate']);
        if (parsedDatetime) {
          values['scheduledDate'] = DateTime.fromJSDate(new Date(Date.parse(parsedDatetime))).toFormat(DEFAULT_SERVER_DATETIME_FORMAT);
        }
        else {
          values['scheduledDate'] = false;
        }
      }
    }
    const newMails = await _super(MailMail, this).create(valuesList);

    let newMailsAttach = this;
    for (const [mail, values] of _.zip([...newMails], valuesList)) {
      if (values['attachmentIds']) {
        newMailsAttach = newMailsAttach.add(mail);
      }
    }
    if (newMailsAttach.ok) {
      await (await newMailsAttach.mapped('attachmentIds')).check('read');
    }
    return newMails;
  }

  async write(vals) {
    if (vals['scheduledDate']) {
      const parsedDatetime = this._parseScheduledDatetime(vals['scheduledDate']);
      if (parsedDatetime) {
        vals['scheduledDate'] = DateTime.fromJSDate(new Date(Date.parse(parsedDatetime))).toFormat(DEFAULT_SERVER_DATETIME_FORMAT);
      }
      else {
        vals['scheduledDate'] = false;
      }
    }
    const res = await _super(MailMail, this).write(vals);
    if (vals['attachmentIds']) {
      for (const mail of this) {
        await (await mail.attachmentIds).check('read');
      }
    }
    return res;
  }

  async unlink() {
    // cascade-delete the parent message for all mails that are not created for a notification
    const mailMsgCascadeIds = [];
    for (const mail of this) {
      if (! await mail.isNotification) {
        mailMsgCascadeIds.push((await mail.mailMessageId).id)
      }
    }
    const res = await _super(MailMail, this).unlink();
    if (mailMsgCascadeIds.length) {
      await this.env.items('mail.message').browse(mailMsgCascadeIds).unlink();
    }
    return res;
  }

  async actionRetry() {
    await (await this.filtered(async (mail) => await mail.state === 'exception')).markUutgoing();
  }

  async markOutgoing() {
    return this.write({ 'state': 'outgoing' });
  }

  async cancel() {
    return this.write({ 'state': 'cancel' });
  }

  /**
   * Send immediately queued messages, committing after each
    message is sent - this is not transactional and should
    not be called during another transaction!

    :param list ids: optional list of emails ids to send. If passed
                    no search is performed, and these ids are used
                    instead.
    :param dict context: if a 'filters' key is present in context,
                        this value will be used as an additional
                        filter to further restrict the outgoing
                        messages to send (by default all 'outgoing'
                        messages are sent).
   * @param ids 
   * @returns 
   */
  @api.model()
  async processEmailQueue(ids: any) {
    const filters = [
      '&',
      ['state', '=', 'outgoing'],
      '|',
      ['scheduledDate', '=', false],
      ['scheduledDate', '<=', Date.now()],
    ]
    if ('filters' in this._context) {
      extend(filters, this._context['filters'] as any);
    }
    // TODO: make limit configurable
    const filteredIds = (await this.search(filters, { limit: 10000 })).ids;
    if (!bool(ids)) {
      ids = filteredIds
    }
    else {
      ids = _.intersection(filteredIds, ids);
    }
    ids = ids.sort();

    let res;
    try {
      // auto-commit except in testing mode
      const autoCommit = !getattr(this.env, 'testing', false)
      res = await this.browse(ids).send(autoCommit);
    } catch (e) {
      console.error("Failed processing mail queue");
    }
    return res;
  }

  /**
   * Perform any post-processing necessary after sending ``mail``
    successfully, including deleting it completely along with its
    attachment if the ``autoDelete`` flag of the mail was set.
    Overridden by subclasses for extra post-processing behaviors.

    :return: true
   * @param successPids 
   * @param failureReason 
   * @param failureType 
   * @returns 
   */
  async _postprocessSentMessage(successPids, failureReason = false, failureType = null) {
    const notifMailsIds = []
    for (const mail of this) {
      if (await mail.isNotification) {
        notifMailsIds.push(mail.id);
      }
    }
    if (notifMailsIds.length) {
      const notifications = await this.env.items('mail.notification').search([
        ['notificationType', '=', 'email'],
        ['mailMailId', 'in', notifMailsIds],
        ['notificationStatus', 'not in', ['sent', 'canceled']]
      ]);
      if (notifications.ok) {
        // find all notification linked to a failure
        let failed = this.env.items('mail.notification');
        if (failureType) {
          failed = await notifications.filtered(async (notif) => !successPids.includes(await notif.resPartnerId));
        }
        await (await notifications.sub(failed).sudo()).write({
          'notificationStatus': 'sent',
          'failureType': '',
          'failureReason': '',
        });
        if (failed.ok) {
          await (await failed.sudo()).write({
            'notificationStatus': 'exception',
            'failureType': failureType,
            'failureReason': failureReason,
          })
          const messages = await (await notifications.mapped('mailMessageId')).filtered(async (m) => m.isThreadMessage())
          // TDE TODO: could be great to notify message-based, not notifications-based, to lessen number of notifs
          await messages._notifyMessageNotificationUpdate()  // notify user that we have a failure
        }
      }
    }
    if (!failureType || ['mailEmailInvalid', 'mailEmailMissing'].includes(failureType)) {  // if we have another error, we want to keep the mail.
      const mailToDeleteIds = [];
      for (const mail of this) {
        if (await mail.autoDelete) {
          mailToDeleteIds.push(mail.id);
        }
      }
      await (await this.browse(mailToDeleteIds).sudo()).unlink();
    }
    return true;
  }

  /**
   * Taking an arbitrary datetime (either as a date, a datetime or a string)
    try to parse it and return a datetime timezoned to UTC.

    If no specific timezone information is given, we consider it as being
    given in UTC, as all datetime values given to the server. Trying to
    guess its timezone based on user or flow would be strange as this is
    not standard. When manually creating datetimes for mail.mail scheduled
    date, business code should ensure either a timezone info is set, either
    it is converted into UTC.

    Using yearfirst when parsing str datetimes eases parser's job when
    dealing with the hard-to-parse trio (01/04/09 -> ?). In most use cases
    year will be given first as this is the expected default formatting.

    :return datetime: parsed datetime (or false if parser failed)
   * @param scheduledDatetime 
   */
  _parseScheduledDatetime(scheduledDatetime): string {
    let parsedDatetime;
    if (isInstance(scheduledDatetime, Date)) {
      parsedDatetime = scheduledDatetime;
    }
    // else if (isInstance(scheduled_datetime, datetime.date):
    //     parsed_datetime = datetime.combine(scheduled_datetime, datetime.time.min)
    else {
      try {
        parsedDatetime = new Date(Date.parse(scheduledDatetime));
      } catch (e) {
        // except (ValueError, TypeError):
        // parsedDatetime = false;
      }
    }
    if (parsedDatetime) {
      if (!parsedDatetime.getTimezoneOffset()) {
        parsedDatetime = parsedDatetime.toLocaleString();
        //pytz.utc.localize(parsed_datetime)
      }
      else {
        try {
          parsedDatetime = parsedDatetime.toISOString();
          // parsedDatetime.astimezone(pytz.utc)
        } catch (e) {
          // pass
        }
      }
    }
    return parsedDatetime;
  }

  // ------------------------------------------------------
  // mail_mail formatting, tools and send mechanism
  // ------------------------------------------------------

  /**
   * Return a specific ir_email body. The main purpose of this method
    is to be inherited to add custom content depending on some module.
   * @returns 
   */
  async _sendPrepareBody() {
    this.ensureOne();
    return await (this as any).bodyHtml || ''
  }

  /**
   * Return a dictionary for specific email values, depending on a
    partner, or generic to the whole recipients given by mail.emailTo.

    :param Model partner: specific recipient partner
   * @param self 
   * @param partner 
   */
  async _sendPrepareValues(partner?: any) {
    this.ensureOne();
    const body = await this._sendPrepareBody();
    const bodyAlternative = html2Text(body);
    let emailTo;
    if (bool(partner)) {
      emailTo = [formataddr([await partner.label ?? 'false', await partner.email ?? 'false'])]
    }
    else {
      emailTo = emailSplitAndFormat(await (this as any).emailTo);
    }
    const res = {
      'body': body,
      'bodyAlternative': bodyAlternative,
      'emailTo': emailTo,
    }
    return res;
  }

  /**
   * Group the <mail.mail> based on their "emailFrom" and their "mail_server_id".

    The <mail.mail> will have the "same sending configuration" if they have the same
    mail server or the same mail from. For performance purpose, we can use an SMTP
    session in batch and therefore we need to group them by the parameter that will
    influence the mail server used.

    The same "sending configuration" may repeat in order to limit batch size
    according to the `mail.session.batch.size` system parameter.

    Return iterators over
        mailServerId, emailFrom, Records<mail.mail>.ids
   */
  async* _splitByMailConfiguration() {
    const mailValues = await this.read(['id', 'emailFrom', 'mailServerId']);

    // First group the <mail.mail> per mail_server_id and per emailFrom
    const groupPerEmailFrom = new Dict<any>() //list)
    for (const values of mailValues) {
      const mailServerId = values['mailServerId'] ? values['mailServerId'][0] : false;
      const k = `${mailServerId}::${values['emailFrom']}`;
      groupPerEmailFrom[k] = groupPerEmailFrom[k] ?? [];
      groupPerEmailFrom[k].push(values['id']);
    }

    // Then find the mail server for each emailFrom and group the <mail.mail>
    // per mailServerId and smtp_from
    const mailServers = await (await this.env.items('ir.mail.server').sudo()).search([], { order: 'sequence' });
    const groupPerSmtpFrom = new Dict<any>() //(list)
    for (const [key, mailIds] of groupPerEmailFrom.items()) {
      let [mailServerId, emailFrom] = key.split('::') as any;
      mailServerId = parseInt(mailServerId);
      let mailServer, smtpFrom;
      if (!mailServerId) {
        [mailServer, smtpFrom] = await this.env.items('ir.mail.server')._findMailServer(emailFrom, mailServers);
        mailServerId = bool(mailServer) ? mailServer.id : false;
      }
      else {
        smtpFrom = emailFrom;
      }
      const k = `${mailServerId}::${smtpFrom}`;
      groupPerSmtpFrom[k] = groupPerSmtpFrom[k] ?? [];
      extend(groupPerSmtpFrom[k], mailIds);
    }

    const sysParams = await this.env.items('ir.config.parameter').sudo();
    const batchSize = parseInt(await sysParams.getParam('mail.session.batch.size', 1000));

    for (const [key, recordIds] of groupPerSmtpFrom.items()) {
      let [mailServerId, smtpFrom] = key.split('::') as any;
      mailServerId = parseInt(mailServerId);
      for (const batchIds of splitEvery(batchSize, recordIds)) {
        yield [mailServerId, smtpFrom, batchIds];
      }
    }
  }

  /**
   * Sends the selected emails immediately, ignoring their current
    state (mails that have already been sent should not be passed
    unless they should actually be re-sent).
    Emails successfully delivered are marked as 'sent', and those
    that fail to be deliver are marked as 'exception', and the
    corresponding error mail is output in the server logs.

    :param bool auto_commit: whether to force a commit of the mail status
        after sending each mail (meant only for scheduler processing);
        should never be true during normal transactions (default: false)
    :param bool raiseException: whether to raise an exception if the
        email sending process has failed
    :return: true
   * @param autoCommit 
   * @param raiseException 
   */
  async send(autoCommit = false, raiseException = false) {
    for await (const [mailServerId, smtpFrom, batchIds] of this._splitByMailConfiguration()) {
      let smtpSession: nodemailer.Transporter;
      let err;
      try {
        smtpSession = await this.env.items('ir.mail.server').connect({ host: mailServerId, smtpFrom });
      } catch (e) {
        // except Exception as exc:
        if (raiseException) {
          // To be consistent and backward compatible with mail_mail.send() raised
          // exceptions, it is encapsulated into an Verp MailDeliveryException
          throw new MailDeliveryException(await this._t('Unable to connect to SMTP Server'), e);
        }
        else {
          const batch = this.browse(batchIds);
          await batch.write({ 'state': 'exception', 'failureReason': e })
          await batch._postprocessSentMessage([], false, "mailSmtp");
        }
        err = true;
      }
      if (!err) {
        await this.browse(batchIds)._send(autoCommit, raiseException, smtpSession);
        console.info('Sent batch %s emails via mail server ID #%s', len(batchIds), mailServerId);
      }
      // finally:
      if (smtpSession) {
        // smtpSession.close();
      }
    }
  }

  async _send(autoCommit = false, raiseException = false, smtpSession: any) {
    const IrMailServer = this.env.items('ir.mail.server');
    const IrAttachment = this.env.items('ir.attachment');
    for (const mailId of this.ids) {
      const successPids = [];
      let failureType;
      let processingPid;
      let mail;
      try {
        mail = this.browse(mailId);
        if (await mail.state != 'outgoing') {
          if (await mail.state != 'exception' && await mail.autoDelete) {
            await (await mail.sudo()).unlink();
          }
          continue;
        }

        // remove attachments if user send the link with the access_token
        let body = await mail.bodyHtml || '';
        let attachments = await mail.attachmentIds;
        for (const [str, link] of body.matchAll(/\/web\/(?:content|image)\/([0-9]+)/g)) {
          attachments = attachments.sub(IrAttachment.browse(parseInt(link)));
        }

        // load attachment binary data with a separate read(), as prefetching all
        // `datas` (binary field) could bloat the browse cache, triggerring
        // soft/hard mem limits with temporary data.
        attachments = (await (await attachments.sudo()).read(['label', 'datas', 'mimetype'])).filter(a => a['datas'] != false).map(a => [a['label'], b64decode(a['datas']), a['mimetype']]);

        // specific behavior to customize the send email for notified partners
        const emailList = [];
        if (await mail.emailTo) {
          emailList.push(await mail._sendPrepareValues());
        }
        for (const partner of await mail.recipientIds) {
          const values = await mail._sendPrepareValues(partner);
          values['partnerId'] = partner;
          emailList.push(values);
        }

        // headers
        const headers = {}
        const ICP = await this.env.items('ir.config.parameter').sudo();
        const bounceAlias = await ICP.getParam("mail.bounce.alias");
        const catchallDomain = await ICP.getParam("mail.catchall.domain");
        if (bounceAlias && catchallDomain) {
          headers['Return-Path'] = f('%s@%s', bounceAlias, catchallDomain);
        }
        if (await mail.headers) {
          try {
            update(headers, AST.Literal(await mail.headers));
          } catch (e) {
            //pass
          }
        }

        // Writing on the mail object may fail (e.g. lock on user) which
        // would trigger a rollback *after* actually sending the email.
        // To avoid sending twice the same email, provoke the failure earlier
        await mail.write({
          'state': 'exception',
          'failureReason': await this._t('Error without exception. Probably due do sending an email without computed recipients.'),
        });
        // Update notification in a transient exception state to avoid concurrent
        // update in case an email bounces while sending all emails related to current
        // mail record.
        const notifs = await this.env.items('mail.notification').search([
          ['notificationType', '=', 'email'],
          ['mailMailId', 'in', mail.ids],
          ['notificationStatus', 'not in', ['sent', 'canceled']]
        ]);
        if (bool(notifs)) {
          const notifMsg = await this._t('Error without exception. Probably due do concurrent access update of notification records. Please see with an administrator.')
          await (await notifs.sudo()).write({
            'notificationStatus': 'exception',
            'failureType': 'unknown',
            'failureReason': notifMsg,
          });
          // `testMailBounceDuringSend`, force immediate update to obtain the lock.
          await notifs.flush(['notificationStatus', 'failureType', 'failureReason'], notifs);
        }

        // protect against ill-formatted email_from when formataddr was used on an already formatted email
        const emailsFrom = emailSplitAndFormat(await mail.emailFrom);
        const emailFrom = bool(emailsFrom) ? emailsFrom[0] : await mail.emailFrom;

        // build an RFC2822 email.message.Message object and send it without queuing
        let res;
        // TDE note: could be great to pre-detect missing to/cc and skip sending it
        // to go directly to failed state update
        for (const email of emailList) {
          const msg = await IrMailServer.buildEmail(
            emailFrom,
            email['emailTo'],
            await mail.subject,
            email['body'], {
            bodyAlternative: email['bodyAlternative'],
            emailCc: emailSplit(await mail.emailCc),
            replyTo: await mail.replyTo,
            attachments: attachments,
            messageId: await mail.messageId,
            references: await mail.references,
            objectId: await mail.resId && f('%s-%s', await mail.resId, await mail.model),
            subtype: 'html',
            subtypeAlternative: 'plain',
            headers: headers
          });
          processingPid = pop(email, "partnerId", null);
          try {
            res = await IrMailServer.sendEmail(
              msg, { mailServerId: (await mail.mailServerId).id, smtpSession: smtpSession });
            if (processingPid) {
              successPids.push(processingPid);
            }
            processingPid = null;
          } catch (e) {
            // except AssertionError as error:
            if (e.message == IrMailServer.NO_VALID_RECIPIENT[0]) {
              // if we have a list of void emails for email_list -> email missing, otherwise generic email failure
              if (!email['emailTo'] && failureType != "mailEmailInvalid") {
                failureType = "mailEmailMissing";
              }
              else {
                failureType = "mailEmailInvalid";
              }
              // No valid recipient found for this particular
              // mail item -> ignore error to avoid blocking
              // delivery to next recipients, if any. If this is
              // the only recipient, the mail will show as failed.
              console.info("Ignoring invalid recipients for mail.mail %s: %s",
                await mail.messageId, email['emailTo']);
            }
            else {
              throw e;
            }
          }
        }
        if (res) {  // mail has been sent at least once, no major exception occurred
          await mail.write({ 'state': 'sent', 'messageId': res, 'failureReason': false });
          console.info('Mail with ID #%s and Message-Id %s successfully sent', mail.id, await mail.messageId);
          // /!\ can't use mail.state here, as mail.refresh() will cause an error
          // see revid:odo@theverp.com-20120622152536-42b2s28lvdv3odyr in 6.1
        }
        await mail._postprocessSentMessage(successPids, false, failureType);
      } catch (e) {
        if (e.code == 'MemoryError') {
          // prevent catching transient MemoryErrors, bubble up to notify user or abort cron job
          // instead of marking the mail as failed
          console.error(
            'MemoryError while processing mail with ID %s and Msg-Id %s. Consider raising the --limit-memory-hard startup option',
            mail.id, await mail.messageId);
          // mail status will stay on ongoing since transaction will be rollback
          throw e;
        }
        else if (e.code == 'psycopg2.Error' || e.code == 'SMTPServerDisconnected') {
          // If an error with the database or SMTP session occurs, chances are that the cursor
          // or SMTP session are unusable, causing further errors when trying to save the state.
          console.error(
            'Exception while processing mail with ID %s and Msg-Id %s.',
            mail.id, await mail.messageId);
          throw e;
        }
        else {
          const failureReason = ustr(e);
          console.error('failed sending mail (id: %s) due to %s', mail.id, failureReason);
          await mail.write({ 'state': 'exception', 'failureReason': failureReason });
          await mail._postprocessSentMessage(successPids, failureReason, 'unknown');
          if (raiseException) {
            if (isInstance(e, AssertionError, UnicodeEncodeError)) {
              let value;
              if (isInstance(e, UnicodeEncodeError)) {
                value = f("Invalid text: %s", e.object);
              }
              else {
                value = String(e);
              }
              throw new MailDeliveryException(value);
            }
            throw e;
          }
        }
      }
      if (autoCommit == true) {
        await this._cr.commit();
      }
    }
    return true;
  }
}