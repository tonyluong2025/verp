import { randomInt } from "crypto";
import { Fields, _Date } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";
import { version } from "../../../core/release";
import { DEFAULT_SERVER_DATE_FORMAT as DF, _f, f, isList, len, next, parseInt, pop, quoteList, range, update } from '../../../core/tools';
import { literalEval } from "../../../core/tools/ast";
import { bool } from "../../../core/tools/bool";
import { addDate, subDate, toFormat } from "../../../core/tools/date_utils";
import { stringify } from "../../../core/tools/json";
import { formatDate, formatLang, getLang } from "../../../core/tools/models";

@MetaModel.define()
class AccountJournal extends Model {
  static _module = module;
  static _parents = "account.journal";

  static kanbanDashboard = Fields.Text({ compute: '_kanbanDashboard' });
  static kanbanDashboardGraph = Fields.Text({ compute: '_kanbanDashboardGraph' });
  static jsonActivityData = Fields.Text({ compute: '_getJsonActivityData' });
  static showOnDashboard = Fields.Boolean({ string: 'Show journal on dashboard', help: "Whether this journal should be displayed on the dashboard or not", default: true });
  static color = Fields.Integer("Color Index", { default: 0 });
  static entriesCount = Fields.Integer({ compute: '_computeEntriesCount' });

  async _kanbanDashboard() {
    for (const journal of this) {
      await journal.set('kanbanDashboard', stringify(await journal.getJournalDashboardDatas()));
    }
  }

  async _kanbanDashboardGraph() {
    for (const journal of this) {
      const type = await journal.type;
      if (['sale', 'purchase'].includes(type)) {
        await journal.set('kanbanDashboardGraph', stringify(await journal.getBarGraphDatas()));
      }
      else if (['cash', 'bank'].includes(type)) {
        await journal.set('kanbanDashboardGraph', stringify(await journal.getLineGraphDatas()));
      }
      else {
        await journal.set('kanbanDashboardGraph', false);
      }
    }
  }

  async _getJsonActivityData() {
    for (const journal of this) {
      const activities = [];
      // search activity on move on the journal
      const sqlQuery = `
          SELECT act.id,
              act."resId",
              act."resModel",
              act.summary,
              "actType".label,
              "actType".category,
              act."dateDeadline",
              m.date,
              m.ref,
              CASE WHEN act."dateDeadline" < CURRENT_DATE THEN 'late' ELSE 'future' END as status
          FROM "accountMove" m
              LEFT JOIN "mailActivity" act ON act."resId" = m.id
              LEFT JOIN "mailActivityType" "actType" ON act."activityTypeId" = "actType".id
          WHERE act."resModel" = 'account.move'
              AND m."journalId" = %s
      `;
      const res = await this.env.cr.execute(sqlQuery, [journal.id]);
      for (const activity of res) {
        const act = {
          'id': activity['id'],
          'resId': activity['resId'],
          'resModel': activity['resModel'],
          'status': activity['status'],
          'label': activity['summary'] || activity['label'],
          'activityCategory': activity['category'],
          'date': await formatDate(this.env, activity['dateDeadline'])
        }
        if (activity['category'] === 'taxReport' && activity['resModel'] === 'account.move') {
          act['label'] = activity['ref'];
        }

        activities.push(act);
      }
      await journal.set('jsonActivityData', stringify({ 'activities': activities }));
    }
  }

  async _computeEntriesCount() {
    const res = Object.fromEntries((await this.env.items('account.move').readGroup(
      [['journalId', 'in', this.ids]],
      ['journalId'],
      ['journalId'],
    )).map(r => [r['journalId'][0], r['journalId_count']]));
    for (const journal of this) {
      await journal.set('entriesCount', res[journal.id] || 0);
    }
  }

  async _graphTitleAndKey() {
    const type = await this('type');
    if (['sale', 'purchase'].includes(type)) {
      return ['', await this._t('Residual amount')];
    }
    else if (type === 'cash') {
      return ['', await this._t('Cash: Balance')];
    }
    else if (type === 'bank') {
      return ['', await this._t('Bank: Balance')];
    }
  }

