import { Fields, _Date, api } from "../../../core";
import { setattr } from "../../../core/api";
import { Dict, UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, extend, f, floatCompare, floatIsZero, len, parseInt, range, some } from "../../../core/tools";
import { monthrange } from "../../../core/tools/calendar";
import { addDate, diffDate, subDate } from "../../../core/tools/date_utils";

@MetaModel.define()
class AccountAssetCategory extends Model {
    static _module = module;
    static _name = 'account.asset.category';
    static _description = 'Asset category';

    static active = Fields.Boolean({ default: true });
    static label = Fields.Char({ required: true, index: true, string: "Asset Type" });
    static accountAnalyticId = Fields.Many2one('account.analytic.account', { string: 'Analytic Account' });
    static analyticTagIds = Fields.Many2many('account.analytic.tag', { string: 'Analytic Tag' });
    static accountAssetId = Fields.Many2one('account.account', {
        string: 'Asset Account',
        required: true,
        domain: [['internalType', '=', 'other'], ['deprecated', '=', false]],
        help: "Account used to record the purchase of the asset at its original price."
    });
    static accountDepreciationId = Fields.Many2one('account.account', {
        string: 'Depreciation Entries: Asset Account',
        required: true, domain: [['internalType', '=', 'other'], ['deprecated', '=', false]],
        help: "Account used in the depreciation entries, to decrease the asset value."
    });
    static accountDepreciationExpenseId = Fields.Many2one('account.account',
        {
            string: 'Depreciation Entries: Expense Account',
            required: true,
            domain: [['internalType', '=', 'other'], ['deprecated', '=', false]],
            help: "Account used in the periodical entries, to record a part of the asset as expense."
        });
    static journalId = Fields.Many2one('account.journal', { string: 'Journal', required: true });
    static companyId = Fields.Many2one('res.company', {
        string: 'Company', required: true,
        default: self => self.env.company()
    });
    static method = Fields.Selection([['linear', 'Linear'], ['degressive', 'Degressive']],
        {
            string: 'Computation Method', required: true, default: 'linear',
            help: ["Choose the method to use to compute the amount of depreciation lines.",
                "  * Linear: Calculated on basis of: Gross Value / Number of Depreciations",
                "  * Degressive: Calculated on basis of: Residual Value * Degressive Factor"].join('\n')
        });
    static methodNumber = Fields.Integer({
        string: 'Number of Depreciations', default: 5,
        help: "The number of depreciations needed to depreciate your asset"
    });
    static methodPeriod = Fields.Integer({
        string: 'Period Length', default: 1,
        help: "State here the time between 2 depreciations, in months", required: true
    });
    static methodProgressFactor = Fields.Float('Degressive Factor', { default: 0.3 });
    static methodTime = Fields.Selection([['number', 'Number of Entries'], ['end', 'Ending Date']],
        {
            string: 'Time Method', required: true, default: 'number',
            help: ["Choose the method to use to compute the dates and number of entries.",
                "  * Number of Entries: Fix the number of entries and the time between 2 depreciations.",
                "  * Ending Date: Choose the time between 2 depreciations and the date the depreciations won't go beyond."].join('\n')
        });
    static methodEnd = Fields.Date('Ending date');
    static prorata = Fields.Boolean({
        string: 'Prorata Temporis',
        help: ['Indicates that the first depreciation entry for this asset have to be done from the ',
            'purchase date instead of the first of January'].join()
    });
    static openAsset = Fields.Boolean({
        string: 'Auto-Confirm Assets',
        help: ["Check this if you want to automatically confirm the assets ",
            "of this category when created by invoices."].join()
    });
    static groupEntries = Fields.Boolean({
        string: 'Group Journal Entries',
        help: "Check this if you want to group the generated entries by categories."
    });
    static type = Fields.Selection([['sale', 'Sale: Revenue Recognition'], ['purchase', 'Purchase: Asset']],
        { required: true, index: true, default: 'purchase' });
    static dateFirstDepreciation = Fields.Selection([
        ['lastDayPeriod', 'Based on Last Day of Purchase Period'],
        ['manual', 'Manual (Defaulted on Purchase Date)']],
        {
            string: 'Depreciation Dates', default: 'manual', required: true,
            help: ['The way to compute the date of the first depreciation.\n',
                '  * Based on last day of purchase period: The depreciation dates will',
                ' be based on the last day of the purchase month or the purchase',
                ' year (depending on the periodicity of the depreciations).\n',
                '  * Based on purchase date: The depreciation dates will be based on the purchase date.'].join()
        });

    @api.onchange('accountAssetId')
    async onchangeAccountAsset() {
        const [type, accountAssetId] = await this('type', 'accountAssetId')
        if (type === "purchase") {
            await this.set('accountDepreciationId', accountAssetId);
        }
        else if (type === "sale") {
            await this.set('accountDepreciationExpenseId', accountAssetId);
        }
    }

