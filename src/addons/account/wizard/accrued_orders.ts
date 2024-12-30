import { Command, Fields, _Date, _Float, api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models";
import { ellipsis, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { addDate, getMonth, subDate } from "../../../core/tools/date_utils";
import { len } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";
import { formatDate, formatLang } from "../../../core/tools/models";

@MetaModel.define()
class AccruedExpenseRevenue extends TransientModel {
  static _module = module;
  static _name = 'account.accrued.orders.wizard';
  static _description = 'Accrued Orders Wizard';

  static companyId = Fields.Many2one('res.company', { default: self => self._getDefaultCompany() });
  static journalId = Fields.Many2one({
    comodelName: 'account.journal',
    compute: '_computeJournalId',
    domain: "[['type', '=', 'general'], ['companyId', '=', companyId]]",
    readonly: false,
    required: true,
    default: self => self._getDefaultJournal(),
    checkCompany: true,
    companyDependent: true,
    string: 'Journal',
  });
  static date = Fields.Date({ default: self => self._getDefaultDate(), required: true });
  static reversalDate = Fields.Date({
    compute: "_computeReversalDate",
    required: true,
    readonly: false,
  })
  static amount = Fields.Monetary({
    string: 'Amount', help: "Specify an arbitrary value that will be accrued on a \
        default account for the entire order, regardless of the products on the different lines."});
  static currencyId = Fields.Many2one({
    related: 'companyId.currencyId', string: 'Company Currency',
    readonly: true, store: true,
    help: 'Utility field to express amount currency'
  });
  static accountId = Fields.Many2one({
    comodelName: 'account.account',
    required: true,
    string: 'Accrual Account',
    checkCompany: true,
    domain: (self) => self._getAccountDomain(),
  });
  static previewData = Fields.Text({ compute: '_computePreviewData' });
  static displayAmount = Fields.Boolean({ compute: '_computeDisplayAmount' });

  async _getAccountDomain() {
    if (this.env.context['activeModel'] === 'purchase.order') {
      return [['userTypeId', '=', (await this.env.ref('account.dataAccountTypeCurrentLiabilities')).id], ['companyId', '=', await this._getDefaultCompany()]];
    }
    else {
      return [['userTypeId', '=', (await this.env.ref('account.dataAccountTypeCurrentAssets')).id], ['companyId', '=', this._getDefaultCompany()]];
    }
  }

  async _getDefaultCompany() {
    if (!this._context['activeModel']) {
      return;
    }
    const orders = this.env.items(this._context['activeModel']).browse(this._context['Cactive_ids']);
    return orders.ok && (await orders[0].companyId).id;
  }

  async _getDefaultJournal() {
    return this.env.items('account.journal').search([['companyId', '=', (await this.env.company()).id], ['type', '=', 'general']], { limit: 1 });
  }

  async _getDefaultDate() {
    return subDate(getMonth(await _Date.contextToday(this))[0], { days: 1 });
  }

  @api.depends('date', 'amount')
  async _computeDisplayAmount() {
    const singleOrder = len(this._context['activeIds']) == 1;
    for (const record of this) {
      const previewData = JSON.parse(await this['previewData']);
      const lines = (previewData['groupsVals'] ?? [])[0]['itemsVals'] ?? [];
      await record.set('displayAmount', await record.amount || (singleOrder && !bool(lines)));
    }
  }

  @api.depends('date')
  async _computeReversalDate() {
    for (const record of this) {
      if (! await record.reversalDate || await record.reversalDate <= await record.date) {
        await record.set('reversalDate', addDate(await record.date, { days: 1 }));
      }
      else {
        await record.set('reversalDate', await record.reversalDate);
      }
    }
  }

  @api.depends('companyId')
  async _computeJournalId() {
    const journal = await this.env.items('account.journal').search(
      [['type', '=', 'general'], ['companyId', '=', (await this['companyId']).id]], { limit: 1 }
    );
    for (const record of this) {
      await record.set('journalId', journal);
    }
  }

  @api.depends('date', 'journalId', 'accountId', 'amount')
  async _computePreviewData() {
    for (const record of this) {
      const previewVals = [await this.env.items('account.move')._moveDictToPreviewVals(
        (await record._computeMoveVals())[0],
        await (await record.companyId).currencyId,
      )];
      const previewColumns = [
        { 'field': 'accountId', 'label': await this._t('Account') },
        { 'field': 'label', 'label': await this._t('Label') },
        { 'field': 'debit', 'label': await this._t('Debit'), 'class': 'text-right text-nowrap' },
        { 'field': 'credit', 'label': await this._t('Credit'), 'class': 'text-right text-nowrap' },
      ];
      await record.set('previewData', stringify({
        'groupsVals': previewVals,
        'options': {
          'columns': previewColumns,
        },
      }));
    }
  }

  async _getComputedAccount(order, product, isPurchase) {
    const accounts = await (await (await product.withCompany(await order.companyId)).productTemplateId).getProductAccounts({ fiscalPos: await order.fiscalPositionId });
    if (isPurchase) {
      return accounts['expense'];
    }
    else {
      return accounts['income'];
    }
  }

  async _computeMoveVals() {
    async function _getAmlVals(order, balance, amountCurrency, accountId, label = "") {
      if (!isPurchase) {
        balance *= -1;
        amountCurrency *= -1;
      }
      const values = {
        'label': label,
        'debit': balance > 0 ? balance : 0.0,
        'credit': balance < 0 ? balance * -1 : 0.0,
        'accountId': accountId,
      }
      const orderCurrency = await order.currencyId;
      if (len(order) == 1 && !(await (await this['companyId']).currencyId).eq(orderCurrency)) {
        update(values, {
          'amountCurrency': amountCurrency,
          'currencyId': orderCurrency.id,
        });
      }
      return values;
    }

    this.ensureOne();
    const moveLines = [];
    const [company, amount, date, account, journal] = await this('companyId', 'amount', 'date', 'accountId', 'journalId');
    const isPurchase = this.env.context['activeModel'] === 'purchase.order';
    const orders = (await this.env.items(this._context['activeModel']).withCompany(company)).browse(this._context['activeIds']);

    if ((await orders.filtered(async (o) => !(await o.companyId).eq(company))).ok) {
      throw new UserError(await this._t('Entries can only be created for a single company at a time.'));
    }

    const ordersWithEntries: any = [];
    let fnames = [];
    let totalBalance = 0.0;
    for (const order of orders) {
      const [orderCurrency, orderLine] = await order('currencyId', 'orderLine');
      if (len(orders) == 1 && amount && orderLine.ok) {
        totalBalance = amount;
        const line = orderLine[0];
        const account = await this._getComputedAccount(order, await line.productId, isPurchase);
        const values = await _getAmlVals(order, amount, 0, account.id, await this._t('Manual entry'));
        moveLines.push(Command.create(values));
      }
      else {
        const otherCurrency = !(await company.currencyId).eq(orderCurrency);
        const rate = otherCurrency ? (await orderCurrency._getRates(company, date))[orderCurrency.id] : 1.0;
        // create a virtual order that will allow to recompute the qty delivered/received (and dependancies)
        // without actually writing anything on the real record (field is computed and stored)
        const o = await order.new({}, { origin: order });
        const line = await o.orderLine;
        const lineCtx = await (await line.withContext({ accrualEntryDate: date }));
        if (isPurchase) {
          await lineCtx._computeQtyReceived();
          await lineCtx._computeQtyInvoiced();
        }
        else {
          await lineCtx._computeQtyDelivered();
          await lineCtx._computeQtyInvoiced();
          await lineCtx._computeUntaxedAmountInvoiced();
          await lineCtx._getToInvoiceQty();
        }
        const lines = await line.filtered(
          async (l) => !['lineSection', 'lineNote'].includes(await l.displayType) &&
            _Float.compare(
              await l.qtyToInvoice,
              0,
              { precisionRounding: await (await l.productUom).rounding },
            ) == 1
        );
        for (const oline of lines) {
          let account, amount, amountCurrency, label;
          if (isPurchase) {
            account = await this._getComputedAccount(order, await oline.productId, isPurchase);
            amount = await (await company.currencyId).round(await oline.qtyToInvoice * await oline.priceUnit / rate);
            amountCurrency = await (await oline.currencyId).round(await oline.qtyToInvoice * await oline.priceUnit);
            fnames = ['qtyToInvoice', 'qtyReceived', 'qtyInvoiced', 'invoiceLines'];
            label = await this._t('%s - %s; %s Billed, %s Received at %s each', await order.label, ellipsis(await oline.label, 20), await oline.qtyInvoiced, await oline.qtyReceived, await formatLang(this.env, await oline.priceUnit, { currencyObj: await order.currencyId }));
          }
          else {
            account = await this._getComputedAccount(order, await oline.productId, isPurchase);
            amount = await (await company.currencyId).round(await oline.untaxedAmountToInvoice / rate);
            amountCurrency = await oline.untaxedAmountToInvoice;
            fnames = ['qtyToInvoice', 'untaxedAmountToInvoice', 'qtyInvoiced', 'qtyDelivered', 'invoiceLines'];
            label = await this._t('%s - %s; %s Invoiced, %s Delivered at %s each', await order.label, ellipsis(await oline.label, 20), await oline.qtyInvoiced, await oline.qtyDelivered, await formatLang(this.env, await oline.priceUnit, { currencyObj: await order.currencyId }));
          }
          const values = await _getAmlVals(order, amount, amountCurrency, account.id, label);
          moveLines.push(Command.create(values));
          totalBalance += amount;
        }
        // must invalidate cache or o can mess when _create_invoices().action_post() of original order after this
        orderLine.invalidateCache(fnames);
      }
    }

    if (! await (await company.currencyId).isZero(totalBalance)) {
      // globalized counterpart for the whole orders selection
      const values = _getAmlVals(orders, -totalBalance, 0.0, account.id, await this._t('Accrued total'));
      moveLines.push(Command.create(values));
    }

    const moveType = isPurchase ? await this._t('Expense') : await this._t('Revenue');
    const moveVals: {} = {
      'ref': await this._t('Accrued %s entry as of %s', moveType, await formatDate(this.env, date)),
      'journalId': journal.id,
      'date': date,
      'lineIds': moveLines,
    }
    return [moveVals, ordersWithEntries];
  }

  async createEntries() {
    this.ensureOne();

    if (await this['reversalDate'] <= await this['date']) {
      throw new UserError(await this._t('Reversal date must be posterior to date.'));
    }

    const [moveVals, ordersWithEntries] = await this._computeMoveVals();
    const move = await this.env.items('account.move').create(moveVals);
    await move._post();
    const reverseMove = await move._reverseMoves([{
      'ref': await this._t('Reversal of: %s', await move.ref),
      'date': await this['reversalDate'],
    }]);
    await reverseMove._post();
    for (const order of ordersWithEntries) {
      const body = await this._t(`Accrual entry created on %s: <a href=# data-oe-model=account.move data-oe-id=%s>%s</a>.
                        And its <a href=# data-oe-model=account.move data-oe-id=%d>reverse entry</a>.`,
        await this['date'],
        move.id,
        await move.label,
        reverseMove.id,
      )
      await order.messagePost({ body: body });
    }
    return {
      'label': await this._t('Accrual Moves'),
      'type': 'ir.actions.actwindow',
      'resModel': 'account.move',
      'viewMode': 'tree,form',
      'domain': [['id', 'in', [move.id, reverseMove.id]]],
    }
  }
}