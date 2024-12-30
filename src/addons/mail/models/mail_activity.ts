import { DateTime } from "luxon";
import { api } from "../../../core";
import { getattr, hasattr, setdefault } from "../../../core/api/func";
import { Command, Fields, _Date } from "../../../core/fields";
import { DefaultDict, Dict } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";
import { extend, len, sorted, sortedAsync } from "../../../core/tools/iterable";
import { cleanContext } from "../../../core/tools/misc";
import { _f } from "../../../core/tools/utils";

/**
 * An actual activity to perform. Activities are linked to
    documents using resId and resModelId Fields. Activities have a deadline
    that can be used in kanban view to display a status. Once done activities
    are unlinked and a message is posted. This message has a new activityTypeId
    field that indicates the activity linked to the message.
 */
@MetaModel.define()
class MailActivity extends Model {
  static _module = module;
  static _name = 'mail.activity';
  static _description = 'Activity';
  static _order = 'dateDeadline ASC';
  static _recName = 'summary';

  @api.model()
  async defaultGet(fields) {
    const res = await _super(MailActivity, this).defaultGet(fields);
    if (!fields || fields.includes('resModelId') && res['resModel']) {
      res['resModelId'] = (await this.env.items('ir.model')._get(res['resModel'])).id;
    }
    return res;
  }

  @api.model()
  async _defaultActivityTypeId() {
    const ActivityType = this.env.items("mail.activity.type");
    const activityTypeTodo = await this.env.ref('mail.mailActivityDataTodo', false);
    const defaultVals = await this.defaultGet(['resModelId', 'resModel']);
    if (!defaultVals['resModelId']) {
      return ActivityType;
    }
    const currentModelId = defaultVals['resModelId'];
    const currentModel = (await this.env.items("ir.model").sudo()).browse(currentModelId);
    if (activityTypeTodo.ok && await activityTypeTodo.active &&
      (await activityTypeTodo.resModel === await currentModel.model || ! await activityTypeTodo.resModel)) {
      return activityTypeTodo;
    }
    const activityTypeModel = await ActivityType.search([['resModel', '=', await currentModel.model]], { limit: 1 });
    if (bool(activityTypeModel)) {
      return activityTypeModel;
    }
    const activityTypeGeneric = await ActivityType.search([['resModel', '=', false]], { limit: 1 });
    return activityTypeGeneric;
  }

  // owner
  static resModelId = Fields.Many2one('ir.model', { string: 'Document Model', index: true, ondelete: 'CASCADE', required: true });
  static resModel = Fields.Char('Related Document Model', { index: true, related: 'resModelId.model', computeSudo: true, store: true, readonly: true });
  static resId = Fields.Many2oneReference({ string: 'Related Document ID', index: true, required: true, modelField: 'resModel' });
  static resName = Fields.Char('Document Name', { compute: '_computeResName', computeSudo: true, store: true, help: "Display name of the related document.", readonly: true });
  // activity
  static activityTypeId = Fields.Many2one(
    'mail.activity.type', {
      string: 'Activity Type',
    domain: "['|', ['resModel', '=', false], ['resModel', '=', resModel]]", ondelete: 'RESTRICT',
    default: async (self) => self._defaultActivityTypeId()
  })
  static activityCategory = Fields.Selection({ related: 'activityTypeId.category', readonly: true })
  static activityDecoration = Fields.Selection({ related: 'activityTypeId.decorationType', readonly: true })
  static icon = Fields.Char('Icon', { related: 'activityTypeId.icon', readonly: true })
  static summary = Fields.Char('Summary');
  static note = Fields.Html('Note', { sanitizeStyle: true });
  static dateDeadline = Fields.Date('Due Date', { index: true, required: true, default: self => _Date.contextToday(self) });
  static automated = Fields.Boolean('Automated activity', { readonly: true, help: 'Indicates this activity has been created automatically and not by any user.' });
  // description
  static userId = Fields.Many2one('res.users', { string: 'Assigned to', default: self => self.env.user(), index: true, required: true });
  static requestPartnerId = Fields.Many2one('res.partner', { string: 'Requesting Partner' })
  static state = Fields.Selection([
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['planned', 'Planned']], { string: 'State', compute: '_computeState' })
  static recommendedActivityTypeId = Fields.Many2one('mail.activity.type', { string: "Recommended Activity Type" })
  static previousActivityTypeId = Fields.Many2one('mail.activity.type', { string: 'Previous Activity Type', readonly: true })
  static hasRecommendedActivities = Fields.Boolean(
    'Next activities available',
    {
      compute: '_computeHasRecommendedActivities',
      help: 'Technical field for UX purpose'
    })
  static mailTemplateIds = Fields.Many2many({ related: 'activityTypeId.mailTemplateIds', readonly: true })
  static chainingType = Fields.Selection({ related: 'activityTypeId.chainingType', readonly: true })
  // access
  static canWrite = Fields.Boolean({ compute: '_computeCanWrite', help: 'Technical field to hide buttons if the current user has no access.' })

