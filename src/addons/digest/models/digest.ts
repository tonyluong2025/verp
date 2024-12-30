import { DateTime, Duration } from "luxon";
import { Fields, _Date, _Datetime, api } from "../../../core";
import { Dict } from "../../../core/helper/collections";
import { AccessError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
// import { floatRound, htmlSanitize, isInstance } from "../../../core/tools";
import { formatDecimalizedAmount } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { subDate } from "../../../core/tools/date_utils";
import { floatRound } from "../../../core/tools/float_utils";
import { isInstance } from "../../../core/tools/func";
import { enumerate, extend } from "../../../core/tools/iterable";
import { htmlSanitize } from "../../../core/tools/mail";
import { hmac } from "../../../core/tools/misc";
import { _f, f } from "../../../core/tools/utils";
import { markup } from "../../../core/tools/xml";

@MetaModel.define()
class Digest extends Model {
  static _module = module;
  static _name = 'digest.digest';
  static _description = 'Digest';

  // Digest description
  static label = Fields.Char({ string: 'Name', required: true, translate: true });
  static userIds = Fields.Many2many('res.users', { string: 'Recipients', domain: "[['share', '=', false]]" });
  static periodicity = Fields.Selection([['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly']],
    { string: 'Periodicity', default: 'daily', required: true });
  static nextRunDate = Fields.Date({ string: 'Next Send Date' });
  static currencyId = Fields.Many2one({ related: "companyId.currencyId", string: 'Currency', readonly: false })
  static companyId = Fields.Many2one('res.company', { string: 'Company', default: async (self) => (await self.env.company()).id });
  static availableFields = Fields.Char({ compute: '_computeAvailableFields' });
  static isSubscribed = Fields.Boolean('Is user subscribed', { compute: '_computeIsSubscribed' });
  static state = Fields.Selection([['activated', 'Activated'], ['deactivated', 'Deactivated']], { string: 'Status', readonly: true, default: 'activated' });
  // First base-related KPIs
  static kpiResUsersConnected = Fields.Boolean('Connected Users');
  static kpiResUsersConnectedValue = Fields.Integer({ compute: '_computeKpiResUsersConnectedValue' });
  static kpiMailMessageTotal = Fields.Boolean('Messages');
  static kpiMailMessageTotalValue = Fields.Integer({ compute: '_computeKpiMailMessageTotalValue' });

  @api.depends('userIds')
  async _computeIsSubscribed() {
    for (const digest of this) {
      await digest.set('isSubscribed', (await digest.userIds).includes(await this.env.user()));
    }
  }

  async _computeAvailableFields() {
    for (const digest of this) {
      const kpisValuesFields = [];
      for (const [fieldName, field] of digest._fields.items()) {
        if (field.type === 'boolean' && ['kpi', 'xKpi', 'xStudioKpi'].some(k => fieldName.startsWith(k)) && await digest[fieldName]) {
          extend(kpisValuesFields, [fieldName + '_value']);
        }
      }
      await digest.set('availableFields', kpisValuesFields.join(', '));
    }
  }

  async _getKpiComputeParameters() {
    return [new Date(this._context['startDatetime']), new Date(this._context['endDatetime']), await this.env.company()];
  }

  async _computeKpiResUsersConnectedValue() {
    for (const record of this) {
      const [start, end, company] = await record._getKpiComputeParameters();
      const userConnected = await this.env.items('res.users').searchCount([['companyId', '=', company.id], ['loginDate', '>=', start], ['loginDate', '<', end]]);
      await record.set('kpiResUsersConnectedValue', userConnected);
    }
  }

  async _computeKpiMailMessageTotalValue() {
    const discussionSubtypeId = (await this.env.ref('mail.mtComment')).id;
    for (const record of this) {
      const [start, end, company] = await record._getKpiComputeParameters();
      const totalMessages = await this.env.items('mail.message').searchCount([['createdAt', '>=', start], ['createdAt', '<', end], ['subtypeId', '=', discussionSubtypeId], ['messageType', 'in', ['comment', 'email']]]);
      await record.set('kpiMailMessageTotalValue', totalMessages);
    }
  }

  @api.onchange('periodicity')
  async _onchangePeriodicity() {
    await this.set('nextRunDate', await this._getNextRunDate());
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const digests = await _super(Digest, this).create(valsList);
    for (const digest of digests) {
      if (! await digest.nextRunDate) {
        await digest.set('nextRunDate', await digest._getNextRunDate());
      }
    }
    return digests;
  }

  // ------------------------------------------------------------
  // ACTIONS
  // ------------------------------------------------------------

  async actionSubscribe() {
    if (await (await this.env.user()).hasGroup('base.groupUser') && !(await (this as any).userIds).includes(await this.env.user())) {
      await this._actionSubscribeUsers(await this.env.user());
    }
  }

  /**
   * Private method to manage subscriptions. Done as sudo() to speedup
    computation and avoid ACLs issues.
   * @param users 
   */
  async _actionSubscribeUsers(users) {
    const sudo = await this.sudo();
    await sudo.set('userIds', (await sudo.userIds).or(users));
  }

  async actionUnsubcribe() {
    if (await (await this.env.user()).hasGroup('base.groupUser') && (await (this as any).userIds).includes(await this.env.user())) {
      await this._actionUnsubscribeUsers(await this.env.user());
    }
  }

  /**
   * Private method to manage subscriptions. Done as sudo() to speedup
    computation and avoid ACLs issues.
   * @param users 
   */
  async _actionUnsubscribeUsers(users) {
    const sudo = await this.sudo();
    await sudo.set('userIds', (await sudo.userIds).sub(users));
  }

  async actionActivate() {
    await this.set('state', 'activated');
  }

  async actionDeactivate() {
    await this.set('state', 'deactivated');
  }

  async actionSetPeriodicity(periodicity) {
    await this.set('periodicity', periodicity);
  }

  async actionSend() {
    const toSlowdown = await this._checkDailyLogs();
    for (const digest of this) {
      for (const user of await digest.userIds) {
        await (await digest.withContext(
          {
            digestSlowdown: toSlowdown.includes(digest),
            lang: await user.lang
          }
        ))._actionSendToUser(user, 1);
      }
      if (toSlowdown.includes(digest)) {
        await digest.write({ 'periodicity': (await this._getNextPeriodicity())[0] });
      }
      await digest.set('nextRunDate', await digest._getNextRunDate());
    }
  }

  async _actionSendToUser(user, tipsCount: number = 1, consumTips: boolean = true) {
    const companyId = await user.companyId;
    const renderedBody = (await this.env.items('mail.render.mixin').withContext({ preserveComments: true })._renderTemplate(
      'digest.digestMailMain',
      'digest.digest',
      this.ids,
      'qwebView',
      {
        'title': await (this as any).label,
        'topButtonLabel': await this._t('Connect'),
        'topButtonUrl': await (this as any).getBaseUrl(),
        'company': companyId,
        'user': user,
        'unsubscribeToken': this._getUnsubscribeToken(user.id),
        'tipsCount': tipsCount,
        'formattedDate': DateTime.now().toFormat('MM dd, yyyy'),
        'displayMobileBanner': true,
        'kpiData': await this._computeKpis(companyId, user),
        'tips': await this._computeTips(companyId, user, tipsCount, consumTips),
        'preferences': await this._computePreferences(companyId, user),
      },
      true
    ))[this.id];
    const fullMail = this.env.items('mail.render.mixin')._renderEncapsulate(
      'digest.digestMailLayout',
      renderedBody,
      {
        'company': companyId,
        'user': user,
      },
    )
    // create a mail_mail based on values, without attachments
    const mailValues = {
      'autoDelete': true,
      'authorId': (await (await this.env.user()).partnerId).id,
      'emailFrom': (
        await (await (await (this as any).companyId).partnerId).emailFormatted
        || await (await this.env.user()).emailFormatted
        || await (await this.env.ref('base.userRoot')).emailFormatted
      ),
      'emailTo': await user.emailFormatted,
      'bodyHtml': fullMail,
      'state': 'outgoing',
      'subject': f('%s: %s', await companyId.label, await this['label']),
    }
    await (await this.env.items('mail.mail').sudo()).create(mailValues);
    return true;
  }

  @api.model()
  async _cronSendDigestEmail() {
    const digests = await this.search([['nextRunDate', '<=', _Date.today()], ['state', '=', 'activated']]);
    for (const digest of digests) {
      try {
        await digest.actionSend();
      } catch (e) {
        // except MailDeliveryException as e:
        console.warn('MailDeliveryException while sending digest %d. Digest is now scheduled for next cron update.', digest.id)
      }
    }
  }

  /**
   * Generate a secure hash for this digest and user. It allows to
    unsubscribe from a digest while keeping some security in that process.

    :param int userId: ID of the user to unsubscribe
   * @param userId 
   * @returns 
   */
  async _getUnsubscribeToken(userId) {
    return hmac(await this.env.change({ su: true }), 'digest-unsubscribe', [this.id, userId]);
  }

  // ------------------------------------------------------------
  // KPIS
  // ------------------------------------------------------------

  /**
   * Compute KPIs to display in the digest template. It is expected to be
    a list of KPIs, each containing values for 3 columns display.

    :return list: result [{
        'kpi_name': 'kpi_mail_message',
        'kpi_fullname': 'Messages',  # translated
        'kpi_action': 'crm.crm_lead_action_pipeline',  # xml id of an action to execute
        'kpi_col1': {
            'value': '12.0',
            'margin': 32.36,
            'col_subtitle': 'Yesterday',  # translated
        },
        'kpi_col2': { ... },
        'kpi_col3':  { ... },
    }, { ... }]
   * @param company 
   * @param user 
   * @returns 
   */
  async _computeKpis(company, user) {
    this.ensureOne();
    const digestFields = await this._getKpiFields();
    const invalidFields = [];
    const kpis = await Promise.all(digestFields.map(async (fieldName) =>
      Dict.from({
        kpiName: fieldName,
        kpiFullname: await (await this.env.items('ir.model.fields')._get(this._name, fieldName)).fieldDescription,
        kpiAction: false,
        kpiCol1: new Dict<any>(),
        kpiCol2: new Dict<any>(),
        kpiCol3: new Dict<any>(),
      })
    ))
    const kpisActions = this._computeKpisActions(company, user);

    for (const [colIndex, [tfName, tf]] of enumerate(await this._computeTimeframes(company))) {
      const digest = await (await (await this.withContext({ startDatetime: tf[0][0], endDatetime: tf[0][1] })).withUser(user)).withCompany(company);
      const previousDigest = await (await (await this.withContext({ startDatetime: tf[1][0], endDatetime: tf[1][1] })).withUser(user)).withCompany(company);
      for (const [index, fieldName] of enumerate(digestFields)) {
        const kpiValues = kpis[index];
        kpiValues['kpiAction'] = kpisActions[fieldName];
        let computeValue, previousValue;
        try {
          computeValue = digest[fieldName + 'Value'];
          // Context start and end date is different each time so invalidate to recompute.
          digest.invalidateCache([fieldName + 'Value']);
          previousValue = previousDigest[fieldName + 'Value'];
          // Context start and end date is different each time so invalidate to recompute.
          previousDigest.invalidateCache([fieldName + 'Value']);
        } catch (e) {
          if (isInstance(e, AccessError)) {  // no access rights -> just skip that digest details from that user's digest email
            invalidFields.push(fieldName);
            continue
          }
          throw e;
        }
        const margin = this._getMarginValue(computeValue, previousValue);
        if (this._fields[f('%sValue', fieldName)].type === 'monetary') {
          const convertedAmount = formatDecimalizedAmount(computeValue);
          computeValue = this._formatCurrencyAmount(convertedAmount, await company.currencyId)
        }
        kpiValues[f('kpiCol%s', colIndex + 1)].update({
          'value': computeValue,
          'margin': margin,
          'colSubtitle': tfName,
        });
      }
    }
    // filter failed KPIs
    return kpis.filter(kpi => !invalidFields.includes(kpi['kpiName']));
  }

  async _computeTips(company, user, tipsCount: number = 1, consumed: boolean = true) {
    const tips = await this.env.items('digest.tip').search([
      ['userIds', '!=', user.id],
      '|', ['groupId', 'in', (await user.groupsId).ids], ['groupId', '=', false]
    ], { limit: tipsCount });
    const tipDescriptions = [];
    for (const tip of tips) {
      tipDescriptions.push(htmlSanitize((await (await this.env.items('mail.render.mixin').sudo())._renderTemplate(await tip.tipDescription, 'digest.tip', tip.ids, true, "qweb"))[tip.id]));
    }
    if (consumed) {
      await tips.set('userIds', (await tips.userIds).add(user));
    }
    return tipDescriptions;
  }

  /**
   * Give an optional action to display in digest email linked to some KPIs.

    :return dict: key: kpi name (field name), value: an action that will be
      concatenated with /web#action={action}
   * @param company 
   * @param user 
   * @returns 
   */
  async _computeKpisActions(company, user) {
    return {};
  }

  /**
   * Give an optional text for preferences, like a shortcut for configuration.

    :return string: html to put in template
   * @param company 
   * @param user 
   * @returns 
   */
  async _computePreferences(company, user) {
    const preferences = [];
    if (this._context['digestSlowdown']) {
      const [_dummy, newPerioridicyStr] = await this._getNextPeriodicity();
      preferences.push(
        _f(await this._t("We have noticed you did not connect these last few days. We have automatically switched your preference to {newPerioridicyStr} Digests."), { newPerioridicyStr: newPerioridicyStr })
      )
    }
    else if (await (this as any).periodicity === 'daily' && await user.hasGroup('base.groupErpManager')) {
      preferences.push(markup(f('<p>%s<br /><a href="%s" target="_blank" style="color:#875A7B; font-weight: bold;">%s</a></p>',
        await this._t('Prefer a broader overview ?'),
        `/digest/${this.id}/setPeriodicity?periodicity=weekly`,
        await this._t('Switch to weekly Digests')
      )));
    }
    if (await user.hasGroup('base.groupErpManager')) {
      preferences.push(markup(f('<p>%s<br /><a href="%s" target="_blank" style="color:#875A7B; font-weight: bold;">%s</a></p>',
        await this._t('Want to customize this email?'),
        `/web#viewType=form&amp;model=${this._name}&amp;id=${this.id}`,
        await this._t('Choose the metrics you care about')
      )));
    }

    return preferences;
  }

  async _getNextRunDate() {
    this.ensureOne();
    const periodicity = await (this as any).periodicity;
    let delta;
    if (periodicity === 'daily') {
      delta = Duration.fromObject({ days: 1 });
    }
    else if (periodicity === 'weekly') {
      delta = Duration.fromObject({ weeks: 1 });
    }
    else if (periodicity === 'monthly') {
      delta = Duration.fromObject({ months: 1 });
    }
    else if (periodicity === 'quarterly') {
      delta = Duration.fromObject({ months: 3 });
    }
    return new Date(Date.now() + delta.milliseconds);
  }

  async _computeTimeframes(company) {
    let startDatetime: any = new Date();
    const tz = await (await company.resourceCalendarId).tz
    if (tz) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      startDatetime = DateTime.fromISO(startDatetime.toISOString(), { zone: tz }).toJSDate();

    }
    const d = DateTime.now();

    startDatetime = startDatetime.getMilliseconds();
    return [
      [await this._t('Last 24 hours'), [
        [subDate(startDatetime, { days: 1 }), new Date(startDatetime)],
        [subDate(startDatetime, { days: 2 }), subDate(startDatetime, { days: 1 })]]
      ], [await this._t('Last 7 Days'), [
        [subDate(startDatetime, { weeks: 1 }), new Date(startDatetime)],
        [subDate(startDatetime, { weeks: 2 }), subDate(startDatetime, { weeks: 1 })]]
      ], [await this._t('Last 30 Days'), [
        [subDate(startDatetime, { months: 1 }), new Date(startDatetime)],
        [subDate(startDatetime, { months: 2 }), subDate(startDatetime, { months: 1 })]]
      ]
    ]
  }
  // ------------------------------------------------------------
  // FORMATTING / TOOLS
  // ------------------------------------------------------------

  async _getKpiFields() {
    const res = []
    for (const [fieldName, field] of this._fields.items()) {
      if (field.type === 'boolean' && ['kpi', 'xKpi', 'xStudioKpi'].some(k => fieldName.startsWith(k)) && await this[fieldName]) {
        res.push(fieldName);
      }
    }
    return res;
  }

  _getMarginValue(value, previousValue: number = 0.0) {
    let margin = 0.0;
    if ((value != previousValue) && (value != 0.0 && previousValue != 0.0)) {
      margin = floatRound(((value - previousValue) / (previousValue ?? 1)) * 100, { precisionDigits: 2 });
    }
    return margin;
  }

  /**
   * Badly named method that checks user logs and slowdown the sending
    of digest emails based on recipients being away.
   * @returns 
   */
  async _checkDailyLogs() {
    const today = _Date.today();
    let toSlowdown = this.env.items('digest.digest');
    for (const digest of this) {
      const periodicity = await digest.periodicity;
      let delta;
      if (periodicity === 'daily') {
        delta = Duration.fromObject({ days: 3 });
      }
      if (periodicity === 'weekly') {
        delta = Duration.fromObject({ days: 14 });
      }
      else if (periodicity === 'monthly') {
        delta = Duration.fromObject({ months: 1 });
      }
      else if (periodicity === 'quarterly') {
        delta = Duration.fromObject({ months: 3 });
      }
      const limitDt = subDate(today, delta);

      const usersLogs = await (await this.env.items('res.users.log').sudo()).searchCount([
        ['createdUid', 'in', (await digest.userIds).ids],
        ['createdAt', '>=', limitDt]
      ]);
      if (!bool(usersLogs)) {
        toSlowdown = toSlowdown.add(digest);
      }
    }
    return toSlowdown;
  }

  async _getNextPeriodicity() {
    const periodicity = await (this as any).periodicity;
    if (periodicity === 'weekly') {
      return ['monthly', await this._t('monthly')];
    }
    if (periodicity === 'monthly') {
      return ['quarterly', await this._t('quarterly')];
    }
    return ['weekly', await this._t('weekly')]
  }

  async _formatCurrencyAmount(amount, currencyId) {
    const pre = await currencyId.position === 'before';
    const symbol = `${await currencyId.symbol || ''}`;
    return `${pre ? symbol : ''}${amount}${!pre ? symbol : ''}`;
  }
}