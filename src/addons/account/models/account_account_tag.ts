import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountAccountTag extends Model {
  static _module = module;
  static _name = 'account.account.tag';
  static _description = 'Account Tag';

  static label = Fields.Char('Tag Name', { required: true });
  static applicability = Fields.Selection([['accounts', 'Accounts'], ['taxes', 'Taxes'], ['products', 'Products']], { required: true, default: 'accounts' });
  static color = Fields.Integer('Color Index');
  static active = Fields.Boolean({ default: true, help: "Set active to false to hide the Account Tag without removing it." });
  static taxReportLineIds = Fields.Many2many({ string: "Tax Report Lines", comodelName: 'account.tax.report.line', relation: 'accountTaxReportLineTagsRel', help: "The tax report lines using this tag" });
  static taxNegate = Fields.Boolean({ string: "Negate Tax Balance", help: "Check this box to negate the absolute value of the balance of the lines associated with this tag in tax report computation." });
  static countryId = Fields.Many2one({ string: "Country", comodelName: 'res.country', help: "Country for which this tag is available, when applied on taxes." });

  /**
   * Returns all the tax tags corresponding to the tag name given in parameter in the specified country.
   * @param tagName 
   * @param countryId 
   * @returns 
   */
  @api.model()
  async _getTaxTags(tagName: string, countryId) {
    const escapedTagName = tagName.replace('\\', '\\\\').replace('%', '\%').replace('_', '\_');
    return this.env.items('account.account.tag').search([['label', '=like', '_' + escapedTagName], ['countryId', '=', countryId], ['applicability', '=', 'taxes']]);
  }
}