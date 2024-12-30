import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"
import { f } from "../../../core/tools/utils"

/**
 * Activity Types are used to categorize activities. Each type is a different
    kind of activity e.g. call, mail, meeting. An activity can be generic i.e.
    available for all models using activities; or specific to a model in which
    case resModel field should be used.
 */
@MetaModel.define()
class MailActivityType extends Model {
  static _module = module;
  static _name = 'mail.activity.type'
  static _description = 'Activity Type'
  static _recName = 'label'
  static _order = 'sequence, id'

  async _getModelSelection() {
    const res = [];
    for (const model of await (await this.env.items('ir.model').sudo()).search(
      ['&', ['isMailThread', '=', true], ['transient', '=', false]])) {
        res.push(await model('model', 'label'));
    }
    return res;
  }

  static label = Fields.Char('Name', {required: true, translate: true});
  static summary = Fields.Char('Default Summary', {translate: true});
  static sequence = Fields.Integer('Sequence', {default: 10});
  static active = Fields.Boolean({default: true});
  static createdUid = Fields.Many2one('res.users', {index: true});
  static delayCount = Fields.Integer(
      'Schedule', {default: 0,
      help: 'Number of days/week/month before executing the action. It allows to plan the action deadline.'});
  static delayUnit = Fields.Selection([
    ['days', 'days'],
    ['weeks', 'weeks'],
    ['months', 'months']], {string: "Delay units", help: "Unit of delay", required: true, default: 'days'});
  static delayLabel = Fields.Char({compute: '_computeDelayLabel'});
  static delayFrom = Fields.Selection([
    ['currentDate', 'after completion date'],
    ['previousActivity', 'after previous activity deadline']], {string: "Delay Type", help: "Type of delay", required: true, default: 'previousActivity'});
  static icon = Fields.Char('Icon', {help: "Font awesome icon e.g. fa-tasks"});
  static decorationType = Fields.Selection([
    ['warning', 'Alert'],
    ['danger', 'Error']], {string: "Decoration Type",
    help: "Change the background color of the related activities of this type."});
  static resModel = Fields.Selection('_getModelSelection', {string: "Model", help: 'Specify a model if the activity should be specific to a model and not available when managing activities for other models.'});
  static triggeredNextTypeId = Fields.Many2one(
    'mail.activity.type', {string: 'Trigger', compute: '_computeTriggeredNextTypeId',
    inverse: '_inverseTriggeredNextTypeId', store: true, readonly: false, domain: "['|', ['resModel', '=', false], ['resModel', '=', resModel]]", ondelete: 'RESTRICT', help: "Automatically schedule this activity once the current one is marked as done."});
  static chainingType = Fields.Selection([
    ['suggest', 'Suggest Next Activity'], ['trigger', 'Trigger Next Activity']
  ], {string: "Chaining Type", required: true, default: "suggest"});
  static suggestedNextTypeIds = Fields.Many2many(
    'mail.activity.type', {relation: 'mailActivityRel', column1: 'activityId', column2: 'recommendedId', string: 'Suggest', domain: "['|', ['resModel', '=', false], ['resModel', '=', resModel]]", compute: '_computeSuggestedNextTypeIds', inverse: '_inverseSuggestedNextTypeIds', store: true, readonly: false,
    help: "Suggest these activities once the current one is marked as done."});
  static previousTypeIds = Fields.Many2many(
    'mail.activity.type', {relation: 'mailActivityRel', column1:  'recommendedId', column2: 'activityId', domain: "['|', ['resModel', '=', false], ['resModel', '=', resModel]]", string: 'Preceding Activities'});
  static category = Fields.Selection([
    ['default', 'None'],
    ['uploadFile', 'Upload Document'],
    ['phonecall', 'Phonecall']
  ], {default: 'default', string: 'Action', help: 'Actions may trigger specific behavior like opening calendar view or automatically mark as done when a document is uploaded'});
  static mailTemplateIds = Fields.Many2many('mail.template', {string: 'Email templates'});
  static defaultUserId = Fields.Many2one("res.users", {string: "Default User"});
  static defaultNote = Fields.Html({string: "Default Note", translate: true});

  //Fields for display purpose only
  static initialResModel = Fields.Selection('_getModelSelection', {string: 'Initial model', compute: "_computeInitialResModel", store: false, help: 'Technical field to keep track of the model at the start of editing to support UX related behaviour'});
  static resModelChange = Fields.Boolean({string: "Model has change", help: "Technical field for UX related behaviour", default: false, store: false});

  @api.onchange('resModel')
  async _onchangeResModel() {
    const [resModel, initialResModel] = await this('resModel', 'initialResModel');
    // await Promise.all([
      await this.set('mailTemplateIds', await (await (await this.sudo()).mailTemplateIds).filtered(async (template) => await (await template.modelId).model === resModel)),
      await this.set('resModelChange', initialResModel && initialResModel !== resModel)
    // ]);
  }

  async _computeInitialResModel() {
    for (const activityType of this) {
      await activityType.set('initialResModel', await activityType.resModel);
    }
  }

  @api.depends('delayUnit', 'delayCount')
  async _computeDelayLabel() {
    const selectionDescriptionValues = Object.fromEntries(await this._fields['delayUnit']._descriptionSelection(this._fields['delayUnit'], this.env));//.map(e => [e[0], e[1]]))
    for (const activityType of this) {
      const unit = selectionDescriptionValues[await activityType.delayUnit];
      await activityType.set('delayLabel', f('%s %s', await activityType.delayCount, unit))
    }
  }

  /**
   * suggested_next_type_ids and triggered_next_type_id should be mutually exclusive
   */
  @api.depends('chainingType')
  async _computeSuggestedNextTypeIds() {
    for (const activityType of this) {
      if (await activityType.chainingType === 'trigger') {
        await activityType.set('suggestedNextTypeIds', false);
      }
    }
  }

  async _inverseSuggestedNextTypeIds() {
    for (const activityType of this) {
      if (await activityType.suggestedNextTypeIds) {
        await activityType.set('chainingType', 'suggest');
      }
    }
  }

  /**
   * suggested_next_type_ids and triggered_next_type_id should be mutually exclusive
   */
  @api.depends('chainingType')
  async _computeTriggeredNextTypeId() {
    for (const activityType of this) {
      if (await activityType.chainingType === 'suggest') {
        await activityType.set('triggeredNextTypeId', false);
      }
    }
  }

  async _inverseTriggeredNextTypeId() {
    for (const activityType of this) {
      if (await activityType.triggeredNextTypeId) {
        await activityType.set('chainingType', 'trigger');
      }
      else {
        await activityType.set('chainingType', 'suggest');
      }
    }
  }
}