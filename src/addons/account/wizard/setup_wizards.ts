import { Fields, _Date, api } from "../../../core";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { subDate } from "../../../core/tools/date_utils";
import { pop } from "../../../core/tools/misc";

@MetaModel.define()
class FinancialYearOpeningWizard extends TransientModel {
  static _module = module;
  static _name = 'account.financial.year.op';
  static _description = 'Opening Balance of Financial Year';

  static companyId = Fields.Many2one({ comodelName: 'res.company', required: true });
  static openingMovePosted = Fields.Boolean({ string: 'Opening Move Posted', compute: '_computeOpeningMovePosted' });
  static openingDate = Fields.Date({ string: 'Opening Date', required: true, related: 'companyId.accountOpeningDate', help: "Date from which the accounting is managed in Verp. It is the date of the opening entry.", readonly: false });
  static fiscalyearLastDay = Fields.Integer({
    related: "companyId.fiscalyearLastDay", required: true, readonly: false,
    help: "The last day of the month will be used if the chosen day doesn't exist."
  });
  static fiscalyearLastMonth = Fields.Selection({
    related: "companyId.fiscalyearLastMonth", readonly: false,
    required: true,
    help: "The last day of the month will be used if the chosen day doesn't exist."
  });

  @api.depends('companyId.accountOpeningMoveId')
  async _computeOpeningMovePosted() {
    for (const record of this) {
      await record.set('openingMovePosted', await (await record.companyId).openingMovePosted());
    }
  }

  @api.constrains('fiscalyearLastDay', 'fiscalyearLastMonth')
  async _checkFiscalyear() {
    // We try if the date exists in 2020, which is a leap year.
    // We do not define the constrain on res.company, since the recomputation of the related
    // fields is done one field at a time.
    for (const wiz of this) {
      try {
        new Date(2020, parseInt(await wiz.fiscalyearLastMonth), await wiz.fiscalyearLastDay);
      } catch (e) {
        // except ValueError:
        throw new ValidationError(
          await this._t('Incorrect fiscal year date: day is out of range for month. Month: %s; Day: %s',
            await wiz.fiscalyearLastMonth, await wiz.fiscalyearLastDay)
        )
      }
    }
  }

  async write(vals) {
    // Amazing workaround: non-stored related fields on company are a BAD idea since the 3 fields
    // must follow the constraint '_check_fiscalyear_last_day'. The thing is, in case of related
    // fields, the inverse write is done one value at a time, and thus the constraint is verified
    // one value at a time... so it is likely to fail.
    for (const wiz of this) {
      const company = await wiz.companyId;
      await company.write({
        'fiscalyearLastDay': vals['fiscalyearLastDay'] || await company.fiscalyearLastDay,
        'fiscalyearLastMonth': vals['fiscalyearLastMonth'] || await company.fiscalyearLastMonth,
        'accountOpeningDate': vals['openingDate'] || await company.accountOpeningDate,
      })
      await (await company.accountOpeningMoveId).write({
        'date': subDate(_Date.toDate(vals['openingDate'] || await company.accountOpeningDate) as Date, { days: 1 }),
      })
    }

    pop(vals, 'openingDate', null);
    pop(vals, 'fiscalyearLastDay', null);
    pop(vals, 'fiscalyearLastMonth', null);
    return _super(FinancialYearOpeningWizard, this).write(vals);
  }

  async actionSaveOnboardingFiscalYear() {
    await (await (await this.env.company()).sudo()).setOnboardingStepDone('accountSetupFyDataState');
  }

}
@MetaModel.define()
class SetupBarBankConfigWizard extends TransientModel {
  static _module = module;
  static _inherits = { 'res.partner.bank': 'resPartnerBankId' }
  static _name = 'account.setup.bank.manual.config';
  static _description = 'Bank setup manual config';
  static _checkCompanyAuto = true;

