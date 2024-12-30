import { _Date, _Datetime, http } from "../../../core";
import { addDate, combine, diffDate, floatRound, formatDate, getLang, parseFloat, range, subDate, sum, update } from "../../../core/tools";
import { WebsiteBackend } from "../../website/controllers";

@http.define()
class WebsiteSaleBackend extends WebsiteBackend {
    static _module = module;

    @http.route()
    async fetchDashboardData(req, res, opts: { websiteId?: any, dateFrom?: any, dateTo?: any } = {}) {
        const env = await req.getEnv();
        const Website = env.items('website');
        const currentWebsite = opts.websiteId ? Website.browse(opts.websiteId) : await Website.getCurrentWebsite();

        const results = await super.fetchDashboardData(req, res, opts);

        const dateDateFrom = _Date.toDate(opts.dateFrom) as Date,
            dateDateTo = _Date.toDate(opts.dateTo) as Date,
            dateDiffDays = diffDate(dateDateTo, dateDateFrom, 'days').days,
            datetimeFrom = combine(dateDateFrom, 'min'),
            datetimeTo = combine(dateDateTo, 'max');

        const salesValues = {
            graph: [],
            bestSellers: [],
            summary: {
                orderCount: 0, orderCartsCount: 0, orderUnpaidCount: 0,
                orderToInvoiceCount: 0, orderCartsAbandonedCount: 0,
                paymentToCaptureCount: 0, totalSold: 0,
                orderPerDayRatio: 0, orderSoldRatio: 0, orderConvertionPctg: 0,
            }
        };

        results['dashboards']['sales'] = salesValues;

        results['groups']['saleSalesman'] = await env.items('res.users').hasGroup('sales_team.groupSaleSalesman');

        if (!results['groups']['saleSalesman']) {
            return results;
        }

        results['dashboards']['sales']['utmGraph'] = await this.fetchUtmData(env, datetimeFrom, datetimeTo);
        // Product-based computation
        const saleReportDomain = [
            ['websiteId', '=', currentWebsite.id],
            ['state', 'in', ['sale', 'done']],
            ['date', '>=', datetimeFrom],
            ['date', '<=', _Datetime.now()]
        ];
        const reportProductLines = await env.items('sale.report').readGroup(
            saleReportDomain,
            ['productTemplateId', 'productUomQty', 'priceSubtotal'],
            'productTemplateId',
            { orderby: 'productUomQty desc', limit: 5 });
        for (const productLine of reportProductLines) {
            const productTemplateId = env.items('product.template').browse(productLine['productTemplateId'][0]);
            salesValues['bestSellers'].push({
                'id': productTemplateId.id,
                'label': await productTemplateId.label,
                'qty': productLine['productUomQty'],
                'sales': productLine['priceSubtotal'],
            });
        }

        // Sale-based results computation
        const saleOrderDomain = [
            ['websiteId', '=', currentWebsite.id],
            ['dateOrder', '>=', datetimeFrom],
            ['dateOrder', '<=', datetimeTo]];
        const soGroupData = await env.items('sale.order').readGroup(saleOrderDomain, ['state'], 'state');
        for (const res of soGroupData) {
            if (res['state'] === 'sent') {
                salesValues['summary']['orderUnpaidCount'] += res['stateCount'];
            }
            else if (['sale', 'done'].includes(res['state'])) {
                salesValues['summary']['orderCount'] += res['stateCount'];
            }
            salesValues['summary']['orderCartsCount'] += res['stateCount'];
        }
        const reportPriceLines = await env.items('sale.report').readGroup(
            [
                ['websiteId', '=', currentWebsite.id],
                ['state', 'in', ['sale', 'done']],
                ['date', '>=', datetimeFrom],
                ['date', '<=', datetimeTo]],
            ['teamId', 'priceSubtotal'],
            ['teamId'],
        );
        update(salesValues['summary'], {
            orderToInvoiceCount: await env.items('sale.order').searchCount(saleOrderDomain.concat([
                ['state', 'in', ['sale', 'done']],
                ['orderLine', '!=', false],
                ['partnerId', '!=', (await env.ref('base.publicPartner')).id],
                ['invoiceStatus', '=', 'to invoice'],
            ])),
            orderCartsAbandonedCount: await env.items('sale.order').searchCount(saleOrderDomain.concat([
                ['isAbandonedCart', '=', true],
                ['cartRecoveryEmailSent', '=', false]
            ])),
            paymentToCaptureCount: await env.items('payment.transaction').searchCount([
                ['state', '=', 'authorized'],
                // that part perform a search on sale.order in order to comply with access rights as tx do not have any
                ['saleOrderIds', 'in', (await env.items('sale.order').search(
                    saleOrderDomain.concat([['state', '!=', 'cancel']])
                )).ids],
            ]),
            totalSold: sum(reportPriceLines.map(priceLine => priceLine['priceSubtotal']))
        });

        // Ratio computation
        salesValues['summary']['orderPerDayRatio'] = floatRound(parseFloat(salesValues['summary']['orderCount']) / dateDiffDays, { precisionDigits: 2 });
        salesValues['summary']['orderSoldRatio'] = salesValues['summary']['orderCount'] ? floatRound(parseFloat(salesValues['summary']['totalSold']) / salesValues['summary']['order_count'], { precisionDigits: 2 }) : 0;
        salesValues['summary']['orderConvertionPctg'] = salesValues['summary']['orderCartsCount'] ? (100.0 * salesValues['summary']['orderCount'] / salesValues['summary']['orderCartsCount']) : 0;

        // Graphes computation
        let previousSaleLabel;
        if (dateDiffDays == 7) {
            previousSaleLabel = await this._t('Previous Week');
        }
        else if (dateDiffDays > 7 && dateDiffDays <= 31) {
            previousSaleLabel = await this._t('Previous Month');
        }
        else {
            previousSaleLabel = await this._t('Previous Year');
        }

        salesValues['graph'] = salesValues['graph'].concat([{
            'values': await this._computeSaleGraph(env, dateDateFrom, dateDateTo, saleReportDomain),
            'key': 'Untaxed Total',
        }, {
            'values': await this._computeSaleGraph(env, subDate(dateDateFrom, { days: dateDiffDays }), dateDateFrom, saleReportDomain, true),
            'key': previousSaleLabel,
        }]);

        return results;
    }

