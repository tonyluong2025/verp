import { DefaultDict } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { sum } from "../../../core/tools/iterable";

async function _prepareData(env, data) {
  // change product ids by actual product object to get access to fields in xml template
  // we needed to pass ids because reports only accepts native types (number, strings, ...)
  let Product;
  if (data['activeModel'] === 'product.template') {
    Product = await env.items('product.template').withContext({displayDefaultCode: false});
  }
  else if (data['activeModel'] === 'product.product') {
    Product = await env.items('product.product').withContext({displayDefaultCode: false});
  }
  else {
    throw new UserError(await this._t('Product model not defined, Please contact your administrator.'));
  }

  let total = 0;
  const quantityByProduct = new DefaultDict(); //list)
  for (const [p, q] of Object.entries<any>(data['quantityByProduct'])) {
    const product = Product.browse(parseInt(p));
    if (!quantityByProduct.has(product)) {
      quantityByProduct.set(product, []);
    }
    quantityByProduct.get(product).push([product.barcode, q]);
    total += q;
  }
  if (data['customBarcodes']) {
    // we expect custom barcodes format as: {product: [(barcode, qty_of_barcode)]}
    for (const [p, b] of Object.entries<any>(data['customBarcodes'])) {
      const product = Product.browse(parseInt(p));
      if (!quantityByProduct.has(product)) {
        quantityByProduct.set(product, []);
      }
      quantityByProduct.get(product).concat(b);
      total += sum(b.map(([,qty]) => qty));
    }
  }
  const layoutWizard = env.items('product.label.layout').browse(data['layoutWizard']);
  if (! bool(layoutWizard)) {
    return {};
  }

  const [rows, columns, extraHtml] = await layoutWizard('rows', 'columns', 'extraHtml');
  return {
    'quantity': quantityByProduct,
    'rows': rows,
    'columns': columns,
    'pageNumbers': Math.floor((total - 1) / (rows * columns)) + 1,
    'priceIncluded': data['priceIncluded'],
    'extra_html': extraHtml,
  }
}

@MetaModel.define()
class ReportProductTemplateLabel extends AbstractModel {
  static _module = module;
  static _name = 'report.product.report.producttemplate.label';
  static _description = 'Product Label Report';

  async _getReportValues(docids, data) {
    return _prepareData(this.env, data);
  }
}

@MetaModel.define()
class ReportProductTemplateLabelDymo extends AbstractModel {
  static _module = module;
  static _name = 'report.product.report.producttemplate.label.dymo';
  static _description = 'Product Label Report';

  async _getReportValues(docids, data) {
    return _prepareData(this.env, data);
  }
}