import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { update } from "../../../core/tools";

@MetaModel.define()
class AccountPartnerLedger extends TransientModel {
    static _module = module;
    static _name = "account.report.partner.ledger";
    static _parents = "account.common.partner.report";
    static _description = "Account Partner Ledger";

    static amountCurrency = Fields.Boolean("With Currency",
                                     {help: "It adds the currency column on report if the currency differs from the company currency."});
    static reconciled = Fields.Boolean('Reconciled Entries');

    async _getReportData(data) {
        data = await this['prePrintReport'](data);
        update(data['form'], {'reconciled': await this['reconciled'],
                             'amountCurrency': await this['amountCurrency']});
        return data;
    }

    async _printReport(data) {
        data = await this._getReportData(data);
        return (await (await this.env.ref('account_pdf_reports.actionReportPartnerledger')).withContext({landscape: true})).reportAction(this, data);
    }
}