    @api.onchange('type')
    async onchangeType() {
        if (await this['type'] === 'sale') {
            // await Promise.all([
            await this.set('prorata', true),
                await this.set('methodPeriod', 1)
            // ]);
        }
        else {
            await this.set('methodPeriod', 12);
        }
    }

    @api.onchange('methodTime')
    async _onchangeMethodTime() {
        if (await this['methodTime'] !== 'number') {
            await this.set('prorata', false);
        }
    }
}

@MetaModel.define()
class AccountAssetAsset extends Model {
    static _module = module;
    static _name = 'account.asset.asset';
    static _description = 'Asset/Revenue Recognition';
    static _parents = ['mail.thread'];

    static entryCount = Fields.Integer({ compute: '_entryCount', string: '# Asset Entries' });
    static label = Fields.Char({
        string: 'Asset Name', required: true,
        readonly: true, states: { 'draft': [['readonly', false]] }
    });
    static code = Fields.Char({
        string: 'Reference', size: 32, readonly: true,
        states: { 'draft': [['readonly', false]] }
    });
    static value = Fields.Monetary({
        string: 'Gross Value', required: true, readonly: true,
        states: { 'draft': [['readonly', false]] }
    });
    static currencyId = Fields.Many2one('res.currency', {
        string: 'Currency', required: true,
        readonly: true, states: { 'draft': [['readonly', false]] },
        default: async (self) => (await (await (await self.env.user()).companyId).currencyId).id
    });
    static companyId = Fields.Many2one('res.company', {
        string: 'Company', required: true,
        readonly: true, states: { 'draft': [['readonly', false]] },
        default: self => self.env.company()
    });
    static note = Fields.Text();
    static categoryId = Fields.Many2one('account.asset.category', {
        string: 'Category',
        required: true, changeDefault: true,
        readonly: true, states: { 'draft': [['readonly', false]] }
    });
    static date = Fields.Date({
        string: 'Date', required: true, readonly: true,
        states: { 'draft': [['readonly', false]] }, default: self => _Date.contextToday(self)
    });
    static state = Fields.Selection([['draft', 'Draft'], ['open', 'Running'], ['close', 'Close']],
        {
            string: 'Status', required: true, copy: false, default: 'draft',
            help: ["When an asset is created, the status is 'Draft'.\n",
                "If the asset is confirmed, the status goes in 'Running' and the depreciation ",
                "lines can be posted in the accounting.\n",
                "You can manually close an asset when the depreciation is over. If the last line",
                " of depreciation is posted, the asset automatically goes in that status."].join()
        });
    static active = Fields.Boolean({ default: true });
    static partnerId = Fields.Many2one('res.partner', {
        string: 'Partner',
        readonly: true, states: { 'draft': [['readonly', false]] }
    });
    static method = Fields.Selection([['linear', 'Linear'], ['degressive', 'Degressive']],
        {
            string: 'Computation Method', required: true, readonly: true,
            states: { 'draft': [['readonly', false]] }, default: 'linear',
            help: ["Choose the method to use to compute the amount of depreciation lines.\n  * Linear:",
                " Calculated on basis of: Gross Value / Number of Depreciations\n",
                "  * Degressive: Calculated on basis of: Residual Value * Degressive Factor"].join()
        });
    static methodNumber = Fields.Integer({
        string: 'Number of Depreciations', readonly: true,
        states: { 'draft': [['readonly', false]] }, default: 5,
        help: "The number of depreciations needed to depreciate your asset"
    });
    static methodPeriod = Fields.Integer({
        string: 'Number of Months in a Period', required: true,
        readonly: true, default: 12, states: { 'draft': [['readonly', false]] },
        help: "The amount of time between two depreciations, in months"
    });
    static methodEnd = Fields.Date({ string: 'Ending Date', readonly: true, states: { 'draft': [['readonly', false]] } });
    static methodProgressFactor = Fields.Float({
        string: 'Degressive Factor',
        readonly: true, default: 0.3, states: { 'draft': [['readonly', false]] }
    });
    static valueResidual = Fields.Monetary({ compute: '_amountResidual', string: 'Residual Value' });
    static methodTime = Fields.Selection([['number', 'Number of Entries'], ['end', 'Ending Date']],
        {
            string: 'Time Method', required: true, readonly: true, default: 'number',
            states: { 'draft': [['readonly', false]] },
            help: ["Choose the method to use to compute the dates and number of entries.\n",
                "  * Number of Entries: Fix the number of entries and the time between 2 depreciations.\n",
                "  * Ending Date: Choose the time between 2 depreciations and the date the depreciations won't go beyond."].join()
        });
    static prorata = Fields.Boolean({
        string: 'Prorata Temporis', readonly: true, states: { 'draft': [['readonly', false]] },
        help: ['Indicates that the first depreciation entry for this asset',
            ' have to be done from the asset date (purchase date) ',
            'instead of the first January / Start date of fiscal year'].join()
    });
    static depreciationLineIds = Fields.One2many('account.asset.depreciation.line', 'assetId', {
        string: 'Depreciation Lines', readonly: true,
        states: { 'draft': [['readonly', false]], 'open': [['readonly', false]] }
    });
    static salvageValue = Fields.Monetary({
        string: 'Salvage Value', readonly: true,
        states: { 'draft': [['readonly', false]] },
        help: "It is the amount you plan to have that you cannot depreciate."
    });
    static invoiceId = Fields.Many2one('account.move', { string: 'Invoice', states: { 'draft': [['readonly', false]] }, copy: false });
    static type = Fields.Selection({ related: "categoryId.type", string: 'Type', required: true });
    static accountAnalyticId = Fields.Many2one('account.analytic.account', { string: 'Analytic Account' });
    static analyticTagIds = Fields.Many2many('account.analytic.tag', { string: 'Analytic Tag' });
    static dateFirstDepreciation = Fields.Selection([
        ['lastDayPeriod', 'Based on Last Day of Purchase Period'],
        ['manual', 'Manual']],
        {
            string: 'Depreciation Dates', default: 'manual',
            readonly: true, states: { 'draft': [['readonly', false]] }, required: true,
            help: ['The way to compute the date of the first depreciation.\n',
                '  * Based on last day of purchase period: The depreciation',
                ' dates will be based on the last day of the purchase month or the ',
                'purchase year (depending on the periodicity of the depreciations).\n',
                '  * Based on purchase date: The depreciation dates will be based on the purchase date.\n'].join()
        });
    static firstDepreciationManualDate = Fields.Date(
        {
            string: 'First Depreciation Date',
            readonly: true, states: { 'draft': [['readonly', false]] },
            help: ['Note that this date does not alter the computation of the first ',
                'journal entry in case of prorata temporis assets. It simply changes its accounting date'].join()
        });

