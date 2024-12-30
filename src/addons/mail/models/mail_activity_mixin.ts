import _ from "lodash";
import { api } from "../../../core";
import { Fields, _Date } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { isInstance, stringPart } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { next } from "../../../core/tools/iterable";
import { _convert$, _f, f } from "../../../core/tools/utils";

/**
 * Mail Activity Mixin is a mixin class to use if you want to add activities
    management on a model. It works like the mail.thread mixin. It defines
    an activityIds one2many field toward activities using resId and resModelId.
    Various related / computed fields are also added to have a global status of
    activities on documents.

    Activities come with a new JS widget for the form view. It is integrated in the
    Chatter widget although it is a separate widget. It displays activities linked
    to the current record and allow to schedule, edit and mark done activities.
    Just include field activityIds in the div.oe-chatter to use it.

    There is also a kanban widget defined. It defines a small widget to integrate
    in kanban vignettes. It allow to manage activities directly from the kanban
    view. Use widget="kanbanActivity" on activitiy_ids field in kanban view to
    use it.

    Some context keys allow to control the mixin behavior. Use those in some
    specific cases like import

     * ``mail_activity_automation_skip``: skip activities automation; it means
       no automated activities will be generated, updated or unlinked, allowing
       to save computation and avoid generating unwanted activities;
 */
@MetaModel.define()
class MailActivityMixin extends AbstractModel {
  static _module = module;
  static _name = 'mail.activity.mixin';
  static _description = 'Activity Mixin';

  /**
   * Define a default fallback activity type when requested xml id wasn't found.

    Can be overriden to specify the default activity type of a model.
    It is only called in in activity_schedule() for now.
   * @returns 
   */
  async _defaultActivityType() {
    let res = await this.env.ref('mail.mailActivityDataTodo', false);
    if (bool(res)) {
      return res;
    }
    res = await this.env.items('mail.activity.type').search([['resModel', '=', this._name]], { limit: 1 });
    if (bool(res)) {
      return res;
    }
    return this.env.items('mail.activity.type').search([['resModel', '=', false]], { limit: 1 })
  }

  static activityIds = Fields.One2many('mail.activity', 'resId', {
    string: 'Activities',
    autojoin: true, groups: "base.groupUser"
  });
  static activityState = Fields.Selection([
    ['overdue', 'Overdue'],
    ['today', 'Today'],
    ['planned', 'Planned']], {
      string: 'Activity State',
    compute: '_computeActivityState',
    search: '_searchActivityState',
    groups: "base.groupUser",
    help: 'Status based on activities\nOverdue: Due date is already passed\n Today: Activity date is today\nPlanned: Future activities.'
  })
  static activityUserId = Fields.Many2one(
    'res.users', {
      string: 'Responsible User',
    related: 'activityIds.userId', readonly: false,
    search: '_searchActivityUserId',
    groups: "base.groupUser"
  })
  static activityTypeId = Fields.Many2one(
    'mail.activity.type', {
      string: 'Next Activity Type',
    related: 'activityIds.activityTypeId', readonly: false,
    search: '_searchActivityTypeId',
    groups: "base.groupUser"
  })
  static activityTypeIcon = Fields.Char('Activity Type Icon', { related: 'activityIds.icon' })
  static activityDateDeadline = Fields.Date(
    'Next Activity Deadline',
    {
      compute: '_computeActivityDateDeadline', search: '_searchActivityDateDeadline',
      computeSudo: false, readonly: true, store: false,
      groups: "base.groupUser"
    })
  static myActivityDateDeadline = Fields.Date(
    'My Activity Deadline',
    {
      compute: '_computeMyActivityDateDeadline', search: '_searchMyActivityDateDeadline',
      computeSudo: false, readonly: true, groups: "base.groupUser"
    })
  static activitySummary = Fields.Char(
    'Next Activity Summary',
    {
      related: 'activityIds.summary', readonly: false,
      search: '_searchActivitySummary',
      groups: "base.groupUser"
    })
  static activityExceptionDecoration = Fields.Selection([
    ['warning', 'Alert'],
    ['danger', 'Error']],
    {
      compute: '_computeActivityExceptionType',
      search: '_searchActivityExceptionDecoration',
      help: "Type of the exception activity on record."
    })
  static activityExceptionIcon = Fields.Char('Icon', { help: "Icon to indicate an exception activity.", compute: '_computeActivityExceptionType' })

