import { Fields, _Date, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";
import { addDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class RecurringPayment extends Model {
    static _module = module;
    static _name = 'recurring.payment';
    static _description = 'Recurring Payment(';
    static _recName = 'label';

    static label = Fields.Char('Name', { readonly: true });
    static partnerId = Fields.Many2one('res.partner', { string: "Partner", required: true });
    static companyId = Fields.Many2one('res.company', { string: 'Company', default: async (self) => (await self.env.company()).id });
    static currencyId = Fields.Many2one('res.currency', { string: 'Currency', related: 'companyId.currencyId' });
    static amount = Fields.Monetary({ string: "Amount", currencyField: 'currencyId' });
    static journalId = Fields.Many2one('account.journal', {
        string: 'Journal',
        related: 'templateId.journalId', readonly: false, required: true
    });
    static paymentType = Fields.Selection([
        ['outbound', 'Send Money'],
        ['inbound', 'Receive Money'],
    ], { string: 'Payment Type', required: true, default: 'inbound' });
    static state = Fields.Selection({
        selection: [['draft', 'Draft'],
        ['done', 'Done']], default: 'draft', string: 'Status'
    });
    static dateBegin = Fields.Date({ string: 'Start Date', required: true });
    static dateEnd = Fields.Date({ string: 'End Date', required: true });
    static templateId = Fields.Many2one('account.recurring.template', {
        string: 'Recurring Template',
        domain: [['state', '=', 'done']], required: true
    });
    static recurringPeriod = Fields.Selection({ related: 'templateId.recurringPeriod' });
    static recurringInterval = Fields.Integer('Recurring Interval', {
        required: true,
        related: 'templateId.recurringInterval', readonly: true
    });
    static journalState = Fields.Selection({
        required: true, string: 'Generate Journal As',
        related: 'templateId.journalState'
    });
    static description = Fields.Text('Description');
    static lineIds = Fields.One2many('recurring.payment.line', 'recurringPaymentId', { string: 'Recurring Lines' });

    async computeNextDate(date: Date) {
        const [period, interval] = await this('recurringPeriod', 'recurringInterval');
        if (period === 'days') {
            date = addDate(date, { days: interval });
        }
        else if (period === 'weeks') {
            date = addDate(date, { weeks: interval });
        }
        else if (period === 'months') {
            date = addDate(date, { months: interval });
        }
        else {
            date = addDate(date, { years: interval });
        }
        return date;
    }

    async actionCreateLines(date) {
        const ids = this.env.items('recurring.payment.line');
        const vals = {
            'partnerId': (await this['partnerId']).id,
            'amount': await this['amount'],
            'date': date,
            'recurringPaymentId': this.id,
            'journalId': (await this['journalId']).id,
            'currencyId': (await this['currencyId']).id,
            'state': 'draft'
        }
        ids.create(vals);
    }

    async actionDone() {
        let [dateBegin, dateEnd] = await this('dateBegin', 'dateEnd');
        while (dateBegin < dateEnd) {
            const date = dateBegin;
            await this.actionCreateLines(date);
            dateBegin = await this.computeNextDate(date);
        }
        await this.set('state', 'done');
    }

    async actionDraft() {
        const lineIds = await this['lineIds'];
        if ((await lineIds.filtered(async (t) => await t.state === 'done')).ok) {
            throw new ValidationError(await this._t('You cannot Set to Draft as one of the line is already in done state'))
        }
        else {
            for (const line of lineIds) {
                await line.unlink();
            }
            await this.set('state', 'draft');
        }
    }

    async actionGeneratePayment() {
        const lineIds = await this.env.items('recurring.payment.line').search([['date', '<=', _Date.today()],
        ['state', '!=', 'done']]);
        for (const line of lineIds) {
            await line.actionCreatePayment();
        }
    }

    @api.model()
    async create(vals) {
        if ('companyId' in vals) {
            vals['label'] = await (await this.env.items('ir.sequence').withContext({ forceCompany: vals['companyId'] })).nextByCode('recurring.payment') || await this._t('New');
        }
        else {
            vals['label'] = await this.env.items('ir.sequence').nextByCode('recurring.payment') || await this._t('New');
        }
        return _super(RecurringPayment, this).create(vals);
    }

    @api.constrains('amount')
    async _checkAmount() {
        if (await this['amount'] <= 0) {
            throw new ValidationError(await this._t('Amount Must Be Non-Zero Positive Number'));
        }
    }

    async unlink() {
        for (const rec of this) {
            if (await rec.state === 'done') {
                throw new ValidationError(await this._t('Cannot delete done records !'));
            }
        }
        return _super(RecurringPayment, this).unlink();
    }
}

@MetaModel.define()
class RecurringPaymentLine extends Model {
    static _module = module;
    static _name = 'recurring.payment.line';
    static _description = 'Recurring Payment Line';

    static recurringPaymentId = Fields.Many2one('recurring.payment', { string: "Recurring Payment" });
    static partnerId = Fields.Many2one('res.partner', { string: 'Partner', required: true });
    static amount = Fields.Monetary('Amount', { required: true, default: 0.0 });
    static date = Fields.Date('Date', { required: true, default: self => _Date.today() });
    static journalId = Fields.Many2one('account.journal', { string: 'Journal', required: true });
    static companyId = Fields.Many2one('res.company', { string: 'Company', default: async (self) => (await self.env.company()).id });
    static currencyId = Fields.Many2one('res.currency', { string: 'Currency', related: 'companyId.currencyId' });
    static paymentId = Fields.Many2one('account.payment', { string: 'Payment' });
    static state = Fields.Selection({
        selection: [['draft', 'Draft'],
        ['done', 'Done']], default: 'draft', string: 'Status'
    });

    async actionCreatePayment() {
        const recurringPaymentId = await this['recurringPaymentId'];
        const vals = {
            'paymentType': await (await this['recurringPaymentId']).paymentType,
            'amount': await this['amount'],
            'currencyId': (await this['currencyId']).id,
            'journalId': (await this['journalId']).id,
            'companyId': (await this['companyId']).id,
            'date': await this['date'],
            'ref': await (await this['recurringPaymentId']).label,
            'partnerId': (await this['partnerId']).id,
        }
        const payment = await this.env.items('account.payment').create(vals);
        if (bool(payment)) {
            if (await recurringPaymentId.journalState === 'posted') {
                await payment.actionPost();
            }
            await this.write({ 'state': 'done', 'paymentId': payment.id });
        }
    }
}
