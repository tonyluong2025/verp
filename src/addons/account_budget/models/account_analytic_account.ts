import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class AccountAnalyticAccount extends Model {
    static _module = module;
    static _parents = "account.analytic.account";

    static crossoveredBudgetLine = Fields.One2many('crossovered.budget.lines', 'analyticAccountId', { string: 'Budget Lines'});
}