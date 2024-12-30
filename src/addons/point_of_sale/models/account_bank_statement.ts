import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountBankStatement extends Model {
    static _module = module;
    static _parents = 'account.bank.statement';

    static posSessionId = Fields.Many2one('pos.session', {string: "Session", copy: false});
    static accountId = Fields.Many2one('account.account', {related: 'journalId.defaultAccountId', readonly: true});

    async buttonValidateOrAction() {
        // OVERRIDE to check the consistency of the statement's state regarding the session's state.
        for (const statement of this) {
            if (['opened', 'closingControl'].includes(await (await statement.posSessionId).state) && await statement.state === 'open') {
                throw new UserError(await this._t("You can't validate a bank statement that is used in an opened Session of a Point of Sale."));
            }
        }
        return _super(AccountBankStatement, this).buttonValidateOrAction();
    }

    @api.ondelete(false)
    async _unlinkExceptLinkedToPosSession() {
        for (const bs of this) {
            if (bool(await bs.posSessionId)) {
                throw new UserError(await this._t("You cannot delete a bank statement linked to Point of Sale session."));
            }
        }
    }
}