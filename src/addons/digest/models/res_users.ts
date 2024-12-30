import { api } from "../../../core"
import { MetaModel, Model, _super } from "../../../core/models"

@MetaModel.define()
class ResUsers extends Model {
  static _module = module;
  static _parents = "res.users";

  /**
   * Automatically subscribe employee users to default digest if activated
   * @param valsList 
   * @returns 
   */
  @api.modelCreateMulti()
  async create(valsList) {
    const users = await _super(ResUsers, this).create(valsList);
    const defaultDigestEmails = await (await this.env.items('ir.config.parameter').sudo()).getParam('digest.defaultDigestEmails');
    const defaultDigestId = await (await this.env.items('ir.config.parameter').sudo()).getParam('digest.defaultDigestId');
    if (defaultDigestEmails && defaultDigestId) {
      const digest = await (await this.env.items('digest.digest').sudo()).browse(parseInt(defaultDigestId)).exists();
      const userIds = await digest.userIds;
      await digest.set('userIds', userIds.or(await users.filteredDomain([['share', '=', false]])));
    }
    return users;
  }
}