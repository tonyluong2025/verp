import { DateTime } from "luxon";
import { Fields, api } from "../../../core";
import { WARNING_HELP, WARNING_MESSAGE } from "../../../core/addons/base";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { isDigit } from "../../../core/tools/func";
import { extend, len, sum } from "../../../core/tools/iterable";
import { DEFAULT_SERVER_DATETIME_FORMAT } from "../../../core/tools/misc";
import { _convert$, _f, f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountFiscalPosition extends Model {
  static _module = module;
  static _name = 'account.fiscal.position';
  static _description = 'Fiscal Position';
  static _order = 'sequence';

  static sequence = Fields.Integer();
  static label = Fields.Char({ string: 'Fiscal Position', required: true });
  static active = Fields.Boolean({ default: true, help: "By unchecking the active field, you may hide a fiscal position without deleting it." });
  static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, readonly: true, default: self => self.env.company() });
  static accountIds = Fields.One2many('account.fiscal.position.account', 'positionId', { string: 'Account Mapping', copy: true });
  static taxIds = Fields.One2many('account.fiscal.position.tax', 'positionId', { string: 'Tax Mapping', copy: true });
  static note = Fields.Html('Notes', { translate: true, help: "Legal mentions that have to be printed on the invoices." });
  static autoApply = Fields.Boolean({ string: 'Detect Automatically', help: "Apply automatically this fiscal position." });
  static vatRequired = Fields.Boolean({ string: 'VAT required', help: "Apply only if partner has a VAT number." });
  static companyCountryId = Fields.Many2one({ string: "Company Country", related: 'companyId.countryId' });
  static countryId = Fields.Many2one('res.country', { string: 'Country', help: "Apply only if delivery country matches." });
  static countryGroupId = Fields.Many2one('res.country.group', { string: 'Country Group', help: "Apply only if delivery country matches the group." });
  static stateIds = Fields.Many2many('res.country.state', { string: 'Federal States' });
  static zipFrom = Fields.Char({ string: 'Zip Range From' });
  static zipTo = Fields.Char({ string: 'Zip Range To' });
  // To be used in hiding the 'Federal States' field('attrs' in view side) when selected 'Country' has 0 states.
  static statesCount = Fields.Integer({ compute: '_computeStatesCount' });
  static foreignVat = Fields.Char({ string: "Foreign Tax ID", help: "The tax ID of your company in the region mapped by this fiscal position." });
  static foreignVatHeaderMode = Fields.Selection([['templatesFound', "Templates Found"], ['noTemplate', "No Template"]], { compute: '_computeForeignVatHeaderMode', help: "Technical field used to display a banner on top of foreign vat fiscal positions, in order to ease the instantiation of foreign taxes when possible." });

  async _computeStatesCount() {
    for (const position of this) {
      await position.set('statesCount', len(await (await position.countryId).stateIds));
    }
  }

  @api.depends('foreignVat', 'countryId')
  async _computeForeignVatHeaderMode() {
    for (const record of this) {
      const [foreignVat, countryId] = await record('foreignVat', 'countryId');
      if (!foreignVat || !bool(countryId)) {
        await record.set('foreignVatHeaderMode', null);
        continue;
      }

      if (bool(await this.env.items('account.tax').search([['countryId', '=', countryId.id]], { limit: 1 }))) {
        await record.set('foreignVatHeaderMode', null);
      }
      else if (bool(await this.env.items('account.tax.template').search([['chartTemplateId.countryId', '=', countryId.id]], { limit: 1 }))) {
        await record.set('foreignVatHeaderMode', 'templatesFound');
      }
      else {
        await record.set('foreignVatHeaderMode', 'noTemplate');
      }
    }
  }

  @api.constrains('zipFrom', 'zipTo')
  async _checkZip() {
    for (const position of this) {
      if (await position.zipFrom && position.zipTo && position.zipFrom > position.zipTo) {
        throw new ValidationError(await this._t('Invalid "Zip Range", please configure it properly.'));
      }
    }
  }

  @api.constrains('countryId', 'stateIds', 'foreignVat')
  async _validateForeignVatCountry() {
    for (const record of this) {
      const [foreignVat, companyId, countryId, stateIds] = await record('foreignVat', 'companyId', 'countryId', 'stateIds');
      if (foreignVat) {
        const [accountFiscalCountryId, vat] = await companyId('accountFiscalCountryId', 'vat');
        if (countryId.eq(accountFiscalCountryId)) {
          if (foreignVat === vat) {
            throw new ValidationError(await this._t("You cannot create a fiscal position within your fiscal country with the same VAT number as the main one set on your company."));
          }
          if (!bool(stateIds)) {
            if (bool(await accountFiscalCountryId.stateIds)) {
              throw new ValidationError(await this._t("You cannot create a fiscal position with a foreign VAT within your fiscal country without assigning it a state."));
            }
            else {
              throw new ValidationError(await this._t("You cannot create a fiscal position with a foreign VAT within your fiscal country."));
            }
          }
        }

        const similarFposDomain = [
          ['foreignVat', '!=', false],
          ['countryId', '=', countryId.id],
          ['companyId', '=', companyId.id],
          ['id', '!=', record.id],
        ];
        if (stateIds.ok) {
          similarFposDomain.push(['stateIds', 'in', stateIds.ids]);
        }
        const similarFposCount = await this.env.items('account.fiscal.position').searchCount(similarFposDomain);
        if (bool(similarFposCount)) {
          throw new ValidationError(await this._t("A fiscal position with a foreign VAT already exists in this region."));
        }
      }
    }
  }

  async mapTax(taxes) {
    if (!this.ok) {
      return taxes;
    }
    let result = this.env.items('account.tax');
    for (const tax of taxes) {
      const taxesCorrespondance = await (await this['taxIds']).filtered(async (t) => (await t.taxSrcId).eq(tax._origin));
      result = result.or(taxesCorrespondance.ok ? await taxesCorrespondance.taxDestId : tax);
    }
    return result;
  }

  async mapAccount(account) {
    for (const pos of await this['accountIds']) {
      if ((await pos.accountSrcId).eq(account)) {
        return pos.accountDestId;
      }
    }
    return account;
  }

  /**
   * Receive a dictionary having accounts in values and try to replace those accounts accordingly to the fiscal position.
   * @param accounts 
   * @returns 
   */
  async mapAccounts(accounts: {} = {}) {
    const refDict = {};
    for (const line of await this['accountIds']) {
      refDict[String((await line.accountSrcId).ids)] = await line.accountDestId;
    }
    for (const [key, acc] of Object.entries<any>(accounts)) {
      const strIds = String(acc.ids);
      if (strIds in refDict) {
        accounts[key] = refDict[strIds];
      }
    }
    return accounts;
  }

  @api.onchange('countryId')
  async _onchangeCountryId() {
    const countryId = await this['countryId'];
    if (countryId.ok) {
      // await Promise.all([
        await this.set('zipFrom', false),
        await this.set('zipTo', false),
        await this.set('countryGroupId', false),
        await this.set('stateIds', [[5]]),
        await this.set('statesCount', len(await countryId.stateIds))
      // ]);
    }
  }

  @api.onchange('countryGroupId')
  async _onchangeCountryGroupId() {
    const countryGroupId = await this['countryGroupId'];
    if (countryGroupId.ok) {
      // await Promise.all([
        await this.set('zipFrom', false),
        await this.set('zipTo', false),
        await this.set('countryId', false),
        await this.set('stateIds', [[5]])
      // ]);
    }
  }

  @api.model()
  _convertZipValues(zipFrom = '', zipTo = '') {
    const maxLength = Math.max(len(zipFrom), len(zipTo));
    if (isDigit(zipFrom)) {
      zipFrom = zipFrom.padStart(maxLength, '0');
    }
    if (isDigit(zipTo)) {
      zipTo = zipTo.padStart(maxLength, '0');
    }
    return [zipFrom, zipTo];
  }

  @api.model()
  async create(vals) {
    const zipFrom = vals['zipFrom'];
    const zipTo = vals['zipTo'];
    if (zipFrom && zipTo) {
      [vals['zipFrom'], vals['zipTo']] = this._convertZipValues(zipFrom, zipTo);
    }
    return _super(AccountFiscalPosition, this).create(vals);
  }

  async write(vals) {
    const zipFrom = vals['zipFrom'];
    const zipTo = vals['zipTo'];
    if (zipFrom || zipTo) {
      for (const rec of this) {
        [vals['zipFrom'], vals['zipTo']] = this._convertZipValues(zipFrom ?? await rec.zipFrom, zipTo ?? await rec.zipTo);
      }
    }
    return _super(AccountFiscalPosition, this).write(vals);
  }

  @api.model()
  async _getFposByRegion(countryId?: any, stateId?: any, zipcode?: any, vatRequired?: any) {
    if (!bool(countryId)) {
      return false;
    }
    const baseDomain = [
      ['autoApply', '=', true],
      ['vatRequired', '=', vatRequired],
      ['companyId', 'in', [(await this.env.company()).id, false]],
    ]
    const nullStateDom = [['stateIds', '=', false]];
    let stateDomain = nullStateDom;
    const nullZipDom = [['zipFrom', '=', false], ['zipTo', '=', false]];
    let zipDomain = nullZipDom;
    const nullCountryDom = [['countryId', '=', false], ['countryGroupId', '=', false]];

    if (zipcode) {
      zipDomain = [['zipFrom', '<=', zipcode], ['zipTo', '>=', zipcode]];
    }
    if (stateId) {
      stateDomain = [['stateIds', '=', stateId]];
    }

    const domainCountry = baseDomain.concat([['countryId', '=', countryId]]);
    const domainGroup = baseDomain.concat([['countryGroupId.countryIds', '=', countryId]]);

    // Build domain to search records with exact matching criteria
    let fpos = await this.search(domainCountry.concat(stateDomain).concat(zipDomain), { limit: 1 });
    // return records that fit the most the criteria, and fallback on less specific fiscal positions if any can be found
    if (!bool(fpos) && bool(stateId)) {
      fpos = await this.search(domainCountry.concat(nullStateDom).concat(zipDomain), { limit: 1 });
    }
    if (!bool(fpos) && zipcode) {
      fpos = await this.search(domainCountry.concat(stateDomain).concat(nullZipDom), { limit: 1 });
    }
    if (!bool(fpos) && bool(stateId) && zipcode) {
      fpos = await this.search(domainCountry.concat(nullStateDom).concat(nullZipDom), { limit: 1 });
    }

    // fallback: country group with no state/zip range
    if (!bool(fpos)) {
      fpos = await this.search(domainGroup.concat(nullStateDom).concat(nullZipDom), { limit: 1 });
    }
    if (!bool(fpos)) {
      // Fallback on catchall (no country, no group)
      fpos = await this.search(baseDomain.concat(nullCountryDom), { limit: 1 });
    }
    return fpos;
  }

  /**
   *  :return: fiscal position found (recordset)
      :rtype: :class:`account.fiscal.position`

   * @param partnerId 
   * @param deliveryId 
   * @returns 
   */
  @api.model()
  async getFiscalPosition(partnerId, deliveryId?: any) {
    if (!bool(partnerId)) {
      return this.env.items('account.fiscal.position');
    }
    // This can be easily overridden to apply more complex fiscal rules
    const PartnerObj = this.env.items('res.partner');
    const partner = PartnerObj.browse(partnerId);

    let delivery;
    // if no delivery use invoicing
    if (bool(deliveryId)) {
      delivery = PartnerObj.browse(deliveryId);
    }
    else {
      delivery = partner;
    }
    // partner manually set fiscal position always win
    let propertyAccountPositionId = await delivery.propertyAccountPositionId;
    if (propertyAccountPositionId.ok) {
      return propertyAccountPositionId;
    }
    propertyAccountPositionId = await partner.propertyAccountPositionId;
    if (propertyAccountPositionId.ok) {
      return propertyAccountPositionId;
    }

    // First search only matching VAT positions
    const vatRequired = bool(await partner.vat);
    const [countryId, stateId, zip] = await delivery('countryId', 'stateId', 'zip');
    let fp = await this._getFposByRegion(countryId.id, stateId.id, zip, vatRequired);

    // Then if VAT required found no match, try positions that do not require it
    if (!bool(fp) && vatRequired) {
      fp = await this._getFposByRegion(countryId.id, stateId.id, zip, false);
    }
    return fp.ok ? fp : this.env.items('account.fiscal.position');
  }

  async actionCreateForeignTaxes() {
    this.ensureOne();
    await this.env.items('account.tax.template')._tryInstantiatingForeignTaxes(await this['countryId'], await this['companyId']);
  }
}

