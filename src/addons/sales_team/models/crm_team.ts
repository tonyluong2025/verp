import { DateTime } from "luxon";
import { Fields, _Date, api, tools } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { Query } from "../../../core/osv";
import { version } from "../../../core/release";
import { bool } from "../../../core/tools/bool";
import { len, range } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";
import { _convert$, _f, f, getRandom } from "../../../core/tools/utils";

@MetaModel.define()
class CrmTeam extends Model {
  static _module = module;
  static _name = "crm.team";
  static _parents = ['mail.thread'];
  static _description = "Sales Team";
  static _order = "sequence";
  static _checkCompanyAuto = true;

  /**
   * Compute default team id for sales related documents. Note that this
      method is not called by defaultGet as it takes some additional
      parameters and is meant to be called by other default methods.

      Heuristic (when multiple match: take first sequence ordered)

        1- any of my teams (member OR responsible) matching domain
        2- any of my teams (member OR responsible)
        3- default from context
        4- any team matching my company and domain
        5- any team matching my company

      Note: ResPartner.teamId field is explicitly not taken into account. We
      think this field causes a lot of noises compared to its added value.
      Think notably: team not in responsible teams, team company not matching
      responsible or lead company, asked domain not matching, ...

      :param userId: salesperson to target, fallback on env.uid;
      :domain: optional domain to filter teams (like use_lead = true);
   * @param userId 
   * @param domain 
   */
  async _getDefaultTeamId(userId?: any, domain?: any) {
    let user;
    if (userId == null) {
      user = await this.env.user();
    }
    else {
      user = (await this.env.items('res.users').sudo()).browse(userId);
    }
    const validCids = [false].concat((await user.companyIds).ids);

    // 1- find in user memberships - note that if current user in C1 searches
    // for team belonging to a user in C1/C2 -> only results for C1 will be returned
    let team = this.env.items('crm.team');
    let teams = await this.env.items('crm.team').search([
      ['companyId', 'in', validCids],
      '|', ['userId', '=', user.id], ['memberIds', 'in', [user.id]],
    ]);
    if (teams.ok && bool(domain)) {
      team = (await teams.filteredDomain(domain)).slice(0, 1);
    }
    // 2- any of my teams
    if (!team.ok) {
      team = teams.slice(0, 1);
    }
    // 3- default: context
    if (!team.ok && 'default_teamId' in this.env.context) {
      team = this.env.items('crm.team').browse(this.env.context['default_teamId']);
    }
    // 4- default: first one matching domain, then first one
    if (!team.ok) {
      teams = await this.env.items('crm.team').search([['companyId', 'in', validCids]]);
      if (teams.ok && bool(domain)) {
        team = (await teams.filteredDomain(domain)).slice(0, 1);
      }
      if (!team.ok) {
        team = teams.slice(0, 1);
      }
    }
    return team;
  }

  async _getDefaultFavoriteUserIds() {
    return [[6, 0, [this.env.uid]]];
  }

  // description
  static label = Fields.Char('Sales Team', { required: true, translate: true });
  static sequence = Fields.Integer('Sequence', { default: 10 });
  static active = Fields.Boolean({ default: true, help: "If the active field is set to false, it will allow you to hide the Sales Team without removing it." });
  static companyId = Fields.Many2one(
    'res.company', {
    string: 'Company', index: true,
    default: self => self.env.company()
  });
  static currencyId = Fields.Many2one(
    "res.currency", {
    string: "Currency",
    related: 'companyId.currencyId', readonly: true
  });
  static userId = Fields.Many2one('res.users', { string: 'Team Leader', checkCompany: true });
  // memberships
  static isMembershipMulti = Fields.Boolean(
    'Multiple Memberships Allowed', {
    compute: '_computeIsMembershipMulti',
    help: 'If true, users may belong to several sales teams. Otherwise membership is limited to a single sales team.'
  });
  static memberIds = Fields.Many2many(
    'res.users', {
    string: 'Salespersons',
    domain: "['&', ['share', '=', false], ['companyIds', 'in', memberCompanyIds]]",
    compute: '_computeMemberIds', inverse: '_inverseMemberIds', search: '_searchMemberIds',
    help: "Users assigned to this team."
  });
  static memberCompanyIds = Fields.Many2many(
    'res.company', {
    compute: '_computeMemberCompanyIds',
    help: 'UX: Limit to team company or all if no company'
  });
  static memberWarning = Fields.Text('Membership Issue Warning', { compute: '_computeMemberWarning' });
  static crmTeamMemberIds = Fields.One2many(
    'crm.team.member', 'crmTeamId', { string: 'Sales Team Members',
    help: "Add members to automatically assign their documents to this sales team."
  });
  static crmTeamMemberAllIds = Fields.One2many(
    'crm.team.member', 'crmTeamId', { string: 'Sales Team Members (incl. inactive)',
    context: { 'activeTest': false }
  });
  // UX options
  static color = Fields.Integer({ string: 'Color Index', help: "The color of the channel" });
  static favoriteUserIds = Fields.Many2many(
    'res.users', {
    relation: 'teamFavoriteUserRel', column1: 'teamId', column2: 'userId',
    string: 'Favorite Members', default: self => self._getDefaultFavoriteUserIds()
  });
  static isFavorite = Fields.Boolean(
    {
      string: 'Show on dashboard', compute: '_computeIsFavorite', inverse: '_inverseIsFavorite',
      help: "Favorite teams to display them in the dashboard and access them easily."
    });
  static dashboardButtonName = Fields.Char({ string: "Dashboard Button", compute: '_computeDashboardButtonName' });
  static dashboardGraphData = Fields.Text({ compute: '_computeDashboardGraph' });

