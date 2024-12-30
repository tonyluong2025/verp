import { api, Fields } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { isImageSizeAbove } from "../../../core/tools";
import { getVideoEmbedCode } from "../../website/tools";

@MetaModel.define()
class ProductImage extends Model {
    static _module = module;
    static _name = 'product.image';
    static _description = "Product Image";
    static _parents = ['image.mixin'];
    static _order = 'sequence, id';

    static label = Fields.Char("Name", {required: true});
    static sequence = Fields.Integer({default: 10, index: true});
    static image1920 = Fields.Image({required: true});

    static productTemplateId = Fields.Many2one('product.template', {string: "Product Template", index: true, ondelete: 'CASCADE'});
    static productVariantId = Fields.Many2one('product.product', {string: "Product Variant", index: true, ondelete: 'CASCADE'});
    static videoUrl = Fields.Char('Video URL', {help: 'URL of a video for showcasing your product.'});
    static embedCode = Fields.Html({compute: "_computeEmbedCode", sanitize: false});

    static canImage1024BeZoomed = Fields.Boolean("Can Image 1024 be zoomed",{compute: '_computeCanImage1024BeZoomed', store: true});

    @api.depends('image1920', 'image1024')
    async _computeCanImage1024BeZoomed() {
        for (const image of this) {
            await image.set('canImage1024BeZoomed', await image.image1920 && isImageSizeAbove(await image.image1920, await image.image1024));
        }
    }

    @api.depends('videoUrl')
    async _computeEmbedCode() {
        for (const image of this) {
            await image.set('embedCode', getVideoEmbedCode(await image.videoUrl));
        }
    }

    @api.constrains('videoUrl')
    async _checkValidVideoUrl() {
        for (const image of this) {
            if (await image.videoUrl && ! await image.embedCode) {
                throw new ValidationError(await this._t("Provided video URL for '%s' is not valid. Please enter a valid video URL.", await image.label));
            }
        }
    }

    /**
     * We don't want the default_product_tmpl_id from the context
            to be applied if we have a product_variant_id set to avoid
            having the variant images to show also as template images.
            But we want it if we don't have a product_variant_id set.
     * @param valsList 
     */
    @api.modelCreateMulti()
    async create(valsList) {
        const contextWithoutTemplate = await this.withContext(Object.fromEntries(Object.entries(this.env.context).filter(([k, v]) => k != 'default_productTemplateId')));
        const normalVals = [],
        variantValsList = [];

        for (const vals of valsList) {
            if (vals['productVariantId'] && 'default_productTemplateId' in this.env.context) {
                variantValsList.push(vals);
            }
            else {
                normalVals.push(vals);
            }
        }

        return (await _super(ProductImage, this).create(normalVals)).add(await _super(ProductImage, contextWithoutTemplate).create(variantValsList));
    }
}