  @api.onchange('previousActivityTypeId')
  async _computeHasRecommendedActivities() {
    for (const record of this) {
      await record.set('hasRecommendedActivities', bool(await (await record.previousActivityTypeId).suggestedNextTypeIds))
    }
  }

  @api.onchange('previousActivityTypeId')
  async _onchangePreviousActivityTypeId() {
    for (const record of this) {
      const previousActivityTypeId = await record.previousActivityTypeId;
      const triggeredNextTypeId = await previousActivityTypeId.triggeredNextTypeId;
      if (bool(triggeredNextTypeId)) {
        await record.set('activityTypeId', triggeredNextTypeId);
      }
    }
  }

  @api.depends('resModel', 'resId')
  async _computeResName() {
    for (const activity of this) {
      const [resId, resModel] = await activity('resId', 'resModel');
      await activity.set('resName', resModel && await this.env.items(resModel).browse(resId).displayName);
    }
  }

  @api.depends('dateDeadline')
  async _computeState() {
    for (const record of await this.filtered(activity => activity.dateDeadline)) {
      const tz = await (await (await record.userId).sudo()).tz;
      const dateDeadline = await record.dateDeadline;
      await record.set('state', await this._computeStateFromDate(dateDeadline, tz));
    }
  }

  @api.model()
  async _computeStateFromDate(dateDeadline, tz?: any) {
    dateDeadline = _Date.toDate(dateDeadline);
    const todayDefault = _Date.today();
    let today = new Date(todayDefault);
    if (tz) {
      const todayTz = DateTime.fromISO(today.toISOString(), { zone: tz });
      today = DateTime.fromObject({ year: todayTz.year, month: todayTz.month, day: todayTz.day }).toJSDate();
    }
    const diff = DateTime.fromJSDate(dateDeadline).diff(DateTime.fromJSDate(today));
    if (diff.days == 0) {
      return 'today';
    }
    else if (diff.days < 0) {
      return 'overdue';
    }
    else {
      return 'planned';
    }
  }

  @api.depends('resModel', 'resId', 'userId')
  async _computeCanWrite() {
    const validRecords = await this._filterAccessRules('write');
    for (const record of this) {
      await record.set('canWrite', validRecords.includes(record));
    }
  }

  @api.onchange('activityTypeId')
  async _onchangeActivityTypeId() {
    const activityTypeId = await (this as any).activityTypeId;
    if (bool(activityTypeId)) {
      const [summary, defaultNote] = await activityTypeId('summary', 'defaultNote');
      if (summary) {
        await this.set('summary', summary);
      }
      await this.set('dateDeadline', this._calculateDateDeadline(activityTypeId));
      const user = await activityTypeId.defaultUserId;
      await this.set('userId', bool(user) ? user : await this.env.user());
      if (defaultNote) {
        await this.set('note', defaultNote);
      }
    }
  }