  @api.depends('sequence')  // TDE FIXME: force compute in new mode
  async _computeIsMembershipMulti() {
    const multiEnabled = await (await this.env.items('ir.config.parameter').sudo()).getParam('sales_team.membershipMulti', false);
    await this.set('isMembershipMulti', multiEnabled);
  }

  @api.depends('crmTeamMemberIds.active')
  async _computeMemberIds() {
    for (const team of this) {
      await team.set('memberIds', await (await team.crmTeamMemberIds).userId);
    }
  }

  async _inverseMemberIds() {
    for (const team of this) {
      // pre-save value to avoid having _computeMemberIds interfering
      // while building membership status
      const memberships = await team.crmTeamMemberIds;
      const usersCurrent = await team.memberIds;
      const usersNew = usersCurrent.sub(await memberships.userId);

      // add missing memberships
      const users = [];
      for (const user of usersNew) {
        users.push({ 'crmTeamId': team.id, 'userId': user.id });
      }
      await this.env.items('crm.team.member').create(users);

      // activate or deactivate other memberships depending on members
      for (const membership of memberships) {
        await membership.set('active', usersCurrent.includes(await membership.userId));
      }
    }
  }

  /**
   * Display a warning message to warn user they are about to archive
      other memberships. Only valid in mono-membership mode and take into
      account only active memberships as we may keep several archived
      memberships.
   * @returns 
   */
  @api.depends('isMembershipMulti', 'memberIds')
  async _computeMemberWarning() {
    await this.set('memberWarning', false);
    if (await this.all(team => team.isMembershipMulti)) {
      return;
    }
    // done in a loop, but to be used in form view only -> not optimized
    for (const team of this) {
      let memberWarning;
      const otherMemberships = await this.env.items('crm.team.member').search([
        ['crmTeamId', '!=', bool(team.ids) ? team.id : false],  // handle NewID
        ['userId', 'in', (await team.memberIds).ids]
      ]);
      if (bool(otherMemberships) && len(otherMemberships) == 1) {
        memberWarning = _f(await this._t("Adding {userName} in this team would remove him/her from its current team {teamName}."), {
          userName: await (await otherMemberships.userId).label,
          teamName: await (await otherMemberships.crmTeamId).label
        });
      }
      else if (bool(otherMemberships)) {
        memberWarning = _f(await this._t("Adding {userNames} in this team would remove them from their current teams {teamNames})."), {
          userNames: (await otherMemberships.mapped('userId.label')).join(', '),
          teamNames: (await otherMemberships.mapped('crmTeamId.label')).join(', ')
        });
      }
      if (memberWarning) {
        await team.set('memberWarning', memberWarning + " " + await this._t("To add a Salesperson into multiple Teams, activate the Multi-Team option in settings."));
      }
    }
  }

  async _searchMemberIds(operator, value) {
    return [['crmTeamMemberIds.userId', operator, value]];
  }