    async fetchUtmData(env, dateFrom, dateTo) {
        const saleUtmDomain = [
            ['websiteId', '!=', false],
            ['state', 'in', ['sale', 'done']],
            ['dateOrder', '>=', _Date.toDate(dateFrom)],
            ['dateOrder', '<=', _Date.toDate(dateTo)]
        ];
        const Order = env.items('sale.order');
        const ordersDataGroupbyCampaignId = await Order.readGroup(
            saleUtmDomain.concat([['campaignId', '!=', false]]),
            ['amountTotal', 'id', 'campaignId'],
            'campaignId'
        );

        const ordersDataGroupbyMediumId = await Order.readGroup(
            saleUtmDomain.concat([['mediumId', '!=', false]]),
            ['amountTotal', 'id', 'mediumId'],
            'mediumId'
        );

        const ordersDataGroupbySourceId = await Order.readGroup(
            saleUtmDomain.concat([['sourceId', '!=', false]]),
            ['amountTotal', 'id', 'sourceId'],
            'sourceId'
        );

        return {
            'campaignId': await this.computeUtmGraphData('campaignId', ordersDataGroupbyCampaignId),
            'mediumId': await this.computeUtmGraphData('mediumId', ordersDataGroupbyMediumId),
            'sourceId': await this.computeUtmGraphData('sourceId', ordersDataGroupbySourceId),
        }
    }

    async computeUtmGraphData(utmType, utmGraphData) {
        return utmGraphData.map(data => {
            return {
                'utmType': data[utmType][1],
                'amountTotal': data['amountTotal']
            }
        });
    }

    async _computeSaleGraph(env, dateFrom, dateTo, salesDomain, previous: boolean = false) {
        const daysBetween = diffDate(dateTo, dateFrom, 'days').days;
        const dateList = Array.from(range(0, daysBetween + 1)).map(x => addDate(dateFrom, { days: x }))

        const dailySales = await env.items('sale.report').readGroup(
            salesDomain,
            ['date', 'priceSubtotal'],
            'date:day'
        );

        const dailySalesDict = Object.fromEntries(dailySales.map(p => [p['date:day'], p['priceSubtotal']]));

        const salesGraph = [];
        for (const d of dateList) {
            salesGraph.push({
                '0': !previous ? _Date.toDate(d) : _Date.toDate(addDate(d, { days: daysBetween })),
                // Respect read_group format in models.js
                '1': dailySalesDict[await formatDate(env, d, await (await getLang(env)).code, 'dd MMM yyyy')] ?? 0
            })
        }

        return salesGraph;
    }
}