  async _calculateDateDeadline(activityType) {
    // Date.contextToday is correct because dateDeadline is a Date and is meant to be
    // expressed in user TZ
    let base = await _Date.contextToday(this);
    if (await activityType.delayFrom === 'previousActivity' && 'activityPreviousDeadline' in this.env.context) {
      base = _Date.toDate(this.env.context['activityPreviousDeadline'] as string) as Date;
    }
    return DateTime.fromJSDate(base).plus({ [activityType.delayUnit]: activityType.delayCount })
  }

  @api.onchange('recommendedActivityTypeId')
  async _onchangeRecommendedActivityTypeId() {
    const recommendedActivityTypeId = await (this as any).recommendedActivityTypeId;
    if (recommendedActivityTypeId) {
      await this.set('activityTypeId', recommendedActivityTypeId);
    }
  }

  async _filterAccessRules(operation) {
    // write / unlink: valid for creator / assigned
    let valid;
    if (['write', 'unlink'].includes(operation)) {
      valid = await _super(MailActivity, this)._filterAccessRules(operation);
      if (valid.ok && valid.eq(this)) {
        return this;
      }
    }
    else {
      valid = this.env.items(this._name);
    }
    return this._filterAccessRulesRemaining(valid, operation, '_filterAccessRules')
  }

  async _filterAccessRulesSystem(operation) {
    // write / unlink: valid for creator / assigned
    let valid;
    if (['write', 'unlink'].includes(operation)) {
      valid = await _super(MailActivity, this)._filterAccessRulesSystem(operation);
      if (valid.ok && valid.eq(this)) {
        return this;
      }
    }
    else {
      valid = this.env.items(this._name);
    }
    return this._filterAccessRulesRemaining(valid, operation, '_filterAccessRulesSystem');
  }

  /**
   * Return the subset of ``self`` for which ``operation`` is allowed.
    A custom implementation is done on activities as this document has some
    access rules and is based on related document for activities that are
    not covered by those rules.

    Access on activities are the following :

      * create: (``mailPostAccess`` or write) right on related documents;
      * read: read rights on related documents;
      * write: access rule OR
                (``mailPostAccess`` or write) rights on related documents);
      * unlink: access rule OR
                (``mailPostAccess`` or write) rights on related documents);
   * @param valid 
   * @param operation 
   * @param filterAccessRulesMethod 
   */
  async _filterAccessRulesRemaining(valid, operation, filterAccessRulesMethod) {
    // compute remaining for hand-tailored rules
    const remaining = this.sub(valid);
    let remainingSudo = await remaining.sudo();

    // fall back on related document access right checks. Use the same as defined for mail.thread
    // if available; otherwise fall back on read for read, write for other operations.
    const activityToDocuments = new Dict<any>();
    for (const activity of remainingSudo) {
      // write / unlink: if not updating self or assigned, limit to automated activities to avoid
      // updating other people's activities. As unlinking a document bypasses access rights checks
      // on related activities this will not prevent people from deleting documents with activities
      // create / read: just check rights on related document
      activityToDocuments.setdefault(await activity.resModel, []).push(await activity.resId);
    }
    for (const [docModel, docIds] of activityToDocuments.items()) {
      let docOperation;
      const model = this.env.items(docModel);
      if (hasattr(model.cls, '_mailPostAccess')) {
        docOperation = model.cls._mailPostAccess;
      }
      else if (operation === 'read') {
        docOperation = 'read';
      }
      else {
        docOperation = 'write';
      }
      const right = await model.checkAccessRights(docOperation, false);
      if (right) {
        const validDocIds = await model.browse(docIds)[filterAccessRulesMethod](docOperation);
        valid = valid.add(await remaining.filtered(async (activity) => await activity.resModel === docModel && validDocIds.ids.includes(activity.resId)))
      }
    }
    return valid;
  }

