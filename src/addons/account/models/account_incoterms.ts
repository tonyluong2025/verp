import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountIncoterms extends Model {
  static _module = module;
  static _name = 'account.incoterms';
  static _description = 'Incoterms';

  static label = Fields.Char('Name', { required: true, translate: true, help: "Incoterms are series of sales terms. They are used to divide transaction costs and responsibilities between buyer and seller and reflect state-of-the-art transportation practices." });
  static code = Fields.Char('Code', { size: 3, required: true, help: "Incoterm Standard Code" });
  static active = Fields.Boolean('Active', { default: true, help: "By unchecking the active field, you may hide an INCOTERM you will not use." });
}