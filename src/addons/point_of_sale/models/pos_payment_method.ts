import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class PosPaymentMethod extends Model {
    static _module = module;
    static _name = "pos.payment.method";
    static _description = "Point of Sale Payment Methods";
    static _order = "id asc";

    async _getPaymentTerminalSelection() {
        return [];
    }

    static label = Fields.Char({string: "Method", required: true, translate: true, help: 'Defines the name of the payment method that will be displayed in the Point of Sale when the payments are selected.'});
    static outstandingAccountId = Fields.Many2one('account.account', {
        string: 'Outstanding Account',
        ondelete: 'RESTRICT',
        help: 'Leave empty to use the default account from the company setting.\n'+
             'Account used as outstanding account when creating accounting payment records for bank payments.'});
    static receivableAccountId = Fields.Many2one('account.account', {
        string: 'Intermediary Account',
        ondelete: 'RESTRICT',
        domain: [['reconcile', '=', true], ['userTypeId.type', '=', 'receivable']],
        help: "Leave empty to use the default account from the company setting.\n"+
             "Overrides the company's receivable account (for Point of Sale) used in the journal entries."});
    static isCashCount = Fields.Boolean({string: 'Cash', compute: "_computeIsCashCount", store: true});
    static journalId = Fields.Many2one('account.journal', {
        string: 'Journal',
        domain: [['type', 'in', ['cash', 'bank']]],
        ondelete: 'RESTRICT',
        help: 'Leave empty to use the receivable account of customer.\n'+
             'Defines the journal where to book the accumulated payments (or individual payment if Identify Customer is true) after closing the session.\n'+
             'For cash journal, we directly write to the default account in the journal via statement lines.\n'+
             'For bank journal, we write to the outstanding account specified in this payment method.\n'+
             'Only cash and bank journals are allowed.'});
    static splitTransactions = Fields.Boolean({
        string: 'Identify Customer',
        default: false,
        help: 'Forces to set a customer when using this payment method and splits the journal entries for each customer. It could slow down the closing process.'});
    static openSessionIds = Fields.Many2many('pos.session', {string: 'Pos Sessions', compute: '_computeOpenSessionIds', help: 'Open PoS sessions that are using this payment method.'});
    static configIds = Fields.Many2many('pos.config', {string: 'Point of Sale Configurations'});
    static companyId = Fields.Many2one('res.company', {string: 'Company', default: self => self.env.company()});
    static usePaymentTerminal = Fields.Selection({selection: (self) => self._getPaymentTerminalSelection(), string: 'Use a Payment Terminal', help: 'Record payments with a terminal on this journal.'});
    static hideUsePaymentTerminal = Fields.Boolean({compute: '_computeHideUsePaymentTerminal', help: 'Technical field which is used to hide usePaymentTerminal when no payment interfaces are installed.'});
    static active = Fields.Boolean({default: true});
    static type = Fields.Selection({selection: [['cash', 'Cash'], ['bank', 'Bank'], ['payLater', 'Customer Account']], compute: "_computeType"});

    @api.depends('type')
    async _computeHideUsePaymentTerminal() {
        const noTerminals = ! bool(await this._fields['usePaymentTerminal'].selection(this));
        for (const paymentMethod of this) {
            await paymentMethod.set('hideUsePaymentTerminal', noTerminals || ['cash', 'payLater'].includes(await paymentMethod.type));
        }
    }

    /**
     * Used by inheriting model to unset the value of the field related to the unselected payment terminal.
     * @returns 
     */
    @api.onchange('usePaymentTerminal')
    async _onchangeUsePaymentTerminal() {
    }

    @api.depends('configIds')
    async _computeOpenSessionIds() {
        for (const paymentMethod of this) {
            await paymentMethod.set('openSessionIds', await this.env.items('pos.session').search([['configId', 'in', (await paymentMethod.configIds).ids], ['state', '!=', 'closed']]));
        }
    }

    @api.depends('journalId', 'splitTransactions')
    async _computeType() {
        for (const pm of this) {
            const type = await (await pm.journalId).type;
            if (['cash', 'bank']. includes(type)) {
                await pm.set('type', type);
            }
            else {
                await pm.set('type', 'payLater');
            }
        }
    }

    @api.onchange('journalId')
    async _onchangeJournalId() {
        for (const pm of this) {
            const journal = await pm.journalId;
            if (journal.ok && !['cash', 'bank'].includes(journal.type)) {
                throw new UserError(await this._t("Only journals of type 'Cash' or 'Bank' could be used with payment methods."));
            }
        }
        if (await this['isCashCount']) {
            await this.set('usePaymentTerminal', false);
        }
    }

    @api.depends('type')
    async _computeIsCashCount() {
        for (const pm of this) {
            await pm.set('isCashCount', await pm.type === 'cash');
        }
    }

    async _isWriteForbidden(fields) {
        return bool(bool(fields) && await this['openSessionIds']);
    }

    async write(vals) {
        if (await this._isWriteForbidden(Object.keys(vals))) {
            throw new UserError('Please close and validate the following open PoS Sessions before modifying this payment method.\nOpen sessions: %s', (await (await this['openSessionIds']).mapped('label')).join(' '));
        }
        return _super(PosPaymentMethod, this).write(vals);
    }
}