  /**
   * Check assigned user (userId field) has access to the document. Purpose
    is to allow assigned user to handle their activities. For that purpose
    assigned user should be able to at least read the document. We therefore
    raise an UserError if the assigned user has no access to the document.
   */
  async _checkAccessAssignation() {
    for (const activity of this) {
      const userId = await activity.userId;
      const model = await (await this.env.items(await activity.resModel).withUser(userId)).withContext({ allowedCompanyIds: (await userId.companyIds).ids });
      let error;
      try {
        await model.checkAccessRights('read');
      } catch (e) {
        error = true;
        // except exceptions.AccessError:
        throw new UserError(
          await this._t('Assigned user %s has no access to the document and is not able to handle this activity.',
            await userId.displayName))
      }
      if (error) {
        try {
          const targetUser = userId;
          const targetRecord = this.env.items(await activity.resModel).browse(await activity.resId);
          if (hasattr(targetRecord._fields, 'companyId') && (!(await targetRecord.companyId).eq(await targetUser.companyId) && (len((await await targetUser.sudo()).companyIds) > 1))) {
            return;  // in that case we skip the check, assuming it would fail because of the company
          }
          await model.browse(await activity.resId).checkAccessRule('read')
        } catch (e) {
          // except exceptions.AccessError:
          throw new UserError(
            await this._t('Assigned user %s has no access to the document and is not able to handle this activity.',
              await userId.displayName))
        }
      }
    }
  }

  // ------------------------------------------------------
  // ORM overrides
  // ------------------------------------------------------

  @api.modelCreateMulti()
  async create(valsList) {
    const activities = await _super(MailActivity, this).create(valsList);
    for (const activity of activities) {
      const userId = await activity.userId;
      let partnerId;
      let needSudo = false;
      try {  // in multicompany, reading the partner might break
        partnerId = (await userId.partnerId).id
      } catch (e) {
        // except exceptions.AccessError:
        needSudo = true
        partnerId = (await (await userId.sudo()).partnerId).id
      }
      // send a notification to assigned user; in case of manually done activity also check
      // target has rights on document otherwise we prevent its creation. Automated activities
      // are checked since they are integrated into business flows that should not crash.
      if (!userId.eq(await this.env.user())) {
        if (! await activity.automated) {
          await activity._checkAccessAssignation();
        }
        if (!this.env.context['mailActivityQuickUpdate'] || false) {
          if (needSudo) {
            await (await activity.sudo()).actionNotify();
          }
          else {
            await activity.actionNotify();
          }
        }
      }
      await this.env.items(await activity.resModel).browse(await activity.resId).messageSubscribe([partnerId]);
      if (await activity.dateDeadline <= _Date.today()) {
        await this.env.items('bus.bus')._sendone(await (await activity.userId).partnerId, 'mail.activity/updated', { 'activityCreated': true });
      }
    }
    return activities;
  }

  /**
   * When reading specific fields, read calls _read that manually applies ir rules
    (_applyIrRules), instead of calling checkAccessRule.

    Meaning that our custom rules enforcing from '_filterAccessRules' and
    '_filterAccessRulesJS' are bypassed in that case.
    To make sure we apply our custom security rules, we force a call to 'checkAccessRule'.
   * @param fields 
   * @param load 
   * @returns 
   */
  async read(fields?: any[], load = '_classicRead') {
    await this.checkAccessRule('read');
    return _super(MailActivity, this).read(fields, load);
  }

