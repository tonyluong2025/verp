import { api } from "../../../core";
import { Dict } from "../../../core/helper/collections";
import { AbstractModel, MetaModel } from "../../../core/models"
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ProductPricelistReport extends AbstractModel {
  static _module = module;
  static _name = 'report.product.report.pricelist';
  static _description = 'Pricelist Report';

  async _getReportValues(docids, data) {
    return this._getReportData(data, 'pdf');
  }

  @api.model()
  async getHtml(data) {
    const renderValues = this._getReportData(data, 'html');
    return (await this.env.ref('product.reportPricelistPage'))._render(renderValues);
  }

  async _getReportData(data, reportType='html') {
    const quantities = data['quantities'] ?? [1];

    const pricelistId = data['pricelistId'] && parseInt(data['pricelistId']) || null;
    let pricelist = await this.env.items('product.pricelist').browse(pricelistId).exists();
    if (! pricelist.ok) {
      pricelist = this.env.items('product.pricelist').search([], {limit: 1});
    }

    const activeModel = data['activeModel'];
    const activeIds = data['activeIds'] || [];
    const isProductTemplate = activeModel === 'product.template';
    const Product = this.env.items(activeModel);

    const products = bool(activeIds) ? Product.browse(activeIds) : await Product.search([['saleOk', '=', true]]);
    const productsData = [];
    for (const product of products) {
      productsData.push(await this._getProductData(isProductTemplate, product, pricelist, quantities));
    }

    return {
      'isHtmlType': reportType === 'html',
      'isProductTemplate': isProductTemplate,
      'isVisibleTitle': bool(data['isVisibleTitle']) ?? false,
      'pricelist': pricelist,
      'products': productsData,
      'quantities': quantities,
    }
  }

  async _getProductData(isProductTemplate, product, pricelist, quantities) {
    const data = {
      'id': product.id,
      'label': isProductTemplate && await product.label || await product.displayName,
      'price': Dict.fromKeys(quantities, 0.0),
      'uom': await (await product.uomId).label,
    }
    for (const qty of quantities) {
      data['price'][qty] = await pricelist.getProductPrice(product, qty, false);
    }

    if (isProductTemplate && await product.productVariantCount > 1) {
      data['variants'] = [];
      for (const variant of await product.productVariantIds) {
        variant.push(await this._getProductData(false, variant, pricelist, quantities))
      }
    }
    return data;
  }
}