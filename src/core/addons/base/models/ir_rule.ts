import { DateTime } from "luxon";
import { Fields, api, tools } from "../../..";
import { MetaModel, Model, _super } from "../../../models";
import { expression } from "../../../osv";
import { bool } from '../../../tools/bool';
import { len } from "../../../tools/iterable";
import { unsafeAsync } from "../../../tools/save_eval";
import { UpCamelCase, _f, f } from '../../../tools/utils';
import { AccessError, ValidationError, ValueError } from './../../../helper/errors';
import { ModelRecords } from './../../../models';

@MetaModel.define()
class IrRule extends Model {
  static _module = module;
  static _name = 'ir.rule';
  static _description = 'Record Rule';
  static _order = 'modelId desc,id';
  _MODES = ['read', 'write', 'create', 'unlink'];

  static label = Fields.Char({ index: true });
  static active = Fields.Boolean({ default: true, help: "If you uncheck the active field, it will disable the record rule without deleting it (if you delete a native record rule, it may be re-created when you reload the module)." });
  static modelId = Fields.Many2one('ir.model', { string: 'Model', index: true, required: true, ondelete: "CASCADE" });
  static groups = Fields.Many2many('res.groups', { relation: 'ruleGroupRel', column1: 'ruleGroupId', column2: 'groupId', ondelete: 'RESTRICT' });
  static domainForce = Fields.Text({ string: 'Domain' });
  static permRead = Fields.Boolean({ string: 'Apply for Read', default: true });
  static permWrite = Fields.Boolean({ string: 'Apply for Write', default: true });
  static permCreate = Fields.Boolean({ string: 'Apply for Create', default: true });
  static permUnlink = Fields.Boolean({ string: 'Apply for Delete', default: true });
  static global = Fields.Boolean({ compute: '_computeGlobal', store: true, help: "If no group is specified the rule is global and applied to everyone" });

  static _sqlConstraints = [
    ['noAccessRights',
      'CHECK ("permRead"!=false or "permWrite"!=false or "permCreate"!=false or "permUnlink"!=false)',
      'Rule must have at least one checked access right !'],
  ]

  @api.model()
  async _evalContext() {
    const result = {
      'user': await (await this.env.user()).withContext({}),
      'time': DateTime,
      'companyIds': (await this.env.companies()).ids,
      'companyId': (await this.env.company()).id,
    }
    return result;
  }

  @api.depends('groups')
  async _computeGlobal() {
    for (const rule of this) {
      rule['global'] = !bool(await rule.groups);
    }
  }

  @api.constrains('modelId')
  async _checkModelName() {
    // Don't allow rules on rules records (this model).
    if (await this.some(async (rule) => await (await rule.modelId).model == this._name)) {
      throw new ValidationError(await this._t('Rules can not be applied on the Record Rules model.'));
    }
  }

  /**
   * Return the list of context keys to use for caching ``_computeDomain``.
   * @returns 
   */
  _computeDomainKeys() {
    return ['allowedCompanyIds'];
  }

  /**
   * Returns the rules for the mode for the current user which fail on
        the specified records.

        Can return any global rule and/or all local rules (since local rules are OR-ed together, the entire group succeeds or fails, while global rules get AND-ed and can each fail)
   * @param forRecords 
   * @param mode 
   * @returns 
   */
  async _getFailing(forRecords, mode = 'read') {
    const Model = await forRecords.browse([]).sudo();
    const evalContext = await this._evalContext();

    const allRules = await (await this._getRules(Model._name, mode)).sudo();

    // first check if the group rules fail for any record (aka if
    // searching on (records, group_rules) filters out some of the records)
    let groupRules = await allRules.filtered(async (r) => {
      const groups = await r.groups;
      return groups.ok && groups.and(await (await this.env.user()).groupsId).ok;
    });
    const groupDomains = expression.OR(await groupRules.map(async (r) => {
      const domainForce = await r.domainForce;
      return domainForce ? await unsafeAsync(domainForce, evalContext) : []
    }));
    // if all records get returned, the group rules are not failing
    if (await Model.searchCount(expression.AND([[['id', 'in', forRecords.ids]], groupDomains])) == len(forRecords)) {
      groupRules = this.browse([]);
    }

    // failing rules are previously selected group rules or any failing global rule
    async function isFailing(r, ids: number[] = forRecords.ids) {
      const domainForce = await r.domainForce;
      const domain = domainForce ? await unsafeAsync(domainForce, evalContext) : [];
      return Model.searchCount(expression.AND([
        [['id', 'in', ids]],
        expression.normalizeDomain(domain)
      ])) < len(ids);
    }

    return (await allRules.filtered(async (r) => groupRules.includes(r) || (!bool(await r.groups) && await isFailing(r)))).withUser(await this.env.user());
  }

