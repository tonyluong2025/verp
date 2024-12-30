import _ from "lodash";
import { api } from "../../../core";
import { setdefault } from "../../../core/api/func";
import { Fields, _Date, _Datetime } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { _f, f, formatDatetime, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { floatRound } from "../../../core/tools/float_utils";
import { formatAmount, formatLang, getLang } from "../../../core/tools/models";

@MetaModel.define()
class Pricelist extends Model {
  static _module = module;
  static _name = "product.pricelist";
  static _description = "Pricelist";
  static _order = "sequence asc, id desc";

  async _getDefaultCurrencyId() {
    return (await (await this.env.company()).currencyId).id
  }

  static label = Fields.Char('Pricelist Name', {required: true, translate: true});
  static active = Fields.Boolean('Active', {default: true, help: "If unchecked, it will allow you to hide the pricelist without removing it."});
  static itemIds = Fields.One2many('product.pricelist.item', 'pricelistId', { string: 'Pricelist Rules', copy: true});
  static currencyId = Fields.Many2one('res.currency', {string: 'Currency', default: async (self) => self._getDefaultCurrencyId(), required: true});
  static companyId = Fields.Many2one('res.company', {string: 'Company'});

  static sequence = Fields.Integer({default: 16});
  static countryGroupIds = Fields.Many2many('res.country.group', {relation: 'resCountryGroupPricelistRel', column1: 'pricelistId', column2: 'resCountryGroupId', string: 'Country Groups'});

  static discountPolicy = Fields.Selection([
    ['withDiscount', 'Discount included in the price'],
    ['withoutDiscount', 'Show public price & discount to the customer']],
    {default: 'withDiscount', required: true});

  async nameGet() {
    const res = [];
    for (const pricelist of this) {
      res.push([pricelist.id, f('%s (%s)', await pricelist.label, await (await pricelist.currencyId).label)]);
    }
    return res;
  }

  @api.model()
  async _nameSearch(name, args: any[]=null, operator='ilike', {limit=100, nameGetUid=false}={}) {
    if (name && operator === '=' && !args) {
      // search on the name of the pricelist and its currency, opposite of nameGet(),
      // Used by the magic context filter in the product search view.
      const queryArgs = {'label': name, 'limit': limit, 'lang': await (await getLang(this.env)).code}
      let query = `
        SELECT p.id
          FROM ((
              SELECT pr.id, pr.label
              FROM "productPricelist" pr JOIN
                "resCurrency" cur ON
                    (pr."currencyId" = cur.id)
              WHERE pr.label || ' (' || cur.label || ')' = {label}
            )
            UNION (
              SELECT tr."resId" as id, tr.value as label
              FROM "irTranslation" tr JOIN
                "productPricelist" pr ON (
                  pr.id = tr."resId" AND
                  tr.type = 'model' AND
                  tr.label = 'product.pricelist,label' AND
                  tr.lang = {lang}
                ) JOIN
                "resCurrency" cur ON
                  (pr."currencyId" = cur.id)
              WHERE tr.value || ' (' || cur.label || ')' = {label}
            )
          ) p
          ORDER BY p.label`
      if (limit) {
        query += " LIMIT {limit}";
      }
      const res = await this._cr.execute(_f(query, queryArgs));
      const ids = res.map(r => r['id']);
      // regular search() to apply ACLs - may limit results below limit in some cases
      const pricelistIds = await this._search([['id', 'in', ids]], {limit, accessRightsUid: nameGetUid});
      if (bool(pricelistIds)) {
        return pricelistIds;
      }
    }
    return _super(Pricelist, this)._nameSearch(name, args, operator, {limit, nameGetUid});
  }

  /**
   * Low-level method - Multi pricelist, multi products
    Returns: dict{productId: dict{pricelistId: (price, suitable_rule)} }
   * @param productsQtyPartner 
   * @param date 
   * @param uomId 
   */
  async _computePriceRuleMulti(productsQtyPartner, date?: any, uomId?: any) {
    let pricelists;
    if (! bool(this.ids)) {
      pricelists = await this.search([]);
    }
    else {
      pricelists = this;
    }
    const results = {};
    for (const pricelist of pricelists) {
      const subres = await pricelist._computePriceRule(productsQtyPartner, date, uomId);
      for (const [productId, price] of Object.entries(subres)) {
        setdefault(results, productId, {});
        results[productId][pricelist.id] = price;
      }
    }
    return results;
  }

  async _computePriceRuleGetItems(productsQtyPartner, date, uomId, prodTmplIds, prodIds, categIds) {
    this.ensureOne();
    // Load all rules
    await this.env.items('product.pricelist.item').flush(['price', 'currencyId', 'companyId', 'active']);
    const res = await this.env.cr.execute(`
      SELECT
        item.id
      FROM
        "productPricelistItem" AS item
      LEFT JOIN "productCategory" AS categ ON item."categId" = categ.id
      WHERE
        (item."productTemplateId" IS NULL OR item."productTemplateId" IN (%s))
        AND (item."productId" IS NULL OR item."productId" IN (%s))
        AND (item."categId" IS NULL OR item."categId" IN (%s))
        AND (item."pricelistId" = %s)
        AND (item."dateStart" IS NULL OR item."dateStart"<='%s')
        AND (item."dateEnd" IS NULL OR item."dateEnd">='%s')
        AND (item.active = TRUE)
      ORDER BY
        item."appliedOn", item."minQuantity" desc, categ."completeName" desc, item.id desc
      `, [String(prodTmplIds) || 'null', String(prodIds) || 'null', String(categIds) || 'null', this.id, date.toISOString(), date.toISOString()]);
    // NOTE: if you change `order by` on that query, make sure it matches _order from model to avoid inconstencies and undeterministic issues.

    const itemIds = res.map(x => x['id']);
    return this.env.items('product.pricelist.item').browse(itemIds);
  }

  /**
   * Low-level method - Mono pricelist, multi products
    Returns: dict{productId: (price, suitable_rule) for the given pricelist}

    Date in context can be a date, datetime, ...

    :param products_qty_partner: list of typles products, quantity, partner
    :param datetime date: validity date
    :param ID uomId: intermediate unit of measure
   * @param productsQtyPartner 
   * @param date 
   * @param uomId 
   */
  async _computePriceRule(productsQtyPartner, date?: any, uomId?: any) {
    this.ensureOne();
    if (! date) {
      date = this._context['date'] ?? _Datetime.now();
    }
    if (!uomId && this._context['uom']) {
      uomId = this._context['uom'];
    }
    let products;
    if (uomId) {
      // rebrowse with uom if given
      products = [];
      for (const item of productsQtyPartner) {
        products.push(await item[0].withContext({uom: uomId}));
      }
      productsQtyPartner = productsQtyPartner.map((dataStruct, index) => [products[index], dataStruct[1], dataStruct[2]]);
    }
    else {
      products = productsQtyPartner.map(item => item[0]);
    }

    if (!bool(products)) {
      return {};
    }

    let categIds: any = {};
    for (const p of products) {
      let categ = await p.categId
      while (categ.ok) {
        categIds[categ.id] = true;
        categ = await categ.parentId
      }
    }
    categIds = Object.keys(categIds);

    let prodIds, prodTmplIds;
    const isProductTemplate = products[0]._name === "product.template";
    if (isProductTemplate) {
      // all variants of all products
      prodIds = [];
      for (const t of products) {
        for (const p of await t.productVariantIds) {
          prodIds.push(p.id);
        }
      }
      prodTmplIds = await products.map(tmpl => tmpl.id);
    }
    else {
      prodIds = await products.map(product => product.id);
      prodTmplIds = await Promise.all(products.map(async (product) => (await product.productTemplateId).id));
    }

    const items = await this._computePriceRuleGetItems(productsQtyPartner, date, uomId, prodTmplIds, prodIds, categIds);

    const results = {};
    for (const [product, qty, partner] of productsQtyPartner) {
      results[product.id] = 0.0;
      let suitableRule;

      // Final unit price is computed according to `qty` in the `qtyUomId` UoM.
      // An intermediary unit price may be computed according to a different UoM, in
      // which case the price_uom_id contains that UoM.
      // The final price will be converted to match `qtyUomId`.
      const uomId = await product.uomId;
      const qtyUomId = this._context['uom'] ?? uomId.id;
      let qtyInProductUom = qty;
      if (qtyUomId != uomId.id) {
        try {
          qtyInProductUom = await this.env.items('uom.uom').browse([this._context['uom']])._computeQuantity(qty, await product.uomId);
        } catch(e) {
        // except UserError:
          // Ignored - incompatible UoM in context, use default product UoM
          // pass
        }
      }
      // if Public user try to access standard price from website sale, need to call price_compute.
      // TDE SURPRISE: product can actually be a template
      let price = (await product.priceCompute('listPrice'))[product.id];

      const priceUom = this.env.items('uom.uom').browse([qtyUomId]);
      const currencyId = await (this as any).currencyId;
      const company = await this.env.company();
      for (const rule of items) {
        if (! rule._isApplicableFor(product, qtyInProductUom)) {
          continue;
        }
        const basePricelistId = await rule.basePricelistId;
        if (await rule.base === 'pricelist' && bool(basePricelistId)) {
          const priceTmp = (await basePricelistId._computePriceRule([[product, qty, partner]], date, uomId))[product.id][0];  // TDE: 0 = price, 1 = rule
          price = await (await basePricelistId.currencyId)._convert(priceTmp, currencyId, company, date, {round: false});
        }
        else {
          // if base option is public price take sale price else cost price of product
          // price_compute returns the price in the context UoM, i.e. qty_uom_id
          price = (await product.priceCompute(await rule.base))[product.id];
        }

        if (price != false) {
          // pass the date through the context for further currency conversions
          const ruleWithDateContext = await rule.withContext({date: date});
          price = await ruleWithDateContext._computePrice(price, priceUom, product, qty, partner);
          suitableRule = rule;
        }
        break;
      }
      // Final price conversion into pricelist currency
      if (bool(suitableRule) && await suitableRule.computePrice != 'fixed' && await suitableRule.base != 'pricelist') {
        let cur;
        if (await suitableRule.base === 'standardPrice') {
          cur = await product.costCurrencyId;
        }
        else {
          cur = await product.currencyId;
        }
        price = await cur._convert(price, currencyId, company, date, {round: false});
      }

      if (!bool(suitableRule)) {
        const cur = await product.currencyId;
        price = await cur._convert(price, currencyId, company, date, {round: false});
      }

      results[product.id] = [price, bool(suitableRule) ? suitableRule.id : false];
    }
    return results;
  }

  /**
   * For a given pricelist, return price for products
    Returns: dict{productId: product price}, in the given pricelist 
   * @param products 
   * @param quantities 
   * @param partners 
   * @param date 
   * @param uomId 
   * @returns 
   */
  async getProductsPrice(products, quantities, partners, date?: any, uomId?: any) {
    this.ensureOne();
    const res = {};
    for (const [productId, resTuple] of Object.entries(await this._computePriceRule(_.zip([...products], [...quantities], [...partners]), date, uomId
    ))) {
      res[productId] = resTuple[0];
    }
    return res;
  }

  async getProductPrice(product, quantity, partner, date?: any, uomId?: any) {
    return (await this.getProductPriceRule(product, quantity, partner, date, uomId))[0];
  }

  /**
   * For a given pricelist, return price for a given product
   * @param product 
   * @param quantity 
   * @param partner 
   * @param date 
   * @param uomId 
   * @returns 
   */
  async getProductPriceRule(product, quantity, partner, date?: any, uomId?: any) {
    this.ensureOne();
    return (await this._computePriceRule([[product, quantity, partner]], date, uomId))[product.id];
  }

  /**
   * Multi pricelist, mono product - returns price per pricelist
   * @param prodId 
   * @param qty 
   * @param partner 
   * @returns 
   */
  async priceGet(prodId, qty, partner?: any) {
    const res = {};
    for (const [key, price] of Object.entries(await (this as any).priceRuleGet(prodId, qty, partner))) {
      res[key] = price[0]; 
    }
  }

  /**
   * Multi pricelist, multi product  - return tuple
   * @param productsByQtyByPartner 
   * @returns 
   */
  async priceRuleGetMulti(productsByQtyByPartner) {
    return this._computePriceRuleMulti(productsByQtyByPartner);
  }

  /**
   * Multi pricelist, mono product - return tuple
   * @param prodId 
   * @param qty 
   * @param partner 
   * @returns 
   */
  async priceRuleGet(prodId, qty, partner?: any) {
    const product = this.env.items('product.product').browse([prodId]);
    return (await this._computePriceRuleMulti([[product, qty, partner]]))[prodId];
  }

  /**
   * Mono pricelist, multi product - return price per product
   * @param pricelist 
   * @param productsByQtyByPartner 
   * @returns 
   */
  @api.model()
  async _priceGetMulti(pricelist, productsByQtyByPartner) {
    return pricelist.getProductsPrice(
      _.zip(...productsByQtyByPartner)
    )
  }

  async _getPartnerPricelistMultiSearchDomainHook(req, companyId) {
    return [
      ['active', '=', true],
      ['companyId', 'in', [companyId, false]],
    ]
  }

  async _getPartnerPricelistMultiFilterHook(req) {
    return this.filtered('active');
  }

  
  async _getPartnerPricelistMulti(req, partnerIds, companyId?: any) {
    // `partnerIds` might be ID from inactive uers. We should use activeTest as we will do a search() later (real case for website public user).
    const Partner = await this.env.items('res.partner').withContext({activeTest: false});
    companyId = companyId ?? (await this.env.company()).id;

    const Property = await this.env.items('ir.property').withCompany(companyId);
    const pricelist = this.env.items('product.pricelist');
    const plDomain = await this._getPartnerPricelistMultiSearchDomainHook(req, companyId);

    // if no specific property, try to find a fitting pricelist
    const result = await Property._getMulti('propertyProductPricelist', Partner._name, partnerIds);

    const remainingPartnerIds = [];
    for (const [pid, val] of Object.entries<any>(result)) {
      if (!bool(val) || !bool(await val._getPartnerPricelistMultiFilterHook(req))) {
        remainingPartnerIds.push(pid);
      }
    }
    if (remainingPartnerIds.length) {
      // get fallback pricelist when no pricelist for a given country
      let plFallback = await pricelist.search(plDomain.concat([['countryGroupIds', '=', false]]), {limit: 1});
      plFallback = bool(plFallback) ? plFallback : 
        await Property._get('propertyProductPricelist', 'res.partner');
      plFallback = bool(plFallback) ? plFallback :
        await pricelist.search(plDomain, {limit: 1});
      // group partners by country, and find a pricelist for each country
      const domain = [['id', 'in', remainingPartnerIds]];
      const groups = await Partner.readGroup(domain, ['countryId'], ['countryId']);
      for (const group of groups) {
        const countryId = group['countryId'] && group['countryId'][0];
        let pl = await pricelist.search(plDomain.concat([['countryGroupIds.countryIds', '=', countryId]]), {limit: 1});
        pl = bool(pl) ? pl : plFallback;
        for (const pid of (await Partner.search(group['__domain'])).ids) {
          result[pid] = pl;
        }
      }
    }
    return result;
  }

  @api.model()
  async getImportTemplates() {
    return [{
      'label': await this._t('Import Template for Pricelists'),
      'template': '/product/static/xls/product_pricelist.xls'
    }]
  }

  @api.ondelete(false)
  async _unlinkExceptUsedAsRuleBase() {
    const linkedItems = await (await (await this.env.items('product.pricelist.item').sudo()).withContext({activeTest: false})).search([
      ['base', '=', 'pricelist'],
      ['basePricelistId', 'in', this.ids],
      ['pricelistId', 'not in', this.ids],
    ])
    if (linkedItems) {
      const [pricelistId, basePricelistId] = await linkedItems('pricelistId', 'basePricelistId');
      throw new UserError(await this._t(
        'You cannot delete those pricelist(s):\n(%s)\n, they are used in other pricelist(s):\n%s',
        (await basePricelistId.mapped('displayName')).join('\n'),
        (await pricelistId.mapped('displayName')).join('\n')
      ))
    }
  }
}

@MetaModel.define()
class ResCountryGroup extends Model {
  static _module = module;
  static _parents = 'res.country.group';

  static pricelistIds = Fields.Many2many('product.pricelist', {relation: 'resCountryGroupPricelistRel', column1: 'resCountryGroupId', column2: 'pricelistId', string: 'Pricelists'})
}

@MetaModel.define()
class PricelistItem extends Model {
  static _module = module;
  static _name = "product.pricelist.item";
  static _description = "Pricelist Rule";
  static _order = "appliedOn, minQuantity desc, categId desc, id desc";
  static _checkCompanyAuto = true;
  // NOTE: if you change _order on this model, make sure it matches the SQL query built in _computePriceRule() above in this file to avoid inconstencies and undeterministic issues.

  async _defaultPricelistId() {
    return this.env.items('product.pricelist').search([
      '|', ['companyId', '=', false],
      ['companyId', '=', (await this.env.company()).id]], {limit: 1})
  }

  static productTemplateId = Fields.Many2one(
      'product.template', {string: 'Product', ondelete: 'CASCADE', checkCompany: true,
      help: "Specify a template if this rule only applies to one product template. Keep empty otherwise."});
  static productId = Fields.Many2one(
      'product.product', {string: 'Product Variant', ondelete: 'CASCADE', checkCompany: true,
      help: "Specify a product if this rule only applies to one product. Keep empty otherwise."})
  static categId = Fields.Many2one(
      'product.category', {string: 'Product Category', ondelete: 'CASCADE',
      help: "Specify a product category if this rule only applies to products belonging to this category or its children categories. Keep empty otherwise."})
  static minQuantity = Fields.Float(
      'Min. Quantity', {default: 0, digits: "Product Unit Of Measure",
      help: "For the rule to apply, bought/sold quantity must be greater than or equal to the minimum quantity specified in this field.\nExpressed in the default unit of measure of the product."})
  static appliedOn = Fields.Selection([
      ['3_global', 'All Products'],
      ['2_productCategory', 'Product Category'],
      ['1_product', 'Product'],
      ['0_productVariant', 'Product Variant']], {string: "Apply On",
      default: '3_global', required: true,
      help: 'Pricelist Item applicable on selected option'})
  static base = Fields.Selection([
      ['listPrice', 'Sales Price'],
      ['standardPrice', 'Cost'],
      ['pricelist', 'Other Pricelist']], {string: "Based on",
      default: 'listPrice', required: true,
      help: 'Base price for computation.\nSales Price: The base price will be the Sales Price.\nCost Price : The base price will be the cost price.\nOther Pricelist : Computation of the base price based on another Pricelist.'})
  static basePricelistId = Fields.Many2one('product.pricelist', {string: 'Other Pricelist', checkCompany: true})
  static pricelistId = Fields.Many2one('product.pricelist', {string: 'Pricelist', index: true, ondelete: 'CASCADE', required: true, default: self => self._defaultPricelistId()})
  static priceSurcharge = Fields.Float(
      'Price Surcharge', {digits: 'Product Price',
      help: 'Specify the fixed amount to add or substract(if negative) to the amount calculated with the discount.'})
  static priceDiscount = Fields.Float(
      'Price Discount', {default: 0, digits: [16, 2],
      help: "You can apply a mark-up by setting a negative discount."})
  static priceRound = Fields.Float(
      'Price Rounding', {digits: 'Product Price',
      help: "Sets the price so that it is a multiple of this value.\nRounding is applied after the discount and before the surcharge.\nTo have prices that end in 9.99, set rounding 10, surcharge -0.01"});
  static priceMinMargin = Fields.Float(
      'Min. Price Margin', {digits: 'Product Price',
      help: 'Specify the minimum amount of margin over the base price.'})
  static priceMaxMargin = Fields.Float(
      'Max. Price Margin', {digits: 'Product Price',
      help: 'Specify the maximum amount of margin over the base price.'})
  static companyId = Fields.Many2one(
      'res.company', {string: 'Company',
      readonly: true, related: 'pricelistId.companyId', store: true})
  static currencyId = Fields.Many2one(
      'res.currency', {string: 'Currency',
      readonly: true, related: 'pricelistId.currencyId', store: true})
  static active = Fields.Boolean(
      {readonly: true, related: "pricelistId.active", store: true});
  static dateStart = Fields.Datetime('Start Date', {help: "Starting datetime for the pricelist item validation\n The displayed value depends on the timezone set in your preferences."})
  static dateEnd = Fields.Datetime('End Date', {help: "Ending datetime for the pricelist item validation\nThe displayed value depends on the timezone set in your preferences."})
  static computePrice = Fields.Selection([
      ['fixed', 'Fixed Price'],
      ['percentage', 'Discount'],
      ['formula', 'Formula']], {index: true, default: 'fixed', required: true})
  static fixedPrice = Fields.Float('Fixed Price', {digits: 'Product Price'})
  static percentPrice = Fields.Float(
      'Percentage Price',
      {help: "You can apply a mark-up by setting a negative discount."})
  // functional fields used for usability purposes
  static label = Fields.Char(
      'Name', {compute: '_getPricelistItemNamePrice',
      help: "Explicit rule name for this pricelist line."})
  static price = Fields.Char(
      'Price', {compute: '_getPricelistItemNamePrice',
      help: "Explicit rule name for this pricelist line."})
  static ruleTip = Fields.Char({compute: '_computeRuleTip'})

  @api.constrains('basePricelistId', 'pricelistId', 'base')
  async _checkRecursion(parent?: any): Promise<boolean> {
    for (const item of this) {
      const pricelistId = await item.pricelistId;
      if (await item.base === 'pricelist' && bool(pricelistId) && pricelistId == await item.basePricelistId) {
        throw new ValidationError(await this._t('You cannot assign the Main Pricelist as Other Pricelist in PriceList Item'));
      }
    }
    return true;
  }

  @api.constrains('dateStart', 'dateEnd')
  async _checkDaterange() {
    for (const item of this) {
      const [dateStart, dateEnd] = await item('dateStart', 'dateEnd');
      if (dateStart && dateEnd && dateStart >= dateEnd) {
        throw new ValidationError(await this._t('%s : end date (%s) should be greater than start date (%s)', await item.displayName, await formatDatetime(this.env, dateEnd), await formatDatetime(this.env, dateStart)))
      }
    }
    return true;
  }

  @api.constrains('priceMinMargin', 'priceMaxMargin')
  async _checkMargin() {
    for (const item of this) {
      if (await item.priceMinMargin > await item.priceMaxMargin) {
        throw new ValidationError(await this._t('The minimum margin should be lower than the maximum margin.'));
      }
    }
  }

  @api.constrains('productId', 'productTemplateId', 'categId')
  async _checkProductConsistency() {
    for (const item of this) {
      const appliedOn = await item.appliedOn;
      if (appliedOn === "2_productCategory" && !bool(await item.categId)) {
        throw new ValidationError(await this._t("Please specify the category for which this rule should be applied"))
      }
      else if (appliedOn === "1_product" && !bool(await item.productTemplateId)) {
        throw new ValidationError(await this._t("Please specify the product for which this rule should be applied"))
      }
      else if (appliedOn === "0_productVariant" && ! bool(await item.productId)) {
        throw new ValidationError(await this._t("Please specify the product variant for which this rule should be applied"))
      }
    }
  }

  @api.depends('appliedOn', 'categId', 'productTemplateId', 'productId', 'computePrice', 'fixedPrice', 'pricelistId', 'percentPrice', 'priceDiscount', 'priceSurcharge')
  async _getPricelistItemNamePrice() {
    for (const item of this) {
      const appliedOn = await item.appliedOn;
      if (bool(await item.categId) && appliedOn === '2_productCategory') {
        await item.set('label', await this._t("Category: %s", await (await item.categId).displayName))
      }
      else if (bool(item.productTemplateId) && appliedOn === '1_product') {
        await item.set('label', await this._t("Product: %s", await (await item.productTemplateId).displayName))
      }
      else if (bool(await item.productId) && appliedOn === '0_productVariant') {
        await item.set('label', await this._t("Variant: %s", await (await item.productId).withContext({display_defaultCode: false}).displayName));
      }
      else {
        await item.set('label', await this._t("All Products"));
      }

      const computePrice = await item.computePrice;
      if (computePrice === 'fixed') {
        await item.set('price', await formatLang(item.env, await item.fixedPrice, {monetary: true, dp: "Product Price", currencyObj: await item.currencyId}));
      }
      else if (computePrice === 'percentage') {
        await item.set('price', await this._t("%s %% discount", await item.percentPrice))
      }
      else {
        await item.set('price', _f(await this._t("{percentage} % discount and {price} surcharge"), {percentage: await item.priceDiscount, price: await item.priceSurcharge}));
      }
    }
  }

  @api.dependsContext('lang')
  @api.depends('computePrice', 'priceDiscount', 'priceSurcharge', 'base', 'priceRound')
  async _computeRuleTip() {
    const baseSelectionVals = Object.fromEntries(await this._fields['base']._descriptionSelection(this._fields['base'], this.env));
    await this.set('ruleTip', false);
    for (const item of this) {
      if (await item.computePrice !== 'formula') {
        continue;
      }
      let baseAmount = 100;
      const [currencyId, priceSurcharge, priceDiscount, priceRound] = await item(['currencyId', 'priceSurcharge', 'priceDiscount', 'priceRound']);
      const discountFactor = (100 - priceDiscount) / 100;
      let discountedPrice = baseAmount * discountFactor;
      if (priceRound) {
        discountedPrice = floatRound(discountedPrice, {precisionRounding: priceRound});
      }
      const surcharge = await formatAmount(item.env, priceSurcharge, currencyId);
      await item.set('ruleTip', _f(await this._t(
        `%(base)s with a %(discount)s %% discount and %(surcharge)s extra fee\n
        Example: %(amount)s * %(discount_charge)s + %(priceSurcharge)s → %(total_amount)s`),
        {base: baseSelectionVals[item.base],
        discount: priceDiscount,
        surcharge: surcharge,
        amount: await formatAmount(item.env, 100, currencyId),
        discountCharge: discountFactor,
        priceSurcharge: surcharge,
        totalAmount: formatAmount(
          item.env, discountedPrice + priceSurcharge, currencyId),
        }
      ));
    }
  }

  @api.onchange('computePrice')
  async _onchangeComputePrice() {
    const computePrice = await (this as any).computePrice;
    if (computePrice !== 'fixed') {
      await this.set('fixedPrice', 0.0);
    }
    if (computePrice !== 'percentage') {
      await this.set('percentPrice', 0.0);
    }
    if (computePrice !== 'formula') {
      await this.update({
        'base': 'listPrice',
        'priceDiscount': 0.0,
        'priceSurcharge': 0.0,
        'priceRound': 0.0,
        'priceMinMargin': 0.0,
        'priceMaxMargin': 0.0,
      });
    }
  }

  @api.onchange('productId')
  async _onchangeProductId() {
    const hasProductId = await this.filtered('productId');
    for (const item of hasProductId) {
      await item.update({'productTemplateId': await (await item.productId).productTemplateId});
    }
    if (this.env.context['default_appliedOn'] === '1_product') {
      // If a product variant is specified, apply on variants instead
      // Reset if product variant is removed
      await hasProductId.update({'appliedOn': '0_productVariant'});
      await this.sub(hasProductId).update({'appliedOn': '1_product'});
    }
  }

  @api.onchange('productTemplateId')
  async _onchangeProductTemplateId() {
    const hasTmplId = await this.filtered('productTemplateId');
    for (const item of hasTmplId) {
      const productId = await item.productId;
      if (productId.ok && !(await productId.productTemplateId).eq(await item.productTemplateId)) {
        await item.set('productId', null);
      }
    }
  }

  @api.onchange('productId', 'productTemplateId', 'categId')
  async _onchangeRuleContent() {
    if (! await this.userHasGroups('product.groupSalePricelist') && !(this.env.context['default_appliedOn'] ?? false)) {
      // If advanced pricelists are disabled (applied_on field is not visible)
      // AND we aren't coming from a specific product template/variant.
      const variantsRules = await this.filtered('productId');
      const templateRules = await this.sub(variantsRules).filtered('productTemplateId');
      // await Promise.all([
        await variantsRules.update({'appliedOn': '0_productVariant'}),
        await templateRules.update({'appliedOn': '1_product'}),
        await this.sub(variantsRules).sub(templateRules).update({'appliedOn': '3_global'})
      // ]);
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const values of valsList) {
      if (values['appliedOn'] ?? false) {
        // Ensure item consistency for later searches.
        const appliedOn = values['appliedOn'];
        if (appliedOn === '3_global') {
          update(values, {productId: null, productTemplateId: null, categId: null});
        }
        else if (appliedOn === '2_productCategory') {
          update(values, {productId: null, productTemplateId: null});
        }
        else if (appliedOn === '1_product') {
          update(values, {productId: null, categId: null});
        }
        else if (appliedOn === '0_productVariant') {
          update(values, {categId: null});
        }
      }
    }
    return _super(PricelistItem, this).create(valsList);
  }

  async write(values) {
    if (values['appliedOn'] ?? false) {
      // Ensure item consistency for later searches.
      const appliedOn = values['appliedOn'];
      if (appliedOn === '3_global') {
        update(values, {productId: null, productTemplateId: null, categId: null});
      }
      else if (appliedOn === '2_productCategory') {
        update(values, {productId: null, productTemplateId: null});
      }
      else if (appliedOn === '1_product') {
        update(values, {productId: null, categId: null});
      }
      else if (appliedOn === '0_productVariant') {
        update(values, {categId: null});
      }
    }
    const res = await _super(PricelistItem, this).write(values);
    // When the pricelist changes we need the product.template price
    // to be invalided and recomputed.
    this.env.items('product.template').invalidateCache(['price']);
    this.env.items('product.product').invalidateCache(['price']);
    return res;
  }

  async toggleActive() {
    throw new ValidationError(await this._t("You cannot disable a pricelist rule, please delete it or archive its pricelist instead."));
  }

  /**
   * Check whether the current rule is valid for the given product & qty.
    Note: self.ensure_one()
    :param product: product record (product.product/product.template)
    :param float qty_in_product_uom: quantity, expressed in product UoM
    :returns: Whether rules is valid or not
    :rtype: bool
   * @param product 
   * @param qtyInProductUom 
   */
  async _isApplicableFor(product, qtyInProductUom) {
    this.ensureOne();
    product.ensureOne();
    let res = true;

    const self: any = this;
    const categId = await self.categId;
    const isProductTemplate = product.cls._name === 'product.template';
    const minQuantity = await self.minQuantity;
    if (minQuantity && qtyInProductUom < minQuantity) {
      res = false;
    }
    else if (categId.ok) {
      // Applied on a specific category
      let cat = await product.categId;
      while (cat.ok) {
        if (cat.id === categId.id) {
          break;
        }
        cat = await cat.parentId;
      }
      if (!cat.ok) {
        res = false;
      }
    }
    else {
      // Applied on a specific product template/variant
      const productTemplateId = await self.productTemplateId;
      const productId = await self.productId;
      if (isProductTemplate) {
        if (productTemplateId.ok && product.id != productTemplateId.id) {
          res = false;
        }
        else if (productId.ok && !(
          await product.productVariantCount == 1
          && (await product.productVariantId).id == productId.id
        )) {
          // product self acceptable on template if has only one variant
          res = false;
        }
      }
      else {
        if (productTemplateId.ok && (await product.productTemplateId).id != productTemplateId.id) {
          res = false;
        }
        else if (productId.ok && product.id != productId.id) {
          res = false;
        }
      }
    }
    return res;
  }

  /**
   * Compute the unit price of a product in the context of a pricelist application.
        The unused parameters are there to make the full context available for overrides.
   * @param price 
   * @param priceUom 
   * @param product 
   * @param quantity 
   * @param partner 
   */
  async _computePrice(price, priceUom, product, quantity=1.0, partner=false) {
    this.ensureOne();
    const self: any = this;
    const date = this.env.context['date'] ?? _Date.today();
    const convertToPriceUom = async (price) => (await product.uomId)._computePrice(price, priceUom);
    const computePrice = await self.computePrice;
    if (computePrice === 'fixed') {
      price = await convertToPriceUom(await self.fixedPrice);
    }
    else if (computePrice === 'percentage') {
      price = (price - (price * (await self.percentPrice / 100))) || 0.0;
    }
    else {
      // complete formula
      let priceLimit = price;
      let priceCurrency;
      price = (price - (price * (await self.priceDiscount / 100))) || 0.0;
      const base = await self.base;
      if (base === 'standardPrice') {
        priceCurrency = await product.costCurrencyId;
      }
      else if (base === 'pricelist') {
        priceCurrency = await self.currencyId;  // Already converted before to the pricelist currency
      }
      else {
        priceCurrency = await product.currencyId;
      }
      if (await self.priceRound) {
        price = floatRound(price, {precisionRounding: await self.priceRound});
      }

      async function convertToBasePriceCurrency(amount) {
        return (await self.currencyId)._convert(amount, priceCurrency, await self.env.company(), date, {round: false});
      }

      if (await self.priceSurcharge) {
        let priceSurcharge = await convertToBasePriceCurrency(await self.priceSurcharge);
        priceSurcharge = await convertToPriceUom(priceSurcharge);
        price += priceSurcharge;
      }

      if (await self.priceMinMargin) {
        let priceMinMargin = await convertToBasePriceCurrency(await self.priceMinMargin);
        priceMinMargin = await convertToPriceUom(priceMinMargin);
        price = Math.max(price, priceLimit + priceMinMargin);
      }

      if (await self.priceMaxMargin) {
        let priceMaxMargin = await convertToBasePriceCurrency(await self.priceMaxMargin);
        priceMaxMargin = await convertToPriceUom(priceMaxMargin);
        price = Math.min(price, priceLimit + priceMaxMargin);
      }
  }
    return price;
  }
}