    async unlink() {
        for (const asset of this) {
            if (['open', 'close'].includes(asset.state)) {
                throw new UserError(await this._t('You cannot delete a document that is in %s state.', await asset.state,));
            }
            for (const depreciationLine of await asset.depreciationLineIds) {
                if ((await depreciationLine.moveId).ok) {
                    throw new UserError(await this._t('You cannot delete a document that contains posted entries.'));
                }
            }
        }
        return _super(AccountAssetAsset, this).unlink();
    }

    @api.model()
    async _cronGenerateEntries() {
        await this.computeGeneratedEntries(_Date.today());
    }

    @api.model()
    async computeGeneratedEntries(date, assetType?: any) {
        // Entries generated : one by grouped category and one by asset from ungrouped category
        let createdMoveIds = [];
        let typeDomain = [];
        if (assetType) {
            typeDomain = [['type', '=', assetType]];
        }

        const ungroupedAssets = await this.env.items('account.asset.asset').search(typeDomain.concat([['state', '=', 'open'], ['categoryId.groupEntries', '=', false]]));
        extend(createdMoveIds, await ungroupedAssets._computeEntries(date, false));

        for (const groupedCategory of await this.env.items('account.asset.category').search(typeDomain.concat([['groupEntries', '=', true]]))) {
            const assets = await this.env.items('account.asset.asset').search([['state', '=', 'open'], ['categoryId', '=', groupedCategory.id]]);
            extend(createdMoveIds, await assets._computeEntries(date, true));
        }
        return createdMoveIds;
    }

    async _computeBoardAmount(sequence: number, residualAmount: number, amountToDepr: number,
        undoneDotationNumber: number, postedDepreciationLineIds: any,
        totalDays: number, depreciationDate: Date) {
        let amount = 0;
        if (sequence === undoneDotationNumber) {
            amount = residualAmount;
        }
        else {
            const [method, methodNumber, prorata, methodProgressFactor] = await this('method', 'methodNumber', 'prorata', 'methodProgressFactor');
            if (method === 'linear') {
                amount = amountToDepr / (undoneDotationNumber - len(postedDepreciationLineIds));
                if (prorata) {
                    amount = amountToDepr / methodNumber;
                    if (sequence == 1) {
                        const date: Date = await this['date'];
                        if (await this['methodPeriod'] % 12 != 0) {
                            const monthDays = monthrange(date.getFullYear(), date.getMonth() + 1)[1];
                            const days = monthDays - date.getDate() + 1;
                            amount = (amountToDepr / methodNumber) / monthDays * days;
                        }
                        else {
                            const days = diffDate((await (await this['companyId']).computeFiscalyearDates(date))['dateTo'], date, 'days').days + 1;
                            amount = (amountToDepr / methodNumber) / totalDays * days;
                        }
                    }
                }
            }
            else if (method === 'degressive') {
                amount = residualAmount * await this['methodProgressFactor'];
                if (prorata) {
                    if (sequence == 1) {
                        const date: Date = await this['date'];
                        if (await this['methodPeriod'] % 12 != 0) {
                            const monthDays = monthrange(date.getFullYear(), date.getMonth() + 1)[1];
                            const days = monthDays - date.getDate() + 1;
                            amount = (residualAmount * methodProgressFactor) / monthDays * days;
                        }
                        else {
                            subDate
                            const days = diffDate((await (await this['companyId']).computeFiscalyearDates(date))['dateTo'], date, 'days').days + 1;
                            amount = (residualAmount * methodProgressFactor) / totalDays * days;
                        }
                    }
                }
            }
        }
        return amount;
    }