  private async _getRules(modelName: any, mode = 'read'): Promise<ModelRecords> {
    if (!this._MODES.includes(mode)) {
      throw new ValueError('Invalid mode: %s', mode);
    }
    if (this.env.su) {
      return this.browse([]);
    }
    const query = `SELECT r.id FROM "irRule" r JOIN "irModel" m ON (r."modelId"=m.id)
      WHERE m.model=$1 AND r.active AND r."perm${UpCamelCase(mode)}"
      AND (r.id IN (SELECT "ruleGroupId" FROM "ruleGroupRel" rg
                    JOIN "resGroupsUsersRel" gu ON (rg."groupId"=gu.gid)
                    WHERE gu.uid=$2)
          OR r.global)
      ORDER BY r.id
    `;
    const res = await this._cr.execute(query, { bind: [modelName, this._uid] });
    return this.browse(res.map(row => row['id']));
  }

  @api.model()
  @tools.conditional(
    !(tools.config.get('devMode').includes('xml')),
    tools.ormcache('self.env.uid', 'self.env.su', 'modelName', 'mode', 'Array.from(await self._computeDomainContextValues())'),
  )
  async _computeDomain(modelName, mode = 'read') {
    let rules: any = await this._getRules(modelName, mode);
    if (!rules.ok) {
      return;
    }

    // browse user and rules as SUPERUSER_ID to avoid access errors!
    const evalContext = await this._evalContext();
    const userGroups = await (await this.env.user()).groupsId;
    const globalDomains = [];                     // list of domains
    const groupDomains = [];                      // list of domains
    rules = await rules.sudo();
    for (const rule of rules) {
      // evaluate the domain for the current user
      const domain = await rule.domainForce;
      let evalDomain = domain ? await unsafeAsync(domain, evalContext) : []; // Tony must check and change to safeAsync
      evalDomain = expression.normalizeDomain(evalDomain);
      if (!bool(await rule.groups)) {
        globalDomains.push(evalDomain);
      }
      else if (bool(await rule.groups) && bool(userGroups)) {
        groupDomains.push(evalDomain);
      }
    }
    // # combine global domains and group domains
    if (!groupDomains.length) {
      return expression.AND(globalDomains);
    }
    return expression.AND(globalDomains.concat([expression.OR(groupDomains)]));
  }

  async* _computeDomainContextValues() {
    for (const k of this._computeDomainKeys()) {
      let v = this._context[k];
      if (Array.isArray(v)) {
        // currently this could be a frozenset (to avoid depending on the order of allowedCompanyIds) but it seems safer if possibly slightly more miss-y to use a tuple
        v = Array.from(v);
      }
      yield v;
    }
  }

  @api.model()
  async domainGet(modelName, mode = 'read') {
    // this method is now unsafe, since it returns a list of tables which  does not contain the joins present in the generated Query object
    console.warn(
      "Unsafe and deprecated IrRule.domainGet(), use IrRule._computeDomain() and expression().query instead",
    );
    const domain = await this._computeDomain(modelName, mode);
    if (domain) {
      // _whereCalc is called as superuser. This means that rules can involve objects on which the real uid has no acces rights.
      // This means also there is no implicit restriction (e.g. an object  references another object the user can't see).
      const query = await (await this.env.items(modelName).sudo())._whereCalc(domain, false);
      return [query.whereClause, query.whereClauseParams, query.tables];
    }
    return [[], [], [f('"%s"', this.env.models[modelName]._table)]];
  }

