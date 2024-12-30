import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ResPartner extends Model {
  static _module = module;
  static _parents = 'res.partner';

  /**
   * `vat` is a commercial field, synced between the parent (commercial
    entity) and the children. Only the commercial entity should be able to
    edit it (as in backend). 
   * @returns 
   */
  async canEditVat() {
    return ! bool(await this['parentId']);
  }
}