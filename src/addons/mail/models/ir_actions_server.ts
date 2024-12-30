import { api } from "../../../core"
import { hasattr } from "../../../core/api/func"
import { Fields, _Date } from "../../../core/fields"
import { Dict } from "../../../core/helper/collections"
import { UserError, ValidationError } from "../../../core/helper/errors"
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool"
import { isList } from "../../../core/tools/iterable"

/**
 * Add email option in server actions.
 */
@MetaModel.define()
class ServerActions extends Model {
  static _module = module;
  static _name = 'ir.actions.server';
  static _description = 'Server Action';
  static _parents = ['ir.actions.server'];

  static state = Fields.Selection({selectionAdd: [
    ['email', 'Send Email'],
    ['followers', 'Add Followers'],
    ['nextActivity', 'Create Next Activity'],
  ], ondelete: {'email': 'CASCADE', 'followers': 'CASCADE', 'nextActivity': 'CASCADE'}});
  // Followers
  static partnerIds = Fields.Many2many('res.partner', {string: 'Add Followers'});
  // Template
  static templateId = Fields.Many2one(
    'mail.template', {string: 'Email Template', ondelete: 'SET NULL',
    domain: "[['modelId', '=', modelId]]"},
  );
  // Next Activity
  static activityTypeId = Fields.Many2one(
      'mail.activity.type', {string: 'Activity',
      domain: "['|', ['resModel', '=', false], ['resModel', '=', modelName]]",
      ondelete: 'RESTRICT'});
  static activitySummary = Fields.Char('Summary');
  static activityNote = Fields.Html('Note');
  static activityDateDeadlineRange = Fields.Integer({string: 'Due Date In'});
  static activityDateDeadlineRangeType = Fields.Selection([
    ['days', 'Days'],
    ['weeks', 'Weeks'],
    ['months', 'Months'],
  ], {string: 'Due type', default: 'days'});
  static activityUserType = Fields.Selection([
    ['specific', 'Specific User'],
    ['generic', 'Generic User From Record']], {default: "specific",
    help: "Use 'Specific User' to always assign the same user on the next activity. Use 'Generic User From Record' to specify the field name of the user to choose on the record."});
  static activityUserId = Fields.Many2one('res.users', {string: 'Responsible'});
  static activityUserFieldName = Fields.Char('User field name', {help: "Technical name of the user on the record", default: "userId"});

  @api.onchange('activityDateDeadlineRange')
  async _onchangeActivityDateDeadlineRange() {
    if (await (this as any).activityDateDeadlineRange < 0) {
      throw new UserError(await this._t("The 'Due Date In' value can't be negative."));
    }
  }

  @api.constrains('state', 'modelId')
  async _checkMailThread() {
    for (const action of this) {
      if (await action.state === 'followers' && ! await (await action.modelId).isMailThread) {
        throw new ValidationError(await this._t("Add Followers can only be done on a mail thread model"));
      }
    }
  }

  @api.constrains('state', 'modelId')
  async _checkActivityMixin() {
    for (const action of this) {
      if (await action.state === 'nextActivity' && ! await (await action.modelId).isMailThread) {
        throw new ValidationError(await this._t("A next activity can only be planned on models that use the chatter"));
      }
    }
  }

  async _runActionFollowersMulti(evalContext: any) {
    const model = this.env.items(await (this as any).modelName);
    const partnerIds = await this['partnerIds'];
    if (partnerIds.ok && hasattr(model, 'messageSubscribe')) {
      const records = model.browse(this._context['activeIds'] ?? this._context['activeId']);
      await records.messageSubscribe(partnerIds.ids);
    }
    return false;
  }

  /**
   * When an activity is set on update of a record,
    update might be triggered many times by recomputes.
    When need to know it to skip these steps.
    Except if the computed field is supposed to trigger the action
   * @returns 
   */
  async _isRecompute() {
    const records = this.env.items(await (this as any).modelName).browse(
        this._context['activeIds'] ?? this._context['activeId']);
    const oldValues = this._context['oldValues'];
    if (oldValues) {
        const domainPost = this._context['domainPost'];
        const trackedFields = [];
        if (domainPost) {
          for (const leaf of domainPost) {
            if (isList(leaf)) {
              trackedFields.push(leaf[0]);
            }
          }
        }
        const fieldsToCheck = []
        for (const [record, fieldNames] of Object.entries<any>(oldValues)) {
          for (const field of fieldNames) {
            if (! trackedFields.includes(field)) {
              fieldsToCheck.push(field);
            }
          }
        }
        if (fieldsToCheck) {
          const field = records._fields[fieldsToCheck[0]];
          // Pick an arbitrary field; if it is marked to be recomputed,
          // it means we are in an extraneous write triggered by the recompute.
          // In this case, we should not create a new activity.
          if (records.and(this.env.recordsToCompute(field)).ok) {
            return true;
          }
        }
    }
    return false;
  }

  async _runActionEmail(evalContext: any) {
    const templateId = await (this as any).templateId;
    // TDE CLEANME: when going to new api with server action, remove action
    if (! bool(templateId) || ! this._context['activeId'] || await this._isRecompute()) {
      return false;
    }
    // Clean context from default_type to avoid making attachment
    // with wrong values in subsequent operations
    const cleanedCtx = Dict.from(this.env.context);
    cleanedCtx.pop('default_type', null);
    cleanedCtx.pop('default_parentId', null);
    await (await templateId.withContext(cleanedCtx)).sendMail(this._context['activeId'], false, false);
    return false;
  }

  async _runActionNextActivity(evalContext: any) {
    const self: any = this;
    if (! await self.activityTypeId || ! self._context['activeId'] || await self._isRecompute()) {
      return false;
    }

    const records = self.env.items(await self.modelName).browse(self._context['activeIds'] ?? self._context['activeId']);

    const vals = {
      'summary': await self.activitySummary || '',
      'note': await self.activityNote || '',
      'activityTypeId': (await self.activityTypeId).id,
    }
    if (await self.activityDateDeadlineRange > 0) {
      vals['dateDeadline'] = (await _Date.contextToday(self)) //+ relativedelta(**{self.activityDateDeadlineRangeType: self.activityDateDeadlineRange})
    }
    for (const record of records) {
      let user;
      if (await self.activityUserType === 'specific') {
        user = await self.activityUserId;
      }
      else if (await self.activityUserType === 'generic' && self.activityUserFieldName in record._fields) {
        user = await record[self.activityUserFieldName];
      }
      if (user) {
        vals['userId'] = user.id
      }
      await record.activitySchedule(vals);
    }
    return false;
  }

  /**
   * Override the method giving the evaluation context but also the
    context used in all subsequent calls. Add the mail_notify_force_send
    key set to false in the context. This way all notification emails linked
    to the currently executed action will be set in the queue instead of
    sent directly. This will avoid possible break in transactions.
   * @param action 
   * @returns 
   */
  @api.model()
  async _getEvalContext(action: any) {
    const evalContext = await _super(ServerActions, this)._getEvalContext(action);
    const ctx = Dict.from(evalContext['env'].context);
    ctx['mailNotifyForceSend'] = false;
    evalContext['env'].context = ctx;
    return evalContext;
  }
}