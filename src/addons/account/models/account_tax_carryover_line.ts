import { api } from "../../../core";
import { Fields, _Date } from "../../../core/fields";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class AccountTaxCarryoverLine extends Model {
  static _module = module;
  static _name = 'account.tax.carryover.line';
  static _description = 'Tax carryover line';

  static label = Fields.Char({ required: true });
  static amount = Fields.Float({ required: true, default: 0.0 });
  static date = Fields.Date({ required: true, default: self => _Date.contextToday(self) });
  static taxReportLineId = Fields.Many2one({ comodelName: 'account.tax.report.line', string: "Tax report line" })
  static taxReportId = Fields.Many2one({ related: 'taxReportLineId.reportId' });
  static taxReportCountryId = Fields.Many2one({ related: 'taxReportId.countryId' });
  static companyId = Fields.Many2one({ comodelName: 'res.company', string: 'Company', required: true, default: self => self.env.company() });
  static foreignVatFiscalPositionId = Fields.Many2one({ comodelName: 'account.fiscal.position', string: "Fiscal position", help: "The foreign fiscal position for which this carryover is made.", domain: "[['companyId', '=', companyId], ['countryId', '=', taxReportCountryId], ['foreignVat', '!=', false]]" });

  @api.constrains('foreignVatFiscalPositionId')
  async _checkFiscalPosition() {
    const foreignVatFiscalPositionId = await this['foreignVatFiscalPositionId'];
    if (foreignVatFiscalPositionId.ok && !(await foreignVatFiscalPositionId.countryId).eq(await this['taxReportCountryId'])) {
      throw new ValidationError(await this._t("The country of the fiscal position must be this report line's report country."));
    }
  }
}