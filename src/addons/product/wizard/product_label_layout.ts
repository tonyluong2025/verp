import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class ProductLabelLayout extends TransientModel {
  static _module = module;
  static _name = 'product.label.layout';
  static _description = 'Choose the sheet layout to print the labels';

  static printFormat = Fields.Selection([
    ['dymo', 'Dymo'],
    ['2x7xprice', '2 x 7 with price'],
    ['4x7xprice', '4 x 7 with price'],
    ['4x12', '4 x 12'],
    ['4x12xprice', '4 x 12 with price']], {string: "Format", default: '2x7xprice', required: true});
  static customQuantity = Fields.Integer('Quantity', {default: 1, required: true});
  static productIds = Fields.Many2many('product.product', {string: 'Product Ids'});
  static productTemplateIds = Fields.Many2many('product.template', {string: 'Template Ids'});
  static extraHtml = Fields.Html('Extra Content', {default: ''});
  static rows = Fields.Integer({compute: '_computeDimensions'});
  static columns = Fields.Integer({compute: '_computeDimensions'});

  @api.depends('printFormat')
  async _computeDimensions() {
    for (const wizard of this) {
      const printFormat = await wizard.printFormat;
      if (printFormat.includes('x')) {
        const [columns, rows] = printFormat.split('x').slice(0,2);
        await wizard.update({columns: parseInt(columns), 'rows': parseInt(rows)});
      }
      else {
        await wizard.update({columns: 1, rows: 1});
      }
    }
  }

  async _prepareReportData() {
    const [productIds, productTemplateIds, customQuantity, printFormat] = await this('productIds', 'productTemplateIds', 'customQuantity', 'printFormat');
    if (customQuantity <= 0) {
      throw new UserError(await this._t('You need to set a positive quantity.'));
    }
    // Get layout grid
    let xmlid;
    if (printFormat === 'dymo') {
      xmlid = 'product.reportProductTemplateLabelDymo';
    }
    else if (printFormat.includes('x')) {
      xmlid = 'product.reportProductTemplateLabel';
    }
    else {
      xmlid = '';
    }

    let products;
    let activeModel = '';
    if (productTemplateIds.ok) {
      products = productTemplateIds.ids;
      activeModel = 'product.template';
    }
    else if (productIds.ok) {
      products = productIds.ids;
      activeModel = 'product.product';
    }
    else {
      throw new UserError(await this._t("No product to print, if the product is archived please unarchive it before printing its label."));
    }

    // Build data to pass to the report
    const data = {
      'activeModel': activeModel,
      'quantityByProduct': Object.fromEntries(products.map(p => [p, customQuantity])),
      'layoutWizard': this.id,
      'priceIncluded': printFormat.includes('xprice'),
    }
    return [xmlid, data]
  }

  async process() {
    this.ensureOne()
    const [xmlid, data] = await this._prepareReportData();
    if (!xmlid) {
      throw new UserError(await this._t('Unable to find report template for %s format', await (this as any).printFormat))
    }
    const reportAction = await (await this.env.ref(xmlid)).reportAction(null, data);
    await reportAction.update({'closeOnReportDownload': true});
    return reportAction;
  }
}