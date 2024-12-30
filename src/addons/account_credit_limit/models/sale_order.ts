import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class SaleOrder extends Model {
    static _module = module;
    static _parents = 'sale.order';

    static partnerCredit = Fields.Monetary({related: 'partnerId.commercialPartnerId.credit', readonly: true});
    static partnerCreditLimit = Fields.Monetary({related: 'partnerId.creditLimitCompute', readonly: true});
    static showPartnerCreditWarning = Fields.Boolean({compute: '_computeShowPartnerCreditWarning'});
    static creditLimitType = Fields.Selection({related: 'companyId.creditLimitType'});

    @api.depends('partnerCreditLimit', 'partnerCredit', 'orderLine',
                 'companyId.accountDefaultCreditLimit', 'companyId.accountCreditLimit')
    async _computeShowPartnerCreditWarning() {
        for (const order of this) {
            const [company, partnerCreditLimit, amountTotal] = await order('companyId', 'partnerCreditLimit', 'amountTotal');
            const [accountCreditLimit, accountDefaultCreditLimit] = await company('accountCreditLimit', 'accountDefaultCreditLimit');
            const companyLimit = partnerCreditLimit == -1 && accountDefaultCreditLimit;
            const partnerLimit = partnerCreditLimit + amountTotal > 0 && partnerCreditLimit;
            const partnerCredit = await order.partnerCredit + amountTotal;
            await order.set('showPartnerCreditWarning', accountCreditLimit &&
                ((companyLimit && partnerCredit > companyLimit) || (partnerLimit && partnerCredit > partnerLimit)));
        }
    }

    async actionConfirm() {
        const result = await _super(SaleOrder, this).actionConfirm();
        for (const so of this) {
            const [showPartnerCreditWarning, creditLimitType, partnerCredit, amountTotal, partnerCreditLimit] = await so('showPartnerCreditWarning', 'creditLimitType', 'partnerCredit', 'amountTotal', 'partnerCreditLimit');
            if (showPartnerCreditWarning && creditLimitType === 'block' &&
                    partnerCredit + amountTotal > partnerCreditLimit) {
                throw new ValidationError(await this._t("You cannot exceed credit limit !"));
            }
        }
        return result;
    }
}