  @api.depends('activityIds.activityTypeId.decorationType', 'activityIds.activityTypeId.icon')
  async _computeActivityExceptionType() {
    // prefetch all activity types for all activities, this will avoid any query in loops
    await this.mapped('activityIds.activityTypeId.decorationType')

    for (const record of this) {
      const activityTypeIds = await (await record.activityIds).mapped('activityTypeId');
      let exceptionActivityTypeId;;
      for (const activityTypeId of activityTypeIds) {
        if (await activityTypeId.decorationType === 'danger') {
          exceptionActivityTypeId = activityTypeId;
          break;
        }
        if (await activityTypeId.decorationType === 'warning') {
          exceptionActivityTypeId = activityTypeId;
        }
      }
      await record.set('activityExceptionDecoration', bool(exceptionActivityTypeId) && await exceptionActivityTypeId.decorationType);
      await record.set('activityExceptionIcon', bool(exceptionActivityTypeId) && await exceptionActivityTypeId.icon);
    }
  }

  _searchActivityExceptionDecoration(operator, operand) {
    return [['activityIds.activityTypeId.decorationType', operator, operand]];
  }

  @api.depends('activityIds.state')
  async _computeActivityState() {
    for (const record of this) {
      const states = await (await record.activityIds).mapped('state');
      if (states.includes('overdue')) {
        await record.set('activityState', 'overdue');
      }
      else if (states.includes('today')) {
        await record.set('activityState', 'today');
      }
      else if (states.includes('planned')) {
        await record.set('activityState', 'planned');;
      }
      else {
        await record.set('activityState', false);
      }
    }
  }

  async _searchActivityState(operator, value) {
    let allStates = ['overdue', 'today', 'planned', false];
    let searchStates;
    if (operator === '=') {
      searchStates = [value];
    }
    else if (operator === '!=') {
      searchStates = _.difference(allStates, [value]);
    }
    else if (operator === 'in') {
      searchStates = [value]
    }
    else if (operator === 'not in') {
      searchStates = _.difference(allStates, [value]);
    }
    let reverseSearch = false;
    if (searchStates.includes(false)) {
      // If we search "activityState = false", they might be a lot of records  (million for some models), so instead of returning the list of IDs
      // [(id, 'in', ids)] we will reverse the domain and return something like
      // [(id, 'not in', ids)], so the list of ids is as small as possible
      reverseSearch = true;
      searchStates = _.difference(allStates, searchStates);
    }
    // Use number in the SQL query for performance purpose
    const integerStateValue = {
      'overdue': -1,
      'today': 0,
      'planned': 1,
      false: null,
    }

    const searchStatesInt = searchStates.map(s => integerStateValue[s] ?? false);

    const query = `
      SELECT "resId"
        FROM (
          SELECT "resId",
            -- Global activity state
            MIN(
              -- Compute the state of each individual activities
              -- -1: overdue
              --  0: today
              --  1: planned
              SIGN(EXTRACT(day from (
                "mailActivity"."dateDeadline" - DATE_TRUNC('day', {todayUtc} AT TIME ZONE "resPartner".tz)
              )))
            )::INT AS "activityState"
            FROM "mailActivity"
          LEFT JOIN "resUsers"
            ON "resUsers".id = "mailActivity"."userId"
          LEFT JOIN "resPartner"
            ON "resPartner".id = "resUsers"."partnerId"
          WHERE "mailActivity"."resModel" = {resModelTable}
          GROUP BY "resId"
        ) AS "resRecord"
      WHERE {searchStatesInt} @> ARRAY["activityState"]
    `;

    const res = await this._cr.execute(
      _f(query,
        {
          'todayUtc': new Date().toISOString(),
          'resModelTable': this._name,
          'searchStatesInt': searchStatesInt
        }),
    )
    return [['id', reverseSearch ? 'not in' : 'in', res.map(r => r['resId'])]];
  }

