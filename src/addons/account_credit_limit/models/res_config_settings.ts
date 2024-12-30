import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static accountCreditLimit = Fields.Boolean(
        {string: "Sales Credit Limit", related: "companyId.accountCreditLimit", readonly: false,
        help: "Enable credit limit for the current company."});
    static accountDefaultCreditLimit = Fields.Monetary(
        {string: "Default Credit Limit", related: "companyId.accountDefaultCreditLimit", readonly: false,
        help: "A limit of zero means no limit by default."});
    static creditLimitType = Fields.Selection({string: "Credit Limit Type", related: "companyId.creditLimitType",
                                         readonly: false});
}