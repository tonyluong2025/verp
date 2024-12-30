import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models";
import { literalEval } from "../../../core/tools/ast";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
  static _module = module;
  static _parents = 'res.config.settings';

  static authSignupResetPassword = Fields.Boolean({string: 'Enable password reset from Login page', configParameter: 'auth_signup.resetPassword'})
  static authSignupUninvited = Fields.Selection([
    ['b2b', 'On invitation'],
    ['b2c', 'Free sign up'],
  ], {string: 'Customer Account', default: 'b2b', configParameter: 'auth_signup.invitationScope'});
  static authSignupTemplateUserId = Fields.Many2one('res.users', {string: 'Template user for new users created through signup', configParameter: 'base.templatePortalUserId'});

  async openTemplateUser() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("base.actionResUsers");
    action['resId'] = literalEval(await (await this.env.items('ir.config.parameter').sudo()).getParam('base.templatePortalUserId', 'false'));
    action['views'] = [[(await this.env.ref('base.viewUsersForm')).id, 'form']];
    return action;
  }
}