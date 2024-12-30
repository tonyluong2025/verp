import { RedirectWarning, ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class ResCompany extends Model {
    static _module = module;
    static _parents = 'res.company';

    // RedirectWarning is changed with validation error to remove error of missing reconciliation view
    async _validateFiscalyearLock(values) {
        if (values['fiscalyearLockDate']) {
            const draftEntries = await this.env.items('account.move').search([
                ['companyId', 'in', this.ids],
                ['state', '=', 'draft'],
                ['date', '<=', values['fiscalyearLockDate']]]);
            if (bool(draftEntries)) {
                const errorMsg = await this._t(
                    'There are still unposted entries in the period you want to lock. You should either post or delete them.');
                const actionError = {
                    'viewMode': 'tree',
                    'label': 'Unposted Entries',
                    'resModel': 'account.move',
                    'type': 'ir.actions.actwindow',
                    'domain': [['id', 'in', draftEntries.ids]],
                    'searchViewId': [(await this.env.ref('account.viewAccountMoveFilter')).id, 'search'],
                    'views': [[(await this.env.ref('account.viewMoveTree')).id, 'list'],
                              [(await this.env.ref('account.viewMoveForm')).id, 'form']],
                }
                throw new RedirectWarning(errorMsg, actionError, await this._t('Show unposted entries'));
            }

            const unreconciledStatementLines = await this.env.items('account.bank.statement.line').search([
                ['companyId', 'in', this.ids],
                ['isReconciled', '=', false],
                ['date', '<=', values['fiscalyearLockDate']],
                ['moveId.state', 'in', ['draft', 'posted']],
            ])
            if (bool(unreconciledStatementLines)) {
                const errorMsg = await this._t("There are still unreconciled bank statement lines in the period you want to lock. You should either reconcile or delete them.");
                throw new ValidationError(errorMsg);
            }
        }
    }
}