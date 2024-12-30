import assert from "assert";
import _ from "lodash";
import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { formatAmount } from "../../../core/tools/models";

const ACCOUNT_DOMAIN = "['&', '&', '&', ['deprecated', '=', false], ['internalType','=','other'], ['companyId', '=', currentCompanyId], ['isOffBalance', '=', false]]";

@MetaModel.define()
class ProductCategory extends Model {
  static _module = module;
  static _parents = "product.category";

  static propertyAccountIncomeCategId = Fields.Many2one('account.account', {
    companyDependent: true,
    string: "Income Account",
    domain: ACCOUNT_DOMAIN,
    help: "This account will be used when validating a customer invoice."
  });
  static propertyAccountExpenseCategId = Fields.Many2one('account.account', {
    companyDependent: true,
    string: "Expense Account",
    domain: ACCOUNT_DOMAIN,
    help: "The expense is accounted for when a vendor bill is validated, except in anglo-saxon accounting with perpetual inventory valuation in which case the expense (Cost of Goods Sold account) is recognized at the customer invoice validation."
  });
}

// Products

@MetaModel.define()
class ProductTemplate extends Model {
  static _module = module;
  static _parents = "product.template";

  static taxesId = Fields.Many2many('account.tax', {
    relation: 'productTaxesRel', column1: 'prodId', column2: 'taxId', help: "Default taxes used when selling the product.", string: 'Customer Taxes',
    domain: [['typeTaxUse', '=', 'sale']], default: async (self) => (await self.env.company()).accountSaleTaxId
  });
  static taxString = Fields.Char({ compute: '_computeTaxString' });
  static supplierTaxesId = Fields.Many2many('account.tax', {
    relation: 'productSupplierTaxesRel', column1: 'prodId', column2: 'taxId', string: 'Vendor Taxes', help: 'Default taxes used when buying the product.',
    domain: [['typeTaxUse', '=', 'purchase']], default: async (self) => await (await self.env.company()).accountPurchaseTaxId
  });
  static propertyAccountIncomeId = Fields.Many2one('account.account', {
    companyDependent: true,
    string: "Income Account",
    domain: ACCOUNT_DOMAIN,
    help: "Keep this field empty to use the default value from the product category."
  });
  static propertyAccountExpenseId = Fields.Many2one('account.account', {
    companyDependent: true,
    string: "Expense Account",
    domain: ACCOUNT_DOMAIN,
    help: "Keep this field empty to use the default value from the product category. If anglo-saxon accounting with automated valuation method is configured, the expense account on the product category will be used."
  });
  static accountTagIds = Fields.Many2many({
    string: "Account Tags",
    comodelName: 'account.account.tag',
    domain: "[['applicability', '=', 'products']]",
    help: "Tags to be set on the base and tax journal items created for this product."
  });

  async _getProductAccounts() {
    const [propertyAccountIncomeId, propertyAccountExpenseId, categId] = await this('propertyAccountIncomeId', 'propertyAccountExpenseId', 'categId');
    return {
      'income': propertyAccountIncomeId.ok ? propertyAccountIncomeId : await categId.propertyAccountIncomeCategId,
      'expense': propertyAccountExpenseId.ok ? propertyAccountExpenseId : await categId.propertyAccountExpenseCategId
    }
  }

  async _getAssetAccounts() {
    const res = {};
    res['stockInput'] = false
    res['stockOutput'] = false
    return res;
  }

  async getProductAccounts(fiscalPos?: any) {
    const accounts = await this._getProductAccounts();
    if (!bool(fiscalPos)) {
      fiscalPos = this.env.items('account.fiscal.position');
    }
    return fiscalPos.mapAccounts(accounts);
  }

  @api.depends('taxesId', 'listPrice')
  async _computeTaxString() {
    for (const record of this) {
      await record.set('taxString', await record._constructTaxString(await record.listPrice));
    }
  }

  async _constructTaxString(price) {
    // const [currency, taxes] = await this('currencyId', 'taxesId');
    const currency = await this['currencyId'];
    const taxes = await this['taxesId'];
    const res = await taxes.computeAll(price, { product: this, partner: this.env.items('res.partner') });
    const joined = [];
    const included = res['totalIncluded'];
    if (await currency.compareAmounts(included, price)) {
      joined.push(await this._t('%s Incl. Taxes', await formatAmount(this.env, included, currency)));
    }
    const excluded = res['totalExcluded'];
    if (await currency.compareAmounts(excluded, price)) {
      joined.push(await this._t('%s Excl. Taxes', await formatAmount(this.env, excluded, currency)));
    }
    let taxString;
    if (joined.length) {
      taxString = `(= ${joined.join(', ')})`;
    }
    else {
      taxString = " ";
    }
    return taxString;
  }

