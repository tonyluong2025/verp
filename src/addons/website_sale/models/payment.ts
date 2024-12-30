import { api } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class PaymentAcquirer extends Model {
    static _module = module;
    static _parents = 'payment.acquirer';

    /**
     * Override of payment to only return acquirers matching website-specific criteria.

        In addition to the base criteria, the website must either not be set or be the same as the
        one provided in the kwargs.

        :param int websiteId: The provided website, as a `website` id
        :return: The compatible acquirers
        :rtype: recordset of `payment.acquirer`
     * @param companyId 
     * @param partnerId 
     * @param opts 
     * @returns 
     */
    @api.model()
    async _getCompatibleAcquirers(companyId: number, partnerId: number, opts: {websiteId?: number}={}) {
        let acquirers = await _super(PaymentAcquirer, this)._getCompatibleAcquirers(companyId, partnerId, opts);
        if (opts.websiteId) {
            acquirers = await acquirers.filtered(
                async (a) => !(await a.websiteId).ok || (await a.websiteId).id == opts.websiteId
            );
        }
        return acquirers;
    }
}
