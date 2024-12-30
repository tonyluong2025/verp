import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { getRequestWebsite } from "../../website/models";

@MetaModel.define()
class ResPartner extends Model {
    static _module = module;
    static _parents = 'res.partner';

    static lastWebsiteSoId = Fields.Many2one('sale.order', {compute: '_computeLastWebsiteSoId', string: 'Last Online Sales Order'});

    async _computeLastWebsiteSoId() {
        const saleOrder = this.env.items('sale.order');
        for (const partner of this) {
            const isPublic = await (await (await partner.withContext({activeTest: false})).userIds).some(u => u._isPublic());
            const website = getRequestWebsite(this.env.req);
            if (website && ! isPublic) {
                await partner.set('lastWebsiteSoId', await saleOrder.search([
                    ['partnerId', '=', partner.id],
                    ['websiteId', '=', website.id],
                    ['state', '=', 'draft'],
                ], {order: 'updatedAt desc', limit: 1}));
            }
            else {
                await partner.set('lastWebsiteSoId', saleOrder);  // Not in a website context or public User
            }
        }
    }
}