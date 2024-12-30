import { UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { series } from "../../../core/release";
import { parseVersion } from "../../../core/tools/parse_version";

@MetaModel.define()
class IrModuleModule extends Model {
  static _module = module;
  static _parents = "ir.module.module";

  /**
   * Warn the user about updating account if they try to install account_reports with an out of date module

          A change in stable added a dependency between account_reports and a template update in account.
          It could cause a traceback when updating account_reports, or account_accountant with an out of date account
          module. This will inform the user about what to do in such case, by asking him to update invoicing.
   * @param values 
   * @returns 
   */
  async write(values) {
    const modNames = await this.mapped('label');
    const newState = values['state'];
    if (['to upgrade', 'to install'].includes(newState) && modNames.includes('accountReports') && !modNames.includes('account')) {
      const invoicingMod = await this.env.ref('base.module_account');
      // Do not install or update account_report if account version is not >= 1.2, and we are not also installing/updating it
      if (parseVersion(await invoicingMod.latestVersion) < parseVersion(`${series}.1.2`) && !['to install', 'to upgrade'].includes(await invoicingMod.state)) {
        throw new UserError(await this._t("Please update the Invoicing module before continuing."));
      }
    }
    return _super(IrModuleModule, this).write(values);
  }
}