  // Below method is used to get data of bank and cash statemens
  /**
   * Computes the data used to display the graph for bank and cash journals in the accounting dashboard
   * @returns 
   */
  async getLineGraphDatas() {
    let currency = await this('currencyId');
    currency = currency.ok ? currency : await (await this['companyId']).currencyId;

    async function buildGraphData(date: Date, amount: number) {
      //display date in locale format
      const label = toFormat(date, 'd MMMM yyyy', { locale: locale });
      const shortLabel = toFormat(date, 'd MMM', { locale: locale })
      return { 'x': shortLabel, 'y': amount, 'label': label }
    }

    this.ensureOne();
    // const BankStatement = this.env.items('account.bank.statement');
    const data = [];
    const today = _Date.today();
    const lastMonth = subDate(today, { days: 30 });
    const locale = (await (await getLang(this.env)).code).replace('_', '-');

    //starting point of the graph is the last statement
    const lastStmt = await (this as any)._getLastBankStatement([['state', 'in', ['posted', 'confirm']]]);

    const lastBalance = bool(lastStmt) && await lastStmt.balanceEndReal || 0;
    data.push(await buildGraphData(today, lastBalance));

    //then we subtract the total amount of bank statement lines per day to get the previous points
    //(graph is drawn backward)
    let date = today;
    let amount = lastBalance;
    const query = `
        SELECT move.date, sum(line.amount) as amount
        FROM "accountBankStatementLine" line
        JOIN "accountMove" move ON move.id = line."moveId"
        WHERE move."journalId" = $1
        AND move.date > $2
        AND move.date <= $3
        GROUP BY move.date
        ORDER BY move.date desc
    `;
    const res = await this.env.cr.execute(query, { bind: [this.id, lastMonth, today] });
    for (const val of res) {
      date = val['date'];
      if (toFormat(new Date(date), DF) != toFormat(today, DF)) {  // make sure the last point in the graph is today
        data.unshift(await buildGraphData(date, amount));
      }
      amount = await currency.round(amount - val['amount']);
    }

    // make sure the graph starts 1 month ago
    if (toFormat(date, DF) != toFormat(lastMonth, DF)) {
      data.unshift(await buildGraphData(lastMonth, amount));
    }

    const [graphTitle, graphKey] = await this._graphTitleAndKey();
    const color = version.includes('e') ? '#875A7B' : '#7c7bad';

    const isSampleData = !bool(lastStmt) && res.length == 0
    if (isSampleData) {
      for (const i of range(30, 0, -5)) {
        const currentDate = subDate(today, { days: i });
        data.push(await buildGraphData(currentDate, randomInt(-5, 15)));
      }
    }
    return [{ 'values': data, 'title': graphTitle, 'key': graphKey, 'area': true, 'color': color, 'isSampleData': isSampleData }];
  }

