import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { ValidationError } from "../../../core/helper/errors"
import { MetaModel, Model, ModelRecords, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool"
import { len } from "../../../core/tools/iterable"
import { _f, f } from "../../../core/tools/utils"

@MetaModel.define()
class CrmTeamMember extends Model {
  static _module = module;
  static _name = 'crm.team.member';
  static _parents = ['mail.thread'];
  static _description = 'Sales Team Member';
  static _recName = 'userId';
  static _order = 'createdAt ASC';
  static _checkCompanyAuto = true;

  static crmTeamId = Fields.Many2one(
    'crm.team', {
      string: 'Sales Team',
    default: false,  // TDE: temporary fix to activate depending computed fields
    checkCompany: true, index: true, ondelete: "CASCADE", required: true
  });
  static userId = Fields.Many2one(
    'res.users', {
      string: 'Salesperson',  // TDE FIXME check responsible field
    checkCompany: true, index: true, ondelete: 'CASCADE', required: true,
    domain: "[['share', '=', false], ['id', 'not in', userInTeamsIds], ['companyIds', 'in', userCompanyIds]]"
  });
  static userInTeamsIds = Fields.Many2many(
    'res.users', {
      compute: '_computeUserInTeamsIds',
    help: 'UX: Give users not to add in the currently chosen team to avoid duplicates'
  });
  static userCompanyIds = Fields.Many2many(
    'res.company', {
      compute: '_computeUserCompanyIds',
    help: 'UX: Limit to team company or all if no company'
  });
  static active = Fields.Boolean({ string: 'Active', default: true });
  static isMembershipMulti = Fields.Boolean(
    'Multiple Memberships Allowed', {
      compute: '_computeIsMembershipMulti',
    help: 'If true, users may belong to several sales teams. Otherwise membership is limited to a single sales team.'
  });
  static memberWarning = Fields.Text({ compute: '_computeMemberWarning' });
  // salesman information
  static image1920 = Fields.Image("Image", { related: "userId.image1920", maxWidth: 1920, maxHeight: 1920 });
  static image128 = Fields.Image("Image (128)", { related: "userId.image128", maxWidth: 128, maxHeight: 128 });
  static label = Fields.Char({ string: 'Name', related: 'userId.displayName', readonly: false });
  static email = Fields.Char({ string: 'Email', related: 'userId.email' });
  static phone = Fields.Char({ string: 'Phone', related: 'userId.phone' });
  static mobile = Fields.Char({ string: 'Mobile', related: 'userId.mobile' });
  static companyId = Fields.Many2one('res.company', { string: 'Company', related: 'userId.companyId' });


  @api.constrains('crmTeamId', 'userId', 'active')
  async _constrainsMembership() {
    // In mono membership mode: check crm_team_id / userId is unique for active memberships. Inactive memberships can create duplicate pairs which is why we don't use a SQL constraint. Include "self" in search in case we use create
    // multi with duplicated user / team pairs in it. Use an explicit active leaf in domain as we may have an activeTest in context that would break computation
    const existing = await this.env.items('crm.team.member').search([
      ['crmTeamId', 'in', (await this['crmTeamId']).ids],
      ['userId', 'in', (await this['userId']).ids],
      ['active', '=', true]
    ])
    let duplicates = this.env.items('crm.team.member');

    const activeRecords = {}
    for (const membership of this) {
      if (await membership.active) {
        activeRecords[(await membership.userId).id] = (await membership.crmTeamId).id;
      }
    }
    for (const membership of this) {
      const potential = await existing.filtered(async (m) => (await m.userId).eq(await membership.userId) && (await m.crmTeamId).eq(await membership.crmTeamId) && m.id != membership.id);
      if (!bool(potential) || len(potential) > 1) {
        duplicates = duplicates.add(potential);
        continue;
      }
      const [userId, crmTeamId] = await potential('userId', 'crmTeamId');
      if (activeRecords[userId.id]) {
        duplicates = duplicates.add(potential);
      }
      else {
        activeRecords[userId.id] = crmTeamId.id;
      }
    }

    if (duplicates.ok) {
      const msgs = [];
      for (const m of duplicates) {
        msgs.push(f("%s (%s)", (await m.userId).label, await (await m.crmTeamId).label));
      }
      throw new ValidationError(
        _f(await this._t("You are trying to create duplicate membership(s). We found that {duplicates} already exist(s)."),
          { duplicates: msgs.join(", ") }
        )
      );
    }
  }

  /**
   * Give users not to add in the currently chosen team to avoid duplicates.
      In multi membership mode this field is empty as duplicates are allowed.
   */
  @api.depends('crmTeamId', 'isMembershipMulti', 'userId')
  @api.dependsContext('default_crmTeamId')
  async _computeUserInTeamsIds() {
    let memberUserIds;
    if (await this.all(m => m.isMembershipMulti)) {
      memberUserIds = this.env.items('res.users');
    }
    else if (bool(this.ids)) {
      memberUserIds = await this.env.items('crm.team.member').search([['id', 'not in', this.ids]]).userId;
    }
    else {
      memberUserIds = await (await this.env.items('crm.team.member').search([])).userId;
    }
    for (const member of this) {
      let userInTeamsIds;
      if (memberUserIds.ok) {
        userInTeamsIds = memberUserIds;
      }
      else if ((await member.crmTeamId).ok) {
        userInTeamsIds = await (await member.crmTeamId).memberIds;
      }
      else if (this.env.context['default_crmTeamId']) {
        userInTeamsIds = await this.env.items('crm.team').browse(this.env.context['default_crmTeamId']).memberIds;
      }
      else {
        userInTeamsIds = this.env.items('res.users');
      }
      await member.set('userInTeamsIds', userInTeamsIds);
    }
  }

  @api.depends('crmTeamId')
  async _computeUserCompanyIds() {
    const allCompanies = await this.env.items('res.company').search([]);
    for (const member of this) {
      const companyId = await (await member.crmTeamId).companyId;
      await member.set('userCompanyIds', bool(companyId) ? companyId : allCompanies);
    }
  }

  @api.depends('crmTeamId')
  async _computeIsMembershipMulti() {
    const multiEnabled = await (await this.env.items('ir.config.parameter').sudo()).getParam('sales_team.membershipMulti', false);
    await this.set('isMembershipMulti', multiEnabled);
  }

  /**
   * Display a warning message to warn user they are about to archive
      other memberships. Only valid in mono-membership mode and take into
      account only active memberships as we may keep several archived
      memberships.
   * @returns 
   */
  @api.depends('isMembershipMulti', 'active', 'userId', 'crmTeamId')
  async _computeMemberWarning() {
    if (await this.all(m => m.isMembershipMulti)) {
      await this.set('memberWarning', false);
    }
    else {
      const active = await this.filtered('active');
      await this.sub(active).set('memberWarning', false);
      if (bool(active)) {
        return;
      }
      const existing = await this.env.items('crm.team.member').search([['userId', 'in', (await active.userId).ids]]);
      const userMapping = new Map<ModelRecords, ModelRecords>();
      for (const userId of await existing.userId) {
        userMapping.set(userId, this.env.items('crm.team'));
      }
      for (const membership of existing) {
        const userId = await membership.userId;
        userMapping.set(userId, userMapping.get(userId).or(await membership.crmTeamId));
      }
      for (const member of active) {
        let teams = userMapping.get(await member.userId);
        teams = bool(teams) ? teams : this.env.items('crm.team');
        const remaining = teams.sub((await member.crmTeamId).or(await member._origin.crmTeamId));
        if (remaining.ok) {
          await member.set('memberWarning', _f(await this._t("Adding {userName} in this team would remove him/her from its current teams {teamNames}."), { userName: await (await member.userId).label, teamNames: (await remaining.mapped('label')).join(', ') }));
        }
        else {
          await member.set('memberWarning', false);
        }
      }
    }
  }

  /**
   * Specific behavior implemented on create

    * mono membership mode: other user memberships are automatically
      archived (a warning already told it in form view);
    * creating a membership already existing as archived: do nothing as
      people can manage them from specific menu "Members";
   * @param valuesList 
   * @returns 
   */
  @api.modelCreateMulti()
  async create(valuesList) {
    const isMembershipMulti = await (await this.env.items('ir.config.parameter').sudo()).getParam('sales_team.membershipMulti', false);
    if (!isMembershipMulti) {
      await this._synchronizeMemberships(valuesList);
    }
    return _super(CrmTeamMember, this).create(valuesList);
  }

  /**
   * Specific behavior about active. If you change userId / teamId user
      get warnings in form view and a raise in constraint check. We support
      archive / activation of memberships that toggles other memberships. But
      we do not support manual creation or update of userId / teamId. This
      either works, either crashes). Indeed supporting it would lead to complex
      code with low added value. Users should create or remove members, and
      maybe archive / activate them. Updating manually memberships by
      modifying userId or teamId is advanced and does not benefit from our
      support.
   * @param values 
   * @returns 
   */
  async write(values) {
    const isMembershipMulti = await (await this.env.items('ir.config.parameter').sudo()).getParam('sales_team.membershipMulti', false);
    if (!isMembershipMulti && values['active']) {
      const memberShips = [];
      for (const membership of this) {
        memberShips.push({ userId: (await membership.userId).id, crmTeamId: (await membership.crmTeamId).id });
      }
      await this._synchronizeMemberships(memberShips);
    }
    return _super(CrmTeamMember, this).write(values);
  }

  /**
   * Synchronize memberships: archive other memberships.

    :param userTeamIds: list of pairs (userId, crmTeamId)
   * @param userTeamIds 
   * @returns 
   */
  async _synchronizeMemberships(userTeamIds) {
    const existing = await this.search([
      ['active', '=', true],  // explicit search on active only, whatever context
      ['userId', 'in', userTeamIds.map(values => values['userId'])]
    ]);
    const userMemberships = {}
    for (const id of (await existing.userId).ids) {
      userMemberships[id] = this.env.items('crm.team.member');
    }
    // dict.fromkeys(existing.userId.ids, this.env.items('crm.team.member'))
    for (const membership of existing) {
      const id = (await membership.userId).id;
      userMemberships[id] = userMemberships[id].add(membership);
    }

    let existingToArchive = this.env.items('crm.team.member');
    for (const values of userTeamIds) {
      let userId = userMemberships[values['userId']];
      userId = bool(userId) ? userId : this.env.items('crm.team.member');
      existingToArchive = existingToArchive.add(userId).filtered(
        async (m) => (await m.crmTeamId).id != values['crmTeamId']
      )
    }

    if (existingToArchive.ok) {
      await existingToArchive.actionArchive();
    }
    return existingToArchive;
  }
}