  static resPartnerBankId = Fields.Many2one({ comodelName: 'res.partner.bank', ondelete: 'CASCADE', required: true });
  static newJournalName = Fields.Char({ default: async (self) => (await self.linkedJournalId).label, inverse: 'setLinkedJournalId', required: true, help: 'Will be used to name the Journal related to this bank account' });
  static linkedJournalId = Fields.Many2one({
    string: "Journal",
    comodelName: 'account.journal', inverse: 'setLinkedJournalId',
    compute: "_computeLinkedJournalId", checkCompany: true,
    domain: "[['type','=','bank'], ['bankAccountId', '=', false], ['companyId', '=', companyId]]"
  });
  static bankBic = Fields.Char({ related: 'bankId.bic', readonly: false, string: "Bic" });
  static numJournalsWithoutAccount = Fields.Integer({ default: async (self) => self._numberUnlinkedJournal() });

  async _numberUnlinkedJournal() {
    return this.env.items('account.journal').search([['type', '=', 'bank'], ['bankAccountId', '=', false],
    ['id', '!=', await this.defaultLinkedJournalId()]], { count: true });
  }

  @api.onchange('accNumber')
  async _onchangeAccNumber() {
    for (const record of this) {
      await record.set('newJournalName', await record.accNumber);
    }
  }

  /**
   * This wizard is only used to setup an account for the current active
      company, so we always inject the corresponding partner when creating
      the model.
   * @param vals 
   * @returns 
   */
  @api.model()
  async create(vals) {
    vals['partnerId'] = (await (await this.env.company()).partnerId).id;
    vals['newJournalName'] = vals['accNumber'];

    // If no bank has been selected, but we have a bic, we are using it to find or create the bank
    if (!vals['bankId'] && vals['bankBic']) {
      vals['bankId'] = (await this.env.items('res.bank').search([['bic', '=', vals['bankBic']]], { limit: 1 })).id
        || (await this.env.items('res.bank').create({ 'label': vals['bankBic'], 'bic': vals['bankBic'] })).id;
    }
    return _super(SetupBarBankConfigWizard, this).create(vals);
  }


  @api.onchange('linkedJournalId')
  async _onchangeNewJournalRelatedData() {
    for (const record of this) {
      if (bool(await record.linkedJournalId)) {
        await record.set('newJournalName', await (await record.linkedJournalId).label);
      }
    }
  }

  @api.depends('journalId')  // Despite its name, journalId is actually a One2many field
  async _computeLinkedJournalId() {
    for (const record of this) {
      const journal = await record.journalId;
      await record.set('linkedJournalId', journal.ok && bool(journal[0]) ? journal[0] : await record.defaultLinkedJournalId());
    }
  }

  async defaultLinkedJournalId() {
    const defaultValue = await this.env.items('account.journal').search([['type', '=', 'bank'], ['bankAccountId', '=', false]], { limit: 1 });
    return defaultValue.slice(0, 1).id;
  }

  /**
   * Called when saving the wizard.
   */
  async setLinkedJournalId() {
    for (const record of this) {
      let selectedJournal = await record.linkedJournalId;
      if (!selectedJournal.ok) {
        const company = await this.env.company();
        const newJournalCode = await this.env.items('account.journal').getNextBankCashDefaultCode('bank', company);
        selectedJournal = await this.env.items('account.journal').create({
          'label': await record.newJournalName,
          'code': newJournalCode,
          'type': 'bank',
          'companyId': company.id,
          'bankAccountId': (await record.resPartnerBankId).id,
        });
      }
      else {
        await selectedJournal.set('bankAccountId', (await record.resPartnerBankId).id);
        await selectedJournal.set('label', await record.new_journal_nameC);
      }
    }
  }

  /**
   * Called by the validation button of this wizard. Serves as an
    extension hook in account_bank_statement_import.
   */
  async validate() {
    await (await this['linkedJournalId']).markBankSetupAsDoneAction();
  }
}