    async _computeBoardUndoneDotationNb(depreciationDate, totalDays) {
        let [methodNumber, methodTime, prorata] = await this('methodNumber', 'methodTime', 'prorata');
        if (methodTime === 'end') {
            const [endDate, methodPeriod] = this('methodEnd', 'methodPeriod');
            methodNumber = 0;
            while (depreciationDate <= endDate) {
                depreciationDate = addDate(new Date(depreciationDate.getFullYear(), depreciationDate.getMonth(),
                    depreciationDate.getDate()), { months: methodPeriod });
                methodNumber += 1;
            }
        }
        if (prorata) {
            methodNumber += 1;
        }
        return methodNumber;
    }

    async computeDepreciationBoard() {
        this.ensureOne();

        const [depreciationLineIds, valueResidual, methodPeriod] = await this('depreciationLineIds', 'valueResidual', 'methodPeriod')
        const postedDepreciationLineIds = await (await depreciationLineIds.filtered((x) => x.moveCheck)).sorted((l) => l.depreciationDate);
        const unpostedDepreciationLineIds = await depreciationLineIds.filtered(async (x) => ! await x.moveCheck);

        // Remove old unposted depreciation lines. We cannot use unlink() with One2many field
        const commands = await unpostedDepreciationLineIds.map(lineId => [2, lineId.id, false]);

        if (valueResidual != 0.0) {
            let amountToDepr = valueResidual;
            let residualAmount = valueResidual;
            let depreciationDate: Date;
            // if we already have some previous validated entries, starting date is last entry + method period
            if (postedDepreciationLineIds.ok) {
                let lastDepreciationDate = await postedDepreciationLineIds.slice(-1).depreciationDate;
                if (lastDepreciationDate) {
                    lastDepreciationDate = _Date.toDate(lastDepreciationDate);
                    depreciationDate = addDate(lastDepreciationDate, { months: methodPeriod });
                }
            }
            else {
                // depreciation_date computed from the purchase date
                const date: Date = await this['date'];
                depreciationDate = date;
                if (await this['dateFirstDepreciation'] === 'lastDayPeriod') {
                    // depreciationDate = the last day of the month
                    depreciationDate = addDate(depreciationDate, { day: 31 });
                    // ... or fiscalyear depending the number of period
                    if (methodPeriod == 12) {
                        const companyId = await this['companyId'];
                        depreciationDate = addDate(depreciationDate, { month: parseInt(await companyId.fiscalyearLastMonth) });
                        depreciationDate = addDate(depreciationDate, { day: parseInt(await companyId.fiscalyearLastDay) });
                        if (depreciationDate < date) {
                            depreciationDate = addDate(depreciationDate, { years: 1 });
                        }
                    }
                }
                else {
                    const firstDepreciationManualDate = await this['firstDepreciationManualDate'];
                    if (firstDepreciationManualDate && firstDepreciationManualDate != date) {
                        // depreciation_date set manually from the 'first_depreciation_manual_date' field
                        depreciationDate = firstDepreciationManualDate;
                    }
                }
            }
            let totalDays = (depreciationDate.getFullYear() % 4) && 365 || 366;
            let monthDay = depreciationDate.getDate();
            const undoneDotationNumber = await this._computeBoardUndoneDotationNb(depreciationDate, totalDays);
            const [code, value, salvageValue, dateFirstDepreciation, prorata] = await this('code', 'value', 'salvageValue', 'dateFirstDepreciation', 'prorata');
            for (const x of range(len(postedDepreciationLineIds), undoneDotationNumber)) {
                const sequence = x + 1;
                let amount = await this._computeBoardAmount(sequence, residualAmount, amountToDepr,
                    undoneDotationNumber, postedDepreciationLineIds,
                    totalDays, depreciationDate);
                const currencyId = await this['currencyId'];
                amount = await currencyId.round(amount);
                if (floatIsZero(amount, { precisionRounding: await currencyId.rounding })) {
                    continue;
                }
                residualAmount -= amount;

                const vals = {
                    'amount': amount,
                    'assetId': this.id,
                    'sequence': sequence,
                    'label': (code || '') + '/' + sequence,
                    'remainingValue': residualAmount,
                    'depreciatedValue': value - (salvageValue + residualAmount),
                    'depreciationDate': depreciationDate,
                }
                commands.push([0, false, vals]);

                depreciationDate = addDate(depreciationDate, { months: methodPeriod });

                if (monthDay > 28 && dateFirstDepreciation === 'manual') {
                    const maxDayInMonth = monthrange(depreciationDate.getFullYear(), depreciationDate.getMonth() + 1)[1];
                    depreciationDate.setDate(Math.min(maxDayInMonth, monthDay));
                }

                // datetime doesn't take into account that the number of days is not the same for each month
                if (!prorata && methodPeriod % 12 != 0 && dateFirstDepreciation === 'lastDayPeriod') {
                    const maxDayInMonth = monthrange(depreciationDate.getFullYear(), depreciationDate.getMonth() + 1)[1];
                    depreciationDate.setDate(maxDayInMonth);
                }
            }
        }
        await this.write({ 'depreciationLineIds': commands });

        return true;
    }