  async getBarGraphDatas() {
    const data = [];
    const today = _Date.today();
    const locale = (await (await getLang(this.env)).code).replace('_', '-');
    data.push({ 'label': await this._t('Due'), 'value': 0.0, 'type': 'past' });
    const dayOfWeek = parseInt(toFormat(today, 'c', { locale: locale }));
    const firstDayOfWeek = addDate(today, { days: -dayOfWeek + 1 });
    for (const i of range(-1, 4)) {
      let label;
      if (i == 0) {
        label = await this._t('This Week');
      }
      else if (i == 3) {
        label = await this._t('Not Due');
      }
      else {
        const startWeek = addDate(firstDayOfWeek, { days: i * 7 });
        const endWeek = addDate(startWeek, { days: 6 });
        if (startWeek.getMonth() == endWeek.getMonth()) {
          label = String(startWeek.getDate()) + '-' + String(endWeek.getDate()) + ' ' + toFormat(endWeek, 'MMM', { locale: locale });
        }
        else {
          label = toFormat(startWeek, 'd MMM', { locale: locale }) + '-' + toFormat(endWeek, 'd MMM', { locale: locale });
        }
      }
      data.push({ 'label': label, 'value': 0.0, 'type': i < 0 ? 'past' : 'future' });
    }

    // Build SQL query to find amount aggregated by week
    const selectSqlClause = await this._getBarGraphSelectQuery();
    let query = '';
    let startDate = subDate(firstDayOfWeek, { days: 7 });
    const weeks = [];
    for (const i of range(0, 6)) {
      if (i == 0) {
        query += "(" + selectSqlClause + ` and "invoiceDateDue" < '` + toFormat(startDate, DF) + "')"
        weeks.push([_Date.min, startDate]);
      }
      else if (i == 5) {
        query += " UNION ALL (" + selectSqlClause + ` and "invoiceDateDue" >= '` + toFormat(startDate, DF) + "')"
        weeks.push([startDate, _Date.max]);
      }
      else {
        const nextDate = addDate(startDate, { days: 7 });
        query += " UNION ALL (" + selectSqlClause + ` and "invoiceDateDue" >= '` + toFormat(startDate, DF) + `' and "invoiceDateDue" < '` + toFormat(nextDate, DF) + "')"
        weeks.push([startDate, nextDate]);
        startDate = nextDate;
      }
    }
    // Ensure results returned by postgres match the order of data list
    const res = await this.env.cr.execute(query);
    let isSampleData = true;
    for (const index of range(0, res.length)) {
      if (res[index]['aggrDate'] != null) {
        isSampleData = false;
        const aggrDate = new Date(res[index]['aggrDate']);
        const weekIndex = next(Array.from(range(0, weeks.length)).filter(i => weeks[i][0] <= aggrDate && aggrDate < weeks[i][1]));
        data[weekIndex]['value'] = Number(res[index]['total']);
      }
    }
    let [graphTitle, graphKey] = await this._graphTitleAndKey();

    if (isSampleData) {
      for (const index of range(0, res.length)) {
        data[index]['type'] = 'o-sample-data'
        // we use unrealistic values for the sample data
        data[index]['value'] = randomInt(0, 20);
        graphKey = await this._t('Sample data');
      }
    }
    return [{ 'values': data, 'title': graphTitle, 'key': graphKey, 'isSampleData': isSampleData }];
  }

  /**
   * Returns a tuple containing the base SELECT SQL query used to gather
      the bar graph's data as its first element, and the arguments dictionary
      for it as its second.
   * @returns 
   */
  async _getBarGraphSelectQuery() {
    const sign = await this['type'] === 'sale' ? '' : '-';
    return (_f(`
                SELECT
                    ` + sign + ` + SUM(move."amountResidualSigned") AS total,
                    MIN("invoiceDateDue") AS "aggrDate"
                FROM "accountMove" move
                WHERE move."journalId" = {journalId}
                AND move.state = 'posted'
                AND move."paymentState" in ('notPaid', 'partial')
                AND move."moveType" IN ({invoiceTypes})
            `, {
      'invoiceTypes': quoteList(this.env.items('account.move').getInvoiceTypes(true)),
      'journalId': this.id
    }));
  }

