import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { _f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountAnalyticAccount extends Model {
  static _module = module;
  static _parents = 'account.analytic.account';

  static invoiceCount = Fields.Integer("Invoice Count", { compute: '_computeInvoiceCount' });
  static vendorBillCount = Fields.Integer("Vendor Bill Count", { compute: '_computeVendorBillCount' });

  @api.constrains('companyId')
  async _checkCompanyConsistency() {
    const analyticAccounts = await this.filtered('companyId');

    if (!bool(analyticAccounts)) {
      return;
    }

    await this.flush(['companyId']);
    const res = await this._cr.execute(`
            SELECT line.id
            FROM "accountMoveLine" line
            JOIN "accountAnalyticAccount" account ON account.id = line."analyticAccountId"
            WHERE line."analyticAccountId" IN (%s)
            AND line."companyId" != account."companyId"
        `, [String(analyticAccounts.ids)])

    if (res.length) {
      throw new UserError(await this._t("You can't set a different company on your analytic account since there are some journal items linked to it."));
    }
  }

  @api.depends('lineIds')
  async _computeInvoiceCount() {
    const saleTypes = await this.env.items('account.move').getSaleTypes();
    const domain = [
      ['parentState', '=', 'posted'],
      ['moveId.moveType', 'in', saleTypes],
      ['analyticAccountId', 'in', this.ids]
    ];
    const groups = await this.env.items('account.move.line').readGroup(domain, ['moveId:count_distinct'], ['analyticAccountId']);
    const movesCountMapping = Object.fromEntries(groups.map(g => [g['analyticAccountId'][0], g['moveId']]));
    for (const account of this) {
      await account.set('invoiceCount', movesCountMapping[account.id] || 0);
    }
  }

  @api.depends('lineIds')
  async _computeVendorBillCount() {
    const purchaseTypes = await this.env.items('account.move').getPurchaseTypes();
    const domain = [
      ['parentState', '=', 'posted'],
      ['moveId.moveType', 'in', purchaseTypes],
      ['analyticAccountId', 'in', this.ids]
    ];
    const groups = this.env.items('account.move.line').readGroup(domain, ['moveId:count_distinct'], ['analyticAccountId']);
    const movesCountMapping = Object.fromEntries(groups.map(g => [g['analyticAccountId'][0], g['moveId']]));
    for (const account of this) {
      await account.set('vendorBillCount', movesCountMapping[account.id] || 0);
    }
  }

  async actionViewInvoice() {
    this.ensureOne();
    const result = {
      "type": "ir.actions.actwindow",
      "resModel": "account.move",
      "domain": [['id', 'in', (await (await (await this['lineIds']).moveId).moveId).ids], ['moveType', 'in', await this.env.items('account.move').getSaleTypes()]],
      "context": { "create": false, 'default_moveType': 'outInvoice' },
      "label": await this._t("Customer Invoices"),
      'viewMode': 'tree,form',
    }
    return result;
  }

  async actionViewVendorBill() {
    this.ensureOne();
    const result = {
      "type": "ir.actions.actwindow",
      "resModel": "account.move",
      "domain": [['id', 'in', (await (await (await this['lineIds']).moveId).moveId).ids], ['moveType', 'in', await this.env.items('account.move').getPurchaseTypes()]],
      "context": { "create": false, 'default_moveType': 'inInvoice' },
      "label": await this._t("Vendor Bills"),
      'viewMode': 'tree,form',
    }
    return result;
  }
}

@MetaModel.define()
class AccountAnalyticTag extends Model {
  static _module = module;
  static _parents = 'account.analytic.tag';

  @api.constrains('companyId')
  async _checkCompanyConsistencyself() {
    const analyticTags = await this.filtered('companyId');

    if (!bool(analyticTags)) {
      return;
    }

    await this.flush(['companyId']);
    const res = await this._cr.execute(`
            SELECT line.id
            FROM "accountAnalyticTagAccountMoveLineRel" tagrel
            JOIN "accountAnalyticTag" tag ON tag.id = tagrel."accountAnalyticTagId"
            JOIN "accountMoveLine" line ON line.id = tagrel."accountMoveLineId"
            WHERE tagrel."accountAnalyticTagId" IN (%s)
            AND line."companyId" != tag."companyId"
        `, [String(analyticTags.ids)]);

    if (res.length) {
      throw new UserError(await this._t("You can't set a different company on your analytic tags since there are some journal items linked to it."));
    }
  }
}

@MetaModel.define()
class AccountAnalyticLine extends Model {
  static _module = module;
  static _parents = 'account.analytic.line';
  static _description = 'Analytic Line';

  static productId = Fields.Many2one('product.product', { string: 'Product', checkCompany: true });
  static generalAccountId = Fields.Many2one('account.account', { string: 'Financial Account', ondelete: 'RESTRICT', readonly: true, related: 'moveId.accountId', store: true, domain: "[['deprecated', '=', false], ['companyId', '=', companyId]]", computeSudo: true });
  static moveId = Fields.Many2one('account.move.line', { string: 'Journal Item', ondelete: 'CASCADE', index: true, checkCompany: true });
  static code = Fields.Char({ size: 8 });
  static ref = Fields.Char({ string: 'Ref.' });
  static category = Fields.Selection({ selectionAdd: [['invoice', 'Customer Invoice'], ['vendorBill', 'Vendor Bill']] });

  @api.onchange('productId', 'productUomId', 'unitAmount', 'currencyId')
  async onchangeUnitAmount() {
    const productId = await this['productId'];
    if (!productId.ok) {
      return {};
    }
    let [currencyId, companyId, unit, unitAmount] = await this('currencyId', 'companyId', 'productUomId', 'unitAmount');
    let result = 0.0;
    const prodAccounts = await (await (await productId.productTemplateId).withCompany(companyId))._getProductAccounts();
    const account = prodAccounts['expense'];
    if (!unit.ok || (await (await productId.uomPoId).categoryId).id != (await unit.categoryId).id) {
      unit = await productId.uomPoId;
    }

    // Compute based on pricetype
    const amountUnit = (await productId.priceCompute('standardPrice', unit))[productId.id];
    const amount = amountUnit * unitAmount || 0.0;
    result = (currencyId.ok ? await currencyId.round(amount) : Number(amount.toFixed(2))) * -1;
    // await Promise.all([
    await this.set('amount', result),
      await this.set('generalAccountId', account),
      await this.set('productUomId', unit)
    // ]);
  }

  @api.model()
  async viewHeaderGet(viewId, viewType) {
    if (this.env.context['accountId']) {
      return _f(await this._t("Entries: {account}"),
        { account: await this.env.items('account.analytic.account').browse(this.env.context['accountId']).label }
      );
    }
    return _super(AccountAnalyticLine, this).viewHeaderGet(viewId, viewType);
  }
}