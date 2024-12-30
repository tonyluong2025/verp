import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class AccountBankStatementImportJounalCreation extends TransientModel {
    static _module = module;
    static _name = 'account.bank.statement.import.journal.creation';
    static _description = 'Journal Creation on Bank Statement Import';

    static journalId = Fields.Many2one('account.journal', {delegate: true, required: true, ondelete: 'CASCADE'});

    /**
     * Create the journal (the record is automatically created in the process of calling this method) and reprocess the statement
     * @returns 
     */
    async createJournal() {
        const statementImportTransient = this.env.items('account.bank.statement.import').browse(this.env.context['statementImportTransientId']);
        return (await statementImportTransient.withContext({journalId: (await this['journalId']).id})).importFile();
    }
}