@MetaModel.define()
class AccountFiscalPositionTax extends Model {
  static _module = module;
  static _name = 'account.fiscal.position.tax';
  static _description = 'Tax Mapping of Fiscal Position';
  static _recName = 'positionId';
  static _checkCompanyAuto = true;

  static positionId = Fields.Many2one('account.fiscal.position', { string: 'Fiscal Position', required: true, ondelete: 'CASCADE' });
  static companyId = Fields.Many2one('res.company', { string: 'Company', related: 'positionId.companyId', store: true });
  static taxSrcId = Fields.Many2one('account.tax', { string: 'Tax on Product', required: true, checkCompany: true });
  static taxDestId = Fields.Many2one('account.tax', { string: 'Tax to Apply', checkCompany: true });

  static _sqlConstraints = [
    ['tax_src_dest_uniq',
      'unique ("positionId","taxSrcId","taxDestId")',
      'A tax fiscal position could be defined only one time on same taxes.']
  ];
}

@MetaModel.define()
class AccountFiscalPositionAccount extends Model {
  static _module = module;
  static _name = 'account.fiscal.position.account';
  static _description = 'Accounts Mapping of Fiscal Position';
  static _recName = 'positionId';
  static _checkCompanyAuto = true;

  static positionId = Fields.Many2one('account.fiscal.position', { string: 'Fiscal Position', required: true, ondelete: 'CASCADE' });
  static companyId = Fields.Many2one('res.company', { string: 'Company', related: 'positionId.companyId', store: true });
  static accountSrcId = Fields.Many2one('account.account', { string: 'Account on Product', checkCompany: true, required: true, domain: "[['deprecated', '=', false], ['companyId', '=', companyId]]" });
  static accountDestId = Fields.Many2one('account.account', { string: 'Account to Use Instead', checkCompany: true, required: true, domain: "[['deprecated', '=', false], ['companyId', '=', companyId]]" });