  async unlink() {
    const res = await _super(IrRule, this).unlink();
    this.clearCaches();
    return res;
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const res = await _super(IrRule, this).create(valsList);
    await this.flush();
    this.clearCaches();
    return res;
  }

  async write(vals) {
    const res = await _super(IrRule, this).write(vals);
    // - verp/addons/test_access_rights/tests/test_feedback.js
    // - verp/addons/test_access_rights/tests/test_ir_rules.js
    // - verp/addons/base/tests/test_orm.js (/home/dle/src/verp/master-nochange-fp/verp/addons/base/tests/test_orm.js)
    await this.flush();
    this.clearCaches();
    return res;
  }

  async _makeAccessError(operation, records) {
    console.info('Access Denied by record rules for operation: %s on record ids: [%s], uid: %s, model: %s', operation, String(records.ids.slice(0, 6)), this._uid, records._name);
    const self = await this.withContext(await (await this.env.user()).contextGet());

    const model = records._name;
    const description = await (await self.env.items('ir.model')._get(model)).label || model;
    const msgHeads = {
      // Messages are declared in extenso so they are properly exported in translation terms
      'read': _f(await this._t("Due to security restrictions, you are not allowed to access '{documentKind}' ({documentModel}) records."), { documentKind: description, documentModel: model }),
      'write': _f(await this._t("Due to security restrictions, you are not allowed to modify '{documentKind}' ({documentModel}) records."), { documentKind: description, documentModel: model }),
      'create': _f(await this._t("Due to security restrictions, you are not allowed to create '{documentKind}' ({documentModel}) records."), { documentKind: description, documentModel: model }),
      'unlink': _f(await this._t("Due to security restrictions, you are not allowed to delete '{documentKind}' ({documentModel}) records."), { documentKind: description, documentModel: model })
    }
    const operationError = msgHeads[operation];
    const resolutionInfo = await this._t("Contact your administrator to request access if necessary.");

    if (! await self.userHasGroups('base.groupNoOne') || ! await (await self.env.user()).hasGroup('base.groupUser')) {
      const msg = _f(`{operationError}
{resolutionInfo}`,
        {
          operationError: operationError,
          resolutionInfo: resolutionInfo
        });
      return new AccessError(msg);
    }
    // This extended AccessError is only displayed in debug mode.
    // Note that by default, public and portal users do not have
    // the group "base.groupNoOne", even if debug mode is enabled,
    // so it is relatively safe here to include the list of rules and record names.
    const rules = await (await self._getFailing(records, operation)).sudo();

    const recordsDescription = (await (await records([0, 6]).sudo()).map(async (rec) => f('%s (id=%s)', await rec.displayName, rec.id))).join(', ');
    const failingRecords = await this._t("Records: %s", recordsDescription);

    const userDescription = f('%s (id=%s)', await (await self.env.user()).label, (await self.env.user()).id);
    const failingUser = await this._t("User: %s", userDescription);

    const rulesDescription = (await rules.map(async (rule) => f('- %s', await rule.label))).join('\n');
    let failingRules = await this._t("This restriction is due to the following rules:\n%s", rulesDescription);
    if (await rules.some(async (r) => (await r.domainForce || []).includes('companyId'))) {
      failingRules += "\n\n" + await this._t('Note: this might be a multi-company issue.');
    }
    const msg = _f(`${operationError}

{failingRecords}
{failingUser}

{failingRules}

{resolutionInfo}`, {
      operationError: operationError,
      failingRecords: failingRecords,
      failingUser: failingUser,
      failingRules: failingRules,
      resolutionInfo: resolutionInfo
    });

    // clean up the cache of records prefetched with displayName above
    for (const record of records([0, 6])) {
      record._cache.clear();
    }

    return new AccessError(msg);
  }
}