  @api.depends('activityIds.dateDeadline')
  async _computeActivityDateDeadline() {
    for (const record of this) {
      await record.set('activityDateDeadline', await (await record.activityIds)([0, 1]).dateDeadline);
    }
  }

  async _searchActivityDateDeadline(operator, operand) {
    if (operator === '=' && !operand) {
      return [['activityIds', '=', false]];
    }
    return [['activityIds.dateDeadline', operator, operand]];
  }

  @api.model()
  async _searchActivityUserId(operator, operand) {
    return [['activityIds.userId', operator, operand]];
  }

  @api.model()
  async _searchActivityTypeId(operator, operand) {
    return [['activityIds.activityTypeId', operator, operand]];
  }

  @api.model()
  async _searchActivitySummary(operator, operand) {
    return [['activityIds.summary', operator, operand]];
  }

  @api.depends('activityIds.dateDeadline', 'activityIds.userId')
  @api.dependsContext('uid')
  async _computeMyActivityDateDeadline() {
    for (const record of this) {
      const dateDeadlines = []
      for (const activity of await record.activityIds) {
        if ((await activity.userId).id === record.env.uid) {
          dateDeadlines.push(await activity.dateDeadline);
        }
      }
      await record.set('myActivityDateDeadline',
        next(dateDeadlines,
          // (
          //   activity.dateDeadline
          //   for activity in record.activityIds
          //   if activity.userId.id == record.env.uid
          // ), 
          false)
      );
    }
  }

  async _searchMyActivityDateDeadline(operator, operand) {
    const activityIds = await this.env.items('mail.activity')._search([
      ['dateDeadline', operator, operand],
      ['resModel', '=', this._name],
      ['userId', '=', (await this.env.user()).id]
    ])
    return [['activityIds', 'in', activityIds]];
  }

  async write(vals) {
    // Delete activities of archived record.
    if ('active' in vals && vals['active'] === false) {
      await (await (await this.env.items('mail.activity').sudo()).search(
        [['resModel', '=', this._name], ['resId', 'in', this.ids]]
      )).unlink();
    }
    return _super(MailActivityMixin, this).write(vals);
  }

  /**
   * Override unlink to delete records activities through (resModel, resId).
   */
  async unlink() {
    const recordIds = this.ids;
    const result = await _super(MailActivityMixin, this).unlink();
    await (await (await this.env.items('mail.activity').sudo()).search(
      [['resModel', '=', this._name], ['resId', 'in', recordIds]]
    )).unlink();
    return result;
  }