  static _sqlConstraints = [
    ['account_src_dest_uniq',
      'unique ("positionId","accountSrcId","accountDestId")',
      'An account fiscal position could be defined only one time on same accounts.']
  ];
}

@MetaModel.define()
class ResPartner extends Model {
  static _module = module;
  static _name = 'res.partner';
  static _parents = 'res.partner';

  @api.dependsContext('company')
  async _creditDebitGet() {
    let [tables, whereClause, whereParams] = await (await this.env.items('account.move.line').withContext({ state: 'posted', companyId: (await this.env.company()).id }))._queryGet();
    // whereParams = [Array.from(this.ids)].concat(whereParams);
    if (whereClause) {
      whereClause = 'AND ' + whereClause;
    }
    let sql = `SELECT "accountMoveLine"."partnerId" AS pid, act.type, SUM("accountMoveLine"."amountResidual") AS val
            FROM ` + tables + `
            LEFT JOIN "accountAccount" a ON ("accountMoveLine"."accountId"=a.id)
            LEFT JOIN "accountAccountType" act ON (a."userTypeId"=act.id)
            WHERE act.type IN ('receivable','payable')
            AND "accountMoveLine"."partnerId" IN (%s)
            AND "accountMoveLine".reconciled IS NOT TRUE
            ` + whereClause + `
            GROUP BY "accountMoveLine"."partnerId", act.type
            `;
    sql = f(sql, String(this.ids) || 'NULL');
    const res = await this._cr.execute(_convert$(sql), { bind: whereParams });
    let treated = this.browse();
    for (const { pid, type, val } of res) {
      const partner = this.browse(pid);
      if (type === 'receivable') {
        await partner.set('credit', val);
        if (!treated.includes(partner)) {
          await partner.set('debit', false);
          treated = treated.or(partner);
        }
      }
      else if (type === 'payable') {
        await partner.set('debit', -val);
        if (!treated.includes(partner)) {
          await partner.set('credit', false);
          treated = treated.or(partner);
        }
      }
    }
    const remaining = this.sub(treated);
    await remaining.set('debit', false),
    await remaining.set('credit', false)
  }

