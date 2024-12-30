import { Fields } from "../../../core";
import { TransientModel } from "../../../core/models"
import { MetaModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static fiscalyearLastDay = Fields.Integer({related: 'companyId.fiscalyearLastDay', readonly: false});
    static fiscalyearLastMonth = Fields.Selection({related: 'companyId.fiscalyearLastMonth', readonly: false});
    static periodLockDate = Fields.Date({related: 'companyId.periodLockDate', readonly: false});
    static fiscalyearLockDate = Fields.Date({related: 'companyId.fiscalyearLockDate', readonly: false});
    static groupFiscalYear = Fields.Boolean({string: 'Fiscal Years', impliedGroup: 'account_fiscal_year.groupFiscalYear'});
}
