import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools/bool";
import { extend } from "../../../core/tools/iterable";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountPaymentMethod extends Model {
  static _module = module;
  static _name = "account.payment.method";
  static _description = "Payment Methods";

  static label = Fields.Char({ required: true, translate: true });
  static code = Fields.Char({ required: true });  // For internal identification
  static paymentType = Fields.Selection({ selection: [['inbound', 'Inbound'], ['outbound', 'Outbound']], required: true });

  static _sqlConstraints = [
    ['nameCodeUnique', 'unique (code, "paymentType")', 'The combination code/payment type already exists!'],
  ];

  @api.modelCreateMulti()
  async create(valsList) {
    const paymentMethods = await _super(AccountPaymentMethod, this).create(valsList);
    const methodsInfo = this._getPaymentMethodInformation();
    for (const method of paymentMethods) {
      const [code, label] = await method('code', 'label');
      const information = methodsInfo[code] ?? {};

      if (information['mode'] === 'multi') {
        const methodDomain = await method._getPaymentMethodDomain();

        const journals = await this.env.items('account.journal').search(methodDomain);

        await this.env.items('account.payment.method.line').create(await journals.map((journal) => {
          return {
            'label': label,
            'paymentMethodId': method.id,
            'journalId': journal.id
          }
        }));
      }
    }
    return paymentMethods;
  }

  /**
   * :return: The domain specyfying which journal can accomodate this payment method.
   * @returns 
   */
  async _getPaymentMethodDomain() {
    this.ensureOne();
    const information = this._getPaymentMethodInformation()[await this['code']];

    const currencyIds = information['currencyIds'];
    const countryId = information['countryId'];
    const defaultDomain = [['type', 'in', ['bank', 'cash']]];
    let domains = [information['domain'] ?? defaultDomain];

    if (bool(currencyIds)) {
      extend(domains, [expression.OR([
        [['currencyId', '=', false], ['companyId.currencyId', 'in', currencyIds]],
        [['currencyId', 'in', currencyIds]]],
      )]);
    }

    if (bool(countryId)) {
      extend(domains, [[['companyId.accountFiscalCountryId', '=', countryId]]]);
    }
    return expression.AND(domains);
  }

  /**
   * Contains details about how to initialize a payment method with the code x.
      The contained info are:
        mode: Either unique if we only want one of them at a single time (payment acquirers for example)
                or multi if we want the method on each journal fitting the domain.
        domain: The domain defining the eligible journals.
        currencyId: The id of the currency necessary on the journal (or company) for it to be eligible.
        countryId: The id of the country needed on the company for it to be eligible.
        hidden: If set to true, the method will not be automatically added to the journal,
                and will not be selectable by the user.
   * @returns 
   */
  @api.model()
  _getPaymentMethodInformation() {
    return {
      'manual': { 'mode': 'multi', 'domain': [['type', 'in', ['bank', 'cash']]] },
    }
  }

  /**
   *  TO OVERRIDE
      This hook will be used to return the list of sdd payment method codes
   * @returns 
   */
  @api.model()
  _getSddPaymentMethodCode() {
    return [];
  }
}

@MetaModel.define()
class AccountPaymentMethodLine extends Model {
  static _module = module;
  static _name = "account.payment.method.line";
  static _description = "Payment Methods";
  static _order = 'sequence, id';

  // == Business fields ==
  static label = Fields.Char({ compute: '_computeName', readonly: false, store: true });
  static sequence = Fields.Integer({ default: 10 });
  static paymentMethodId = Fields.Many2one({
    string: 'Payment Method',
    comodelName: 'account.payment.method',
    domain: "[['paymentType', '=?', paymentType], ['id', 'in', availablePaymentMethodIds]]",
    required: true
  });
  static paymentAccountId = Fields.Many2one({
    comodelName: 'account.account',
    checkCompany: true,
    copy: false,
    ondelete: 'RESTRICT',
    domain: async (self) => f(`[['deprecated', '=', false],
                                ['companyId', '=', companyId],
                                ['userTypeId.type', 'not in', ['receivable', 'payable']],
                                '|', ['userTypeId', '=', %s], ['id', '=', parent.defaultAccountId]]`,
      (await self.env.ref('account.dataAccountTypeCurrentAssets')).id)
  });
  static journalId = Fields.Many2one({ comodelName: 'account.journal', ondelete: 'CASCADE' });

  // == Display purpose fields ==
  static code = Fields.Char({ related: 'paymentMethodId.code' });
  static paymentType = Fields.Selection({ related: 'paymentMethodId.paymentType' });
  static companyId = Fields.Many2one({ related: 'journalId.companyId' });
  static availablePaymentMethodIds = Fields.Many2many({ related: 'journalId.availablePaymentMethodIds' });

  @api.depends('paymentMethodId.label')
  async _computeName() {
    for (const method of this) {
      if (! await method.label) {
        await method.set('label', await (await method.paymentMethodId).label);
      }
    }
  }

  @api.constrains('label')
  async _ensureUniqueNameForJournal() {
    await this.flush(['label']);
    const res = await this._cr.execute(`
            SELECT apml.label, apm."paymentType"
            FROM "accountPaymentMethodLine" apml
            JOIN "accountPaymentMethod" apm ON apml."paymentMethodId" = apm.id
            WHERE apml."journalId" IS NOT NULL
            GROUP BY apml.label, "journalId", apm."paymentType"
            HAVING COUNT(apml.id) > 1
        `);
    if (res.length) {
      const { label, paymentType } = res[0];
      throw new UserError(await this._t("You can't have two payment method lines of the same payment type (%s) and with the same name (%s) on a single journal.", paymentType, label))
    }
  }

  /**
   * Payment method lines which are used in a payment should not be deleted from the database,
      only the link betweend them and the journals must be broken.
   * @returns 
   */
  async unlink() {
    let unusedPaymentMethodLines = this;
    for (const line of this) {
      const paymentCount = await this.env.items('account.payment').searchCount([['paymentMethodLineId', '=', line.id]]);
      if (paymentCount > 0) {
        unusedPaymentMethodLines = unusedPaymentMethodLines.sub(line);
      }
    }
    await this.sub(unusedPaymentMethodLines).write({ 'journalId': false });

    return _super(AccountPaymentMethodLine, unusedPaymentMethodLines).unlink();
  }

  /**
   * Automatically toggle the account to reconcile if allowed.
      :param accountId: The id of an account.account.
   * @param accountId 
   */
  @api.model()
  async _autoToggleAccountToReconcile(accountId) {
    const account = this.env.items('account.account').browse(accountId);
    if (! await account.reconcile && await account.internalType !== 'liquidity' && await account.internalGroup !== 'offBalance') {
      await account.set('reconcile', true);
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    // OVERRIDE
    for (const vals of valsList) {
      if (vals['paymentAccountId']) {
        await this._autoToggleAccountToReconcile(vals['paymentAccountId']);
      }
    }
    return _super(AccountPaymentMethodLine, this).create(valsList);
  }

  async write(vals) {
    // OVERRIDE
    if (vals['paymentAccountId']) {
      await this._autoToggleAccountToReconcile(vals['paymentAccountId']);
    }
    return _super(AccountPaymentMethodLine, this).write(vals);
  }
}