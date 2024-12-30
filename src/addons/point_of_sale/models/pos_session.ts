import { Command, Fields, _Date, _Datetime, api } from "../../../core";
import { setdefault } from "../../../core/api";
import { AccessError, DefaultDict2, MapDefaultKey, MapKey, UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { _f, bool, f, floatCompare, floatIsZero, isInstance, len, subDate, sum, update } from "../../../core/tools";

const POS_SESSION_STATE = [
    ['opening', 'Opening Control'],     // method actionPosSessionOpen
    ['opened', 'Opened In Progress'],   // method actionPosSessionClosingControl
    ['closing', 'Closing Control'],     // method actionPosSessionClose
    ['closed', 'Closed & Posted'],
];

@MetaModel.define()
class PosSession extends Model {
    static _module = module;
    static _name = 'pos.session';
    static _order = 'id desc';
    static _description = 'Point of Sale Session';
    static _parents = ['mail.thread', 'mail.activity.mixin'];

    static companyId = Fields.Many2one('res.company', {related: 'configId.companyId', string: "Company", readonly: true});

    static configId = Fields.Many2one(
        'pos.config', {string: 'Point of Sale',
        help: "The physical point of sale you will use.",
        required: true,
        index: true});
    static label = Fields.Char({string: 'Session ID', required: true, readonly: true, default: '/'});
    static userId = Fields.Many2one(
        'res.users', {string: 'Opened By',
        required: true,
        index: true,
        readonly: true,
        states: {'opening': [['readonly', false]]},
        default: self => self.env.uid,
        ondelete: 'RESTRICT'});
    static currencyId = Fields.Many2one('res.currency', {related: 'configId.currencyId', string: "Currency", readonly: false});
    static startAt = Fields.Datetime({string: 'Opening Date', readonly: true});
    static stopAt = Fields.Datetime({string: 'Closing Date', readonly: true, copy: false});

    static state = Fields.Selection(
        POS_SESSION_STATE, {string: 'Status',
        required: true, readonly: true,
        index: true, copy: false, default: 'opening'});

    static sequenceNumber = Fields.Integer({string: 'Order Sequence Number', help: 'A sequence number that is incremented with each order', default: 1});
    static loginNumber = Fields.Integer({string: 'Login Sequence Number', help: 'A sequence number that is incremented each time a user resumes the pos session', default: 0});

    static openingNotes = Fields.Text({string: "Opening Notes"});
    static cashControl = Fields.Boolean({compute: '_computeCashAll', string: 'Has Cash Control', computeSudo: true});
    static cashJournalId = Fields.Many2one('account.journal', {compute: '_computeCashAll', string: 'Cash Journal', store: true});
    static cashRegisterId = Fields.Many2one('account.bank.statement', {compute: '_computeCashAll', string: 'Cash Register', store: true});

    static cashRegisterBalanceEndReal = Fields.Monetary({
        related: 'cashRegisterId.balanceEndReal',
        string: "Ending Balance",
        help: "Total of closing cash control lines.",
        readonly: true});
    static cashRegisterBalanceStart = Fields.Monetary({
        related: 'cashRegisterId.balanceStart',
        string: "Starting Balance",
        help: "Total of opening cash control lines.",
        readonly: true});
    static cashRegisterTotalEntryEncoding = Fields.Monetary({
        compute: '_computeCashBalance',
        string: 'Total Cash Transaction',
        readonly: true,
        help: "Total of all paid sales orders"});
    static cashRegisterBalanceEnd = Fields.Monetary({
        compute: '_computeCashBalance',
        string: "Theoretical Closing Balance",
        help: "Sum of opening balance and transactions.",
        readonly: true});
    static cashRegisterDifference = Fields.Monetary({
        compute: '_computeCashBalance',
        string: 'Before Closing Difference',
        help: "Difference between the theoretical closing balance and the real closing balance.",
        readonly: true});
    static cashRealDifference = Fields.Monetary({string: 'Difference', readonly: true});
    static cashRealTransaction = Fields.Monetary({string: 'Transaction', readonly: true});
    static cashRealExpected = Fields.Monetary({string: "Expected", readonly: true});

    static orderIds = Fields.One2many('pos.order', 'sessionId', {string: 'Orders'});
    static orderCount = Fields.Integer({compute: '_computeOrderCount'});
    static statementIds = Fields.One2many('account.bank.statement', 'posSessionId', {string: 'Cash Statements', readonly: true});
    static failedPickings = Fields.Boolean({compute: '_computePickingCount'});
    static pickingCount = Fields.Integer({compute: '_computePickingCount'});
    static pickingIds = Fields.One2many('stock.picking', 'posSessionId');
    static rescue = Fields.Boolean({string: 'Recovery Session',
        help: "Auto-generated session for orphan orders, ignored in constraints",
        readonly: true,
        copy: false});
    static moveId = Fields.Many2one('account.move', {string: 'Journal Entry', index: true});
    static paymentMethodIds = Fields.Many2many('pos.payment.method', {related: 'configId.paymentMethodIds', string: 'Payment Methods'});
    static totalPaymentsAmount = Fields.Float({compute: '_computeTotalPaymentsAmount', string: 'Total Payments Amount'});
    static isInCompanyCurrency = Fields.Boolean('Is Using Company Currency', {compute: '_computeIsInCompanyCurrency'});
    static updateStockAtClosing = Fields.Boolean('Stock should be updated at closing');
    static bankPaymentIds = Fields.One2many('account.payment', 'posSessionId', {string: 'Bank Payments', help: 'Account payments representing aggregated and bank split payments.'});

    static _sqlConstraints = [['uniq_label', 'unique(label)', "The label of this POS Session must be unique !"]];

    @api.depends('currencyId', 'companyId.currencyId')
    async _computeIsInCompanyCurrency() {
        for (const session of this) {
            await session.set('isInCompanyCurrency', (await session.currencyId).eq(await (await session.companyId).currencyId));
        }
    }

    @api.depends('paymentMethodIds', 'orderIds', 'cashRegisterBalanceStart', 'cashRegisterId')
    async _computeCashBalance() {
        for (const session of this) {
            const cashPaymentMethod = (await (await session.paymentMethodIds).filtered('isCashCount')).slice(0, 1);
            if (cashPaymentMethod.ok) {
                let totalCashPayment = 0.0;
                const result = await this.env.items('pos.payment').readGroup([['sessionId', '=', session.id], ['paymentMethodId', '=', cashPaymentMethod.id]], ['amount'], ['sessionId']);
                if (bool(result)) {
                    totalCashPayment = result[0]['amount'];
                }
                await session.set('cashRegisterTotalEntryEncoding', await (await session.cashRegisterId).totalEntryEncoding + (
                    await session.state == 'closed' ? 0.0 : totalCashPayment
                ));
                await session.set('cashRegisterBalanceEnd', await session.cashRegisterBalanceStart + await session.cashRegisterTotalEntryEncoding);
                await session.set('cashRegisterDifference', await session.cashRegisterBalanceEndReal - await session.cashRegisterBalanceEnd);
            }
            else {
                await session.update({
                    cashRegisterTotalEntryEncoding: 0.0,
                    cashRegisterBalanceEnd: 0.0,
                    cashRegisterDifference: 0.0
                });
            }
        }
    }

    @api.depends('orderIds.paymentIds.amount')
    async _computeTotalPaymentsAmount() {
        const result = await this.env.items('pos.payment').readGroup([['sessionId', 'in', this.ids]], ['amount'], ['sessionId']);
        const sessionAmountMap = Object.fromEntries(result.map(data => [data['sessionId'][0], data['amount']]));
        for (const session of this) {
            await session.set('totalPaymentsAmount', sessionAmountMap[session.id] ?? 0);
        }
    }

    async _computeOrderCount() {
        const ordersData = await this.env.items('pos.order').readGroup([['sessionId', 'in', this.ids]], ['sessionId'], ['sessionId']);
        const sessionsData = Object.fromEntries(ordersData.map(orderData => [orderData['sessionId'][0], orderData['sessionId_count']]));
        for (const session of this) {
            await session.set('orderCount', sessionsData[session.id] ?? 0);
        }
    }

    @api.depends('pickingIds', 'pickingIds.state')
    async _computePickingCount() {
        for (const session of this) {
            await session.set('pickingCount', await this.env.items('stock.picking').searchCount([['posSessionId', '=', session.id]]));
            await session.set('failedPickings', bool(await this.env.items('stock.picking').search([['posSessionId', '=', session.id], ['state', '!=', 'done']], {limit: 1})));
        }
    }

    async actionStockPicking() {
        this.ensureOne();
        const action = await this.env.items('ir.actions.actions')._forXmlid('stock.actionPickingTreeReady');
        action['displayName'] = await this._t('Pickings');
        action['context'] = {}
        action['domain'] = [['id', 'in', (await this['pickingIds']).ids]];
        return action;
    }

    @api.depends('configId', 'statementIds', 'paymentMethodIds')
    async _computeCashAll() {
        // Only one cash register is supported by point_of_sale.
        for (const session of this) {
            await session.update({
                cashJournalId: false, 
                cashRegisterId: false,
                cashControl: false
            });
            const cashPaymentMethods = await (await session.paymentMethodIds).filtered('isCashCount');
            if (! cashPaymentMethods.ok) {
                continue;
            }
            for (const statement of await session.statementIds) {
                if ((await statement.journalId).eq(await cashPaymentMethods[0].journalId)) {
                    await session.set('cashControl', await (await session.configId).cashControl);
                    await session.set('cashJournalId', (await statement.journalId).id);
                    await session.set('cashRegisterId', statement.id);
                    break;  // stop iteration after finding the cash journal
                }
            }
        }
    }

    @api.constrains('configId')
    async _checkPosConfig() {
        if (await this.searchCount([
                ['state', '!=', 'closed'],
                ['configId', '=', (await this['configId']).id],
                ['rescue', '=', false]
            ]) > 1) {
            throw new ValidationError(await this._t("Another session is already opened for this point of sale."));
        }
    }

    @api.constrains('startAt')
    async _checkStartDate() {
        for (const record of this) {
            const company = await (await (await record.configId).journalId).companyId;
            const startDate = _Date.toDate(await record.startAt);
            if ((await company.periodLockDate && startDate <= await company.periodLockDate) || (await company.fiscalyearLockDate && startDate <= await company.fiscalyearLockDate)) {
                throw new ValidationError(await this._t("You cannot create a session before the accounting lock date."));
            }
        }
    }

    async _checkBankStatementState() {
        for (const session of this) {
            const closedStatementIds = await (await session.statementIds).filtered(async (x) => await x.state !== "open");
            if (closedStatementIds.ok) {
                throw new UserError(await this._t("Some Cash Registers are already posted. Please reset them to new in order to close the session.\nCash Registers: %s", String(await closedStatementIds.map(statement => statement.label))));
            }
        }
    }

    async _checkInvoicesArePosted() {
        const unpostedInvoices = await (await (await (await (await this['orderIds']).sudo()).withCompany(await this['companyId'])).accountMove).filtered(async (x) => await x.state !== 'posted');
        if (unpostedInvoices.ok) {
            throw new UserError(await this._t('You cannot close the POS when invoices are not posted.\nInvoices: %s', (await unpostedInvoices.map(async (invoice) => f('%s - %s', await invoice.label, await invoice.state))).join('\n')));
        }
    }

    @api.model()
    async create(values) {
        const configId = values['configId'] || this.env.context['default_configId'];
        if (! configId) {
            throw new UserError(await this._t("You should assign a Point of Sale to your session."));
        }
        // journalId is not required on the pos_config because it does not
        // exists at the installation. If nothing is configured at the
        // installation we do the minimal configuration. Impossible to do in
        // the .xml files as the CoA is not yet installed.
        const posConfig = this.env.items('pos.config').browse(configId);
        const ctx = Object.assign({}, this.env.context, {companyId: (await posConfig.companyId).id});

        let posName = await (await this.env.items('ir.sequence').withContext(ctx)).nextByCode('pos.session');
        if (values['label']) {
            posName += ' ' + values['label'];
        }
        const cashPaymentMethods = await (await posConfig.paymentMethodIds).filtered(pm => pm.isCashCount);
        let statementIds = this.env.items('account.bank.statement');
        if (await this.userHasGroups('point_of_sale.groupPosUser')) {
            statementIds = await statementIds.sudo();
        }
        for (const cashJournal of await cashPaymentMethods.mapped('journalId')) {
            ctx['journalId'] = await posConfig.cashControl && await cashJournal.type === 'cash' ? cashJournal.id : false
            const stValues = {
                'journalId': cashJournal.id,
                'userId': (await this.env.user()).id,
                'label': posName,
            }
            statementIds = statementIds.or(await (await statementIds.withContext(ctx)).create(stValues));
        }
        const updateStockAtClosing = await (await posConfig.companyId).pointOfSaleUpdateStockQuantities === "closing";

        update(values, {
            'label': posName,
            'statementIds': [[6, 0, statementIds.ids]],
            'configId': configId,
            'updateStockAtClosing': updateStockAtClosing,
        });

        let res;
        if (await this.userHasGroups('point_of_sale.groupPosUser')) {
            res = await _super(PosSession, await (await this.withContext(ctx)).sudo()).create(values);
        }
        else {
            res = await _super(PosSession, await this.withContext(ctx)).create(values);
        }
        await res.actionPosSessionOpen();

        return res;
    }

    async unlink() {
        for (const session of await this.filtered(s => s.statementIds)) {
            await (await session.statementIds).unlink();
        }
        return _super(PosSession, this).unlink();
    }

    async login() {
        this.ensureOne();
        const loginNumber = await this['loginNumber'] + 1;
        await this.write({
            'loginNumber': loginNumber,
        });
        return loginNumber;
    }

    async actionPosSessionOpen() {
        // second browse because we need to refetch the data from the DB for cashRegisterId
        // we only open sessions that haven't already been opened
        for (const session of await this.filtered(async (session) => await session.state === 'opening')) {
            const values = {}
            if (! await session.startAt) {
                values['startAt'] = _Datetime.now();
            }
            if (await (await session.configId).cashControl && ! await session.rescue) {
                const lastSession = await this.search([['configId', '=', (await session.configId).id], ['id', '!=', session.id]], {limit: 1});
                await (await session.cashRegisterId).set('balanceStart', lastSession.ok ? await (await lastSession.cashRegisterId).balanceEndReal : 0);
                values['state'] = 'opening';
            }
            else {
                values['state'] = 'opened';
            }
            await session.write(values);
        }
        return true;
    }

    async actionPosSessionClosingControl(balancingAccount=false, amountToBalance=0, bankPaymentMethodDiffs={}) {
        await this._checkPosSessionBalance();
        for (const session of this) {
            if (await (await session.orderIds).some(async (order) => await order.state === 'draft')) {
                throw new UserError(await this._t("You cannot close the POS when orders are still in draft"));
            }
            if (await session.state === 'closed') {
                throw new UserError(await this._t('This session is already closed.'));
            };
            const [config, orderIds] = await session('configId', 'orderIds');
            await session.write({'state': 'closing', 'stopAt': _Datetime.now()});
            if (! await config.cashControl) {
                return session.actionPosSessionClose(balancingAccount, amountToBalance, bankPaymentMethodDiffs);
            }
            // If the session is in rescue, we only compute the payments in the cash register
            // It is not yet possible to close a rescue session through the front end, see `close_session_from_ui`
            if (await session.rescue && await config.cashControl) {
                const defaultCashPaymentMethodId = (await (await this['paymentMethodIds']).filtered(async (pm) => await pm.type === 'cash'))[0];
                const orders = await orderIds.filtered(async (o) => await o.state === 'paid' || await o.state === 'invoiced');
                const totalCash = sum(
                    await (await (await orders.paymentIds).filtered(async (p) => (await p.paymentMethodId).eq(defaultCashPaymentMethodId))).mapped('amount')
                ) + await this['cashRegisterBalanceStart'];

                await (await session.cashRegisterId).set('balanceEndReal', totalCash);
            }
            return session.actionPosSessionValidate(balancingAccount, amountToBalance, bankPaymentMethodDiffs);
        }
    }

    async _checkPosSessionBalance() {
        for (const session of this) {
            for (const statement of await session.statementIds) {
                if (!statement.eq(await session.cashRegisterId) && (await statement.balanceEnd != await statement.balanceEndReal)) {
                    await statement.write({'balanceEndReal': await statement.balanceEnd});
                }
            }
        }
    }

    async actionPosSessionValidate(balancingAccount=false, amountToBalance=0, bankPaymentMethodDiffs={}) {
        await this._checkPosSessionBalance();
        return this.actionPosSessionClose(balancingAccount, amountToBalance, bankPaymentMethodDiffs);
    }

    async actionPosSessionClose(balancingAccount=false, amountToBalance=0, bankPaymentMethodDiffs={}) {
        // Session without cash payment method will not have a cash register.
        // However, there could be other payment methods, thus, session still
        // needs to be validated.
        await this._checkBankStatementState();
        return this._validateSession(balancingAccount, amountToBalance, bankPaymentMethodDiffs);
    }

    async _validateSession(balancingAccount=false, amountToBalance=0, bankPaymentMethodDiffs={}) {
        this.ensureOne();
        const sudo = await this.userHasGroups('point_of_sale.groupPosUser');
        const [orderIds, company, config] = await this('orderIds', 'companyId', 'configId');
        if (bool(orderIds) || bool(await (await (await this.sudo()).statementIds).lineIds)) {
            await this.set('cashRealTransaction', await this['cashRegisterTotalEntryEncoding']);
            await this.set('cashRealExpected', await this['cashRegisterBalanceEnd']);
            await this.set('cashRealDifference', await this['cashRegisterDifference']);
            if (await this['state'] === 'closed') {
                throw new UserError(await this._t('This session is already closed.'));
            }
            await this._checkIfNoDraftOrders();
            await this._checkInvoicesArePosted();
            if (await this['updateStockAtClosing']) {
                await this._createPickingAtEndOfSession();
                await (await orderIds.filtered(async (o) => ! await o.isTotalCostComputed))._computeTotalCostAtSessionClosing(await (await this['pickingIds']).moveLines);
            }
            let data;
            try {
                // with this.env.cr.savepoint():
                    data = await (await this.withCompany(company))._createAccountMove(balancingAccount, amountToBalance, bankPaymentMethodDiffs);
            } catch(e) {
                if (isInstance(e, AccessError)) {
                    if (sudo) {
                        data = await (await (await this.sudo()).withCompany(company))._createAccountMove(balancingAccount, amountToBalance, bankPaymentMethodDiffs);
                    }
                    else {
                        throw e;
                    }
                } 
                else {
                    throw e;
                }
            }
            const move = await this['moveId'];
            let balance;
            try {
                balance = sum(await (await move.lineIds).mapped('balance'));
                await move._checkBalanced();
            } catch(e) {
                if (isInstance(e, UserError)) {
                    // Creating the account move is just part of a big database transaction
                    // when closing a session. There are other database changes that will happen
                    // before attempting to create the account move, such as, creating the picking
                    // records.
                    // We don't, however, want them to be committed when the account move creation
                    // failed; therefore, we need to roll back this transaction before showing the
                    // close session wizard.
                    await this.env.cr.rollback();
                    return this._closeSessionAction(balance);
                } else {
                    throw e;
                }
            }

            if (bool(await move.lineIds)) {
                await (await (await move.sudo()).withCompany(company))._post();
                // Set the uninvoiced orders' state to 'done'
                await (await this.env.items('pos.order').search([['sessionId', '=', this.id], ['state', '=', 'paid']])).write({'state': 'done'});
            }
            else {
                await (await move.sudo()).unlink();
            }
            await (await (await this.sudo()).withCompany(company))._reconcileAccountMoveLines(data);
        }
        else {
            const statement = await this['cashRegisterId'];
            if (! await config.cashControl) {
                statement.write({'balanceEndReal': await statement.balanceEnd});
            }
            await (await statement.sudo()).buttonPost();
            await statement.buttonValidate();
        }
        await this.write({'state': 'closed'});
        return true;
    }

    async _closeSessionAction(amountToBalance) {
        // NOTE This can't handle `bank_payment_method_diffs` because there is no field in the wizard that can carry it.
        const defaultAccount = await this._getBalancingAccount();
        const wizard = await this.env.items('pos.close.session.wizard').create({
            'amountToBalance': amountToBalance,
            'accountId': defaultAccount.id,
            'accountReadonly': ! await (await this.env.user()).hasGroup('account.groupAccountReadonly'),
            'message': await this._t("There is a difference between the amounts to post and the amounts of the orders, it is probably caused by taxes or accounting configurations changes.")
        });
        return {
            'label': await this._t("Force Close Session"),
            'type': 'ir.actions.actwindow',
            'viewType': 'form',
            'viewMode': 'form',
            'resModel': 'pos.close.session.wizard',
            'resId': wizard.id,
            'target': 'new',
            'context': {...this.env.context, 'activeIds': this.ids, 'activeModel': 'pos.session'},
        }
    }

    /**
     * Calling this method will try to close the session.

        param bank_payment_method_diff_pairs: list[(int, float)]
            Pairs of paymentMethodId and diff_amount which will be used to post
            loss/profit when closing the session.

        If successful, it returns {'successful': true}
        Otherwise, it returns {'successful': false, 'message': str, 'redirect': bool}.
        'redirect' is a boolean used to know whether we redirect the user to the back end or not.
        When necessary, error (i.e. UserError, AccessError) is raised which should redirect the user to the back end.
     * @param bankPaymentMethodDiffPairs 
     */
    async closeSessionFromUi(bankPaymentMethodDiffPairs?: any) {
        const bankPaymentMethodDiffs = Object.fromEntries(bankPaymentMethodDiffPairs ?? []);
        this.ensureOne();
        // Even if this is called in `post_closing_cash_details`, we need to call this here too for case
        // where cashControl = false
        const checkClosingSession = await this._cannotCloseSession(bankPaymentMethodDiffs);
        if (checkClosingSession) {
            return checkClosingSession;
        }
        // For now we won't simply do
        // await this._checkPosSessionBalance()
        // await this._checkBankStatementState()
        // validateResult = await this._validateSession()
        // because some functions are being used and overridden in other modules...
        // so we'll try to use the original flow as of now for the moment
        const validateResult = await this.actionPosSessionClosingControl(false, 0, bankPaymentMethodDiffs);

        // If an error is raised, the user will still be redirected to the back end to manually close the session.
        // If the return result is a dict, this means that normally we have a redirection or a wizard => we redirect the user
        if (isInstance(validateResult, {})) {
            // imbalance accounting entry
            return {
                'successful': false,
                'message': validateResult['label'],
                'redirect': true
            }
        }

        await (this as any).messagePost({body: 'Point of Sale Session ended'});

        return {'successful': true}
    }

    async updateClosingControlStateSession(notes) {
        // Prevent closing the session again if it was already closed
        if (await this['state'] === 'closed') {
            throw new UserError(await this._t('This session is already closed.'));
        }
        // Prevent the session to be opened again.
        await this.write({'state': 'closing', 'stopAt': _Datetime.now()});
        await this._postCashDetailsMessage('Closing', await this['cashRegisterDifference'], notes);
    }

    /**
     * Calling this method will try store the cash details during the session closing.

        :param counted_cash: float, the total cash the user counted from its cash register
        If successful, it returns {'successful': true}
        Otherwise, it returns {'successful': false, 'message': str, 'redirect': bool}.
        'redirect' is a boolean used to know whether we redirect the user to the back end or not.
        When necessary, error (i.e. UserError, AccessError) is raised which should redirect the user to the back end.
     * @param countedCash 
     * @returns 
     */
    async postClosingCashDetails(countedCash) {
        this.ensureOne();
        const checkClosingSession = await this._cannotCloseSession();
        if (checkClosingSession) {
            return checkClosingSession;
        }

        const cashRegister = await this['cashRegisterId'];
        if (! bool(cashRegister)) {
            // The user is blocked anyway, this user error is mostly for developers that try to call this function
            throw new UserError(await this._t("There is no cash register in this session."));
        }

        await cashRegister.set('balanceEndReal', countedCash);

        return {'successful': true}
    }

    async _createDiffAccountMoveForSplitPaymentMethod(paymentMethod, diffAmount) {
        this.ensureOne();

        const getDiffValsResult = await this._getDiffVals(paymentMethod.id, diffAmount);
        if (! bool(getDiffValsResult)) {
            return;
        }

        const [sourceVals, destVals] = getDiffValsResult;
        const diffMove = await this.env.items('account.move').create({
            'journalId': (await paymentMethod.journalId).id,
            'date': await _Date.contextToday(this),
            'ref': await this._getDiffAccountMoveRef(paymentMethod),
            'lineIds': [Command.create(sourceVals), Command.create(destVals)]
        })
        await diffMove._post();
    }

    async _getDiffAccountMoveRef(paymentMethod) {
        return this._t('Closing difference in %s (%s)', await paymentMethod.label, await this['label']);
    }

    async _getDiffVals(paymentMethodId, diffAmount): Promise<any> {
        let paymentMethod = this.env.items('pos.payment.method').browse(paymentMethodId);
        const [currency, company] = await this('currencyId', 'companyId');
        let diffCompareToZero = await currency.compareAmounts(diffAmount, 0);
        let sourceAccount = await paymentMethod.outstandingAccountId;
        sourceAccount = bool(sourceAccount) ? sourceAccount : await company.accountJournalPaymentDebitAccountId;
        let destinationAccount = this.env.items('account.account');

        const journal = await paymentMethod.journalId;
        if (diffCompareToZero > 0) {
            destinationAccount = await journal.profitAccountId;
        }
        else if (diffCompareToZero < 0) {
            destinationAccount = await journal.lossAccountId;
        }

        if (diffCompareToZero == 0 || ! bool(sourceAccount)) {
            return false;
        }

        const amounts = await this._updateAmounts({'amount': 0, 'amountConverted': 0}, {'amount': diffAmount}, await this['stopAt']);
        const sourceVals = await this._debitAmounts({'accountId': sourceAccount.id}, amounts['amount'], amounts['amountConverted']);
        const destVals = await this._creditAmounts({'accountId': destinationAccount.id}, amounts['amount'], amounts['amountConverted']);
        return [sourceVals, destVals];
    }

    /**
     * Add check in this method if you want to return or throw new an error when trying to either post cash details
        or close the session. Raising an error will always redirect the user to the back end.
        It should return {'successful': false, 'message': str, 'redirect': bool} if we can't close the session
     * @param bankPaymentMethodDiffs 
     * @returns 
     */
    async _cannotCloseSession(bankPaymentMethodDiffs={}) {
        if (await (await this['orderIds']).some(async (order) => await order.state === 'draft')) {
            return {'successful': false, 'message': await this._t("You cannot close the POS when orders are still in draft"), 'redirect': false}
        }
        if (await this['state'] === 'closed') {
            return {'successful': false, 'message': await this._t("This session is already closed."), 'redirect': true}
        }
        if (bool(bankPaymentMethodDiffs)) {
            let noLossAccount = this.env.items('account.journal');
            let noProfitAccount = this.env.items('account.journal');
            for (const paymentMethod of this.env.items('pos.payment.method').browse(Object.keys(bankPaymentMethodDiffs))) {
                const journal = await paymentMethod.journalId;
                const compareToZero = await (await this['currencyId']).compareAmounts(bankPaymentMethodDiffs[paymentMethod.id], 0);
                if (compareToZero == -1 && !bool(await journal.lossAccountId)) {
                    noLossAccount = noLossAccount.or(journal);
                }
                else if (compareToZero == 1 && ! bool(await journal.profitAccountId)) {
                    noProfitAccount = noProfitAccount.or(journal);
                }
            }
            let message = '';
            if (bool(noLossAccount)) {
                message += await this._t("Need loss account for the following journals to post the lost amount: %s\n", (await noLossAccount.mapped('label')).join(', '));
            }
            if (bool(noProfitAccount)) {
                message += await this._t("Need profit account for the following journals to post the gained amount: %s", (await noProfitAccount.mapped('label')).join(', '));
            }
            if (message) {
                return {'successful': false, 'message': message, 'redirect': false}
            }
        }
    }

    async getClosingControlData() {
        if (! await (await this.env.user()).hasGroup('point_of_sale.groupPosUser')) {
            throw new AccessError(await this._t("You don't have the access rights to get the point of sale closing control data."));
        }
        this.ensureOne();
        const [orderIds, paymentMethodIds, config] = await this('orderIds', 'paymentMethodIds', 'configId');
        const orders = await orderIds.filtered(async (o) => await o.state === 'paid' || await o.state === 'invoiced');
        const payments = await (await orders.paymentIds).filtered(async (p) => await (await p.paymentMethodId).type !== "payLater");
        const payLaterPayments = (await orders.paymentIds).sub(payments);
        const cashPaymentMethodIds = await paymentMethodIds.filtered(async (pm) => await pm.type === 'cash');
        const defaultCashPaymentMethodId = bool(cashPaymentMethodIds) ? cashPaymentMethodIds[0] : null;
        const totalDefaultCashPaymentAmount = bool(defaultCashPaymentMethodId) ? sum(await (await payments.filtered(async (p) => (await p.paymentMethodId).eq(defaultCashPaymentMethodId))).mapped('amount')) : 0;
        const otherPaymentMethodIds = bool(defaultCashPaymentMethodId) ? paymentMethodIds.sub(defaultCashPaymentMethodId) : paymentMethodIds;
        let cashInCount = 0;
        let cashOutCount = 0;
        let cashInOutList = [];
        for (const cashMove of await (await (await (await this.sudo()).cashRegisterId).lineIds).sorted('createdAt')) {
            let label;
            const [amount, paymentRef] = await cashMove('amount', 'paymentRef');
            if (amount > 0) {
                cashInCount += 1;
                label = `Cash in ${cashInCount}`;
            }
            else {
                cashOutCount += 1;
                label = `Cash out ${cashOutCount}`;
            }
            cashInOutList.push({
                'label': paymentRef ? paymentRef : label,
                'amount': amount
            });
        }
        return {
            'ordersDetails': {
                'quantity': len(orders),
                'amount': sum(await orders.mapped('amountTotal'))
            },
            'paymentsAmount': sum(await payments.mapped('amount')),
            'payLaterAmount': sum(await payLaterPayments.mapped('amount')),
            'openingNotes': await this['openingNotes'],
            'defaultCashDetails': !bool(defaultCashPaymentMethodId) ? null : {
                'label': await defaultCashPaymentMethodId.label,
                'amount': await (await this['cashRegisterId']).balanceStart + totalDefaultCashPaymentAmount +
                                             sum(await (await (await (await this.sudo()).cashRegisterId).lineIds).mapped('amount')),
                'opening': await (await this['cashRegisterId']).balanceStart,
                'paymentAmount': totalDefaultCashPaymentAmount,
                'moves': cashInOutList,
                'id': defaultCashPaymentMethodId.id
            },
            'otherPaymentMethods': await otherPaymentMethodIds.map(async (pm) => {
                return {
                    'label': await pm.label,
                    'amount': sum(await (await (await orders.paymentIds).filtered(async (p) => (await p.paymentMethodId).eq(pm))).mapped('amount')),
                    'number': len(await (await orders.paymentIds).filtered(async (p) => (await p.paymentMethodId).eq(pm))),
                    'id': pm.id,
                    'type': await pm.type,
                }
            }),
            'isManager': await this.userHasGroups("point_of_sale.groupPosManager"),
            'amountAuthorizedDiff': await config.setMaximumDifference ? await config.amountAuthorizedDiff : null
        }
    }

    async _createPickingAtEndOfSession() {
        this.ensureOne();
        const linesGroupedByDestLocation = new MapKey();
        const pickingType = await (await this['configId']).pickingTypeId;

        let sessionDestinationId;
        if (! bool(pickingType) || ! bool(await pickingType.defaultLocationDestId)) {
            sessionDestinationId = (await this.env.items('stock.warehouse')._getPartnerLocations())[0].id;
        }
        else {
            sessionDestinationId = (await pickingType.defaultLocationDestId).id;
        }
        for (const order of await this['orderIds']) {
            if (await (await order.companyId).angloSaxonAccounting && await order.isInvoiced || await order.toShip) {
                continue;
            }
            let destinationId = await (await order.partnerId).propertyStockCustomer.id;
            destinationId = bool(destinationId) ? destinationId : sessionDestinationId;
            if (linesGroupedByDestLocation.has(destinationId)) {
                linesGroupedByDestLocation[destinationId] = linesGroupedByDestLocation[destinationId].or(await order.lines);
            }
            else {
                linesGroupedByDestLocation[destinationId] = await order.lines;
            }
        }

        for (const [locationDestId, lines] of Object.entries(linesGroupedByDestLocation)) {
            const pickings = await this.env.items('stock.picking')._createPickingFromPosOrderLines(locationDestId, lines, pickingType);
            await pickings.write({'posSessionId': this.id, 'origin': await this['label']});
        }
    }

    async _createBalancingLine(data, balancingAccount, amountToBalance) {
        if (!floatIsZero(amountToBalance, {precisionRounding: await (await this['currencyId']).rounding})) {
            const balancingVals = await this._prepareBalancingLineVals(amountToBalance, await this['moveId'], balancingAccount);
            const moveLine = data['moveLine'];
            await moveLine.create(balancingVals);
        }
        return data;
    }

    async _prepareBalancingLineVals(imbalanceAmount, move, balancingAccount) {
        const partialVals = {
            'label': await this._t('Difference at closing PoS session'),
            'accountId': balancingAccount.id,
            'moveId': move.id,
            'partnerId': false,
        }
        // `imbalanceAmount` is already in terms of company currency so it is the amount_converted
        // param when calling `_creditAmounts`. amount param will be the converted value of
        // `imbalanceAmount` from company currency to the session currency.
        let imbalanceAmountSession = 0;
        if (! await this['isInCompanyCurrency']) {
            imbalanceAmountSession = await (await (await this['companyId']).currencyId)._convert(imbalanceAmount, await this['currencyId'], await this['companyId'], await _Date.contextToday(this));
        }
        return this._creditAmounts(partialVals, imbalanceAmountSession, imbalanceAmount);
    }

    async _getBalancingAccount() {
        const propoertyAccount = await this.env.items('ir.property')._get('propertyAccountReceivableId', 'res.partner');
        let res = await (await this['companyId']).accountDefaultPosReceivableAccountId;
        res = bool(res) ? res : propoertyAccount;
        return bool(res) ? res : this.env.items('account.account');
    }

    /**
     * Create account.move and account.move.line records for this session.

        Side-effects include:
            - setting self.moveId to the created account.move record
            - creating and validating account.bank.statement for cash payments
            - reconciling cash receivable lines, invoice receivable lines and stock output lines
     * @param balancingAccount 
     * @param amountToBalance 
     * @param bankPaymentMethodDiffs 
     */
    async _createAccountMove(balancingAccount=false, amountToBalance=0, bankPaymentMethodDiffs={}) {
        const journal = await (await this['configId']).journalId;
        // Passing default_journal_id for the calculation of default currency of account move
        // See _get_default_currency in the account/account_move..
        const accountMove = await (await this.env.items('account.move').withContext({default_journalId: journal.id})).create({
            'journalId': journal.id,
            'date': await _Date.contextToday(this),
            'ref': await this['label'],
        })
        await this.write({'moveId': accountMove.id})

        let data = {'bankPaymentMethodDiffs': bankPaymentMethodDiffs}
        data = await this._accumulateAmounts(data);
        data = await this._createNonReconciliableMoveLines(data);
        data = await this._createBankPaymentMoves(data);
        data = await this._createPayLaterReceivableLines(data);
        data = await this._createCashStatementLinesAndCashMoveLines(data);
        data = await this._createInvoiceReceivableLines(data);
        data = await this._createStockOutputLines(data);
        if (bool(balancingAccount) && amountToBalance) {
            data = await this._createBalancingLine(data, balancingAccount, amountToBalance);
        }

        return data;
    }

    async _accumulateAmounts(data) {
        // Accumulate the amounts for each accounting lines group
        // Each dict maps `key` -> `amounts`, where `key` is the group key.
        // E.g. `combine_receivables_bank` is derived from pos.payment records
        // in the self.orderIds with group key of the `paymentMethodId`
        // field of the pos.payment record.
        const amounts = () => { return {'amount': 0.0, 'amountConverted': 0.0} }
        const taxAmounts = () => { return {'amount': 0.0, 'amountConverted': 0.0, 'baseAmount': 0.0, 'baseAmountConverted': 0.0} }
        const splitReceivablesBank = new MapDefaultKey(amounts),
        splitReceivablesCash = new MapDefaultKey(amounts),
        splitReceivablesPayLater = new MapDefaultKey(amounts),
        combineReceivablesBank = new MapDefaultKey(amounts),
        combineReceivablesCash = new MapDefaultKey(amounts),
        combineReceivablesPayLater = new MapDefaultKey(amounts),
        combineInvoiceReceivables = new MapDefaultKey(amounts),
        splitInvoiceReceivables = new MapDefaultKey(amounts),
        sales = new MapDefaultKey(amounts, item => String(item)),
        stockExpense = new MapDefaultKey(amounts),
        stockReturn = new MapDefaultKey(amounts),
        stockOutput = new MapDefaultKey(amounts),
        taxes = new MapDefaultKey(taxAmounts, item => String(item)),
        // Track the receivable lines of the order's invoice payment moves for reconciliation
        // These receivable lines are reconciled to the corresponding invoice receivable lines
        // of this session's moveId.
        combineInvPaymentReceivableLines = new MapDefaultKey(() => this.env.items('account.move.line')),
        splitInvPaymentReceivableLines = new MapDefaultKey(() => this.env.items('account.move.line')),
        
        [company, currency, orderIds] = await this('companyId', 'currencyId', 'orderIds'),
        roundedGlobally = await company.taxCalculationRoundingMethod === 'roundGlobally',
        posReceivableAccount = await company.accountDefaultPosReceivableAccountId,
        currencyRounding = await currency.rounding;
        let roundingDifference = {'amount': 0.0, 'amount_converted': 0.0};
        
        for (const order of orderIds) {
            const orderIsInvoiced = await order.isInvoiced;
            for (const payment of await order.paymentIds) {
                const amount = await payment.amount;
                if (floatIsZero(amount, {precisionRounding: currencyRounding})) {
                    continue;
                }
                const [date, paymentMethod] = await payment('paymentDate', 'paymentMethodId');
                const [isSplitPayment, paymentType] = await paymentMethod('splitTransactions', 'type');

                // If not pay_later, we create the receivable vals for both invoiced and uninvoiced orders.
                //   Separate the split and aggregated payments.
                // Moreover, if the order is invoiced, we create the pos receivable vals that will balance the
                // pos receivable lines from the invoice payments.
                if (paymentType !== 'payLater') {
                    if (isSplitPayment && paymentType === 'cash') {
                        splitReceivablesCash.set(payment, await this._updateAmounts(splitReceivablesCash.get(payment), {'amount': amount}, date));
                    }
                    else if (! isSplitPayment && paymentType === 'cash') {
                        combineReceivablesCash.set(paymentMethod, await this._updateAmounts(combineReceivablesCash.get(paymentMethod), {'amount': amount}, date));
                    }
                    else if (isSplitPayment && paymentType === 'bank') {
                        splitReceivablesBank.set(payment, await this._updateAmounts(splitReceivablesBank.get(payment), {'amount': amount}, date));
                    }
                    else if (! isSplitPayment && paymentType === 'bank') {
                        combineReceivablesBank.set(paymentMethod, await this._updateAmounts(combineReceivablesBank.get(paymentMethod), {'amount': amount}, date));
                    }

                    // Create the vals to create the pos receivables that will balance the pos receivables from invoice payment moves.
                    if (orderIsInvoiced) {
                        const lineIds = await (await payment.accountMoveId).lineIds;
                        if (isSplitPayment) {
                            splitInvPaymentReceivableLines.set(payment, splitInvPaymentReceivableLines.get(payment).or(await lineIds.filtered(async (line) => (await line.accountId).eq(posReceivableAccount))));
                            splitInvoiceReceivables.set(payment, await this._updateAmounts(splitInvoiceReceivables.get(payment), {'amount': await payment.amount}, await order.dateOrder));
                        }
                        else {
                            combineInvPaymentReceivableLines.set(paymentMethod, combineInvPaymentReceivableLines.get(paymentMethod).or(await lineIds.filtered(async (line)=> (await line.accountId).eq(posReceivableAccount))));
                            combineInvoiceReceivables.set(paymentMethod, await this._updateAmounts(combineInvoiceReceivables.get(paymentMethod), {'amount': await payment.amount}, await order.dateOrder));
                        }
                    }
                }

                // If pay_later, we create the receivable lines.
                //   if split, with partner
                //   Otherwise, it's aggregated (combined)
                // But only do if order is *not* invoiced because no account move is created for pay later invoice payments.
                if (paymentType === 'payLater' && ! orderIsInvoiced) {
                    if (isSplitPayment) {
                        splitReceivablesPayLater.set(payment, await this._updateAmounts(splitReceivablesPayLater.get(payment), {'amount': amount}, date));
                    }
                    else if (! isSplitPayment) {
                        combineReceivablesPayLater.set(paymentMethod, await this._updateAmounts(combineReceivablesPayLater.get(paymentMethod), {'amount': amount}, date));
                    }
                }
            }
            if (!orderIsInvoiced) {
                const orderTaxes = new MapDefaultKey(taxAmounts);
                for (const orderLine of await order.lines) {
                    const line = await this._prepareLine(orderLine);
                    // Combine sales/refund lines
                    const saleKey = [
                        // account
                        line['incomeAccountId'],
                        // sign
                        line['amount'] < 0 ? -1 : 1,
                        // for taxes
                        line['taxes'].map(tax => [tax['id'], tax['accountId'], tax['taxRepartitionLineId']]),
                        line['baseTags'],
                    ];
                    sales.set(saleKey, await this._updateAmounts(sales.get(saleKey), {'amount': line['amount']}, line['dateOrder']));
                    setdefault(sales.set(saleKey), 'taxAmount', 0.0);
                    // Combine tax lines
                    for (const tax of line['taxes']) {
                        const taxKey = [
                            tax['accountId'] || line['incomeAccountId'], 
                            tax['taxRepartitionLineId'], 
                            tax['id'], 
                            tax['tagIds']
                        ];
                        sales.get(saleKey)['taxAmount'] += tax['amount'];
                        orderTaxes.set(taxKey, await this._updateAmounts(
                            orderTaxes.get(taxKey),
                            {'amount': tax['amount'], 'baseAmount': tax['base']},
                            tax['dateOrder'],
                            {round: ! roundedGlobally}
                        ));
                    }
                }

                for (let [taxKey, amounts] of orderTaxes) {
                    if (roundedGlobally) {
                        amounts = await this._roundAmounts(amounts);
                    }
                    for (const [amountKey, amount] of amounts) {
                        taxes.get(taxKey)[amountKey] += amount;
                    }
                }

                if (await company.angloSaxonAccounting && bool((await order.pickingIds).ids)) {
                    // Combine stock lines
                    const stockMoves = await (await this.env.items('stock.move').sudo()).search([
                        ['pickingId', 'in', (await order.pickingIds).ids],
                        ['companyId.angloSaxonAccounting', '=', true],
                        ['productId.categId.propertyValuation', '=', 'auto']
                    ]);
                    for (const move of stockMoves) {
                        const [product, picking] = await move('productId', 'pickingId');
                        const expKey = (await product._getProductAccounts())['expense'];
                        const outKey = await (await product.categId).propertyStockAccountOutputCategId;
                        let signedProductQty = await move.productQty;
                        if (await move._isIn()) {
                            signedProductQty *= -1;
                        }
                        const pickingDate = await picking.date;
                        const amount = signedProductQty * await product._computeAveragePrice(0, await move.quantityDone, move);
                        stockExpense.set(expKey, await this._updateAmounts(stockExpense.get(expKey), {'amount': amount}, pickingDate, {forceCompanyCurrency: true}));
                        if (await move._isIn()) {
                            stockReturn.set(outKey, await this._updateAmounts(stockReturn.get(outKey), {'amount': amount}, pickingDate, {forceCompanyCurrency: true}));
                        }
                        else {
                            stockOutput.set(outKey, await this._updateAmounts(stockOutput.get(outKey), {'amount': amount}, pickingDate, {forceCompanyCurrency: true}));
                        }
                    }
                }

                if (await (await this['configId'].cashRounding)) {
                    const diff = await order.amountPaid - await order.amountTotal;
                    roundingDifference = await this._updateAmounts(roundingDifference, {'amount': diff}, await order.dateOrder);
                }
                // Increasing current partner's customer_rank
                const partners = (await order.partnerId).or(await (await order.partnerId).commercialPartnerId);
                await partners._increaseRank('customerRank');
            }
        }

        if (await company.angloSaxonAccounting) {
            const globalSessionPickings = await (await this['pickingIds']).filtered(async (p) => ! await p.posOrderId);
            if (globalSessionPickings.ok) {
                const stockMoves = await (await this.env.items('stock.move').sudo()).search([
                    ['picking_id', 'in', globalSessionPickings.ids],
                    ['companyId.angloSaxonAccounting', '=', true],
                    ['productId.categId.propertyValuation', '=', 'auto'],
                ]);
                for (const move of stockMoves) {
                    const [product, picking] = await move('productId', 'pickingId');
                    const pickingDate = await picking.date;
                    const expKey = (await product._getProductAccounts())['expense'];
                    const outKey = await (await product.categId).propertyStockAccountOutputCategId;
                    let signedProductQty = await move.productQty;
                    if (await move._isIn()) {
                        signedProductQty *= -1;
                    }
                    const amount = signedProductQty * await product._computeAveragePrice(0, await move.quantityDone, move);
                    stockExpense.set(expKey, await this._updateAmounts(stockExpense.get(expKey), {'amount': amount}, pickingDate, {forceCompanyCurrency: true}));
                    if (await move._isIn()) {
                        stockReturn.set(outKey, await this._updateAmounts(stockReturn.get(outKey), {'amount': amount}, pickingDate, {forceCompanyCurrency: true}));
                    }
                    else {
                        stockOutput.set(outKey, await this._updateAmounts(stockOutput.get(outKey), {'amount': amount}, pickingDate, {forceCompanyCurrency: true}));
                    }
                }
            }
        }

        const moveLine = await this.env.items('account.move.line').withContext({checkMoveValidity: false});

        update(data, {
            taxes,
            sales,
            stockExpense,
            splitReceivablesBank,
            combineReceivablesBank,
            splitReceivablesCash,
            combineReceivablesCash,
            combineInvoiceReceivables,
            splitReceivablesPayLater,
            combineReceivablesPayLater,
            stockReturn,
            stockOutput,
            combineInvPaymentReceivableLines,
            roundingDifference,
            moveLine,
            splitInvoiceReceivables,
            splitInvPaymentReceivableLines,
        })
        return data;
    }

    async _createNonReconciliableMoveLines(data) {
        // Create account.move.line records for
        //   - sales
        //   - taxes
        //   - stock expense
        //   - non-cash split receivables (not for automatic reconciliation)
        //   - non-cash combine receivables (not for automatic reconciliation)
        const taxes = data['taxes'],
        sales = data['sales'],
        stockExpense = data['stockExpense'],
        roundingDifference = data['roundingDifference'],
        moveLine = data['moveLine'],
        taxVals = [];

        for (const [key, amounts] of taxes) {
            taxVals.push(await this._getTaxVals(key, amounts['amount'], amounts['amountConverted'], amounts['baseAmountConverted']));
        }
        // Check if all taxes lines have accountId assigned. If not, there are repartition lines of the tax that have no accountId.
        const taxNamesNoAccount = taxVals.filter(line => line['accountId'] == false).map(line => line['label']);
        if (len(taxNamesNoAccount) > 0) {
            const errorMessage = await this._t(
                'Unable to close and validate the session.\n'+
                'Please set corresponding tax account in each repartition line of the following taxes: \n%s', 
                taxNamesNoAccount.join(', ')
            )
            throw new UserError(errorMessage);
        }
        let roundingVals = [];
        const rounding = await (await this['currencyId']).rounding;
        if (! floatIsZero(roundingDifference['amount'], {precisionRounding: rounding}) || ! floatIsZero(roundingDifference['amountConverted'], {precisionRounding: rounding})) {
            roundingVals = [await this._getRoundingDifferenceVals(roundingDifference['amount'], roundingDifference['amountConverted'])];
        }

        for (const [key, amounts] of sales) {
            taxVals.push(await this._getSaleVals(key, amounts['amount'], amounts['amountConverted'], amounts['taxAmount'])); 
        }
        for (const [key, amounts] of stockExpense) {
            taxVals.push(await this._getStockExpenseVals(key, amounts['amount'], amounts['amountConverted'])); 
        }
        await moveLine.create(taxVals.concat(roundingVals));
        return data;
    }

    async _createBankPaymentMoves(data) {
        const combineReceivablesBank = data['combineReceivablesBank'],
        splitReceivablesBank = data['splitReceivablesBank'],
        bankPaymentMethodDiffs = data['bankPaymentMethodDiffs'],
        moveLine = data['moveLine'],
        paymentMethodToReceivableLines = new MapKey(),
        paymentToReceivableLines = new MapKey();
        for (const [paymentMethod, amounts] of combineReceivablesBank) {
            const combineReceivableLine = await moveLine.create(await this._getCombineReceivableVals(paymentMethod, amounts['amount'], amounts['amount_converted']));
            const paymentReceivableLine = await this._createCombineAccountPayment(paymentMethod, amounts, bankPaymentMethodDiffs[paymentMethod.id] || 0);
            paymentMethodToReceivableLines.set(paymentMethod, combineReceivableLine.or(paymentReceivableLine));
        }
        for (const [payment, amounts] of splitReceivablesBank) {
            const splitReceivableLine = await moveLine.create(await this._getSplitReceivableVals(payment, amounts['amount'], amounts['amountConverted']));
            const paymentReceivableLine = await this._createSplitAccountPayment(payment, amounts);
            paymentToReceivableLines.set(payment, splitReceivableLine.or(paymentReceivableLine));
        }
        for (const bankPaymentMethod of await (await this['paymentMethodIds']).filtered(async (pm) => await pm.type === 'bank' && await pm.splitTransactions)) {
            await this._createDiffAccountMoveForSplitPaymentMethod(bankPaymentMethod, bankPaymentMethodDiffs[bankPaymentMethod.id] || 0);
        }

        data['paymentMethodToReceivableLines'] = paymentMethodToReceivableLines;
        data['paymentToReceivableLines'] = paymentToReceivableLines;
        return data;
    }

    async _createPayLaterReceivableLines(data) {
        const moveLine = data['moveLine'],
        combineReceivablesPayLater = data['combineReceivablesPayLater'],
        splitReceivablesPayLater = data['splitReceivablesPayLater'],
        vals = [];
        for (const [paymentMethod, amounts] of combineReceivablesPayLater) {
            vals.push(await this._getCombineReceivableVals(paymentMethod, amounts['amount'], amounts['amountConverted']));
        }
        for (const [payment, amounts] of splitReceivablesPayLater) {
            vals.push(await this._getSplitReceivableVals(payment, amounts['amount'], amounts['amountConverted']));
        }
        await moveLine.create(vals);
        return data;
    }

    async _createCombineAccountPayment(paymentMethod, amounts, diffAmount) {
        let outstandingAccount = await paymentMethod.outstandingAccountId;
        outstandingAccount = bool(outstandingAccount) ? outstandingAccount : await (await this['companyId']).accountJournalPaymentDebitAccountId;
        let destinationAccount = await this._getReceivableAccount(paymentMethod);
        const currency = await this['currencyId'];
        if (floatCompare(amounts['amount'], 0, {precisionRounding: await currency.rounding}) < 0) {
            // revert the accounts because account.payment doesn't accept negative amount.
            [outstandingAccount, destinationAccount] = [destinationAccount, outstandingAccount];
        }
        const accountPayment = await this.env.items('account.payment').create({
            'amount': Math.abs(amounts['amount']),
            'journalId': (await paymentMethod.journalId).id,
            'forceOutstandingAccountId': outstandingAccount.id,
            'destinationAccountId':  destinationAccount.id,
            'ref': await this._t('Combine %s POS payments from %s', await paymentMethod.label, await this['labelame']),
            'posPaymentMethodId': paymentMethod.id,
            'posSessionId': this.id,
        });

        const diffAmountCompareToZero = await currency.compareAmounts(diffAmount, 0);
        if (diffAmountCompareToZero != 0) {
            await this._applyDiffOnAccountPaymentMove(accountPayment, paymentMethod, diffAmount);
        }
        await accountPayment.actionPost();
        return await (await (await accountPayment.moveId).lineIds).filtered(async (line) => (await line.accountId).eq(await accountPayment.destinationAccountId));
    }

    async _applyDiffOnAccountPaymentMove(accountPayment, paymentMethod, diffAmount) {
        const [sourceVals, destVals] = await this._getDiffVals(paymentMethod.id, diffAmount);
        const outstandingLine = await (await (await accountPayment.moveId).lineIds).filtered(async (line) => (await line.accountId).id == sourceVals['accountId']);
        const newBalance = await outstandingLine.balance + diffAmount;
        const newBalanceCompareToZero = await (await this['currencyId']).compareAmounts(newBalance, 0);
        await (await accountPayment.moveId).write({
            'lineIds': [
                Command.create(destVals),
                Command.update(outstandingLine.id, {
                    'debit': newBalanceCompareToZero > 0 && newBalance || 0.0,
                    'credit': newBalanceCompareToZero < 0 && -newBalance || 0.0
                })
            ]
        });
    }

    async _createSplitAccountPayment(payment, amounts) {
        const paymentMethod = await payment.paymentMethodId;
        if (! (await paymentMethod.journalId).ok) {
            return this.env.items('account.move.line');
        }
        let outstandingAccount = await paymentMethod.outstandingAccountId;
        outstandingAccount = outstandingAccount.ok ? outstandingAccount : await (await this['companyId']).accountJournalPaymentDebitAccountId;
        const accountingPartner = await this.env.items("res.partner").FindAccountingPartner(await payment.partnerId);
        let destinationAccount = await accountingPartner.propertyAccountReceivableId;

        if (floatCompare(amounts['amount'], 0, {precisionRounding: await (await this['currencyId']).rounding}) < 0) {
            // revert the accounts because account.payment doesn't accept negative amount.
            [outstandingAccount, destinationAccount] = [destinationAccount, outstandingAccount];
        }
        const accountPayment = await this.env.items('account.payment').create({
            'amount': Math.abs(amounts['amount']),
            'partnerId': (await payment.partnerId).id,
            'journalId': (await paymentMethod.journalId).id,
            'forceOutstandingAccountId': outstandingAccount.id,
            'destinationAccountId': destinationAccount.id,
            'ref': await this._t('%s POS payment of %s in %s', await paymentMethod.label, await (await payment.partnerId).displayName, await this['label']),
            'posPaymentMethodId': paymentMethod.id,
            'posSessionId': this.id,
        });
        await accountPayment.actionPost();
        return await (await (await accountPayment.moveId).lineIds).filtered(async (line) => (await line.accountId).eq(await accountPayment.destinationAccountId));
    }

    async _createCashStatementLinesAndCashMoveLines(data) {
        // Create the split and combine cash statement lines and account move lines.
        // Keep the reference by statement for reconciliation.
        // `splitCashStatementLines` maps `statement` -> split cash statement lines
        // `combineCashStatementLines` maps `statement` -> combine cash statement lines
        // `splitCashReceivableLines` maps `statement` -> split cash receivable lines
        // `combineCashReceivableLines` maps `statement` -> combine cash receivable lines
        const moveLine = data['moveLine'];
        const splitReceivablesCash = data['splitReceivablesCash'];
        const combineReceivablesCash = data['combineReceivablesCash'];

        const statementsByJournalId = Object.fromEntries(await (await this['statementIds']).map(async (statement) => [(await statement.journalId).id, statement]));
        // handle split cash payments
        const splitCashStatementLineVals = new MapDefaultKey(() => []);
        const splitCashReceivableVals = new MapDefaultKey(() => []);
        for (const [payment, amounts] of splitReceivablesCash) {
            const statement = statementsByJournalId.get((await (payment.paymentMethodId).journalId).id);
            splitCashStatementLineVals.get(statement).push(await this._getSplitStatementLineVals(statement, amounts['amount'], payment));
            splitCashReceivableVals.get(statement).push(await this._getSplitReceivableVals(payment, amounts['amount'], amounts['amountConverted']));
        }
        // handle combine cash payments
        const combineCashStatementLineVals = new MapDefaultKey(() => []);
        const combineCashReceivableVals = new MapDefaultKey(() => []);
        for (const [paymentMethod, amounts] of combineReceivablesCash) {
            if (! floatIsZero(amounts['amount'] , {precisionRounding: await (await this['currencyId']).rounding})) {
                const statement = statementsByJournalId.get((await paymentMethod.journalId).id);
                combineCashStatementLineVals.get(statement).push(await this._getCombineStatementLineVals(statement, amounts['amount'], paymentMethod));
                combineCashReceivableVals.get(statement).push(await this._getCombineReceivableVals(paymentMethod, amounts['amount'], amounts['amountConverted']));
            }
        }
        // create the statement lines and account move lines
        const bankStatementLine = this.env.items('account.bank.statement.line'),
        splitCashStatementLines = new MapKey(),
        combineCashStatementLines = new MapKey(),
        splitCashReceivableLines = new MapKey(),
        combineCashReceivableLines = new MapKey();
        
        for (const statement of await this['statementIds']) {
            splitCashStatementLines.set(statement, await (await (await bankStatementLine.create(splitCashStatementLineVals.get(statement))).mapped('moveId.lineIds')).filtered(async (line) => await (await line.accountId).internalType === 'receivable'));
            combineCashStatementLines.set(statement, await (await (await bankStatementLine.create(combineCashStatementLineVals.get(statement))).mapped('moveId.lineIds')).filtered(async (line) => await (await line.accountId).internalType === 'receivable'));
            splitCashReceivableLines.set(statement, await moveLine.create(splitCashReceivableVals.get(statement)));
            combineCashReceivableLines.set(statement, await moveLine.create(combineCashReceivableVals.get(statement)));
        }
        update(data, {
            splitCashStatementLines,
            combineCashStatementLines,
            splitCashReceivableLines,
            combineCashReceivableLines
        });
        return data;
    }

    async _createInvoiceReceivableLines(data) {
        // Create invoice receivable lines for this session's moveId.
        // Keep reference of the invoice receivable lines because
        // they are reconciled with the lines in combine_inv_payment_receivable_lines
        const moveLine = data['moveLine'],
        combineInvoiceReceivables = data['combineInvoiceReceivables'],
        splitInvoiceReceivables = data['splitInvoiceReceivables'],

        combineInvoiceReceivableVals = new MapDefaultKey(() => []),
        splitInvoiceReceivableVals = new MapDefaultKey(() => []),
        combineInvoiceReceivableLines = new MapKey(),
        splitInvoiceReceivableLines = new MapKey();
        
        for (const [paymentMethod, amounts] of combineInvoiceReceivables) {
            combineInvoiceReceivableVals.get(paymentMethod).push(await this._getInvoiceReceivableVals(amounts['amount'], amounts['amountConverted']));
        }
        for (const [payment, amounts] of splitInvoiceReceivables) {
            splitInvoiceReceivableVals.get(payment).push(await this._getInvoiceReceivableVals(amounts['amount'], amounts['amountConverted']));
        }
        for (const [paymentMethod, vals] of combineInvoiceReceivableVals) {
            const receivableLines = await moveLine.create(vals);
            combineInvoiceReceivableLines.set(paymentMethod, receivableLines);
        }
        for (const [payment, vals] of splitInvoiceReceivableVals) {
            const receivableLines = await moveLine.create(vals);
            splitInvoiceReceivableLines.set(payment, receivableLines);
        }

        update(data, {
            combineInvoiceReceivableLines,
            splitInvoiceReceivableLines
        });
        return data;
    }

    async _createStockOutputLines(data) {
        // Keep reference to the stock output lines because
        // they are reconciled with output lines in the stock.move's account.move.line
        const moveLine = data['moveLine'],
        stockOutput = data['stockOutput'],
        stockReturn = data['stockReturn'],

        stockOutputVals = new MapDefaultKey(() => []),
        stockOutputLines = new MapKey();

        for (const stockMoves of [stockOutput, stockReturn]) {
            for (const [account, amounts] of stockMoves) {
                stockOutputVals.get(account).push(await this._getStockOutputVals(account, amounts['amount'], amounts['amountConverted']));
            }
        }

        for (const [outputAccount, vals] of stockOutputVals) {
            stockOutputLines.set(outputAccount, await moveLine.create(vals));
        }

        update(data, {stockOutputLines});
        return data;
    }

    async _reconcileAccountMoveLines(data) {
        // reconcile cash receivable lines
        const splitCashStatementLines = data['splitCashStatementLines'],
        combineCashStatementLines = data['combineCashStatementLines'],
        splitCashReceivableLines = data['splitCashReceivableLines'],
        combineCashReceivableLines = data['combineCashReceivableLines'],
        combineInvPaymentReceivableLines = data['combineInvPaymentReceivableLines'],
        splitInvPaymentReceivableLines = data['splitInvPaymentReceivableLines'],
        combineInvoiceReceivableLines = data['combineInvoiceReceivableLines'],
        splitInvoiceReceivableLines = data['splitInvoiceReceivableLines'],
        stockOutputLines = data['stockOutputLines'],
        paymentMethodToReceivableLines = data['paymentMethodToReceivableLines'],
        paymentToReceivableLines = data['paymentToReceivableLines'];

        for (const statement of await this['statementIds']) {
            if (! await (await this['configId']).cashControl) {
                await statement.write({'balanceEndReal': await statement.balanceEnd});
            }
            await statement.buttonPost();
            const allLines = splitCashStatementLines.get(statement)
                .or(combineCashStatementLines.get(statement))
                .or(splitCashReceivableLines.get(statement))
                .or(combineCashReceivableLines.get(statement));

            const accounts = await allLines.mapped('accountId');
            const linesByAccount = [];
            for (const account of accounts) {
                if (await account.reconcile) {
                    linesByAccount.push(await allLines.filtered(async (l) => (await l.accountId).eq(account) && ! await l.reconciled));
                }
            }
            for (const lines of linesByAccount) {
                await lines.reconcile();
            }
            // We try to validate the statement after the reconciliation is done
            // because validating the statement requires each statement line to be
            // reconciled.
            // Furthermore, if the validation failed, which is caused by unreconciled
            // cash difference statement line, we just ignore that. Leaving the statement
            // not yet validated. Manual reconciliation and validation should be made
            // by the user in the accounting app.
            try {
                await statement.buttonValidate();
            } catch(e) {
                if (!isInstance(e, UserError)) {
                    throw e;
                }
            }
        }

        for (const [paymentMethod, lines] of paymentMethodToReceivableLines) {
            const receivableAccount = await this._getReceivableAccount(paymentMethod);
            if (await receivableAccount.reconcile) {
                await (await lines.filtered(async (line) => ! await line.reconciled)).reconcile();
            }
        }

        for (const [payment, lines] of paymentToReceivableLines) {
            if (await (await (await payment.partnerId).propertyAccountReceivableId).reconcile) {
                await (await lines.filtered(async (line) => ! await line.reconciled)).reconcile();
            }
        }

        // Reconcile invoice payments' receivable lines. But we only do when the account is reconcilable.
        // Though `account_default_pos_receivable_account_id` should be of type receivable, there is currently
        // no constraint for it. Therefore, it is possible to put set a non-reconcilable account to it.
        if (await (await (await this['companyId']).accountDefaultPosReceivableAccountId).reconcile) {
            for (const paymentMethod of combineInvPaymentReceivableLines) {
                const lines = combineInvPaymentReceivableLines.get(paymentMethod).or(combineInvoiceReceivableLines.get(paymentMethod, this.env.items('account.move.line')));
                await (await lines.filtered(async (line) => ! await line.reconciled)).reconcile();
            }

            for (const payment of splitInvPaymentReceivableLines) {
                const lines = splitInvPaymentReceivableLines.get(payment).or(splitInvoiceReceivableLines.get(payment, this.env.items('account.move.line')));
                await (await lines.filtered(async (line) => ! await line.reconciled)).reconcile();
            }
        }

        // reconcile stock output lines
        let pickings = await (await this['pickingIds']).filtered(async (p) => ! bool(await p.posOrderId));
        pickings = pickings.or(await (await (await this['orderIds']).filtered(async (o) => ! await o.isInvoiced)).mapped('pickingIds'));
        const stockMoves = await this.env.items('stock.move').search([['pickingId', 'in', pickings.ids]]);
        const stockAccountMoveLines = await (await this.env.items('account.move').search([['stockMoveId', 'in', stockMoves.ids]])).mapped('lineIds');
        for (const accountId of stockOutputLines) {
            await (await stockOutputLines.get(accountId)
            .or(await stockAccountMoveLines.filtered(async (aml) => (await aml.accountId).eq(accountId)))
            .filtered(async (aml) => ! await aml.reconciled))
            .reconcile();
        }
        return data;
    }

    /**
     * Derive from orderLine the order date, income account, amount and taxes information.

        These information will be used in accumulating the amounts for sales and tax lines.
     * @param orderLine 
     * @returns 
     */
    async _prepareLine(orderLine) {
        const self: any = this;
        async function getIncomeAccount(orderLine) {
            const product = await orderLine.productId;
            let incomeAccount = (await (await product.withCompany(await orderLine.companyId))._getProductAccounts())['income']
            incomeAccount = bool(incomeAccount) ? incomeAccount : await (await (await self.configId).journalId).defaultAccountId;
            if (! bool(incomeAccount)) {
                throw new UserError(await self._t('Please define income account for this product: "%s" (id:%d).',await product.label, product.id));
            }
            return await( await (await orderLine.orderId).fiscalPositionId).mapAccount(incomeAccount);
        }

        const taxIds = await (await orderLine.taxIdsAfterFiscalPosition)
                    .filtered(async (t) => (await t.companyId).id == (await (await orderLine.orderId).companyId).id);
        const [qty, priceUnit, discount] = await orderLine('qty', 'priceUnit', 'discount');
        const sign = qty >= 0 ? -1 : 1;
        const price = sign * priceUnit * (1 - (discount || 0.0) / 100.0);
        // The 'isRefund' parameter is used to compute the tax tags. Ultimately, the tags are part
        // of the key used for summing taxes. Since the POS UI doesn't support the tags, inconsistencies
        // may arise in 'Round Globally'.
        const checkRefund = async (x) => (await x.qty * await x.priceUnit) < 0;
        const isRefund = await checkRefund(orderLine);
        const taxData = await (await taxIds.withContext({forceSign: sign})).computeAll(price, {quantity: Math.abs(qty), currency: await this['currencyId'], isRefund});
        let taxes = taxData['taxes'];
        // For Cash based taxes, use the account from the repartition line immediately as it has been paid already
        for (const tax of taxes) {
            const taxRep = this.env.items('account.tax.repartition.line').browse(tax['taxRepartitionLineId']);
            tax['accountId'] = (await taxRep.accountId).id;
        }
        const dateOrder = await (await orderLine.orderId).dateOrder;
        taxes = taxes.map(tax => { return {'dateOrder': dateOrder, ...tax} });
        return {
            'dateOrder': dateOrder,
            'incomeAccountId': (await getIncomeAccount(orderLine)).id,
            'amount': await orderLine.priceSubtotal,
            'taxes': taxes,
            'baseTags': Array.from(taxData['baseTags']),
        }
    }

    async _getRoundingDifferenceVals(amount, amountConverted) {
        const config = await this['configId'];
        if (await config.cashRounding) {
            const [move, currency] = await this('moveId', 'currencyId');
            const partialArgs = {
                'label': 'Rounding line',
                'moveId': move.id,
            }
            const compare = floatCompare(0.0, amount, {precisionRounding: await currency.rounding});
            if (compare > 0) {    // loss
                partialArgs['accountId'] = (await (await config.roundingMethod).lossAccountId).id;
                return this._debitAmounts(partialArgs, -amount, -amountConverted);
            }
            if (compare < 0) {    // profit
                partialArgs['accountId'] = (await (await config.roundingMethod).profitAccountId).id;
                return this._creditAmounts(partialArgs, amount, amountConverted);
            }
        }
    }

    async _getSplitReceivableVals(payment, amount, amountConverted) {
        const accountingPartner = await this.env.items("res.partner")._findAccountingPartner(await payment.partnerId);
        if (! bool(accountingPartner)) {
            throw new UserError(await this._t('You have enabled the "Identify Customer" option for %s payment method,'+
                              'but the order %s does not contain a customer.', await (await payment.paymentMethodId).label,
                               await (await payment.posOrderId).label));
        }
        const partialVals = {
            'accountId': (await accountingPartner.propertyAccountReceivableId).id,
            'moveId': (await this['moveId']).id,
            'partnerId': accountingPartner.id,
            'label': f('%s - %s', await this['label'], await (await payment.paymentMethodId).label),
        }
        return this._debitAmounts(partialVals, amount, amountConverted);
    }

    async _getCombineReceivableVals(paymentMethod, amount, amountConverted) {
        const partialVals = {
            'accountId': (await this._getReceivableAccount(paymentMethod)).id,
            'moveId': (await this['moveId']).id,
            'label': f('%s - %s', await this['label'], await paymentMethod.label)
        }
        return this._debitAmounts(partialVals, amount, amountConverted);
    }

    async _getInvoiceReceivableVals(amount, amountConverted) {
        const partialVals = {
            'accountId': (await (await this['companyId']).accountDefaultPosReceivableAccountId).id,
            'moveId': (await this['moveId']).id,
            'label': await this._t('From invoice payments'),
        }
        return this._creditAmounts(partialVals, amount, amountConverted);
    }

    async _getSaleVals(key, amount, amountConverted, taxAmount) {
        const [accountId, sign, taxKeys, baseTagIds] = key;
        const taxIds = new Set(taxKeys.map(tax => tax[0]));
        const appliedTaxes = this.env.items('account.tax').browse(taxIds);
        const title = sign == 1 ? 'Sales' : 'Refund';
        let label = f('%s untaxed', title);
        if (bool(appliedTaxes)) {
            label = f('%s with %s', title, (await appliedTaxes.map(tax => tax.label).join(', ')));
        }
        const partialVals = {
            'label': label,
            'accountId': accountId,
            'moveId': (await this['moveId']).id,
            'taxIds': [[6, 0, taxIds]],
            'taxTagIds': [[6, 0, baseTagIds]],
            'priceSubtotal': Math.abs(amountConverted),
            'priceTotal': Math.abs(amountConverted) + Math.abs(taxAmount),
        }
        return this._creditAmounts(partialVals, amount, amountConverted);
    }

    async _getTaxVals(key, amount, amountConverted, baseAmountConverted) {
        const [accountId, repartitionLineId, taxId, tagIds] = key;
        const tax = await this.env.items('account.tax').browse(taxId);
        const partialArgs = {
            'label': await tax.name,
            'accountId': accountId,
            'moveId': (await this['moveId']).id,
            'taxBaseAmount': Math.abs(baseAmountConverted),
            'taxRepartitionLineId': repartitionLineId,
            'taxTagIds': [[6, 0, tagIds]],
        }
        return this._debitAmounts(partialArgs, amount, amountConverted);
    }

    async _getStockExpenseVals(expAccount, amount, amountConverted) {
        const partialArgs = {'accountId': expAccount.id, 'moveId': (await this['moveId']).id}
        return this._debitAmounts(partialArgs, amount, amountConverted, true);
    }

    async _getStockOutputVals(outAccount, amount, amountConverted) {
        const partialArgs = {'accountId': outAccount.id, 'moveId': (await this['moveId']).id}
        return this._creditAmounts(partialArgs, amount, amountConverted, true);
    }

    async _getCombineStatementLineVals(statement, amount, paymentMethod) {
        return {
            'date': await _Date.contextToday(this),
            'amount': amount,
            'paymentRef': await this['label'],
            'statementId': statement.id,
            'journalId': (await statement.journalId).id,
            'counterpartAccountId': (await this._getReceivableAccount(paymentMethod)).id,
        }
    }

    async _getSplitStatementLineVals(statement, amount, payment) {
        const accountingPartner = await this.env.items("res.partner")._findAccountingPartner(await payment.partnerId);
        return {
            'date': await _Date.contextToday(this, await payment.paymentDate),
            'amount': amount,
            'paymentRef': await this['label'],
            'statementId': statement.id,
            'journalId': (await statement.journalId).id,
            'counterpartAccountId': (await accountingPartner.propertyAccountReceivableId).id,
            'partnerId': accountingPartner.id,
        }
    }

    async _updateAmounts(oldAmounts, amountsToAdd, date, opts: {round?: any, forceCompanyCurrency?: any}={}) {
        const round = opts.round ?? true;
        const forceCompanyCurrency = opts.forceCompanyCurrency ?? false;
        // make a copy of the old amounts
        const newAmounts = { ...oldAmounts }

        const isInCompanyCurrency = await this['isInCompanyCurrency'];
        const amount = amountsToAdd['amount'];
        let amountConverted;
        if (isInCompanyCurrency || forceCompanyCurrency) {
            amountConverted = amount;
        }
        else {
            amountConverted = await this._amountConverter(amount, date, round);
        }

        // update amount and amount converted
        newAmounts['amount'] += amount;
        newAmounts['amountConverted'] += amountConverted;

        // consider baseAmount if present
        if (! amountsToAdd['baseAmount'] == null) {
            const baseAmount = amountsToAdd['baseAmount'];
            let baseAmountConverted;
            if (isInCompanyCurrency || forceCompanyCurrency) {
                baseAmountConverted = baseAmount;
            }
            else {
                baseAmountConverted = await this._amountConverter(baseAmount, date, round);
            }

            // update baseAmount and base_amount_converted
            newAmounts['baseAmount'] += baseAmount;
            newAmounts['baseAmountConverted'] += baseAmountConverted;
        }
        return newAmounts;
    }

    async _roundAmounts(amounts) {
        const newAmounts = {}
        for (const [key, amount] of amounts) {
            if (key === 'amountConverted') {
                // round the amount_converted using the company currency.
                newAmounts[key] = await (await (await this['companyId']).currencyId).round(amount);
            }
            else {
                newAmounts[key] = await (await this['currencyId']).round(amount);
            }
        }
        return newAmounts;
    }

    /**
     *  `partialMoveLineVals` is completed by `credit`ing the given amounts.

        NOTE Amounts in PoS are in the currency of journalId in the session.configId.
        This means that amount fields in any pos record are actually equivalent to amount_currency
        in account module. Understanding this basic is important in correctly assigning values for
        'amount' and 'amount_currency' in the account.move.line record.

        :param partialMoveLineVals dict:
            initial values in creating account.move.line
        :param amount float:
            amount derived from pos.payment, pos.order, or pos.order.line records
        :param amountConverted float:
            converted value of `amount` from the given `sessionCurrency` to company currency

        :return dict: complete values for creating 'amount.move.line' record
     */
    async _creditAmounts(partialMoveLineVals, amount, amountConverted, forceCompanyCurrency=false) {
        let additionalField;
        if (await this['isInCompanyCurrency'] || forceCompanyCurrency) {
            additionalField = {}
        }
        else {
            additionalField = {
                'amountCurrency': -amount,
                'currencyId': (await this['currencyId']).id,
            }
        }
        return {
            'debit': amountConverted < 0.0 ? -amountConverted : 0.0,
            'credit': amountConverted > 0.0 ? amountConverted : 0.0,
            ...partialMoveLineVals,
            ...additionalField,
        }
    }

    /**
     * `partialMoveLineVals` is completed by `debit`ing the given amounts.

        See _creditAmounts docs for more details.
     * @param partialMoveLineVals 
     * @param amount 
     * @param amountConverted 
     * @param forceCompanyCurrency 
     */
    async _debitAmounts(partialMoveLineVals, amount, amountConverted, forceCompanyCurrency=false) {
        let additionalField;
        if (await this['isInCompanyCurrency'] || forceCompanyCurrency) {
            additionalField = {}
        }
        else {
            additionalField = {
                'amountCurrency': amount,
                'currencyId': (await this['currencyId']).id,
            }
        }
        return {
            'debit': amountConverted > 0.0 ? amountConverted : 0.0,
            'credit': amountConverted < 0.0 ? -amountConverted : 0.0,
            ...partialMoveLineVals,
            ...additionalField,
        }
    }

    async _amountConverter(amount, date, round) {
        // self should be single record as this method is only called in the subfunctions of self._validateSession
        const [company, currency] = await this('companyId', 'currencyId')
        return currency._convert(amount, await company.currencyId, company, date, {round});
    }

    async showCashRegister() {
        const cashRegister = await this['cashRegisterId'];
        return {
            'label': await this._t('Cash register for %s', await cashRegister.label),
            'type': 'ir.actions.actwindow',
            'resModel': 'account.bank.statement',
            'viewMode': 'form',
            'resId': cashRegister.id,
        }
    }

    async showJournalItems() {
        this.ensureOne();
        const allRelatedMoves = await this._getRelatedAccountMoves();
        return {
            'label': await this._t('Journal Items'),
            'type': 'ir.actions.actwindow',
            'resModel': 'account.move.line',
            'viewMode': 'tree',
            'viewId': (await this.env.ref('account.viewMoveLineTreeGrouped')).id,
            'domain': [['id', 'in', (await allRelatedMoves.mapped('lineIds')).ids]],
            'context': {
                'journalType':'general',
                'searchDefault_groupbyMove': 1,
                'groupby': 'moveId', 
                'searchDefault_posted': 1,
                'nameGroupby': 1,
            },
        }
    }

    async _getOtherRelatedMoves() {
        // TODO This is not an ideal way to get the diff account.move's for
        // the session. It would be better if there is a relation field where
        // these moves are saved.

        // Unfortunately, the 'ref' of account.move is not indexed, so
        // we are querying over the account.move.line because its 'ref' is indexed.
        // And yes, we are only concern for split bank payment methods.
        const diffLinesRef = await (await (await this['paymentMethodIds']).filtered(async (pm) => await pm.type === 'bank' && await pm.splitTransactions)).map(async (pm) => await this._getDiffAccountMoveRef(pm));
        diffLinesRef.push(f("Opening Balance difference for %s", await this['label']));
        const costMoveLines = await (await this['orderIds']).map(rec => 'posOrder_'+String(rec.id));
        return (await this.env.items('account.move.line').search([['ref', 'in', diffLinesRef.concat(costMoveLines)]])).mapped('moveId');
    }

    async _getRelatedAccountMoves() {
        const pickings = (await this['pickingIds']).or(await (await this['orderIds']).mapped('pickingIds')),
        invoices = await this.mapped('orderIds.accountMove'),
        invoicePayments = await this.mapped('orderIds.paymentIds.accountMoveId'),
        stockAccountMoves = await pickings.mapped('moveLines.accountMoveIds'),
        cashMoves = await (await (await this['cashRegisterId']).lineIds).mapped('moveId'),
        bankPaymentMoves = await (await this['bankPaymentIds']).mapped('moveId'),
        otherRelatedMoves = await this._getOtherRelatedMoves();
        return invoices.or(invoicePayments).or(await this['moveId']).or(stockAccountMoves).or(cashMoves).or(bankPaymentMoves).or(otherRelatedMoves);
    }

    /**
     * Returns the default pos receivable account if no receivable_account_id is set on the payment method.
     * @param paymentMethod 
     * @returns 
     */
    async _getReceivableAccount(paymentMethod) {
        const res = await paymentMethod.receivableAccountId;
        return res.ok ? res : await (await this['companyId']).accountDefaultPosReceivableAccountId;
    }

    async actionShowPaymentsList() {
        return {
            'label': await this._t('Payments'),
            'type': 'ir.actions.actwindow',
            'resModel': 'pos.payment',
            'viewMode': 'tree,form',
            'domain': [['sessionId', '=', this.id]],
            'context': {'searchDefault_groupbyPaymentMethod': 1}
        }
    }

    /**
     * Open the pos interface with configId as an extra argument.

        In vanilla PoS each user can only have one active session, therefore it was not needed to pass the configId
        on opening a session. It is also possible to login to sessions created by other users.

        :returns: dict
     * @returns 
     */
    async openFrontendCb() {
        if (! bool(this.ids)) {
            return {}
        }
        const config = await this['configId']
        return {
            'type': 'ir.actions.acturl',
            'target': 'self',
            'url': await config._getPosBaseUrl() + f('?configId=%d', config.id),
        }
    }

    async setCashboxPos(cashboxValue, notes) {
        if (! await (await this.env.user()).hasGroup('point_of_sale.groupPosUser')) {
            throw new AccessError(await this._t("You don't have the access rights to set the point of sale cash box."));
        }
        await this.set('state', 'opened');
        await this.set('openingNotes', notes);
        const cashRegister = await this['cashRegisterId'];
        const difference = cashboxValue - await cashRegister.balanceStart;
        await this._postCashDetailsMessage('Opening', difference, notes);
        //if there is a difference create an account move to register the loss
        if (difference) {
            await (await this.env.items('account.bank.statement.line').sudo()).create({
                'paymentRef': f('Opening Balance difference for %s', await this['label']),
                'journalId': (await cashRegister.journalId).id,
                'date': await this['startAt'],
                'amount': difference,
                'statementId': cashRegister.id,
            });
        }
    }

    async _postCashDetailsMessage(state, difference, notes) {
        const [currency] = await this('currencyId')
        let message = "";
        if (difference) {
            message = `${state} difference: ` +
                      `${await currency.position == 'before' ? await currency.symbol + ' ' : ''}` +
                      `${await currency.round(difference)} ` +
                      `${await currency.position == 'after' ? await currency.symbol : ''}<br/>`;
        }
        if (notes) {
            message += notes.replace('\n', '<br/>');
        }
        if (message) {
            await this.env.items('mail.message').create({
                'body': message,
                'model': 'account.bank.statement',
                'resId': (await this['cashRegisterId']).id,
            });
            await (this as any).messagePost({body: message});
        }
    }

    async actionViewOrder() {
        return {
            'label': await this._t('Orders'),
            'resModel': 'pos.order',
            'viewMode': 'tree,form',
            'views': [
                [(await this.env.ref('point_of_sale.viewPosOrderTreeNoSessionId')).id, 'tree'],
                [(await this.env.ref('point_of_sale.viewPosPosForm')).id, 'form'],
                ],
            'type': 'ir.actions.actwindow',
            'domain': [['sessionId', 'in', this.ids]],
        }
    }

    @api.model()
    async _alertOldSession() {
        // If the session is open for more then one week,
        // log a next activity to close the session.
        const sessions = await (await this.sudo()).search([['startAt', '<=', subDate(_Datetime.now(), {days: 7})], ['state', '!=', 'closed']]);
        for (const session of sessions) {
            if (await this.env.items('mail.activity').searchCount([['resId', '=', session.id], ['resModel', '=', 'pos.session']]) == 0) {
                await session.activitySchedule({
                    actTypeXmlid: 'point_of_sale.mailActivityOldSession',
                    userId: (await session.userId).id,
                    note: _f(await this._t(
                        "Your PoS Session is open since %(date)s, we advise you to close it and to create a new one."),
                        {date: await session.startAt},
                    )
                });
            }
        }
    }

    async _checkIfNoDraftOrders() {
        const draftOrders = await (await this['orderIds']).filtered(async (order) => await order.state === 'draft');
        if (bool(draftOrders)) {
            throw new UserError(await this._t(
                    'There are still orders in draft state in the session. '+
                    'Pay or cancel the following orders to validate the session:\n%s', 
                    (await draftOrders.mapped('label')).join(', ')
            ));
        }
        return true;
    }

    async tryCashInOut(type, amount, reason, extras) {
        const sign = type == 'in' ? 1 : -1;
        await (await (await (await this.env.items('cash.box.out'))
            .withContext({'activeModel': 'pos.session', 'activeIds': this.ids}))
            .create({'amount': sign * amount, 'name': reason}))
            .run();
        const messageContent = [`Cash ${extras['translatedType']}`, `- Amount: ${extras["formattedAmount"]}`];
        if (reason) {
            messageContent.push(`- Reason: ${reason}`);
        }
        await (this as any).messagePost({body: messageContent.join('<br/>\n')});
    }
}

@MetaModel.define()
class ProcurementGroup extends Model {
    static _module = module;
    static _parents = 'procurement.group';

    @api.model()
    async _runSchedulerTasks(useNewCursor=false, companyId?: any) {
        await _super(ProcurementGroup, this)._runSchedulerTasks(useNewCursor, companyId);
        await this.env.items('pos.session')._alertOldSession();
        if (useNewCursor) {
            await this.env.cr.commit();
        }
    }
}