  /**
   * Available companies for members. Either team company if set, either
      any company if not set on team.
   */
  @api.depends('companyId')
  async _computeMemberCompanyIds() {
    const allCompanies = await this.env.items('res.company').search([]);
    for (const team of this) {
      const companyId = await team.companyId;
      await team.set('memberCompanyIds', bool(companyId) ? companyId : allCompanies);
    }
  }

  async _computeIsFavorite() {
    for (const team of this) {
      await team.set('isFavorite', (await team.favoriteUserIds).includes(await this.env.user()));
    }
  }

  async _inverseIsFavorite() {
    const sudoedSelf = await this.sudo();
    const toFav = await sudoedSelf.filtered(async (team) => !(await team.favoriteUserIds).includes(await this.env.user()));
    await toFav.write({ 'favoriteUserIds': [[4, this.env.uid]] });
    await sudoedSelf.sub(toFav).write({ 'favoriteUserIds': [[3, this.env.uid]] });
    return true;
  }

  /**
   * Sets the adequate dashboard button name depending on the Sales Team's options
   */
  async _computeDashboardButtonName() {
    for (const team of this) {
      await team.set('dashboardButtonName', await this._t("Big Pretty Button :)")); // placeholder
    }
  }

  async _computeDashboardGraph() {
    for (const team of this) {
      await team.set('dashboardGraphData', stringify(await team._getDashboardGraphData()));
    }
  }

  // ------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------

  @api.modelCreateMulti()
  async create(valsList) {
    const teams = await _super(CrmTeam, await this.withContext({ mailCreateNosubscribe: true })).create(valsList);
    await (await teams.filtered((t) => t.memberIds))._addMembersToFavorites();
    return teams;
  }

  async write(values) {
    const res = await _super(CrmTeam, this).write(values);
    // manually launch company sanity check
    if (values['companyId']) {
      await (await this['crmTeamMemberIds'])._checkCompany({ fnames: ['crmTeamId'] });
    }
    if (values['memberIds']) {
      await this._addMembersToFavorites();
    }
    return res;
  }

  @api.ondelete(false)
  async _unlinkExceptDefault() {
    const defaultTeams = [
      await this.env.ref('sales_team.salesteamWebsiteSales'),
      await this.env.ref('sales_team.posSalesTeam'),
      await this.env.ref('sales_team.ebaySalesTeam')
    ];
    for (const team of this) {
      if (defaultTeams.includes(team)) {
        throw new UserError(await this._t('Cannot delete default team "%s"', await team.label));
      }
    }
  }

  // ------------------------------------------------------------
  // ACTIONS
  // ------------------------------------------------------------

  /**
   * Skeleton function to be overloaded It will return the adequate action
      depending on the Sales Team's options.
   * @returns 
   */
  async actionPrimaryChannelButton() {
    return false;
  }

  // ------------------------------------------------------------
  // TOOLS
  // ------------------------------------------------------------

  async _addMembersToFavorites() {
    for (const team of this) {
      const userIds = [];
      for (const member of await team.memberIds) {
        userIds.push([4, member.id]);
      }
      await team.set('favoriteUserIds', userIds);
    }
  }

  // ------------------------------------------------------------
  // GRAPH
  // ------------------------------------------------------------

  /**
   * skeleton function defined here because it'll be called by crm and/or sale
   */
  async _graphGetModel(): Promise<string> {
    throw new UserError(await this._t('Undefined graph model for Sales Team: %s', await this['label']));
  }

  /**
   * return a coherent start and end date for the dashboard graph covering a month period grouped by week.
   * @param today 
   * @returns 
   */
  async _graphGetDates(today: Date) {
    const startDate = DateTime.fromJSDate(today).minus({ months: 1 });
    // we take the start of the following week if we group by week
    // (to avoid having twice the same week from different month)
    const _startDate = startDate.plus({ days: 8 - startDate.weekday }).toJSDate();
    return [_startDate, today];
  }

  async _graphDateColumn() {
    return 'createdAt';
  }

  async _graphXQuery() {
    return f('EXTRACT(WEEK FROM "%s")', await this._graphDateColumn());
  }

  async _graphYQuery() {
    throw new UserError(await this._t('Undefined graph model for Sales Team: %s', await this['label']));
  }

  async _extraSqlConditions() {
    return '';
  }

  /**
   * Returns an array containing the appropriate graph title and key respectively.
   * The key is for lineCharts, to have the on-hover label.
   * @returns 
   */
  async _graphTitleAndKey() {
    return ['', ''];
  }

