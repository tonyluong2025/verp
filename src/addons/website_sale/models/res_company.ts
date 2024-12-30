import { api, Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ResCompany extends Model {
    static _module = module;
    static _parents = 'res.company';

    static websiteSaleOnboardingPaymentAcquirerState = Fields.Selection([['notDone', "Not done"], ['justDone', "Just done"], ['done', "Done"]], {string: "State of the website sale onboarding payment acquirer step", default: 'notDone'});

    /**
     * Called by onboarding panel above the quotation list.
     * @returns 
     */
    @api.model()
    async actionOpenWebsiteSaleOnboardingPaymentAcquirer() {
        await (await this.env.company()).set('paymentOnboardingPaymentMethod', 'stripe');
        const menuId = (await this.env.ref('website.menuWebsiteDashboard')).id;
        return (this as any)._runPaymentOnboardingStep(menuId);
    }
}
