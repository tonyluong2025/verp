import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"

@MetaModel.define()
class ResPartner extends Model {
    static _module = module;
    static _parents = 'res.partner';

    static amountCreditLimit = Fields.Monetary({string: 'Internal Credit Limit', default: -1});
    static creditLimitCompute = Fields.Monetary(
        {string: 'Credit Limit ', default: -1,
        compute: '_computeCreditLimitCompute', inverse: '_inverseCreditLimitCompute',
        help: 'A limit of zero means no limit. A limit of -1 will use the default (company) limit.'}
    );
    static showCreditLimit = Fields.Boolean({compute: '_computeShowCreditLimit'});

    @api.depends('amountCreditLimit')
    @api.dependsContext('company')
    async _computeCreditLimitCompute() {
        const accountDefaultCreditLimit = await (await this.env.company()).accountDefaultCreditLimit;
        for (const partner of this) {
            const amountCreditLimit = await partner.amountCreditLimit;
            await partner.set('creditLimitCompute', amountCreditLimit == -1 ? accountDefaultCreditLimit : amountCreditLimit);
        }
    }

    @api.depends('creditLimitCompute')
    @api.dependsContext('company')
    async _inverseCreditLimitCompute() {
        const accountDefaultCreditLimit = await (await this.env.company()).accountDefaultCreditLimit;
        for (const partner of this) {
            const creditLimitCompute = await partner.creditLimitCompute;
            const isDefault = creditLimitCompute == accountDefaultCreditLimit
            await partner.set('amountCreditLimit', isDefault ? -1 : creditLimitCompute);
        }
    }

    @api.dependsContext('company')
    async _computeShowCreditLimit() {
        const accountCreditLimit = await (await this.env.company()).accountCreditLimit;
        for (const partner of this) {
            await partner.set('showCreditLimit', accountCreditLimit);
        }
    }

    @api.model()
    _commercialFields() {
        return _super(ResPartner, this)._commercialFields().concat(['amountCreditLimit']);
    }
}