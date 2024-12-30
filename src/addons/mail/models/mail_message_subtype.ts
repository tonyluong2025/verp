import { api, tools } from "../../../core"
import { Fields } from "../../../core/fields"
import { Dict } from "../../../core/helper/collections"
import { MetaModel, Model, _super } from "../../../core/models"
import { extend } from "../../../core/tools/iterable"

/**
 * Class holding subtype definition for messages. Subtypes allow to tune the follower subscription, allowing only some subtypes to be pushed on the Wall.
 */
@MetaModel.define()
class MailMessageSubtype extends Model {
  static _module = module;
  static _name = 'mail.message.subtype'
  static _description = 'Message subtypes'
  static _order = 'sequence, id'

  static label = Fields.Char(
    'Message Type', {required: true, translate: true,
    help: 'Message subtype gives a more precise type on the message, especially for system notifications. For example, it can be a notification related to a new record (New), or to a stage change in a process (Stage change). Message subtypes allow to precisely tune the notifications the user want to receive on its wall.'});
  static description = Fields.Text(
    'Description', {translate: true,
    help: 'Description that will be added in the message posted for this subtype. If void, the name will be added instead.'})
  static internal = Fields.Boolean(
    'Internal Only',
    {help: 'Messages with internal subtypes will be visible only by employees, aka members of base_user group'});
  static parentId = Fields.Many2one(
    'mail.message.subtype', {string: 'Parent', ondelete: 'SET NULL',
    help: 'Parent subtype, used for automatic subscription. This field is not correctly named. For example on a project, the parentId of project subtypes refers to task-related subtypes.'});
  static relationField = Fields.Char(
    'Relation field',
    {help: 'Field used to link the related model to the subtype model when using automatic subscription on a related document. The field is used to compute getattr(related_document.relationField).'})
  static resModel = Fields.Char('Model', {help: "Model the subtype applies to. If false, this subtype applies to all models."})
  static default = Fields.Boolean('Default', {default: true, help: "Activated by default when subscribing."})
  static sequence = Fields.Integer('Sequence', {default: 1, help: "Used to order subtypes."})
  static hidden = Fields.Boolean('Hidden', {help: "Hide the subtype in the follower options"})

  @api.modelCreateMulti()
  async create(valsList) {
    this.clearCaches();
    return _super(MailMessageSubtype, this).create(valsList);
  }

  async write(vals) {
    this.clearCaches()
    return _super(MailMessageSubtype, this).write(vals);
  }

  async unlink() {
    this.clearCaches();
    return _super(MailMessageSubtype, this).unlink();
  }

  /**
   * Return data related to auto subscription based on subtype matching.
    Here modelName indicates child model (like a task) on which we want to
    make subtype matching based on its parents (like a project).

    Example with tasks and project :

      * generic: discussion, resModel = false
      * task: new, resModel = project.task
      * project: task_new, parentId = new, resModel = project.project, field = project_id

    Returned data

      * child_ids: all subtypes that are generic or related to task (resModel = false or modelName)
      * def_ids: default subtypes ids (either generic or task specific)
      * all_int_ids: all internal-only subtypes ids (generic or task or project)
      * parent: dict(parent subtype id, child subtype id), i.e. {task_new.id: new.id}
      * relation: dict(parent_model, relation_fields), i.e. {'project.project': ['project_id']}
   * @param modelName 
   * @returns 
   */
  @tools.ormcache('modelName')
  async _getAutoSubscriptionSubtypes(modelName) {
    const childIds = [];
    const defIds = [];
    const allIntIds = [];
    const parent = new Dict<any>();
    const relation = new Dict<any>();
    const subtypes = await (await this.sudo()).search([
      '|', '|', ['resModel', '=', false],
      ['resModel', '=', modelName],
      ['parentId.resModel', '=', modelName]
    ]);
    for (const subtype of subtypes) {
      const resModel = await subtype.resModel;
      if (!resModel || resModel === modelName) {
        extend(childIds, subtype.ids);
        if (await subtype.default) {
          extend(defIds, subtype.ids);
        }
      }
      else if (await subtype.relationField) {
        parent[subtype.id] = (await subtype.parentId).id;
        relation.setdefault(resModel, new Set()).add(await subtype.relationField);
      }
      // required for backward compatibility
      if (await subtype.internal) {
        extend(allIntIds, subtype.ids);
      }
    }
    return [childIds, defIds, allIntIds, parent, relation];
  }

  /**
   * Retrieve the default subtypes (all, internal, external) for the given model.
   * @param modelName 
   * @returns 
   */
  @api.model()
  async defaultSubtypes(modelName) {
    const [subtypeIds, internalIds, externalIds] = await this._defaultSubtypes(modelName);
    return [this.browse(subtypeIds), this.browse(internalIds), this.browse(externalIds)];
  }

  @tools.ormcache('self.env.uid', 'self.env.su', 'modelName')
  async _defaultSubtypes(modelName) {
    const domain = [['default', '=', true],
      '|', ['resModel', '=', modelName], ['resModel', '=', false]];
    const subtypes = await this.search(domain);
    const internal = await subtypes.filtered('internal');
    return [subtypes.ids, internal.ids, subtypes.sub(internal).ids];
  }
}