import { DateTime } from "luxon";
import { Fields, _Date } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class AccountTaxReport extends TransientModel {
    static _module = module;
    static _name = 'account.tax.report.wizard';
    static _parents = "account.common.report";
    static _description = 'Tax Report';

    static dateFrom = Fields.Date({string: 'Date From', required: true,
                            default: self => _Date.toString(DateTime.fromJSDate(_Date.today()).set({day: 1}).toJSDate())});
    static dateTo = Fields.Date({string: 'Date To', required: true,
                          default: self => _Date.toString(_Date.today())});

    async _printReport(data) {
        return (await this.env.ref('account_pdf_reports.actionReportAccountTax')).reportAction(this, data);
    }
}