  @api.constrains('uomId')
  async _checkUomNotInInvoice() {
    await this.env.items('product.template').flush(['uomId']);
    const res = await this._cr.execute(`
            SELECT "productTemplate".id
              FROM "accountMoveLine" line
              JOIN "productProduct" ON line."productId" = "productProduct".id
              JOIN "productTemplate" ON "productProduct"."productTemplateId" = "productTemplate".id
              JOIN "uomUom" "templateUom" ON "productTemplate"."uomId" = "templateUom".id
              JOIN "uomCategory" "templateUomCat" ON "templateUom"."categoryId" = "templateUomCat".id
              JOIN "uomUom" "lineUom" ON line."productUomId" = "lineUom".id
              JOIN "uomCategory" "lineUomCat" ON "lineUom"."categoryId" = "lineUomCat".id
             WHERE "productTemplate".id IN (%s)
               AND line."parentState" = 'posted'
               AND "templateUomCat".id != "lineUomCat".id
             LIMIT 1
        `, [String(this.ids) || 'NULL'])
    if (res.length) {
      throw new ValidationError(await this._t(
        `This product is already being used in posted Journal Entries.\n
                If you want to change its Unit of Measure, please archive this product and create a new one.`
      ));
    }
  }
}

@MetaModel.define()
class ProductProduct extends Model {
  static _module = module;
  static _parents = "product.product";

  static taxString = Fields.Char({ compute: '_computeTaxString' });

  async _getProductAccounts() {
    return await (await this['productTemplateId'])._getProductAccounts();
  }

  /**
   * Helper to get the price unit from different models.
      This is needed to compute the same unit price in different models (sale order, account move, etc.) with same parameters.
   * @param company 
   * @param currency 
   * @param documentDate 
   * @param documentType 
   * @param opts 
   */
  @api.model()
  async _getTaxIncludedUnitPrice(company, currency, documentDate, documentType, opts: {
    isRefundDocument?: boolean, productUom?: any, productCurrency?: any,
    productPriceUnit?: any, productTaxes?: any, fiscalPosition?: any
  } = {}) {
    let product: any = this;

    assert(documentType);

    const productUom = bool(opts.productUom) ? opts.productUom : await product.uomId;
    let productCurrency = opts.productCurrency;
    if (!bool(productCurrency)) {
      if (documentType === 'sale') {
        productCurrency = await product.currencyId;
      }
      else if (documentType === 'purchase') {
        productCurrency = await company.currencyId;
      }
    }
    let productPriceUnit = opts.productPriceUnit;
    if (productPriceUnit == null) {
      if (documentType === 'sale') {
        productPriceUnit = await (await product.withCompany(company)).lstPrice;
      }
      else if (documentType === 'purchase') {
        productPriceUnit = await (await product.withCompany(company)).standardPrice;
      }
      else {
        return 0.0;
      }
    }
    let productTaxes = opts.productTaxes;
    if (productTaxes == null) {
      if (documentType === 'sale') {
        productTaxes = await (await product.taxesId).filtered(async (x) => (await x.companyId).eq(company));
      }
      else if (documentType === 'purchase') {
        productTaxes = await (await product.supplierTaxesId).filtered(async (x) => (await x.companyId).eq(company));
      }
    }
    // Apply unit of measure.
    if (bool(productUom) && !(await product.uomId).eq(productUom)) {
      productPriceUnit = await (await product.uomId)._computePrice(productPriceUnit, productUom);
    }

    // Apply fiscal position.
    const fiscalPosition = opts.fiscalPosition;
    if (bool(productTaxes) && bool(fiscalPosition)) {
      const productTaxesAfterFp = await fiscalPosition.mapTax(productTaxes);
      const flattenedTaxesAfterFp = await productTaxesAfterFp._origin.flattenTaxesHierarchy();
      const flattenedTaxesBeforeFp = await productTaxes._origin.flattenTaxesHierarchy();
      const taxesBeforeIncluded = await flattenedTaxesBeforeFp.all(tax => tax.priceInclude);

      if (_.difference(productTaxes.ids, productTaxesAfterFp.ids) && taxesBeforeIncluded) {
        const taxesRes = await flattenedTaxesBeforeFp.computeAll(
          productPriceUnit,
          {
            quantity: 1.0,
            currency: currency,
            product: product,
            isRefund: opts.isRefundDocument,
          });
        productPriceUnit = taxesRes['totalExcluded'];

        if (await flattenedTaxesAfterFp.some(tax => tax.priceInclude)) {
          const taxesRes = await flattenedTaxesAfterFp.computeAll(
            productPriceUnit,
            {
              quantity: 1.0,
              currency: currency,
              product: product,
              isRefund: opts.isRefundDocument,
              handlePriceInclude: false,
            });
          for (const taxRes of taxesRes['taxes']) {
            const tax = this.env.items('account.tax').browse(taxRes['id']);
            if (await tax.priceInclude) {
              productPriceUnit += taxRes['amount'];
            }
          }
        }
      }
    }
    // Apply currency rate.
    if (!currency.eq(productCurrency)) {
      productPriceUnit = await productCurrency._convert(productPriceUnit, currency, company, documentDate);
    }
    return productPriceUnit;
  }

  @api.depends('lstPrice', 'productTemplateId', 'taxesId')
  async _computeTaxString() {
    for (const record of this) {
      await record.set('taxString', await (await record.productTemplateId)._constructTaxString(await record.lstPrice));
    }
  }
}