  async _assetDifferenceSearch(accountType, operator, operand) {
    if (!['<', '=', '>', '>=', '<='].includes(operator)) {
      return [];
    }
    if (typeof (operand) !== 'number') {
      return [];
    }
    let sign = 1;
    if (accountType === 'payable') {
      sign = -1;
    }
    const res = await this._cr.execute(`
            SELECT partner.id
            FROM "resPartner" partner
            LEFT JOIN "accountMoveLine" aml ON aml."partnerId" = partner.id
            JOIN "accountMove" move ON move.id = aml."moveId"
            RIGHT JOIN "accountAccount" acc ON aml."accountId" = acc.id
            WHERE acc."internalType" = '%s'
              AND NOT acc.deprecated AND acc."companyId" = %s
              AND move.state = 'posted'
            GROUP BY partner.id
            HAVING %s * COALESCE(SUM(aml."amountResidual"), 0) ` + operator + ' %s ', [accountType, (await (await this.env.user()).companyId).id, sign, operand]);
    if (!res.length) {
      return [['id', '=', '0']];
    }
    return [['id', 'in', res.map(r => r['id'])]];
  }

  @api.model()
  async _creditSearch(operator, operand) {
    return this._assetDifferenceSearch('receivable', operator, operand);
  }

  @api.model()
  async _debitSearch(operator, operand) {
    return this._assetDifferenceSearch('payable', operator, operand);
  }