  async write(values) {
    let preResponsibles, userChanges;
    if (values['userId']) {
      userChanges = await this.filtered(async (activity) => (await activity.userId).id != values['userId']);
      preResponsibles = await userChanges.mapped('userId.partnerId');
    }
    const res = await _super(MailActivity, this).write(values);

    if (values['userId']) {
      if (values['userId'] != this.env.uid) {
        const toCheck = await userChanges.filtered(async (act) => ! await act.automated);
        await toCheck._checkAccessAssignation();
        if (!this.env.context['mailActivityQuickUpdate']) {
          await userChanges.actionNotify();
        }
      }
      for (const activity of userChanges) {
        const userId = await activity.userId;
        this.env.items(await activity.resModel).browse(await activity.resId).messageSubscribe([(await userId.partnerId).id]);
        if (await activity.dateDeadline <= _Date.today()) {
          await this.env.items('bus.bus')._sendone(await userId.partnerId, 'mail.activity/updated', { 'activityCreated': true });
        }
      }
      for (const activity of userChanges) {
        if (await activity.dateDeadline <= _Date.today()) {
          for (const partner of preResponsibles) {
            await this.env.items('bus.bus')._sendone(partner, 'mail.activity/updated', { 'activityDeleted': true });
          }
        }
      }
    }
    return res;
  }

  async unlink() {
    for (const activity of this) {
      if (await activity.dateDeadline <= _Date.today()) {
        await this.env.items('bus.bus')._sendone(await (await activity.userId).partnerId, 'mail.activity/updated', { 'activityDeleted': true });
      }
    }
    return _super(MailActivity, this).unlink();
  }

