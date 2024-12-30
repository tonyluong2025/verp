import { DateTime } from "luxon";
import { api, tools } from "../../..";
import { Fields } from "../../../fields";
import { UserError } from "../../../helper/errors";
import { MetaModel, Model, _super } from "../../../models";
import { safeEval } from "../../../tools/save_eval";
import { _f } from "../../../tools/utils";

@MetaModel.define()
class IrFilters extends Model {
  static _module = module;
  static _name = 'ir.filters';
  static _description = 'Filters';
  static _order = 'modelId, label, id desc';

  static label = Fields.Char({ string: 'Filter Name', translate: true, required: true });
  static userId = Fields.Many2one('res.users', { string: 'User', ondelete: 'CASCADE', help: "The user this filter is private to. When left empty the filter is public and available to all users." });
  static domain = Fields.Text({ default: '[]', required: true });
  static context = Fields.Text({ default: '{}', required: true });
  static sort = Fields.Text({ default: '[]', required: true });
  static modelId = Fields.Selection('_listAllModels', { string: 'Model', required: true });
  static isDefault = Fields.Boolean({ string: 'Default Filter' });
  static actionId = Fields.Many2one('ir.actions.actions', { string: 'Action', ondelete: 'CASCADE', help: "The menu action this filter applies to. When left empty the filter applies to all menus for this model." });
  static active = Fields.Boolean({ default: true });

  static _sqlConstraints = [
    // Partial constraint, complemented by unique index (see below). Still
    // useful to keep because it provides a proper error message when a
    // violation occurs, as it shares the same prefix as the unique index.
    ['label_model_uid_unique', 'unique (label, "modelId", "userId", "actionId")', 'Filter names must be unique'],
  ]

  async _autoInit() {
    await _super(IrFilters, this)._autoInit();
    // Use unique index to implement unique constraint on the lowercase name (not possible using a constraint)
    await tools.createUniqueIndex(this._cr, 'irFiltersLabelModelUid_unique_action_index', this.cls._table, [`lower("label")`, '"modelId"', `COALESCE("userId",-1)`, `COALESCE("actionId",-1)`]);
  }

  @api.model()
  async _listAllModels() {
    const res = await this._cr.execute('SELECT "model", "label" FROM "irModel" ORDER BY "label"');
    return res.map(e => [e['model'], e['label']]);
  }

  async copy(defaultValue?: any) {
    this.ensureOne();
    defaultValue = Object.assign({}, defaultValue, { label: await this._t('%s (copy)', this.cls.name) });
    return _super(IrFilters, this).copy(defaultValue);
  }

  async _getEvalDomain() {
    this.ensureOne();
    return safeEval(await this['domain'], {
      'DateTime': DateTime,
      'contextToday': () => new Date(),
    })
  }

  /**
   * Return a domain component for matching filters that are visible in the
          same context (menu/view) as the given action.
   * @param actionId 
   * @returns 
   */
  @api.model()
  _getActionDomain(actionId?: number): any[][] {
    if (actionId) {
      // filters specific to this menu + global ones
      return [['actionId', 'in', [actionId, false]]];
    }
    // only global ones
    return [['actionId', '=', false]];
  }

  /**
   * Obtain the list of filters available for the user on the given model.

    @param actionId optional ID of action to restrict filters to this action
        plus global filters. If missing only global filters are returned.
        The action does not have to correspond to the model, it may only be
        a contextual action.
    @returns list of method `~osv.read`-like dicts containing the
        ``label``, ``isDefault``, ``domain``, ``userId`` (m2o tuple),
        ``actionId`` (m2o tuple) and ``context`` of the matching ``ir.filters``.
   */
  @api.model()
  async getFilters(model, actionId?: number) {
    // available filters: private filters (userId=uid) and public filters (uid=NULL),
    // and filters for the action (actionId=actionId) or global (actionId=NULL)
    const actionDomain = this._getActionDomain(actionId);
    const filters = await this.search(actionDomain.concat([['modelId', '=', model], ['userId', 'in', [this._uid, false]]]));
    const userContext = await this.env.items('res.users').contextGet();
    return (await filters.withContext(userContext)).read(['label', 'isDefault', 'domain', 'context', 'userId', 'sort']);
  }

  /**
   * _checkGlobalDefault(dict, dict[], dict) -> null

      Checks if there is a global default for the modelId requested.

      If there is, and the default is different than the record being written
      (-> we're not updating the current global default), raise an error
      to avoid users unknowingly overwriting existing global defaults (they
      have to explicitly remove the current default before setting a new one)

      This method should only be called if ``vals`` is trying to set
      ``isDefault``

      @thows verp.exceptions.UserError if there is an existing default and we're not updating it
   */
  @api.model()
  async _checkGlobalDefault(vals, matchingFilters) {
    const domain = this._getActionDomain(vals['actionId']);
    const defaults = await this.search(domain.concat([
      ['modelId', '=', vals['modelId']],
      ['userId', '=', false],
      ['isDefault', '=', true],
    ]));

    if (!defaults.ok) {
      return;
    }
    if (matchingFilters && (matchingFilters[0]['id'] == defaults.id)) {
      return;
    }

    throw new UserError(_f(await this._t("There is already a shared filter set as default for {model}, delete or change it before setting a new default"), { 'model': vals['modelId'] }));
  }

  @api.model()
  @api.returns('self', (value) => value.id)
  async createOrReplace(vals) {
    const actionId = vals['actionId'];
    const currentFilters = await this.getFilters(vals['modelId'], actionId);
    const matchingFilters = [];
    for (const f of currentFilters) {
      if ((await f('label')).toLowerCase() === vals['label'].toLowerCase()) {
        // next line looks for matching userIds (specific or global), i.e.
        // f.userId is false and vals.userId is false or missing,
        // or f.userId.id == vals.userId
        const [userId] = await f('userId');
        if (userId && userId[0].rq(vals['userId'])) {
          matchingFilters.push(f);
        }
      }
    }

    if (vals['isDefault']) {
      if (vals['userId']) {
        // Setting new default: any other default that belongs to the user
        // should be turned off
        const domain = this._getActionDomain(actionId);
        const defaults = await this.search(domain.concat([
          ['modelId', '=', vals['modelId']],
          ['userId', '=', vals['userId']],
          ['isDefault', '=', true],
        ]));
        if (defaults.ok) {
          await defaults.write({ 'isDefault': false });
        }
      }
      else {
        await this._checkGlobalDefault(vals, matchingFilters);
      }
    }
    // When a filter exists for the same (label, model, user) triple, we simply
    // replace its definition (considering actionId irrelevant here)
    if (matchingFilters.length) {
      const matchingFilter = this.browse(matchingFilters[0]['id']);
      await matchingFilter.write(vals);
      return matchingFilter;
    }
    return this.create(vals);
  }
}