  async _readProgressBar(domain, groupby, progressBar) {
    const groupbyFname = stringPart(groupby, ':')[0];
    if (!(progressBar['field'] === 'activityState' && this._fields[groupbyFname].store)) {
      return _super(MailActivityMixin, this)._readProgressBar(domain, groupby, progressBar);
    }

    // optimization for 'activityState'

    // explicitly check access rights, since we bypass the ORM
    await this.checkAccessRights('read');
    await this._flushSearch(domain, { fields: [groupbyFname], order: 'id' });
    await this.env.items('mail.activity').flush(['resModel', 'resId', 'userId', 'dateDeadline']);

    const query = await this._whereCalc(domain);
    await this._applyIrRules(query, 'read')
    // const gb = stringPart(groupby, ':')[0];
    const annotatedGroupbys = await Promise.all([groupby, 'activityState'].map(async gb => this._readGroupProcessGroupby(gb, query)));
    const groupbyDict = new Dict(annotatedGroupbys.map(gb => [gb['groupby'], gb]));
    for (const gb of annotatedGroupbys) {
      if (gb['field'] === 'activityState') {
        gb['qualifiedField'] = '"_lastActivityState"."activityState"'
      }
    }
    const [groupbyTerms, _orderbyTerms] = await this._readGroupPrepare('activityState', [], annotatedGroupbys, query);
    const selectTerms = annotatedGroupbys.map(gb => f('%s as "%s"', gb['qualifiedField'], gb['groupby']));
    const [fromClause, whereClause, whereParams] = query.getSql();
    const tz = this._context['tz'] || await (await this.env.user()).tz || 'UTC';
    const selectQuery = _f(`
      SELECT 1 AS id, COUNT(*)::int AS __count, {fields}
      FROM {fromClause}
      JOIN (
        SELECT "resId",
        CASE
          WHEN min("dateDeadline" - (now() AT TIME ZONE COALESCE("resPartner".tz, %s))::date) > 0 THEN 'planned'
          WHEN min("dateDeadline" - (now() AT TIME ZONE COALESCE("resPartner".tz, %s))::date) < 0 THEN 'overdue'
          WHEN min("dateDeadline" - (now() AT TIME ZONE COALESCE("resPartner".tz, %s))::date) = 0 THEN 'today'
          ELSE null
        END AS "activityState"
        FROM "mailActivity"
        JOIN "resUsers" ON ("resUsers".id = "mailActivity"."userId")
        JOIN "resPartner" ON ("resPartner".id = "resUsers"."partnerId")
        WHERE "resModel" = '{model}'
        GROUP BY "resId"
      ) AS "_lastActivityState" ON ("{table}".id = "_lastActivityState"."resId")
      WHERE {whereClause}
      GROUP BY {groupby}
    `, {
      fields: String(selectTerms),
      fromClause: fromClause,
      model: this.cls._name,
      table: this.cls._table,
      whereClause: whereClause || '1=1',
      groupby: String(groupbyTerms),
    })
    const numFromParams = (fromClause.match(/%s/g) || []).length;
    whereParams.splice(numFromParams, 0, ...[tz, tz, tz]); // timezone after from parameters
    const res = await this.env.cr.execute(_convert$(selectQuery), { bind: whereParams });
    await this._readGroupResolveMany2xFields(res, annotatedGroupbys);
    const data = [];
    for (const row of res) {
      data.push(Object.fromEntries(
        await Promise.all(
          Object.entries(row).map(async ([key, val]) => [key, await this._readGroupPrepareData(key, val, groupbyDict)])
        )
      ))
    }
    return Promise.all(data.map(async vals => this._readGroupFormatResult(vals, annotatedGroupbys, [groupby], domain)));
  }

  /**
   * Before archiving the record we should also remove its ongoing
    activities. Otherwise they stay in the systray and concerning archived records it makes no sense.
   * @returns 
   */
  async toggleActive() {
    const recordToDeactivate = await this.filtered(async (rec) => rec[rec._activeName]);
    if (recordToDeactivate.ok) {
      // use a sudo to bypass every access rights; all activities should be removed
      await (await (await this.env.items('mail.activity').sudo()).search([
        ['resModel', '=', this._name],
        ['resId', 'in', recordToDeactivate.ids]
      ])).unlink();
    }
    return _super(MailActivityMixin, this).toggleActive();
  }

  /**
   * Automatically send an email based on the given mail.template, given its ID.
   * @param templateId 
   * @returns 
   */
  async activitySendMail(templateId) {
    const template = await this.env.items('mail.template').browse(templateId).exists();
    if (!bool(template)) {
      return false;
    }
    for (const record of this) {
      await record.messagePostWithTemplate(
        templateId,
        { compositionMode: 'comment' }
      );
    }
    return true;
  }