  async _invoiceTotal() {
    await this.set('totalInvoiced', 0);
    if (!bool(this.ids)) {
      return true;
    }

    const allPartnersAndChildren = {};
    const allPartnerIds = [];
    for (const partner of await this.filtered('id')) {
      // priceTotal is in the company currency
      allPartnersAndChildren[partner.id] = (await (await this.withContext({ activeTest: false })).search([['id', 'childOf', partner.id]])).ids;
      extend(allPartnerIds, allPartnersAndChildren[partner.id]);
    }
    const domain = [
      ['partnerId', 'in', allPartnerIds],
      ['state', 'not in', ['draft', 'cancel']],
      ['moveType', 'in', ['outInvoice', 'outRefund']],
    ];
    const priceTotals = await this.env.items('account.invoice.report').readGroup(domain, ['priceSubtotal'], ['partnerId']);
    for (const [partner, childIds] of Object.entries<any>(allPartnersAndChildren)) {
      await this.browse(partner).set('totalInvoiced', sum(priceTotals.filter(price => childIds.includes(price['partnerId'][0])).map(price => price['priceSubtotal'])));
    }
  }

  async _computeJournalItemCount() {
    const AccountMoveLine = this.env.items('account.move.line');
    for (const partner of this) {
      await partner.set('journalItemCount', await AccountMoveLine.searchCount([['partnerId', '=', partner.id]]));
    }
  }

  async _computeHasUnreconciledEntries() {
    for (const partner of this) {
      // Avoid useless work if has_unreconciled_entries is not relevant for this partner
      const [active, isCompany, parentId] = await partner('active', 'isCompany', 'parentId');
      if (!active || !isCompany && parentId.ok) {
        await partner.set('hasUnreconciledEntries', false);
        continue;
      }
      const res = await this.env.cr.execute(
        ` SELECT 1 FROM(
                        SELECT
                            p."lastTimeEntriesChecked" AS "lastTimeEntriesChecked",
                            MAX(l."updatedAt") AS "maxDate"
                        FROM
                            "accountMoveLine" l
                            RIGHT JOIN "accountAccount" a ON (a.id = l."accountId")
                            RIGHT JOIN "resPartner" p ON (l."partnerId" = p.id)
                        WHERE
                            p.id = %s
                            AND EXISTS (
                                SELECT 1
                                FROM "accountMoveLine" l
                                WHERE l."accountId" = a.id
                                AND l."partnerId" = p.id
                                AND l."amountResidual" > 0
                            )
                            AND EXISTS (
                                SELECT 1
                                FROM "accountMoveLine" l
                                WHERE l."accountId" = a.id
                                AND l."partnerId" = p.id
                                AND l."amountResidual" < 0
                            )
                        GROUP BY p."lastTimeEntriesChecked"
                    ) as s
                    WHERE ("lastTimeEntriesChecked" IS NULL OR "maxDate" > "lastTimeEntriesChecked")
                `, [partner.id]);
      await partner.set('hasUnreconciledEntries', res.length == 1);
    }
  }

  async markAsReconciled() {
    await this.env.items('account.partial.reconcile').checkAccessRights('write');
    return (await this.sudo()).write({ 'lastTimeEntriesChecked': DateTime.now().toFormat(DEFAULT_SERVER_DATETIME_FORMAT) });
  }