  /**
   * return format should be an iterable of dicts that contain {'xValue': ..., 'yValue': ...}
          x_values should be weeks.
          y_values are floats.
   * @param startDate 
   * @param endDate 
   * @returns 
   */
  async _graphData(startDate, endDate) {
    let query = `SELECT {xQuery} as "xValue", {yQuery} as "yValue"
                     FROM "{table}"
                    WHERE "teamId" = {teamId}
                      AND DATE("{dateColumn}") >= '{startDate}'
                      AND DATE("{dateColumn}") <= '{endDate}'
                      {extraConditions}
                    GROUP BY "xValue";`;

    // apply rules
    const dashboardGraphModel = await this._graphGetModel();
    const GraphModel = this.env.items(dashboardGraphModel);
    const graphTable = GraphModel.cls._table;
    let extraConditions = await this._extraSqlConditions();
    const whereQuery: Query = await GraphModel._whereCalc([]);
    await GraphModel._applyIrRules(whereQuery, 'read');
    const [fromClause, whereClause, whereClauseParams] = whereQuery.getSql();
    if (whereClause) {
      extraConditions += " AND " + whereClause;
    }
    query = _f(query, {
      'xQuery': await this._graphXQuery(),
      'yQuery': await this._graphYQuery(),
      'table': graphTable,
      'teamId': this.id,
      'dateColumn': await this._graphDateColumn(),
      'startDate': startDate.toISOString(),
      'endDate': endDate.toISOString(),
      'extraConditions': extraConditions
    });

    return this._cr.execute(_convert$(query), {bind: whereClauseParams});
  }

  async _getDashboardGraphData() {
    /**
     * Generates a week name (string) from a datetime according to the locale:
                E.g.: locale    startDate (datetime)      return string
                    "en_US"      November 16th           "16-22 Nov"
                    "en_US"      December 28th           "28 Dec-3 Jan"
    * @param startDate 
    * @param locale 
    */
    function getWeekName(startDate: Date, locale: string) {
      let shortNameFrom;
      const _startDate = DateTime.fromJSDate(startDate);
      if (_startDate.plus({ days: 6 }).month == _startDate.month) {
        shortNameFrom = _startDate.toFormat('dd', { locale: locale });
      }
      else {
        shortNameFrom = _startDate.toFormat('dd MMM', { locale: locale });
      }
      const shortNameTo = _startDate.plus({ days: 6 }).toFormat('d MMM', { locale: locale });
      return shortNameFrom + '-' + shortNameTo;
    }

    this.ensureOne();
    const values = [];
    const today = _Date.toDate(await _Date.contextToday(this)) as Date;
    const [startDate, endDate] = await this._graphGetDates(today);
    const graphData = await this._graphData(startDate, endDate);
    let xField = 'label';
    let yField = 'value';

    // generate all required x_fields and update the y_values where we have data for them
    const locale = (this._context['lang'] || 'en_US').replace('_', '-');

    const weeksInStartYear = DateTime.local(startDate.getFullYear(), 12, 28).weekNumber; // This date is always in the last week of ISO years
    const weekCount = (DateTime.fromJSDate(endDate).weekNumber - DateTime.fromJSDate(startDate).weekNumber) % weeksInStartYear + 1;
    for (const week of range(weekCount)) {
      const shortName = getWeekName(DateTime.fromJSDate(startDate).plus({ days: 7 * week }).toJSDate(), locale);
      values.push({ [xField]: shortName, [yField]: 0, 'type': week + 1 == weekCount ? 'future' : 'past' });
    }
    for (const dataItem of graphData) {
      const index = tools.parseInt((DateTime.fromJSDate(dataItem['xValue']).weekNumber - DateTime.fromJSDate(startDate).weekNumber) % weeksInStartYear);
      values[index][yField] = dataItem['yValue'];
    }

    let [graphTitle, graphKey] = await this._graphTitleAndKey();
    const color = version.includes('+e') ? '#875A7B' : '#7c7bad';

    // If no actual data available, show some sample data
    if (!bool(graphData)) {
      graphKey = await this._t('Sample data');
      for (const value of values) {
        value['type'] = 'o-sample-data';
        // we use unrealistic values for the sample data
        value['value'] = getRandom(0, 20);
      }
    }
    return [{ 'values': values, 'area': true, 'title': graphTitle, 'key': graphKey, 'color': color }];
  }
}