    async validate() {
        await this.write({ 'state': 'open' });
        const fields = [
            'method',
            'methodNumber',
            'methodPeriod',
            'methodEnd',
            'methodProgressFactor',
            'methodTime',
            'salvageValue',
            'invoiceId',
        ];
        const refTrackedFields = this.env.items('account.asset.asset').fieldsGet(fields);
        for (const asset of this) {
            const trackedFields = Object.assign({}, refTrackedFields);
            if (await asset.method === 'linear') {
                delete trackedFields['methodProgressFactor'];
            }
            if (await asset.methodTime !== 'end') {
                delete trackedFields['methodEnd'];
            }
            else {
                delete trackedFields['methodNumber'];
            }
            const [dummy, trackingValueIds] = await asset._mailTrack(trackedFields, Dict.fromKeys(fields));
            await asset.messagePost({ subject: await this._t('Asset created'), trackingValueIds: trackingValueIds });
        }
    }

    async _returnDisposalView(moveIds) {
        let label = await this._t('Disposal Move');
        let viewMode = 'form';
        if (len(moveIds) > 1) {
            label = await this._t('Disposal Moves');
            viewMode = 'tree,form';
        }
        return {
            'label': label,
            'viewType': 'form',
            'viewMode': viewMode,
            'resModel': 'account.move',
            'type': 'ir.actions.actwindow',
            'target': 'current',
            'resId': moveIds[0],
        }
    }

    async _getDisposalMoves() {
        const moveIds = [];
        for (const asset of this) {
            const depreciationLineIds = await asset.depreciationLineIds;
            const unpostedDepreciationLineIds = await depreciationLineIds.filtered(async (x) => ! await x.moveCheck);
            if (unpostedDepreciationLineIds.ok) {
                const [methodEnd, methodNumber, valueResidual, value, salvageValue, code] = await asset('methodEnd', 'methodNumber', 'valueResidual', 'value', 'salvageValue', 'code');
                const oldValues = {
                    'methodEnd': methodEnd,
                    'methodNumber': methodNumber,
                }

                // Remove all unposted depr. lines
                const commands = await unpostedDepreciationLineIds.map(lineId => [2, lineId.id, false]);

                // Create a new depr. line with the residual amount and post it
                const sequence = len(depreciationLineIds) - len(unpostedDepreciationLineIds) + 1;
                const today = _Date.today();
                const vals = {
                    'amount': valueResidual,
                    'asset_id': asset.id,
                    'sequence': sequence,
                    'label': (code || '') + '/' + sequence,
                    'remainingValue': 0,
                    'depreciatedValue': value - salvageValue,  // the asset is completely depreciated
                    'depreciationDate': today,
                }
                commands.push([0, false, vals]);
                await asset.write({ 'depreciationLineIds': commands, 'methodEnd': today, 'methodNumber': sequence });
                const trackedFields = this.env.items('account.asset.asset').fieldsGet(['methodNumber', 'methodEnd']);
                const [changes, trackingValueIds] = await asset._mailTrack(trackedFields, oldValues);
                if (bool(changes)) {
                    await asset.messagePost({ subject: await this._t('Asset sold or disposed. Accounting entry awaiting for validation.'), trackingValueIds: trackingValueIds });
                }
                extend(moveIds, await depreciationLineIds.slice(-1).createMove(false));
            }
        }
        return moveIds;
    }

    async setToClose() {
        const moveIds = await this._getDisposalMoves();
        if (bool(moveIds)) {
            return this._returnDisposalView(moveIds);
        }
        // Fallback, as if we just clicked on the smartbutton
        return this.openEntries();
    }