  async _getCompanyCurrency() {
    for (const partner of this) {
      if ((await partner.companyId).ok) {
        await partner.set('currencyId', await (await (await partner.sudo()).companyId).currencyId);
      }
      else {
        await partner.set('currencyId', await (await this.env.company()).currencyId);
      }
    }
  }

  static credit = Fields.Monetary({ compute: '_creditDebitGet', search: '_creditSearch', string: 'Total Receivable', help: "Total amount this customer owes you." });
  static debit = Fields.Monetary({ compute: '_creditDebitGet', search: '_debitSearch', string: 'Total Payable', help: "Total amount you have to pay to this vendor." });
  static debitLimit = Fields.Monetary('Payable Limit');
  static totalInvoiced = Fields.Monetary({ compute: '_invoiceTotal', string: "Total Invoiced", groups: 'account.groupAccountInvoice,account.groupAccountReadonly' });
  static currencyId = Fields.Many2one('res.currency', { compute: '_getCompanyCurrency', readonly: true, string: "Currency", help: 'Utility field to express amount currency' });
  static journalItemCount = Fields.Integer({ compute: '_computeJournalItemCount', string: "Journal Items" });
  static propertyAccountPayableId = Fields.Many2one('account.account', { companyDependent: true, string: "Account Payable", domain: "[['internalType', '=', 'payable'], ['deprecated', '=', false], ['companyId', '=', currentCompanyId]]", help: "This account will be used instead of the default one as the payable account for the current partner", required: true });
  static propertyAccountReceivableId = Fields.Many2one('account.account', { companyDependent: true, string: "Account Receivable", domain: "[['internalType', '=', 'receivable'], ['deprecated', '=', false], ['companyId', '=', currentCompanyId]]", help: "This account will be used instead of the default one as the receivable account for the current partner", required: true });
  static propertyAccountPositionId = Fields.Many2one('account.fiscal.position', { companyDependent: true, string: "Fiscal Position", domain: "[['companyId', '=', currentCompanyId]]", help: "The fiscal position determines the taxes/accounts used for this contact." });
  static propertyPaymentTermId = Fields.Many2one('account.payment.term', { companyDependent: true, string: 'Customer Payment Terms', domain: "[['companyId', 'in', [currentCompanyId, false]]]", help: "This payment term will be used instead of the default one for sales orders and customer invoices" });
  static propertySupplierPaymentTermId = Fields.Many2one('account.payment.term', { companyDependent: true, string: 'Vendor Payment Terms', domain: "[['companyId', 'in', [currentCompanyId, false]]]", help: "This payment term will be used instead of the default one for purchase orders and vendor bills" });
  static refCompanyIds = Fields.One2many('res.company', 'partnerId', { string: 'Companies that refers to partner' });
  static hasUnreconciledEntries = Fields.Boolean({ compute: '_computeHasUnreconciledEntries', help: "The partner has at least one unreconciled debit and credit since last time the invoices & payments matching was performed." });
  static lastTimeEntriesChecked = Fields.Datetime({ string: 'Latest Invoices & Payments Matching Date', readonly: true, copy: false, help: 'Last time the invoices & payments matching was performed for this partner. It is set either if there\'s not at least an unreconciled debit and an unreconciled credit or if you click the "Done" button.' });
  static invoiceIds = Fields.One2many('account.move', 'partnerId', { string: 'Invoices', readonly: true, copy: false });
  static contractIds = Fields.One2many('account.analytic.account', 'partnerId', { string: 'Partner Contracts', readonly: true });
  static bankAccountCount = Fields.Integer({ compute: '_computeBankCount', string: "Bank" });
  static trust = Fields.Selection([['good', 'Good Debtor'], ['normal', 'Normal Debtor'], ['bad', 'Bad Debtor']], { string: 'Degree of trust you have in this debtor', default: 'normal', companyDependent: true });
  static invoiceWarn = Fields.Selection(WARNING_MESSAGE, { string: 'Invoice', help: WARNING_HELP, default: "no-message" });
  static invoiceWarnMsg = Fields.Text('Message for Invoice');
  // Computed fields to order the partners as suppliers/customers according to the amount of their generated incoming/outgoing account moves
  static supplierRank = Fields.Integer({ default: 0 });
  static customerRank = Fields.Integer({ default: 0 });