  async getJournalDashboardDatas() {
    let [currency, company, type] = await this('currencyId', 'companyId', 'type');
    currency = currency.ok ? currency : await company.currencyId;
    let [numberToReconcile, numberToCheck, lastBalance] = [0, 0, 0];
    let hasAtLeastOneStatement = false;
    let [bankAccountBalance, nbLinesBankAccountBalance] = [0, 0];
    let [outstandingPayAccountBalance, nbLinesOutstandingPayAccountBalance] = [0, 0];
    let title = '';
    let [numberDraft, numberWaiting, numberLate, toCheckBalance] = [0, 0, 0, 0];
    let [sumDraft, sumWaiting, sumLate] = [0.0, 0.0, 0.0];
    if (['bank', 'cash'].includes(type)) {
      const lastStatement = await (this as any)._getLastBankStatement([['state', 'in', ['posted', 'confirm']]]);
      const lastBalance = await lastStatement.balanceEnd;
      hasAtLeastOneStatement = bool(lastStatement);
      [bankAccountBalance, nbLinesBankAccountBalance] = await (this as any)._getJournalBankAccountBalance([['parentState', '=', 'posted']]);
      [outstandingPayAccountBalance, nbLinesOutstandingPayAccountBalance] = await (this as any)._getJournalOutstandingPaymentsAccountBalance([['parentState', '=', 'posted']]);

      const res = await this._cr.execute(`
                    SELECT COUNT(line.id)::int
                    FROM "accountBankStatementLine" line
                    JOIN "accountMove" move ON move.id = line."moveId"
                    JOIN "accountBankStatement" st ON line."statementId" = st.id
                    WHERE move."journalId" IN (%s)
                    AND st.state = 'posted'
                    AND NOT line."isReconciled"
                `, [String(this.ids || 'NULL')]);
      numberToReconcile = res[0];

      const toCheckIds = await this.toCheckIds();
      numberToCheck = len(toCheckIds);
      toCheckBalance = await toCheckIds.sum(r => r.amount);
    }
    //TODO need to check if all invoices are in the same currency than the journal!!!!
    else if (['sale', 'purchase'].includes(type)) {
      const title = type === 'purchase' ? await this._t('Bills to pay') : await this._t('Invoices owed to you');
      await this.env.items('account.move').flush(['amountResidual', 'currencyId', 'moveType', 'invoiceDate', 'companyId', 'journalId', 'date', 'state', 'paymentState']);

      let query = await this._getOpenBillsToPayQuery();
      const queryResultsToPay = await this.env.cr.execute(query);

      query = await this._getDraftBillsQuery();
      const queryResultsDrafts = await this.env.cr.execute(query);

      query = await this._getLateBillsQuery();
      const lateQueryResults = await this.env.cr.execute(query);

      const currCache = {};
      [numberWaiting, sumWaiting] = await this._countResultsAndSumAmounts(queryResultsToPay, currency, currCache);
      [numberDraft, sumDraft] = await this._countResultsAndSumAmounts(queryResultsDrafts, currency, currCache);
      [numberLate, sumLate] = await this._countResultsAndSumAmounts(lateQueryResults, currency, currCache);
      const read = await this.env.items('account.move').readGroup([['journalId', '=', this.id], ['toCheck', '=', true]], ['amountTotalSigned'], 'journalId', { lazy: false });
      if (bool(read)) {
        numberToCheck = read[0]['__count'];
        toCheckBalance = read[0]['amountTotalSigned'];
      }
    }
    else if (type === 'general') {
      const read = await this.env.items('account.move').readGroup([['journalId', '=', this.id], ['toCheck', '=', true]], ['amountTotalSigned'], 'journalId', { lazy: false });
      if (bool(read)) {
        numberToCheck = read[0]['__count'];
        toCheckBalance = read[0]['amountTotalSigned'];
      }
    }
    const isSampleData = await this['kanbanDashboardGraph'] && Object.values(JSON.parse(await this['kanbanDashboardGraph'])).some(data => data['isSampleData'] ?? false);

    return {
      'numberToCheck': numberToCheck,
      'toCheckBalance': await formatLang(this.env, toCheckBalance, { currencyObj: currency }),
      'numberToReconcile': numberToReconcile,
      'accountBalance': await formatLang(this.env, await currency.round(bankAccountBalance), { currencyObj: currency }),
      'hasAtLeastOneStatement': hasAtLeastOneStatement,
      'nbLinesBankAccountBalance': nbLinesBankAccountBalance,
      'outstandingPayAccountBalance': await formatLang(this.env, await currency.round(outstandingPayAccountBalance), { currencyObj: currency }),
      'nbLinesOutstandingPayAccountBalance': nbLinesOutstandingPayAccountBalance,
      'lastBalance': await formatLang(this.env, await currency.round(lastBalance) + 0.0, { currencyObj: currency }),
      'numberDraft': numberDraft,
      'numberWaiting': numberWaiting,
      'numberLate': numberLate,
      'sumDraft': await formatLang(this.env, await currency.round(sumDraft) + 0.0, { currencyObj: currency }),
      'sumWaiting': await formatLang(this.env, await currency.round(sumWaiting) + 0.0, { currencyObj: currency }),
      'sumLate': await formatLang(this.env, await currency.round(sumLate) + 0.0, { currencyObj: currency }),
      'currencyId': currency.id,
      'bankStatementsSource': await this['bankStatementsSource'],
      'title': title,
      'isSampleData': isSampleData,
      'companyCount': len(await this.env.companies())
    }
  }