    async setToDraft() {
        await this.write({ 'state': 'draft' });
    }

    @api.depends('value', 'salvageValue', 'depreciationLineIds.moveCheck', 'depreciationLineIds.amount')
    async _amountResidual() {
        for (const rec of this) {
            const [depreciationLineIds, value, salvageValue] = await rec('depreciationLineIds', 'value', 'salvageValue');
            let totalAmount = 0.0;
            for (const line of depreciationLineIds) {
                if (await line.moveCheck) {
                    totalAmount += await line.amount;
                }
            }
            await rec.set('valueResidual', value - totalAmount - salvageValue);
        }
    }

    @api.onchange('companyId')
    async onchangeCompanyId() {
        await this.set('currencyId', (await (await this['companyId']).currencyId).id);
    }

    @api.onchange('dateFirstDepreciation')
    async onchangeDateFirstDepreciation() {
        for (const record of this) {
            if (await record.dateFirstDepreciation === 'manual') {
                await record.set('firstDepreciationManualDate', await record.date);
            }
        }
    }

    @api.depends('depreciationLineIds.moveId')
    async _entryCount() {
        for (const asset of this) {
            const res = await this.env.items('account.asset.depreciation.line').searchCount([['assetId', '=', asset.id], ['moveId', '!=', false]]);
            await asset.set('entryCount', res || 0);
        }
    }

    @api.constrains('prorata', 'methodTime')
    async _checkProrata() {
        if (await this['prorata'] && await this['methodTime'] !== 'number') {
            throw new ValidationError(await this._t('Prorata temporis can be applied only for the "number of depreciations" time method.'));
        }
    }

    @api.onchange('categoryId')
    async onchangeCategoryId() {
        const vals = await this.onchangeCategoryIdValues((await this['categoryId']).id);
        // We cannot use 'write' on an object that doesn't exist yet
        if (bool(vals)) {
            for (const [k, v] of Object.entries(vals['value'])) {
                console.warn('Must check', this, k, v);
                setattr(this, k, v);
            }
        }
    }

    async onchangeCategoryIdValues(categoryId) {
        if (bool(categoryId)) {
            const category = await this.env.items('account.asset.category').browse(categoryId).getDict(
                'method', 'methodNumber', 'methodTime', 'methodPeriod', 'methodProgressFactor', 'methodEnd', 'prorata', 'dateFirstDepreciation', 'accountAnalyticId', 'analyticTagIds');
            return {
                'value': {
                    'method': category.method,
                    'methodNumber': category.methodNumber,
                    'methodTime': category.methodTime,
                    'methodPeriod': category.methodPeriod,
                    'methodProgressFactor': category.methodProgressFactor,
                    'methodEnd': category.methodEnd,
                    'prorata': category.prorata,
                    'dateFirstDepreciation': category.dateFirstDepreciation,
                    'accountAnalyticId': category.accountAnalyticId.id,
                    'analyticTagIds': [[6, 0, category.analyticTagIds.ids]],
                }
            }
        }
    }

    @api.onchange('methodTime')
    async onchangeMethodTime() {
        if (await this['methodTime'] !== 'number') {
            await this.set('prorata', false);
        }
    }

    async copyData(defaultValue?: any) {
        if (defaultValue == null) {
            defaultValue = {};
        }
        defaultValue['label'] = await this['label'] + await this._t(' (copy)');
        return _super(AccountAssetAsset, this).copyData(defaultValue);
    }

    async _computeEntries(date, groupEntries = false) {
        const depreciationIds = await this.env.items('account.asset.depreciation.line').search([
            ['assetId', 'in', this.ids], ['depreciationDate', '<=', date],
            ['moveCheck', '=', false]]);
        if (groupEntries) {
            return depreciationIds.createGroupedMove();
        }
        return depreciationIds.createMove();
    }

    @api.model()
    async create(vals) {
        const asset = await _super(AccountAssetAsset, await this.withContext({ mailCreateNolog: true })).create(vals);
        await (await asset.sudo()).computeDepreciationBoard();
        return asset;
    }

    async write(vals) {
        const res = await _super(AccountAssetAsset, this).write(vals);
        if (!('depreciationLineIds' in vals) && !('state' in vals)) {
            for (const rec of this) {
                await rec.computeDepreciationBoard();
            }
        }
        return res;
    }

    async openEntries() {
        const moveIds = [];
        for (const asset of this) {
            for (const depreciationLine of await asset.depreciationLineIds) {
                const moveId = await depreciationLine.moveId;
                if (moveId.ok) {
                    moveIds.push(moveId.id);
                }
            }
        }
        return {
            'label': await this._t('Journal Entries'),
            'viewType': 'form',
            'viewMode': 'tree,form',
            'resModel': 'account.move',
            'viewId': false,
            'type': 'ir.actions.actwindow',
            'domain': [['id', 'in', moveIds]],
        }
    }
}