  /**
   * Override that adds specific access rights of mail.activity, to remove
    ids uid could not see according to our custom rules. Please refer to
    _filterAccessRulesRemaining for more details about those rules.

    The method is inspired by what has been done on mail.message.
   * @param args 
   * @param options 
   * @returns 
   */
  @api.model()
  async _search(args, options: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean } = {}) {
    // Rules do not apply to administrator
    if (this.env.isSuperuser()) {
      return _super(MailActivity, this)._search(args, options);
    }
    // Perform a super with count as false, to have the ids, not a counter
    const ids = await _super(MailActivity, this)._search(args, options);
    if (!bool(ids)) {
      if (options.count) {
        return 0;
      }
      else {
        return ids;
      }
    }

    // check read access rights before checking the actual rules on the given ids
    await _super(MailActivity, await this.withUser(options.accessRightsUid ?? this._uid)).checkAccessRights('read');

    await this.flush(['resModel', 'resId']);
    const activitiesToCheck = [];
    for (const subIds of this._cr.splitForInConditions(ids)) {
      const res = await this._cr.execute(`
        SELECT DISTINCT activity.id, activity."resModel", activity."resId"
        FROM "%s" activity
        WHERE activity.id IN (%s) AND activity."resId" != 0`, [this.cls._table, String(subIds)]);
      extend(activitiesToCheck, res);
    }
    const activityToDocuments = {}
    for (const activity of activitiesToCheck) {
      setdefault(activityToDocuments, activity['resModel'], new Set()).add(activity['resId']);
    }

    const allowedIds = new Set();
    for (const [docModel, docIds] of Object.entries(activityToDocuments)) {
      // fall back on related document access right checks. Use the same as defined for mail.thread
      // if available; otherwise fall back on read
      let docOperation;
      const model = this.env.items(docModel);
      if (hasattr(model.cls, '_mailPostAccess')) {
        docOperation = model.cls._mailPostAccess;
      }
      else {
        docOperation = 'read';
      }
      const DocumentModel = await model.withUser(options.accessRightsUid ?? this._uid);
      const right = await DocumentModel.checkAccessRights(docOperation, false);
      if (right) {
        const validDocs = await DocumentModel.browse(docIds)._filterAccessRules(docOperation);
        const validDocIds = new Set(validDocs.ids);
        activitiesToCheck.filter(activity => activity['resModel'] === docModel && validDocIds.has(activity['resId'])).forEach(activity => {
          if (!allowedIds.has(activity['id'])) {
            allowedIds.add(activity['id']);
          }
        });
      }
    }
    if (options.count) {
      return len(allowedIds);
    }
    else {
      // re-construct a list based on ids, because 'allowedIds' does not keep the original order
      return ids.filter(id => allowedIds.has(id));
    }
  }

  /**
   * The base _readGroupRaw method implementation computes a where based on a given domain
    (_whereCalc) and manually applies ir rules (_applyIrRules).

    Meaning that our custom rules enforcing from '_filterAccessRules' and
    '_filterAccessRulesJS' are bypassed in that case.

    This overrides re-uses the _search implementation to force the read group domain to allowed
    ids only, that are computed based on our custom rules (see _filterAccessRulesRemaining
    for more details).
   * @param domain 
   * @param fields 
   * @param groupby 
   * @param options 
   * @returns 
   */
  @api.model()
  async _readGroupRaw(domain, fields, groupby, options: { offset?: number, limit?: number, orderby?: string, lazy?: boolean } = {}) {
    options.lazy = options.lazy ?? true;
    // Rules do not apply to administrator
    if (!this.env.isSuperuser()) {
      const allowedIds = await this._search(domain, { count: false });
      if (bool(allowedIds)) {
        domain = expression.AND([domain, [['id', 'in', allowedIds]]]);
      }
      else {
        // force void result if no allowed ids found
        domain = expression.AND([domain, [[0, '=', 1]]]);
      }
    }
    return _super(MailActivity, this)._readGroupRaw(domain, fields, groupby, options);
  }

  async nameGet() {
    const res = [];
    for (const record of this) {
      const name = await record.summary || await (await record.activityTypeId).displayName;
      res.push([record.id, name]);
    }
    return res;
  }

  // ------------------------------------------------------
  // Business Methods
  // ------------------------------------------------------

  async actionNotify() {
    if (!this.ok) {
      return;
    }
    let originalContext = this.env.context;
    let bodyTemplate = await this.env.ref('mail.messageActivityAssigned');
    let self = this;
    for (let activity of self) {
      const userId = await activity.userId;
      const lang = await userId.lang;
      if (lang) {
        // Send the notification in the assigned user's language
        self = await self.withContext({ lang: lang });
        bodyTemplate = await bodyTemplate.withContext({ lang: lang });
        activity = await activity.withContext({ lang: lang });
      }
      const modelDescription = await (await self.env.items('ir.model')._get(await activity.resModel)).displayName;
      const body = await bodyTemplate._render(
        {
          activity: activity,
          modelDescription: modelDescription,
          accessLink: await self.env.items('mail.thread')._notifyGetActionLink('view', await activity.resModel, await activity.resId),
        },
        'ir.qweb',
        true
      )
      const record = self.env.items(await activity.resModel).browse(await activity.resId);
      if (userId.ok) {
        await record.messageNotify({
          partnerIds: (await userId.partnerId).ids,
          body: body,
          subject: _f(await this._t('{activityName}: {summary} assigned to you',
            {
              activityName: await activity.resName,
              summary: await activity.summary || await (await activity.activityTypeId).label
            })),
          recordName: await activity.resName,
          modelDescription: modelDescription,
          emailLayoutXmlid: 'mail.mailNotificationLight',
        })
      }
      bodyTemplate = await bodyTemplate.withContext(originalContext);
      self = await self.withContext(originalContext);
    }
  }

  /**
   * Wrapper without feedback because web button add context as
    parameter, therefore setting context to feedback 
   * @returns 
   */
  async actionDone() {
    const [messages] = await this._actionDone();
    return messages.ids.length && bool(messages.ids[0]) ? messages.ids[0] : false;
  }

  async actionFeedback(feedback = false, attachmentIds?: any) {
    const self = await this.withContext(cleanContext(this.env.context))
    const [messages] = await self._actionDone(feedback, attachmentIds);
    return messages.ids.length && bool(messages.ids[0]) ? messages.ids[0] : false;
  }

  /**
   * Wrapper without feedback because web button add context as
    parameter, therefore setting context to feedback 
   * @returns 
   */
  async actionDoneScheduleNext() {
    return this.actionFeedbackScheduleNext();
  }

  async actionFeedbackScheduleNext(feedback = false) {
    const self: any = this;
    const ctx = {
      ...cleanContext(this.env.context),
      default_previousActivityTypeId: (await self.activityTypeId).id,
      activityPreviousDeadline: await self.dateDeadline,
      default_resId: await self.resId,
      default_resModel: await self.resModel,
    };
    const [messages, nextActivities] = await self._actionDone(feedback)  // will unlink activity, dont access self after that
    if (nextActivities) {
      return false;
    }
    return {
      'label': await this._t('Schedule an Activity'),
      'context': ctx,
      'viewMode': 'form',
      'resModel': 'mail.activity',
      'views': [[false, 'form']],
      'type': 'ir.actions.actwindow',
      'target': 'new',
    }
  }

  /**
   * Private implementation of marking activity as done: posting a message, deleting activity
      (since done), and eventually create the automatical next activity (depending on config).
      :param feedback: optional feedback from user when marking activity as done
      :param attachmentIds: list of ir.attachment ids to attach to the posted mail.message
      :returns (messages, activities) where
          - messages is a recordset of posted mail.message
          - activities is a recordset of mail.activity of forced automically created activities
   * @param feedback 
   * @param attachmentIds 
   * @returns 
   */
  async _actionDone(feedback = false, attachmentIds?: any) {
    // marking as 'done'
    let messages = this.env.items('mail.message');
    const nextActivitiesValues = [];

    // Search for all attachments linked to the activities we are about to unlink. This way, we
    // can link them to the message posted and prevent their deletion.
    const attachments = this.env.items('ir.attachment').searchRead([
      ['resModel', '=', this._name],
      ['resId', 'in', this.ids],
    ], ['id', 'resId']);

    const activityAttachments = new DefaultDict()// []
    for (const attachment of attachments) {
      const activityId = attachment['resId'];
      activityAttachments[activityId] = activityAttachments[activityId] ?? [];
      activityAttachments[activityId].push(attachment['id']);
    }

    for (const activity of this) {
      // extract value to generate next activities
      if (await activity.chainingType === 'trigger') {
        const vals = await (await activity.withContext({ activityPreviousDeadline: await activity.dateDeadline }))._prepareNextActivityValues();
        nextActivitiesValues.push(vals);
      }

      // post message on activity, before deleting it
      const record = this.env.items(await activity.resModel).browse(await activity.resId);
      await record.messagePostWithView('mail.messageActivityDone', {
        values: {
          'activity': activity,
          'feedback': feedback,
          'displayAssignee': !activity.userId.eq(await this.env.user())
        },
        subtypeId: await this.env.items('ir.model.data')._xmlidToResId('mail.mtActivities'),
        mailActivityTypeId: (await activity.activityTypeId).id,
        attachmentIds: bool(attachmentIds) ? [...attachmentIds].map(attachmentId => Command.link(attachmentId)) : [],
      })

      // Moving the attachments in the message
      // TODO: Fix void resId on attachment when you create an activity with an image
      // directly, see route /web_editor/attachment/add
      const activityMessage = (await record.messageIds)(0);
      const messageAttachments = this.env.items('ir.attachment').browse(activityAttachments[activity.id]);
      if (messageAttachments.ok) {
        await messageAttachments.write({
          'resId': activityMessage.id,
          'resModel': activityMessage.cls._name,
        })
        await activityMessage.set('attachmentIds', messageAttachments);
      }
      messages = messages.or(activityMessage);
    }

    const nextActivities = await this.env.items('mail.activity').create(nextActivitiesValues);
    await this.unlink()  // will unlink activity, dont access `self` after that

    return [messages, nextActivities];
  }

  async actionCloseDialog() {
    return { 'type': 'ir.actions.actwindow.close' }
  }

  async activityFormat() {
    const activities = await this.read();
    const mailTemplateIds = new Set();
    for (const activity of activities) {
      for (const templateId of activity["mailTemplateIds"]) {
        mailTemplateIds.add(templateId);
      }
    }
    const mailTemplateInfo = await this.env.items("mail.template").browse(mailTemplateIds).read(['id', 'label']);
    const mailTemplateDict = Object.fromEntries(mailTemplateInfo.map(mailTemplate => [mailTemplate['id'], mailTemplate]));
    for (const activity of activities) {
      activity['mailTemplateIds'] = activity['mailTemplateIds'].map(mailTemplateId => mailTemplateDict[mailTemplateId]);
    }
    return activities;
  }

  @api.model()
  async getActivityData(resModel, domain) {
    const activityDomain = [['resModel', '=', resModel]];
    if (domain) {
      const res = await this.env.items(resModel).search(domain);
      activityDomain.push(['resId', 'in', res.ids]);
    }
    let groupedActivities = await this.env.items('mail.activity').readGroup(
      activityDomain,
      ['resId', 'activityTypeId', 'ids:array_agg(id)', 'dateDeadline:min(dateDeadline)'],
      ['resId', 'activityTypeId'],
      { lazy: false }
    );
    // filter out unreadable records
    if (!bool(domain)) {
      const resIds = groupedActivities.map(a => a['resId']);
      const res = await this.env.items(resModel).search([['id', 'in', resIds]]);
      groupedActivities = groupedActivities.filter(a => res.ids.includes(a['resId']));
    }
    const resIdToDeadline = {};
    const activityData = new DefaultDict(); //dict)
    for (const group of groupedActivities) {
      const resId = group['resId'];
      const activityTypeId = (bool(group['activityTypeId']) ? group['activityTypeId'] : [false, false])[0];
      resIdToDeadline[resId] = (!(resId in resIdToDeadline) || group['dateDeadline'] < resIdToDeadline[resId]) ?
        group['dateDeadline'] : resIdToDeadline[resId];
      const state = await this._computeStateFromDate(group['dateDeadline'], await (await (await (this as any).userId).sudo()).tz);
      activityData[resId][activityTypeId] = {
        'count': group['__count'],
        'ids': group['ids'],
        'state': state,
        'o-closest-deadline': group['dateDeadline'],
      }
    }
    const activityTypeInfos = [];
    const activityTypeIds = await this.env.items('mail.activity.type').search(
      ['|', ['resModel', '=', resModel], ['resModel', '=', false]]);
    for (const elem of await sortedAsync(activityTypeIds, async (item) => item.sequence)) {
      const mailTemplateInfo = []
      for (const mailTemplateId of await elem.mailTemplateIds) {
        mailTemplateInfo.push({ "id": mailTemplateId.id, "label": await mailTemplateId.labelame });
      }
      activityTypeInfos.push([elem.id, await elem.label, mailTemplateInfo]);
    }
    return {
      'activityTypes': activityTypeInfos,
      'activityResIds': sorted(Object.entries(resIdToDeadline), (item) => resIdToDeadline[item]),
      'groupedActivities': activityData,
    }
  }

  // ----------------------------------------------------------------------
  // TOOLS
  // ----------------------------------------------------------------------

  /**
   * Prepare the next activity values based on the current activity record and applies _onchange methods
    :returns a dict of values for the new activity
   * @returns 
   */
  async _prepareNextActivityValues() {
    this.ensureOne();
    const vals = await this.defaultGet(await this.fieldsGet());
    const self: any = this;
    Object.assign(vals, {
      'previousActivityTypeId': (await self.activityTypeId).id,
      'resId': self.resId,
      'resModel': self.resModel,
      'resModelId': await self.env.items('ir.model')._get(self.resModel).id,
    })
    const virtualActivity = await self.new(vals);
    await virtualActivity._onchangePreviousActivityTypeId();
    await virtualActivity._onchangeActivityTypeId();
    return virtualActivity._convertToWrite(virtualActivity._cache);
  }
}