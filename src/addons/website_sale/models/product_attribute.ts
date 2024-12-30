import { Fields } from "../../../core";
import { MapKey, OrderedDict } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models"
import { len } from "../../../core/tools";

@MetaModel.define()
class ProductAttribute extends Model {
    static _module = module;
    static _parents = 'product.attribute';

    static visibility = Fields.Selection([['visible', 'Visible'], ['hidden', 'Hidden']], {default: 'visible'});
}

@MetaModel.define()
class ProductTemplateAttributeLine extends Model {
    static _module = module;
    static _parents = 'product.template.attribute.line';

    /**
     * On the product page group together the attribute lines that concern
        the same attribute and that have only one value each.

        Indeed those are considered informative values, they do not generate
        choice for the user, so they are displayed below the configurator.

        The returned attributes are ordered as they appear in `self`, so based
        on the order of the attribute lines.
     * @returns 
     */
    async _prepareSingleValueForDisplay() {
        const singleValueLines = await this.filtered(async (ptal) => len(await ptal.valueIds) == 1);
        const singleValueAttributes = new MapKey();
        for (const pa of await singleValueLines.attributeId) {
            singleValueAttributes.set(pa, this.env.items('product.template.attribute.line'));
        }
        for (const ptal of singleValueLines) {
            const attribute = await ptal.attributeId;
            singleValueAttributes.set(attribute, singleValueAttributes.get(attribute).or(ptal));
        }
        return singleValueAttributes;
    }
}