@MetaModel.define()
class AccountAssetDepreciationLine extends Model {
    static _module = module;
    static _name = 'account.asset.depreciation.line';
    static _description = 'Asset depreciation line';

    static label = Fields.Char({ string: 'Depreciation Name', required: true, index: true });
    static sequence = Fields.Integer({ required: true });
    static assetId = Fields.Many2one('account.asset.asset', {
        string: 'Asset',
        required: true, ondelete: 'CASCADE'
    });
    static parentState = Fields.Selection({ related: 'assetId.state', string: 'State of Asset' });
    static amount = Fields.Monetary({ string: 'Current Depreciation', required: true });
    static remainingValue = Fields.Monetary({ string: 'Next Period Depreciation', required: true });
    static depreciatedValue = Fields.Monetary({ string: 'Cumulative Depreciation', required: true });
    static depreciationDate = Fields.Date('Depreciation Date', { index: true });
    static moveId = Fields.Many2one('account.move', { string: 'Depreciation Entry' });
    static moveCheck = Fields.Boolean({ compute: '_getMoveCheck', string: 'Linked', store: true });
    static movePostedCheck = Fields.Boolean({ compute: '_getMovePostedCheck', string: 'Posted', store: true });
    static currencyId = Fields.Many2one('res.currency', { string: 'Currency', related: 'assetId.currencyId', readonly: true });

    @api.depends('moveId')
    async _getMoveCheck() {
        for (const line of this) {
            await line.set('moveCheck', bool(line.moveId));
        }
    }

    @api.depends('moveId.state')
    async _getMovePostedCheck() {
        for (const line of this) {
            const moveId = await line.moveId;
            await line.set('movePostedCheck', moveId.ok && await moveId.state === 'posted' ? true : false);
        }
    }

    async createMove(postMove = true) {
        let createdMoves = this.env.items('account.move');
        for (const line of this) {
            if ((await line.moveId).ok) {
                throw new UserError(await this._t('This depreciation is already linked to a journal entry. Please post or delete it.'));
            }
            const moveVals = await this._prepareMove(line);
            const move = await this.env.items('account.move').create(moveVals);
            await line.write({ 'moveId': move.id, 'moveCheck': true });
            createdMoves = createdMoves.or(move);
        }

        if (postMove && createdMoves.ok) {
            await (await createdMoves.filtered(async (m) => some(await (await m.assetDepreciationIds).mapped('assetId.categoryId.openAsset')))).actionPost();
        }
        return createdMoves.map(x => x.id);
    }

    async _prepareMove(line) {
        const [asset, sequence, lineamount] = await line('assetId', 'sequence', 'amount');
        const [label, code, category, accountAnalytic, analyticTagIds, company, currency, depreciationLineIds, partner] = await asset('label', 'code', 'categoryId', 'accountAnalyticId', 'analyticTagIds', 'companyId', 'currencyId', 'depreciationLineIds', 'partnerId');
        const depreciationDate = this.env.context['depreciationDate'] || await line['depreciationDate'] || await _Date.contextToday(this);
        const companyCurrency = await company.currencyId;
        const prec = await companyCurrency.decimalPlaces;
        const amount = await currency._convert(lineamount, currency, company, depreciationDate);
        const assetLabel = label + f(' (%s/%s)', sequence, len(depreciationLineIds));
        const categoryType = await category.type;
        const moveLine1 = {
            'label': assetLabel,
            'accountId': (await category.accountDepreciationId).id,
            'debit': floatCompare(amount, 0.0, { precisionDigits: prec }) > 0 ? 0.0 : -amount,
            'credit': floatCompare(amount, 0.0, { precisionDigits: prec }) > 0 ? amount : 0.0,
            'partnerId': partner.id,
            'analyticAccountId': categoryType == 'sale' ? accountAnalytic.id : false,
            'analyticTagIds': categoryType == 'sale' ? [[6, 0, analyticTagIds.ids]] : false,
            'currencyId': !companyCurrency.eq(currency) && bool(currency.id) && currency.id || false,
            'amountCurrency': !companyCurrency.eq(currency) && - 1.0 * lineamount || 0.0,
        }
        const moveLine2 = {
            'label': assetLabel,
            'accountId': (await category.accountDepreciationExpenseId).id,
            'credit': floatCompare(amount, 0.0, { precisionDigits: prec }) > 0 ? 0.0 : -amount,
            'debit': floatCompare(amount, 0.0, { precisionDigits: prec }) > 0 ? amount : 0.0,
            'partnerId': partner.id,
            'analyticAccountId': categoryType === 'purchase' ? accountAnalytic.id : false,
            'analyticTagIds': categoryType === 'purchase' ? [[6, 0, analyticTagIds.ids]] : false,
            'currencyId': !companyCurrency.eq(currency) && bool(currency.id) && currency.id || false,
            'amountCurrency': !companyCurrency.eq(currency) && lineamount || 0.0,
        }
        const moveVals = {
            'ref': code,
            'date': depreciationDate || false,
            'journalId': (await category.journalId).id,
            'lineIds': [[0, 0, moveLine1], [0, 0, moveLine2]],
        }
        return moveVals;
    }

