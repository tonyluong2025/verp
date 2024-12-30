import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class ProductChangeQuantity extends TransientModel {
    static _module = module;
    static _name = "stock.change.product.qty";
    static _description = "Change Product Quantity";

    static productId = Fields.Many2one('product.product', { string: 'Product', required: true });
    static productTemplateId = Fields.Many2one('product.template', { string: 'Template', required: true });
    static productVariantCount = Fields.Integer('Variant Count', { related: 'productTemplateId.productVariantCount' });
    static newQuantity = Fields.Float('New Quantity on Hand', {
        default: 1,
        digits: 'Product Unit of Measure', required: true,
        help: 'This quantity is expressed in the Default Unit of Measure of the product.'
    });

    @api.onchange('productId')
    async _onchangeProductId() {
        await this.set('newQuantity', await (await this['productId']).qtyAvailable);
    }

    @api.constrains('newQuantity')
    async checkNewQuantity() {
        if (await this.some(async (wizard) => await wizard.newQuantity < 0)) {
            throw new UserError(await this._t('Quantity cannot be negative.'));
        }
    }

    /**
     * Changes the Product Quantity by creating/editing corresponding quant.
     * @returns 
     */
    async changeProductQty() {
        const warehouse = await this.env.items('stock.warehouse').search(
            [['companyId', '=', (await this.env.company()).id]], { limit: 1 }
        )
        // Before creating a new quant, the quand `create` method will check if
        // it exists already. If it does, it'll edit its `inventoryQuantity`
        // instead of create a new one.
        await (await (await this.env.items('stock.quant').withContext({ inventoryMode: true })).create({
            'productId': (await this['productId']).id,
            'locationId': (await warehouse.lotStockId).id,
            'inventoryQuantity': await this['newQuantity'],
        }))._applyInventory();
        return { 'type': 'ir.actions.actwindow.close' }
    }
}