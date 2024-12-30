import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { update } from "../../../core/tools/misc";

@MetaModel.define()
class AccountCommonJournalReport extends TransientModel {
    static _module = module;
    static _name = 'account.common.journal.report';
    static _description = 'Common Journal Report';
    static _parents = "account.common.report";

    static amountCurrency = Fields.Boolean('With Currency', {help: "Print Report with the currency column if the currency differs from the company currency."});

    async prePrintReport(data) {
        update(data['form'], {'amountCurrency': await this['amountCurrency']});
        return data;
    }
}