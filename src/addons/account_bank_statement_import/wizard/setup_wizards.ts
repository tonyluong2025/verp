import { _super, MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class SetupBarBankConfigWizard extends TransientModel {
  static _module = module;
  static _parents = 'account.setup.bank.manual.config';

  /**
   * Default the bank statement source of new bank journals as 'file_import'
   */
  async validate() {
    await _super(SetupBarBankConfigWizard, this).validate();
    const linkedJournal = await this['linkedJournalId'];
    if ((await this['numJournalsWithoutAccount'] == 0 || await linkedJournal.bankStatementsSource == 'undefined') && this.env.items('account.journal')._getBankStatementsAvailableImportFormats()) {
      await linkedJournal.set('bankStatementsSource', 'fileImport');
    }
  }
}