  async _getNameSearchOrderByFields() {
    const res = await _super(ResPartner, this)._getNameSearchOrderByFields();
    const partnerSearchMode = this.env.context['resPartnerSearchMode'];
    if (!['customer', 'supplier'].includes(partnerSearchMode)) {
      return res;
    }
    let orderByField = 'COALESCE("resPartner"."%s", 0) DESC,';
    let field;
    if (partnerSearchMode === 'customer') {
      field = 'customerRank';
    }
    else {
      field = 'supplierRank';
    }
    orderByField = f(orderByField, field);
    return bool(res) ? f('%s, %s', res, f(orderByField, field)) : orderByField;
  }

  async _computeBankCount() {
    const bankData = await this.env.items('res.partner.bank').readGroup([['partnerId', 'in', this.ids]], ['partnerId'], ['partnerId']);
    const mappedData = Object.fromEntries(bankData.map(bank => [bank['partnerId'][0], bank['partnerId_count']]));
    for (const partner of this) {
      await partner.set('bankAccountCount', mappedData[partner.id] || 0);
    }
  }

  /**
   * Find the partner for which the accounting entries will be created
   * @param partner 
   * @returns 
   */
  async _findAccountingPartner(partner) {
    return partner.commercialPartnerId;
  }

  @api.model()
  _commercialFields() {
    return _super(ResPartner, this)._commercialFields().concat(['debitLimit', 'propertyAccountPayableId', 'propertyAccountReceivableId', 'propertyAccountPositionId', 'propertyPaymentTermId', 'propertySupplierPaymentTermId', 'lastTimeEntriesChecked']);
  }

  async actionViewPartnerInvoices() {
    this.ensureOne();
    const action = await this.env.items("ir.actions.actions")._forXmlid("account.actionMoveOutInvoiceType");
    action['domain'] = [
      ['moveType', 'in', ['outInvoice', 'outRefund']],
      ['partnerId', 'childOf', this.id],
    ];
    action['context'] = { 'default_moveType': 'outInvoice', 'moveType': 'outInvoice', 'journalType': 'sale', 'searchDefault_unpaid': 1 }
    return action;
  }

  /**
   * Can't edit `vat` if there is (non draft) issued invoices. 
   * @returns 
   */
  async canEditVat() {
    const canEditVat = await _super(ResPartner, this).canEditVat();
    if (!canEditVat) {
      return canEditVat;
    }
    const hasInvoice = await this.env.items('account.move').search([
      ['moveType', 'in', ['outInvoice', 'outRefund']],
      ['partnerId', 'childOf', (await this['commercialPartnerId']).id],
      ['state', '=', 'posted']
    ], { limit: 1 });
    return canEditVat && !bool(hasInvoice);
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const searchPartnerMode = this.env.context['resPartnerSearchMode'];
    const isCustomer = searchPartnerMode === 'customer';
    const isSupplier = searchPartnerMode === 'supplier';
    if (searchPartnerMode) {
      for (const vals of valsList) {
        if (isCustomer && !('customerRank' in vals)) {
          vals['customerRank'] = 1;
        }
        else if (isSupplier && !('supplierRank' in vals)) {
          vals['supplierRank'] = 1;
        }
      }
    }
    return _super(ResPartner, this).create(valsList);
  }

  async _increaseRank(field, n = 1) {
    if (bool(this.ids) && ['customerRank', 'supplierRank'].includes(field)) {
      try {
        await this.env.cr.savepoint(false, async () => {
          const query = _f(`
                        SELECT "{field}" FROM "resPartner" WHERE ID IN ({partnerIds}) FOR UPDATE NOWAIT;
                        UPDATE "resPartner" SET "{field}" = "{field}" + {n}
                        WHERE id IN ({partnerIds})
                    `, { 'field': field, 'partnerIds': String(this.ids) || 'NULL', 'n': n });
          await this.env.cr.execute(query);
          for (const partner of this) {
            this.env.cache.remove(partner, partner._fields[field]);
          }
        });
      } catch (e) {
        // except DatabaseError as e:
        if (e.code === '55P03') {
          console.debug('Another transaction already locked partner rows. Cannot update partner ranks.');
        }
        else {
          throw e;
        }
      }
    }
  }
}