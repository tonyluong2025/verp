import { _Date, api, Fields } from "../../../core";
import { UserError } from "../../../core/helper";
import { _super, MetaModel, Model } from "../../../core/models"
import { _convert$, _f, bool, f, floatRound, setDate } from "../../../core/tools";

@MetaModel.define()
class CrmTeam extends Model {
    static _module = module;
    static _parents = 'crm.team';

    static useQuotations = Fields.Boolean({string: 'Quotations', help: "Check this box if you send quotations to your customers rather than confirming orders straight away."});
    static invoiced = Fields.Float({
        compute: '_computeInvoiced',
        string: 'Invoiced This Month', readonly: true,
        help: "Invoice revenue for the current month. This is the amount the sales "+
                "channel has invoiced this month. It is used to compute the progression ratio "+
                "of the current and target revenue on the kanban view."});
    static invoicedTarget = Fields.Float({
        string: 'Invoicing Target',
        help: "Revenue target for the current month (untaxed total of confirmed invoices)."});
    static quotationsCount = Fields.Integer({
        compute: '_computeQuotationsToInvoice',
        string: 'Number of quotations to invoice', readonly: true});
    static quotationsAmount = Fields.Float({
        compute: '_computeQuotationsToInvoice',
        string: 'Amount of quotations to invoice', readonly: true});
    static salesToInvoiceCount = Fields.Integer({
        compute: '_computeSalesToInvoice',
        string: 'Number of sales to invoice', readonly: true});
    static saleOrderCount = Fields.Integer({compute: '_computeSaleOrderCount', string: '# Sale Orders'});

    async _computeQuotationsToInvoice() {
        const query = await this.env.items('sale.order')._whereCalc([
            ['teamId', 'in', this.ids],
            ['state', 'in', ['draft', 'sent']],
        ]);
        await this.env.items('sale.order')._applyIrRules(query, 'read');
        const [, whereClause, whereClauseArgs] = query.getSql();
        const selectQuery = f(`
            SELECT "teamId", COUNT(*)::int, sum("amountTotal" /
                CASE COALESCE("currencyRate", 0)
                WHEN 0 THEN 1.0
                ELSE "currencyRate"
                END
            ) as "amountTotal"
            FROM "saleOrder"
            WHERE %s
            GROUP BY "teamId"
        `, whereClause);
        const res = await this.env.cr.execute(_convert$(selectQuery), {bind: whereClauseArgs});
        let teams = this.browse();
        for (const datum of res) {
            const team = this.browse(datum['teamId']);
            await team.set('quotationsAmount', datum['amountTotal']);
            await team.set('quotationsCount', datum['count']);
            teams = teams.or(team);
        }
        const remaining = this.sub(teams);
        await remaining.set('quotationsAmount', 0);
        await remaining.set('quotationsCount', 0);
    }

    async _computeSalesToInvoice() {
        const saleOrderData = await this.env.items('sale.order').readGroup([
            ['teamId', 'in', this.ids],
            ['invoiceStatus','=','to invoice'],
        ], ['teamId'], ['teamId']);
        const dataMap = {};
        for (const datum of saleOrderData) {
            dataMap[datum['teamId'][0]] = datum['teamId_count'];
        }
        for (const team of this) {
            await team.set('salesToInvoiceCount', dataMap[team.id] ?? 0.0);
        }
    }

    async _computeInvoiced() {
        if (! this.ok) {
            return;
        }

        const query = `
            SELECT
                move."teamId" AS "teamId",
                SUM(move."amountUntaxedSigned") AS "amountUntaxedSigned"
            FROM "accountMove" move
            WHERE move."moveType" IN ('outInvoice', 'outRefund', 'outReceipt')
            AND move."paymentState" IN ('inPayment', 'paid', 'reversed')
            AND move.state = 'posted'
            AND move."teamId" IN (%s)
            AND move.date BETWEEN '%s' AND '%s'
            GROUP BY move."teamId"
        `;
        const today = _Date.today();
        const params = [String(this.ids) || 'NULL', setDate(today, {day: 1}).toISOString(), today.toISOString()];
        const res = await this._cr.execute(query, params);

        const dataMap = Object.fromEntries(res.map(v => [v['teamdId'], v['amountUntaxedSigned']]));
        for (const team of this) {
            await team.set('invoiced', dataMap[team.id] ?? 0.0);
        }
    }

    async _computeSaleOrderCount() {
        const dataMap = {};
        if (bool(this.ids)) {
            const saleOrderData = await this.env.items('sale.order').readGroup([
                ['teamId', 'in', this.ids],
                ['state', '!=', 'cancel'],
            ], ['teamId'], ['teamId']);
            for (const datum of saleOrderData) {
                dataMap[datum['teamId'][0]] = datum['teamId_count'];
            }
        }
        for (const team of this) {
            await team.set('saleOrderCount', dataMap[team.id] ?? 0);
        }
    }

    async _graphGetModel() {
        if (this._context['inSalesApp']) {
            return 'sale.report';
        }
        return _super(CrmTeam, this)._graphGetModel();
    }

    async _graphDateColumn() {
        if (this._context['inSalesApp']) {
            return 'date';
        }
        return _super(CrmTeam, this)._graphDateColumn();
    }

    async _graphYQuery() {
        if (this._context['inSalesApp']) {
            return 'SUM("priceSubtotal")';
        }
        return _super(CrmTeam, this)._graphYQuery();
    }

    async _extraSqlConditions() {
        if (this._context['inSalesApp']) {
            return "AND state in ('sale', 'done', 'posDone')";
        }
        return _super(CrmTeam, this)._extraSqlConditions();
    }

    async _graphTitleAndKey() {
        if (this._context['inSalesApp']) {
            return ['', await this._t('Sales: Untaxed Total')] // no more title
        }
        return _super(CrmTeam, this)._graphTitleAndKey();
    }

    async _computeDashboardButtonName() {
        await _super(CrmTeam, this)._computeDashboardButtonName();
        if (this._context['inSalesApp']) {
            await this.update({'dashboardButtonName': await this._t("Sales Analysis")});
        }
    }

    async actionPrimaryChannelButton() {
        if (this._context['inSalesApp']) {
            return this.env.items("ir.actions.actions")._forXmlid("sale.actionOrderReportSoSalesteam");
        }
        return _super(CrmTeam, this).actionPrimaryChannelButton();
    }

    async updateInvoicedTarget(value) {
        return this.write({'invoicedTarget': floatRound(parseFloat(value || 0))});
    }

    /**
     * If more than 5 active SOs, we consider this team to be actively used.
        5 is some random guess based on "user testing", aka more than testing
        CRM feature and less than use it in real life use cases.
     */
    @api.ondelete(false)
    async _unlinkExceptUsedForSales() {
        const SO_COUNT_TRIGGER = 5;
        for (const team of this) {
            if (await team.saleOrderCount >= SO_COUNT_TRIGGER) {
                throw new UserError(
                    _f(await this._t('Team {teamName} has {saleOrderCount} active sale orders. Consider canceling them or archiving the team instead.)', {
                      teamName: await team.label,
                      saleOrderCount: await team.saleOrderCount
                    }))
                )
            }
        }
    }
}