import { api, Fields } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool, f } from "../../../core/tools";

@MetaModel.define()
class Product extends Model {
    static _module = module;
    static _parents = "product.product";

    static websiteId = Fields.Many2one({related: 'productTemplateId.websiteId', readonly: false});

    static productVariantImageIds = Fields.One2many('product.image', 'productVariantId', {string: "Extra Variant Images"});

    static websiteUrl = Fields.Char('Website URL', {compute: '_computeProductWebsiteUrl', help: 'The full URL to access the document through the website.'});

    static baseUnitCount = Fields.Float('Base Unit Count', {required: true, default: 1, help: "Display base unit price on your eCommerce pages. Set to 0 to hide it for this product."});
    static baseUnitId = Fields.Many2one('website.base.unit', {string: 'Custom Unit of Measure', help: "Define a custom unit to display in the price per unit of measure field."});
    static baseUnitPrice = Fields.Monetary("Price Per Unit", {currencyField: "currencyId", compute: "_computeBaseUnitPrice"});
    static baseUnitName = Fields.Char({compute: '_computeBaseUnitName', help: 'Displays the custom unit for the products if defined or the selected unit of measure otherwise.'});

    @api.depends('price', 'lstPrice', 'baseUnitCount')
    async _computeBaseUnitPrice() {
        for (const product of this) {
            if (! bool(product.id)) {
                await product.set('baseUnitPrice', 0);
            }
            else {
                await product.set('baseUnitPrice', await product.baseUnitCount && (await product.price || await product.lstPrice) / await product.baseUnitCount);
            }
        }
    }

    @api.depends('uomName', 'baseUnitId')
    async _computeBaseUnitName() {
        for (const product of this) {
            await product.set('baseUnitName', await (await product.baseUnitId).label || await product.uomName);
        }
    }

    @api.constrains('baseUnitCount')
    async _checkBaseUnitCount() {
        if (await this.some(async (product) => await product.baseUnitCount < 0)) {
            throw new ValidationError(await this._t('The value of Base Unit Count must be greater than 0. Use 0 to hide the price per unit on this product.'));
        }
    }

    @api.dependsContext('lang')
    @api.depends('productTemplateId.websiteUrl', 'productTemplateAttributeValueIds')
    async _computeProductWebsiteUrl() {
        for (const product of this) {
            const attributes = String((await product.productTemplateAttributeValueIds).ids);
            await product.set('websiteUrl', f("%s#attr=%s", await (await product.productTemplateId).websiteUrl, attributes));
        }
    }

    async _prepareVariantValues(combination) {
        const variantDict = await _super(Product, this)._prepareVariantValues(combination);
        variantDict['baseUnitCount'] = await this['baseUnitCount'];
        return variantDict;
    }

    async websitePublishButton() {
        this.ensureOne();
        return (await this['productTemplateId']).websitePublishButton();
    }

    async openWebsiteUrl() {
        this.ensureOne();
        const res = await (await this['productTemplateId']).openWebsiteUrl();
        res['url'] = await this['websiteUrl'];
        return res;
    }

    /**
     * Return a list of records implementing `image.mixin` to
        display on the carousel on the website for this variant.

        This returns a list and not a recordset because the records might be
        from different models (template, variant and image).

        It contains in this order: the main image of the variant (if set), the
        Variant Extra Images, and the Template Extra Images.
     */
    async _getImages() {
        this.ensureOne();
        let variantImages = Array.from(await this['productVariantImageIds']);
        if (await this['imageVariant1920']) {
            // if the main variant image is set, display it first
            variantImages.unshift(this);
        }
        else {
            // If the main variant image is empty, it will fallback to template
            // image, in this case insert it after the other variant images, so
            // that all variant images are first and all template images last.
            variantImages.push(this);
        }
        // [1:] to remove the main image from the template, we only display
        // the template extra images here
        return variantImages.concat((await (await this['productTemplateId'])._getImages()).slice(1));
    }

    async _isSoldOut() {
        const combinationInfo = await (await (await this.withContext({websiteSaleStockGetQuantity: true})).productTemplateId)._getCombinationInfo({combination: false, productId: this.id});
        return combinationInfo['productType'] === 'product' && combinationInfo['freeQty'] <= 0;
    }

    async _isAddToCartAllowed() {
        this.ensureOne();
        return await this.userHasGroups('base.groupSystem') || (await this['active'] && await this['saleOk'] && await this['websitePublished']);
    }
}