  /**
   * Search automated activities on current record set, given a list of activity
    types xml IDs. It is useful when dealing with specific types involved in automatic
    activities management.

    :param act_type_xmlids: list of activity types xml IDs
    :param userId: if set, restrict to activities of that userId;
    :param additional_domain: if set, filter on that domain;
   * @param actTypeXmlids 
   * @param userId 
   * @param additionalDomain 
   * @returns 
   */
  async activitySearch(actTypeXmlids = '', userId?: any, additionalDomain?: any) {
    if (this.env.context['mailActivityAutomationSkip']) {
      return false;
    }

    const Data = await this.env.items('ir.model.data').sudo();
    const activityTypesIds = []
    for (const xmlid of actTypeXmlids) {
      for (const typeId of await Data._xmlidToResId(xmlid, false)) {
        if (bool(typeId)) {
          activityTypesIds.push(typeId);
        }
      }
    }
    if (!activityTypesIds.some(id => bool(id))) {
      return false;
    }

    let domain = [
      '&', '&', '&',
      ['resModel', '=', this._name],
      ['resId', 'in', this.ids],
      ['automated', '=', true],
      ['activityTypeId', 'in', activityTypesIds]
    ]

    if (userId) {
      domain = expression.AND([domain, [['userId', '=', userId]]])
    }
    if (additionalDomain) {
      domain = expression.AND([domain, additionalDomain]);
    }
    return this.env.items('mail.activity').search(domain)
  }

  /**
   * Schedule an activity on each record of the current record set.
    This method allow to provide as parameter act_type_xmlid. This is an xmlid of activity type instead of directly giving an activityTypeId.
    It is useful to avoid having various "env.ref" in the code and allow to let the mixin handle access rights.

    :param dateDeadline: the day the activity must be scheduled on
    the timezone of the user must be considered to set the correct deadline
   * @param actTypeXmlid 
   * @param dateDeadline 
   * @param summary 
   * @param note 
   * @param actValues 
   * @returns 
   */
  async activitySchedule(options: { actTypeXmlid?: string, dateDeadline?: Date, summary?: string, note?: string, actValues?: any } = {}) {
    if (this.env.context['mailActivityAutomationSkip']) {
      return false;
    }

    if (!options.dateDeadline) {
      options.dateDeadline = await _Date.contextToday(this);
    }
    if (isInstance(options.dateDeadline, Date)) {
      console.warn("Scheduled deadline should be a date (got %s)", options.dateDeadline);
    }
    let activityType;
    if (options.actTypeXmlid) {
      activityType = await this.env.ref(options.actTypeXmlid, false) || await this._defaultActivityType();
    }
    else {
      const activityTypeId = options.actValues['activityTypeId'] ?? false;
      activityType = activityTypeId && (await this.env.items('mail.activity.type').sudo()).browse(activityTypeId);
    }

    const modelId = (await this.env.items('ir.model')._get(this._name)).id;
    let activities = this.env.items('mail.activity');
    for (const record of this) {
      const createVals = {
        'activityTypeId': activityType.ok && activityType.id,
        'summary': options.summary || await activityType.summary,
        'automated': true,
        'note': options.note || await activityType.defaultNote,
        'dateDeadline': options.dateDeadline,
        'resModelId': modelId,
        'resId': record.id,
      }
      Object.assign(createVals, options.actValues);
      if (!createVals['userId']) {
        const id = (await activityType.defaultUserId).id;
        createVals['userId'] = bool(id) ? id : this.env.uid;
      }
      activities = activities.or(await this.env.items('mail.activity').create(createVals));
    }
    return activities;
  }

