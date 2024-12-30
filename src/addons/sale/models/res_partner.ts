import { Fields } from "../../../core";
import { WARNING_HELP, WARNING_MESSAGE } from "../../../core/addons/base";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class ResPartner extends Model {
    static _module = module;
    static _parents = 'res.partner';

    static saleOrderCount = Fields.Integer({compute: '_computeSaleOrderCount', string: 'Sale Order Count'});
    static saleOrderIds = Fields.One2many('sale.order', 'partnerId', {string: 'Sales Order'});
    static saleWarn = Fields.Selection(WARNING_MESSAGE, {string: 'Sales Warnings', default: 'no-message', help: WARNING_HELP});
    static saleWarnMsg = Fields.Text('Message for Sales Order');

    async _computeSaleOrderCount() {
        // retrieve all children partners and prefetch 'parentId' on them
        const allPartners = await (await this.withContext({activeTest: false})).search([['id', 'childOf', this.ids]]);
        await allPartners.read(['parentId']);

        const saleOrderGroups = await this.env.items('sale.order').readGroup(
            [['partnerId', 'in', allPartners.ids]],
            ['partnerId'], ['partnerId']
        );
        let partners = this.browse();
        for (const group of saleOrderGroups) {
            let partner = this.browse(group['partnerId'][0]);
            while (bool(partner)) {
                if (this.includes(partner)) {
                    await partner.set('saleOrderCount', await partner.saleOrderCount + group['partnerId_count']);
                    partners = partners.or(partner);
                }
                partner = await partner.parentId;
            }
        }
        await this.sub(partners).set('saleOrderCount', 0);
    }

    /**
     * Can't edit `vat` if there is (non draft) issued SO.
     */
    async canEditVat() {
        const canEditVat = await _super(ResPartner, this).canEditVat();
        if (! canEditVat) {
            return canEditVat;
        }
        const SaleOrder = this.env.items('sale.order');
        const hasSo = await SaleOrder.search([
            ['partnerId', 'childOf', (await this['commercialPartnerId']).id],
            ['state', 'in', ['sent', 'sale', 'done']]
        ], {limit: 1});
        return canEditVat && !bool(hasSo);
    }

    async actionViewSaleOrder() {
        const action = await this.env.items('ir.actions.actions')._forXmlid('sale.actResPartner2SaleOrder');
        const allChild = await (await this.withContext({activeTest: false})).search([['id', 'childOf', this.ids]]);
        action["domain"] = [["partnerId", "in", allChild.ids]];
        return action;
    }
}