    async _prepareMoveGrouped() {
        const asset = await this[0].assetId;
        const [category, accountAnalytic, analyticTagIds] = await asset('categoryId', 'accountAnalyticId', 'analyticTagIds');
        const depreciationDate = this.env.context['depreciationDate'] || await _Date.contextToday(this);
        let amount = 0.0;
        for (const line of this) {
            const [lineasset, lineamount] = await line('assetId', 'amount');
            // Sum amount of all depreciation lines
            const [company, currency] = await lineasset('companyId', 'currencyId');
            const companyCurrency = await company.currencyId;
            amount += currency._convert(lineamount, companyCurrency, company, _Date.today());
        }

        const [type, catlabel, journal, accountDepreciation, accountDepreciationExpense] = await category('type', 'label', 'journalId', 'accountDepreciationId', 'accountDepreciationExpenseId');
        const label = catlabel + await this._t(' (grouped)');
        const moveLine1 = {
            'label': label,
            'accountId': accountDepreciation.id,
            'debit': 0.0,
            'credit': amount,
            'journalId': journal.id,
            'analyticAccountId': type == 'sale' ? accountAnalytic.id : false,
            'analyticTagIds': type == 'sale' ? [[6, 0, analyticTagIds.ids]] : false,
        }
        const moveLine2 = {
            'label': label,
            'accountId': accountDepreciationExpense.id,
            'credit': 0.0,
            'debit': amount,
            'journalId': journal.id,
            'analyticAccountId': type === 'purchase' ? accountAnalytic.id : false,
            'analyticTagIds': type == 'purchase' ? [[6, 0, analyticTagIds.ids]] : false,
        }
        const moveVals = {
            'ref': catlabel,
            'date': depreciationDate || false,
            'journalId': journal.id,
            'lineIds': [[0, 0, moveLine1], [0, 0, moveLine2]],
        }

        return moveVals;
    }

    async createGroupedMove(postMove: true) {
        if (!bool(await this.exists())) {
            return [];
        }

        let createdMoves = this.env.items('account.move');
        const move = await this.env.items('account.move').create(await this._prepareMoveGrouped());
        await this.write({ 'moveId': move.id, 'moveCheck': true });
        createdMoves = createdMoves.or(move);

        if (postMove && createdMoves.ok) {
            await createdMoves.actionPost();
        }
        return createdMoves.map(x => x.id);
    }

    async postLinesAndCloseAsset() {
        // we re-evaluate the assets to determine whether we can close them
        for (const line of this) {
            await line.logMessageWhenPosted();
            const asset = await line.assetId;
            const [currencyId, valueResidual] = await asset('currencyId', 'valueResidual');
            if (await currencyId.isZero(valueResidual)) {
                await asset.messagePost({ body: await this._t("Document closed.") });
                await asset.write({ 'state': 'close' })
            }
        }
    }

    async logMessageWhenPosted() {
        function _formatMessage(messageDescription, trackedValues) {
            let message = '';
            if (messageDescription) {
                message = f('<span>%s</span>', messageDescription);
            }
            for (const [name, values] of Object.entries(trackedValues)) {
                message += f('<div> &nbsp; &nbsp; &bull; <b>%s</b>: ', name);
                message += f('%s</div>', values);
            }
            return message;
        }

        for (const line of this) {
            const [move, asset, amount] = await line('moveId', 'assetId', 'amount')
            if (move.ok && await move.state === 'draft') {
                const partnerName = await (await asset.partnerId).label;
                const currencyName = await (await asset.currencyId).label;
                const msgValues = { [await this._t('Currency')]: currencyName, [await this._t('Amount')]: amount }
                if (partnerName) {
                    msgValues[await this._t('Partner')] = partnerName;
                }
                const msg = _formatMessage(await this._t('Depreciation line posted.'), msgValues);
                await asset.messagePost({ body: msg });
            }
        }
    }

    async unlink() {
        for (const record of this) {
            if (await record.moveCheck) {
                let msg;
                if (await (await (await record.assetId).categoryId).type === 'purchase') {
                    msg = await this._t("You cannot delete posted depreciation lines.");
                }
                else {
                    msg = await this._t("You cannot delete posted installment lines.");
                }
                throw new UserError(msg);
            }
        }
        return _super(AccountAssetDepreciationLine, this).unlink();
    }
}