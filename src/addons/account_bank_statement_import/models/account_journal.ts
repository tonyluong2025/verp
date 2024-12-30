import { _super, MetaModel, Model } from "../../../core/models"
import { bool, f, update } from "../../../core/tools";

@MetaModel.define()
class AccountJournal extends Model {
    static _module = module;
    static _parents = "account.journal";

    /**
     * Returns a list of strings representing the supported import formats.
     * @returns 
     */
    _getBankStatementsAvailableImportFormats() {
        return [];
    }

    async __getBankStatementsAvailableSources() {
        const rslt = await _super(AccountJournal, this).__getBankStatementsAvailableSources();
        const formatsList: any[] = this._getBankStatementsAvailableImportFormats();
        if (bool(formatsList)) {
            formatsList.sort();
            const importFormatsStr = formatsList.join(', ');
            rslt.push(["fileImport", await this._t("Import") + "(" + importFormatsStr + ")"]);
        }
        return rslt;
    }

    /**
     * return action to import bank/cash statements. This button should be called only on journals with type =='bank'
     */
    async importStatement() {
        const actionName = 'actionAccountBankStatementImport';
        const [action] = await (await (await this.env.ref(f('accountBankStatementImport.%s', actionName))).sudo()).read();
        // Note: this drops action['context'], which is a dict stored as a string, which is not easy to update
        update(action, {'context': ("{'journalId': " + String(this.id) + "}")});
        return action;
    }
}