  /**
   * Returns a tuple containing the SQL query used to gather the open bills
      data as its first element, and the arguments dictionary to use to run
      it as its second.
   * @returns 
   */
  async _getOpenBillsToPayQuery() {
    return _f(`
                SELECT
                    (CASE WHEN move."moveType" IN ('outRefund', 'inRefund') THEN -1 ELSE 1 END) * move."amountResidual" AS "amountTotal",
                    {sign} * "amountResidualSigned" AS "amountTotalCompany",
                    move."currencyId" AS currency,
                    move."moveType",
                    move."invoiceDate",
                    move."companyId"
                FROM "accountMove" move
                WHERE move."journalId" = {journalId}
                AND move.state = 'posted'
                AND move."paymentState" in ('notPaid', 'partial')
                AND move."moveType" IN ('outInvoice', 'outRefund', 'inInvoice', 'inRefund', 'outReceipt', 'inReceipt');
            `, {
      'sign': await this['type'] === 'sale' ? 1 : -1,
      'journalId': this.id,
    });
  }

  /**
   * Returns a tuple containing as its first element the SQL query used to
      gather the bills in draft state data, and the arguments
      dictionary to use to run it as its second.
   * @returns 
   */
  async _getDraftBillsQuery() {
    return _f(`
                SELECT
                    (CASE WHEN move."moveType" IN ('outRefund', 'inRefund') THEN -1 ELSE 1 END) * move."amountTotal" AS "amountTotal",
                    {sign} * "amountResidualSigned" AS "amountTotalCompany",
                    move."currencyId" AS currency,
                    move."moveType",
                    move."invoiceDate",
                    move."companyId"
                FROM "accountMove" move
                WHERE move."journalId" = {journalId}
                AND move.state = 'draft'
                AND move."paymentState" in ('notPaid', 'partial')
                AND move."moveType" IN ('outInvoice', 'outRefund', 'inInvoice', 'inRefund', 'outReceipt', 'inReceipt');
            `, {
      'sign': await this['type'] === 'sale' ? 1 : -1,
      'journalId': this.id,
    });
  }

  async _getLateBillsQuery() {
    return _f(`
                SELECT
                    (CASE WHEN "moveType" IN ('outRefund', 'inRefund') THEN -1 ELSE 1 END) * "amountResidual" AS "amountTotal",
                    {sign} * "amountResidualSigned" AS "amountTotalCompany",
                    "currencyId" AS currency,
                    "moveType",
                    "invoiceDate",
                    "companyId"
                FROM "accountMove" move
                WHERE "journalId" = {journalId}
                AND "invoiceDateDue" < '{today}'
                AND state = 'posted'
                AND "paymentState" in ('notPaid', 'partial')
                AND "moveType" IN ('outInvoice', 'outRefund', 'inInvoice', 'inRefund', 'outReceipt', 'inReceipt');
            `, {
      'sign': await this['type'] === 'sale' ? 1 : -1,
      'journalId': this.id,
      'today': (await _Date.contextToday(this)).toISOString()
    });
  }

  /**
   * Loops on a query result to count the total number of invoices and sum
      their amountTotal field (expressed in the given target currency).
      amountTotal must be signed !
      """
   * @param resultsDict 
   * @param targetCurrency 
   * @param currCache 
   */
  async _countResultsAndSumAmounts(resultsDict, targetCurrency, currCache?: any) {
    let rsltCount = 0;
    let rsltSum = 0.0;
    // Create a cache with currency rates to avoid unnecessary SQL requests. Do not copy
    // curr_cache on purpose, so the dictionary is modified and can be re-used for subsequent
    // calls of the method.
    currCache = currCache == null ? {} : currCache;
    for (const result of resultsDict) {
      const cur = this.env.items('res.currency').browse(result['currency']);
      const company = bool(result['companyId']) ? this.env.items('res.company').browse(result['companyId']) : await this.env.company();
      rsltCount += 1;
      const date = result['invoiceDate'] || await _Date.contextToday(this);

      let amount;
      if (cur.eq(targetCurrency)) {
        amount = result['amountTotal'] || 0;
      }
      else if ((await company.currencyId).eq(targetCurrency) && result['amountTotalCompany']) {
        amount = result['amountTotalCompany'] || 0;
      }
      else {
        const list = [cur, targetCurrency, company, date];
        const key = String([cur.id, targetCurrency.id, company.id, date]);
        // Using setdefault will call _get_conversion_rate, so we explicitly check the
        // existence of the key in the cache instead.
        if (!(key in currCache)) {
          currCache[key] = this.env.items('res.currency')._getConversionRate(...list);
        }
        amount = currCache[key] * (result['amountTotal'] || 0);
      }
      rsltSum += await targetCurrency.round(amount);
    }
    return [rsltCount, rsltSum];
  }

