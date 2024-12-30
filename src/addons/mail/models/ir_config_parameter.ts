import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class IrConfigParameter extends Model {
  static _module = module;
  static _parents = 'ir.config.parameter'

  @api.modelCreateMulti()
  async create(valsList) {
    for (const vals of valsList) {
      if (['mail.bounce.alias', 'mail.catchall.alias'].includes(vals['key'])) {
        vals['value'] = await this.env.items('mail.alias')._cleanAndCheckUnique([vals['value']])[0]
      }
    }
    return _super(IrConfigParameter, this).create(valsList);
  }

  async write(vals) {
    for (const parameter of this) {
      if ('value' in vals && ['mail.bounce.alias', 'mail.catchall.alias'].includes(await parameter.key) && vals['value'] !== await parameter.value) {
        vals['value'] = await this.env.items('mail.alias')._cleanAndCheckUnique([vals.get('value')])[0];
      }
    }
    return _super(IrConfigParameter, this).write(vals);
  }

  @api.model()
  async setParam(key, value) {
    if (key === 'mail.restrict.template.rendering') {
      const groupUser = await this.env.ref('base.groupUser');
      const groupMailTemplateEditor = await this.env.ref('mail.groupMailTemplateEditor')

      const impliedIds = await groupUser.impliedIds
      if (!value && !impliedIds.includes(groupMailTemplateEditor)) {
        await groupUser.set('impliedIds', impliedIds.or(groupMailTemplateEditor));
      }
      else if (value && impliedIds.includes(groupMailTemplateEditor)) {
        await groupUser.set('impliedIds', impliedIds.sub(groupMailTemplateEditor));
      }
    }

    return _super(IrConfigParameter, this).setParam(key, value);
  }
}