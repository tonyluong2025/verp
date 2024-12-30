import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class PosOpenStatement extends TransientModel {
    static _module = module;
    static _name = 'pos.open.statement';
    static _description = 'Point of Sale Open Statement';

    async openStatement() {
        this.ensureOne();
        let bankStatement = this.env.items('account.bank.statement'),
        journals = await this.env.items('account.journal').search([['journalUser', '=', true]]);
        if (! journals.ok) {
            throw new UserError(await this._t('You have to define which payment method must be available in the point of sale by reusing existing bank and cash through "Accounting / Configuration / Journals / Journals". Select a journal and check the field "PoS Payment Method" from the "Point of Sale" tab. You can also create new payment methods directly from menu "PoS Backend / Configuration / Payment Methods".'));
        }

        for (const journal of journals) {
            let number;
            const sequence = await journal.sequenceId;
            if (sequence.ok) {
                number = await sequence.nextById();
            }
            else {
                throw new UserError(await this._t("No sequence defined on the journal"));
            }
            bankStatement  = bankStatement.add(await bankStatement.create({'journalId': journal.id, 'userId': this.env.uid, 'label': number}));
        }
        const treeId = (await this.env.ref('account.viewBankStatementTree')).id,
        formId = (await this.env.ref('account.viewBankStatementForm')).id,
        searchId = (await this.env.ref('account.viewBankStatementSearch')).id;

        return {
            'type': 'ir.actions.actwindow',
            'label': await this._t('List of Cash Registers'),
            'viewMode': 'tree,form',
            'resModel': 'account.bank.statement',
            'domain': String([['id', 'in', bankStatement.ids]]),
            'views': [[treeId, 'tree'], [formId, 'form']],
            'searchViewId': [searchId],
        }
    }
}
