import { tools } from "../../../core";
import { Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { MetaModel, TransientModel, _super } from "../../../core/models";

@MetaModel.define()
class ProductLabelLayout extends TransientModel {
  static _module = module;
  static _parents = 'product.label.layout';

  static moveLineIds = Fields.Many2many('stock.move.line');
  static pickingQuantity = Fields.Selection([
    ['picking', 'Transfer Quantities'],
    ['custom', 'Custom']], { string: "Quantity to print", required: true, default: 'custom' });
  static printFormat = Fields.Selection({
    selectionAdd: [
      ['zpl', 'ZPL Labels'],
      ['zplxprice', 'ZPL Labels with price']
    ], ondelete: { 'zpl': 'SET DEFAULT', 'zplxprice': 'SET DEFAULT' }
  });

  async _prepareReportData() {
    let [xmlid, data] = await _super(ProductLabelLayout, this)._prepareReportData();

    if ((await this['printFormat']).includes('zpl')) {
      xmlid = 'stock.labelProductProduct';
    }

    const [pickingQuantity, moveLineIds] = await this('pickingQuantity', 'moveLineIds');
    if (pickingQuantity === 'picking' && moveLineIds.ok) {
      const qties = new Dict<any>();//int)
      const customBarcodes = new Dict<any>();//list)
      const uomUnit = await this.env.ref('uom.productUomCategUnit', false);
      for (const line of moveLineIds) {
        if ((await (await line.productUomId).categoryId).eq(uomUnit)) {
          const id = line.productId.id;
          if (((await line.lotId).ok || await line.lotName) && tools.parseInt(await line.qtyDone)) {
            customBarcodes[id] = customBarcodes[id] ?? [];
            customBarcodes[id].push([await (await line.lotId).label || await line.lotName, tools.parseInt(await line.qtyDone)]);
            continue;
          }
          qties[id] = qties[id] || 0;
          qties[id] += await line.qtyDone;
        }
      }
      // Pass only products with some quantity done to the report
      data['quantityByProduct'] = Object.fromEntries(qties.items().map(([p, q]) => [p, tools.parseInt(q)]));
      data['customBarcodes'] = customBarcodes;
    }
    return [xmlid, data]
  }
}