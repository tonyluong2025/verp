import { api, Fields } from "../../../core";
import { _super, MetaModel, TransientModel } from "../../../core/models";
import { f, update } from "../../../core/tools";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static salespersonId = Fields.Many2one('res.users', { related: 'websiteId.salespersonId', string: 'Salesperson', readonly: false });
    static salesteamId = Fields.Many2one('crm.team', { related: 'websiteId.salesteamId', string: 'Sales Team', readonly: false });
    static moduleWebsiteSaleDelivery = Fields.Boolean("eCommerce Shipping Costs");
    // field used to have a nice radio in form view, resuming the 2 fields above
    static saleDeliverySettings = Fields.Selection([
        ['none', 'No shipping management on website'],
        ['internal', "Delivery methods are only used internally: the customer doesn't pay for shipping costs"],
        ['website', "Delivery methods are selectable on the website: the customer pays for shipping costs"],
    ], { string: "Shipping Management" });

    static groupDeliveryInvoiceAddress = Fields.Boolean({ string: "Shipping Address", impliedGroup: 'sale.groupDeliveryInvoiceAddress', groups: 'base.groupPortal,base.groupUser,base.groupPublic' });
    static groupShowUomPrice = Fields.Boolean({ default: false, string: "Base Unit Price", impliedGroup: "website_sale.groupShowUomPrice", groups: 'base.groupPortal,base.groupUser,base.groupPublic' });

    static moduleWebsiteSaleDigital = Fields.Boolean("Digital Content");
    static moduleWebsiteSaleWishlist = Fields.Boolean("Wishlists");
    static moduleWebsiteSaleComparison = Fields.Boolean("Product Comparison Tool");
    static moduleWebsiteSaleGiftCard = Fields.Boolean("Gift Card");
    static moduleAccount = Fields.Boolean("Invoicing");

    static cartRecoveryMailTemplate = Fields.Many2one('mail.template', { string: 'Cart Recovery Email', domain: "[['model', '=', 'sale.order']]", related: 'websiteId.cartRecoveryMailTemplateId', readonly: false });
    static cartAbandonedDelay = Fields.Float("Abandoned Delay", { help: "Number of hours after which the cart is considered abandoned.", related: 'websiteId.cartAbandonedDelay', readonly: false });
    static cartAddOnPage = Fields.Boolean("Stay on page after adding to cart", { related: 'websiteId.cartAddOnPage', readonly: false });
    static termsUrl = Fields.Char({ compute: '_computeTermsUrl', string: "URL", help: "A preview will be available at this URL." });

    @api.depends('websiteId')
    async _computeTermsUrl() {
        for (const record of this) {
            await record.set('termsUrl', f('%s/terms', await (await record.websiteId).getBaseUrl()));
        }
    }

    @api.model()
    async getValues() {
        const res = await _super(ResConfigSettings, this).getValues();

        let saleDeliverySettings = 'none';
        if (['installed', 'to install', 'to upgrade'].includes(await (await this.env.items('ir.module.module').search([['label', '=', 'delivery']], { limit: 1 })).state)) {
            let saleDeliverySettings = 'internal';
            if (['installed', 'to install', 'to upgrade'].includes(await (await this.env.items('ir.module.module').search([['label', '=', 'websiteSaleDelivery']], { limit: 1 })).state)) {
                saleDeliverySettings = 'website';
            }
        }

        update(res, { saleDeliverySettings });
        return res;
    }

    @api.onchange('saleDeliverySettings')
    async _onchangeSaleDeliverySettings() {
        if (await this['saleDeliverySettings'] === 'none') {
            await this.update({
                'moduleDelivery': false,
                'moduleWebsiteSaleDelivery': false,
            });
        }
        else if (await this['saleDeliverySettings'] === 'internal') {
            await this.update({
                'moduleDelivery': true,
                'moduleWebsiteSaleDelivery': false,
            });
        }
        else {
            await this.update({
                'moduleDelivery': true,
                'moduleWebsiteSaleDelivery': true,
            });
        }
    }

    @api.onchange('groupDiscountPerSoLine')
    async _onchangeGroupDiscountPerSoLine() {
        if (await this['groupDiscountPerSoLine']) {
            await this.update({
                'groupProductPricelist': true,
            });
        }
    }

    async actionUpdateTerms() {
        this.ensureOne();
        return {
            'type': 'ir.actions.acturl',
            'url': '/terms?enableEditor=1',
            'target': 'self',
        }
    }
}
