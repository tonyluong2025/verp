import { MetaModel, Model, _super } from "../../../core/models"

@MetaModel.define()
class AccountChartTemplate extends Model {
    static _module = module;
    static _parents = 'account.chart.template';

    /**
     * Remove the payment methods that are created for the company before installing the chart of accounts.

        Keeping these existing pos.payment.method records interferes with the installation of chart of accounts
        because pos.payment.method model has fields linked to account.journal and account.account records that are
        deleted during the loading of chart of accounts.
     * @param saleTaxRate 
     * @param purchaseTaxRate 
     * @param company 
     * @returns 
     */
    async _load(saleTaxRate, purchaseTaxRate, company) {
        await (await this.env.items('pos.payment.method').search([['companyId', '=', company.id]])).unlink();
        const result = await _super(AccountChartTemplate, this)._load(saleTaxRate, purchaseTaxRate, company);
        await this.env.items('pos.config').postInstallPosLocalisation(company);
        return result;
    }
}