  /**
   * Helper method: Schedule an activity on each record of the current record set.
    This method allow to the same mecanism as `activity_schedule`, but provide 2 additionnal parameters:
    :param views_or_xmlid: record of ir.ui.view or string representing the xmlid of the qweb template to render
    :type views_or_xmlid: string or recordset
    :param render_context: the values required to render the given qweb template
    :type render_context: dict
   * @param self 
   * @param actTypeXmlid 
   * @param dateDeadline 
   * @param summary 
   * @param viewsOrXmlid 
   * @param renderContext 
   */
  async _activityScheduleWithView(actTypeXmlid = '', dateDeadline?: any, summary: string = '', viewsOrXmlid: string = '', renderContext: {} = {}, actValues: {} = {}) {
    if (this.env.context['mailActivityAutomationSkip']) {
      return false;
    }

    let views;
    if (typeof (viewsOrXmlid) === 'string') {
      views = await this.env.ref(viewsOrXmlid, false);
    }
    else {
      views = viewsOrXmlid;
    }
    if (!bool(views)) {
      return;
    }
    let activities = this.env.items('mail.activity');
    for (const record of this) {
      renderContext['object'] = record;
      const note = await views._render(renderContext, 'ir.qweb', true);
      activities = activities.or(await record.activitySchedule({ actTypeXmlid, dateDeadline, summary, note, actValues }));
    }
    return activities;
  }

  /**
   * Reschedule some automated activities. Activities to reschedule are
    selected based on type xml ids and optionally by user. Purpose is to be able to
    * update the deadline to dateDeadline;
    * update the responsible to new_user_id;
   * @param actTypeXmlids 
   * @param userId 
   * @param dateDeadline 
   * @param newUserId 
   * @returns 
   */
  async activityReschedule(actTypeXmlids, userId?: any, dateDeadline?: any, newUserId?: any) {
    if (this.env.context['mailActivityAutomationSkip']) {
      return false;
    }

    const Data = await this.env.items('ir.model.data').sudo();
    let activityTypesIds = []
    for (const xmlid of actTypeXmlids) {
      activityTypesIds.push(await Data._xmlidToResId(xmlid, false));
    }
    activityTypesIds = activityTypesIds.filter(actTypeId => bool(actTypeId));
    if (!activityTypesIds.some(actTypeId => bool(actTypeId))) {
      return false;
    }
    const activities = await this.activitySearch(actTypeXmlids, userId);
    if (bool(activities)) {
      const writeVals = {}
      if (dateDeadline) {
        writeVals['dateDeadline'] = dateDeadline;
      }
      if (newUserId) {
        writeVals['userId'] = newUserId;
      }
      await activities.write(writeVals);
    }
    return activities;
  }

  /**
   * Set activities as done, limiting to some activity types and
    optionally to a given user.
   * @param actTypeXmlids 
   * @param userId 
   * @param feedback 
   * @returns 
   */
  async activityFeedback(actTypeXmlids, userId?: any, feedback?: any) {
    if (this.env.context['mailActivityAutomationSkip']) {
      return false;
    }

    const Data = await this.env.items('ir.model.data').sudo();
    let activityTypesIds = [];
    for (const xmlid of actTypeXmlids) {
      activityTypesIds.push(await Data._xmlidToResId(xmlid, false));
    }
    activityTypesIds = activityTypesIds.filter(actTypeId => bool(actTypeId));
    if (!activityTypesIds.some(actTypeId => bool(actTypeId))) {
      return false;
    }
    const activities = await this.activitySearch(actTypeXmlids, userId);
    if (activities) {
      await activities.actionFeedback(feedback);
    }
    return true;
  }

  /**
   * Unlink activities, limiting to some activity types and optionally
    to a given user. 
   * @param actTypeXmlids 
   * @param userId 
   * @returns 
   */
  async activityUnlink(actTypeXmlids, userId?: any) {
    if (this.env.context['mailActivityAutomationSkip']) {
      return false;
    }

    const Data = await this.env.items('ir.model.data').sudo();
    let activityTypesIds = [];
    for (const xmlid of actTypeXmlids) {
      activityTypesIds.push(await Data._xmlidToResId(xmlid, false));
    }
    activityTypesIds = activityTypesIds.filter(actTypeId => bool(actTypeId));
    if (!activityTypesIds.some(actTypeId => bool(actTypeId))) {
      return false;
    }
    await (await this.activitySearch(actTypeXmlids, userId)).unlink();
    return true;
  }
}