  async actionCreateNew() {
    const ctx = Object.assign({}, this._context);
    ctx['default_journalId'] = this.id;
    if (await this['type'] === 'sale') {
      ctx['default_moveType'] = ctx['refund'] ? 'outRefund' : 'outInvoice';
    }
    else if (await this['type'] === 'purchase') {
      ctx['default_moveType'] = ctx['refund'] ? 'inRefund' : 'inInvoice';
    }
    else {
      ctx['default_moveType'] = 'entry';
      ctx['viewNoMaturity'] = true;
    }
    return {
      'label': await this._t('Create invoice/bill'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel': 'account.move',
      'viewId': (await this.env.ref('account.viewMoveForm')).id,
      'context': ctx,
    }
  }

  async createCashStatement() {
    const ctx = Object.assign({}, this._context);
    update(ctx, { 'journalId': this.id, 'default_journalId': this.id, 'default_journalType': 'cash' });
    const openStatements = await this.env.items('account.bank.statement').search([['journalId', '=', this.id], ['state', '=', 'open']]);
    const action = {
      'label': await this._t('Create cash statement'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel': 'account.bank.statement',
      'context': ctx,
    };
    if (len(openStatements) == 1) {
      update(action, {
        'viewMode': 'form',
        'resId': openStatements.id,
      });
    }
    else if (len(openStatements) > 1) {
      update(action, {
        'viewMode': 'tree,form',
        'domain': [['id', 'in', openStatements.ids]],
      });
    }
    return action;
  }

  /**
   * This function is called by the "Import" button of Vendor Bills,
      visible on dashboard if no bill has been created yet.
   * @returns 
   */
  async actionCreateVendorBill() {
    await (await (await this.env.company()).sudo()).setOnboardingStepDone('accountSetupBillState');

    const newWizard = await this.env.items('account.tour.upload.bill').create({});
    const viewId = (await this.env.ref('account.accountTourUploadBill')).id;

    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t('Import your first bill'),
      'viewMode': 'form',
      'resModel': 'account.tour.upload.bill',
      'target': 'new',
      'resId': newWizard.id,
      'views': [[viewId, 'form']],
    }
  }

  async toCheckIds() {
    this.ensureOne();
    const domain = await this.env.items('account.move.line')._getSuspenseMovesDomain();
    domain.push(['journalId', '=', this.id]);
    const statementLineIds = await (await this.env.items('account.move.line').search(domain)).mapped('statementLineId');
    return statementLineIds;
  }

  async _selectActionToOpen() {
    this.ensureOne();
    const type = await this['type'];
    if (this._context['actionName']) {
      return this._context['actionName'];
    }
    else if (type === 'bank') {
      return 'actionBankStatementTree';
    }
    else if (type === 'cash') {
      return 'actionViewBankStatementTree';
    }
    else if (type === 'sale') {
      return 'actionMoveOutInvoiceType';
    }
    else if (type === 'purchase') {
      return 'actionMoveInInvoiceType';
    }
    else {
      return 'actionMoveJournalLine';
    }
  }

  /**
   * return action based on type for related journals
   */
  async openAction() {
    this.ensureOne();
    let actionName = await this._selectActionToOpen();

    // Set 'account.' prefix if missing.
    if (!actionName.startsWith("account.")) {
      actionName = f('account.%s', actionName);
    }

    const action = await this.env.items("ir.actions.actions")._forXmlid(actionName);

    const context = Object.assign({}, this._context);
    if ('context' in action && typeof (action['context']) === 'string') {
      update(context, literalEval(action['context']));
    }
    else {
      update(context, action['context'] ?? {});
    }
    action['context'] = context;
    update(action['context'], {
      'default_journalId': this.id,
      'searchDefault_journalId': this.id,
    })

    const domainTypeField = action['resModel'] === 'account.move.line' && 'moveId.moveType' || 'moveType'; // The model can be either account.move or account.move.line

    // Override the domain only if the action was not explicitly specified in order to keep the
    // original action domain.
    if (!this._context['actionName']) {
      if (await this['type'] === 'sale') {
        action['domain'] = [[domainTypeField, 'in', ['outInvoice', 'outRefund', 'outReceipt']]];
      }
      else if (await this['type'] === 'purchase') {
        action['domain'] = [[domainTypeField, 'in', ['inInvoice', 'inRefund', 'inReceipt', 'entry']]];
      }
    }
    return action;
  }

  async openSpendMoney() {
    return this.openPaymentsAction('outbound');
  }

  async openCollectMoney() {
    return this.openPaymentsAction('inbound');
  }

  async openTransferMoney() {
    return this.openPaymentsAction('transfer');
  }

  async openPaymentsAction(paymentType: string, mode: string = 'tree') {
    let actionRef;
    if (paymentType === 'outbound') {
      actionRef = 'account.actionAccountPaymentsPayable';
    }
    else if (paymentType === 'transfer') {
      actionRef = 'account.actionAccountPaymentsTransfer';
    }
    else {
      actionRef = 'account.actionAccountPayments';
    }
    const action = await this.env.items('ir.actions.actions')._forXmlid(actionRef);
    action['context'] = Object.assign({}, literalEval(action['context']), { default_journalId: this.id, searchDefault_journalId: this.id });
    if (paymentType === 'transfer') {
      update(action['context'], {
        'default_partnerId': (await (await this['companyId']).partnerId).id,
        'default_isInternalTransfer': true,
      });
    }
    if (mode === 'form') {
      action['views'] = [[false, 'form']];
    }
    return action;
  }

  async openActionWithContext() {
    const actionName = this.env.context['actionName'] ?? false;
    if (!actionName) {
      return false;
    }
    const ctx = Object.assign({}, this.env.context, { default_journalId: this.id });
    if (ctx['searchDefault_journal'] ?? false) {
      update(ctx, { searchDefault_journalId: this.id });
      ctx['searchDefault_journal'] = false;  // otherwise it will do a useless groupby in bank statements
    }
    pop(ctx, 'groupby', null);
    const action = await this.env.items('ir.actions.actions')._forXmlid(`account.${actionName}`);
    action['context'] = ctx;
    if (ctx['useDomain'] ?? false) {
      action['domain'] = isList(ctx['useDomain']) && ctx['useDomain'] || ['|', ['journalId', '=', this.id], ['journalId', '=', false]];
      action['label'] = _f(await this._t(
        "{action} for journal {journal}",
        {
          action: action["label"],
          journal: await this['label']
        },
      ));
    }
    return action;
  }

  /**
   * return action to create a bank statements. This button should be called only on journals with type =='bank'
   * @returns 
   */
  async createBankStatement() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("account.actionBankStatementTree");
    update(action, {
      'views': [[false, 'form']],
      'context': "{'default_journalId': " + String(this.id) + "}",
    })
    return action;
  }

  /**
   * return action to create a customer payment
   * @returns 
   */
  async createCustomerPayment() {
    return this.openPaymentsAction('inbound', 'form');
  }

  /**
   * return action to create a supplier payment
   * @returns 
   */
  async createSupplierPayment() {
    return this.openPaymentsAction('outbound', 'form');
  }

  /**
   * return action to create a internal transfer
   * @returns 
   */
  async createInternalTransfer() {
    return this.openPaymentsAction('transfer', 'form');
  }

  // Setup Steps Stuff #

  /**
   * Marks the 'bank setup' step as done in the setup bar and in the company.
   */
  async markBankSetupAsDoneAction() {
    await (await (await this['companyId']).sudo()).setOnboardingStepDone('accountSetupBankDataState');
  }

  /**
   * Marks the 'bank setup' step as not done in the setup bar and in the company.
   */
  async unmarkBankSetupAsDoneAction() {
    await (await this['companyId']).set('accountSetupBankDataState', 'notDone');
  }
}