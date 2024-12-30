import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { f } from "../../../core/tools";

@MetaModel.define()
class AccountMove extends Model {
    static _module = module;
    static _parents = 'account.move';

    static partnerCredit = Fields.Monetary({related: 'partnerId.commercialPartnerId.credit', readonly: true});
    static partnerCreditLimit = Fields.Monetary({related: 'partnerId.creditLimitCompute', readonly: true});
    static showPartnerCreditWarning = Fields.Boolean({compute: '_computeShowPartnerCreditWarning'});
    static creditLimitType = Fields.Selection({related: 'companyId.creditLimitType'});

    @api.depends('partnerCreditLimit', 'partnerCredit', 'invoiceLineIds',
                 'companyId.accountDefaultCreditLimit', 'companyId.accountCreditLimit')
    async _computeShowPartnerCreditWarning() {
        for (const move of this) {
            const [company, amountTotal, partnerCreditLimit] = await move('companyId', 'amountTotal', 'partnerCreditLimit');
            const [accountCreditLimit, accountDefaultCreditLimit] = await company('accountCreditLimit', 'accountDefaultCreditLimit');
            const companyLimit = partnerCreditLimit == -1 && accountDefaultCreditLimit;
            const partnerLimit = partnerCreditLimit > 0 && partnerCreditLimit;
            const partnerCredit = await move.partnerCredit + amountTotal
            await move.set('showPartnerCreditWarning', accountCreditLimit &&
                ((companyLimit && partnerCredit > companyLimit) || (partnerLimit && partnerCredit > partnerLimit)));
        }
    }

    async actionPost() {
        const result = await _super(AccountMove, this).actionPost();
        for (const inv of this) {
            const [showPartnerCreditWarning, creditLimitType, partnerCredit, partnerCreditLimit] = await inv('showPartnerCreditWarning', 'creditLimitType', 'partnerCredit', 'partnerCreditLimit');
            if (showPartnerCreditWarning && creditLimitType === 'block' && partnerCredit > partnerCreditLimit) {
                throw new ValidationError(f(await this._t('You cannot exceed credit limit ! \nAllowed Limit: %s ! \nComputed Balance: %s !'), partnerCreditLimit, partnerCredit));
            }
        }
        return result;
    }
}

