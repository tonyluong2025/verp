import { api } from "../../../core";
import { Fields, _Date } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { AbstractModel, MetaModel, Model, _super } from "../../../core/models"
import { _f, f } from "../../../core/tools/utils";
import { PAYMENT_STATE_SELECTION } from "../models/account_move";

@MetaModel.define()
class AccountInvoiceReport extends Model {
    static _module = module;
    static _name = "account.invoice.report";
    static _description = "Invoices Statistics";
    static _auto = false;
    static _recName = 'invoiceDate';
    static _order = 'invoiceDate desc';

    // ==== Invoice fields ====
    static moveId = Fields.Many2one('account.move', {readonly: true});
    static journalId = Fields.Many2one('account.journal', {string: 'Journal', readonly: true});
    static companyId = Fields.Many2one('res.company', {string: 'Company', readonly: true});
    static companyCurrencyId = Fields.Many2one('res.currency', {string: 'Company Currency', readonly: true});
    static partnerId = Fields.Many2one('res.partner', {string: 'Partner', readonly: true});
    static commercialPartnerId = Fields.Many2one('res.partner', {string: 'Partner Company', help: "Commercial Entity"});
    static countryId = Fields.Many2one('res.country', {string: "Country"});
    static invoiceUserId = Fields.Many2one('res.users', {string: 'Salesperson', readonly: true});
    static moveType = Fields.Selection([
        ['outInvoice', 'Customer Invoice'],
        ['inInvoice', 'Vendor Bill'],
        ['outRefund', 'Customer Credit Note'],
        ['inRefund', 'Vendor Credit Note'],
        ], {readonly: true});
    static state = Fields.Selection([
        ['draft', 'Draft'],
        ['posted', 'Open'],
        ['cancel', 'Cancelled']
        ], {string: 'Invoice Status', readonly: true});
    static paymentState = Fields.Selection({selection: PAYMENT_STATE_SELECTION, string: 'Payment Status', readonly: true});
    static fiscalPositionId = Fields.Many2one('account.fiscal.position', {string: 'Fiscal Position', readonly: true});
    static invoiceDate = Fields.Date({readonly: true, string: "Invoice Date"});

    // ==== Invoice line fields ====
    static quantity = Fields.Float({string: 'Product Quantity', readonly: true});
    static productId = Fields.Many2one('product.product', {string: 'Product', readonly: true});
    static productUomId = Fields.Many2one('uom.uom', {string: 'Unit of Measure', readonly: true});
    static productCategId = Fields.Many2one('product.category', {string: 'Product Category', readonly: true});
    static invoiceDateDue = Fields.Date({string: 'Due Date', readonly: true});
    static accountId = Fields.Many2one('account.account', {string: 'Revenue/Expense Account', readonly: true, domain: [['deprecated', '=', false]]});
    static analyticAccountId = Fields.Many2one('account.analytic.account', {string: 'Analytic Account', groups: "analytic.groupAnalyticAccounting"});
    static priceSubtotal = Fields.Float({string: 'Untaxed Total', readonly: true});
    static priceAverage = Fields.Float({string: 'Average Price', readonly: true, groupOperator: "avg"});

    static _depends = Dict.from({
        'account.move': [
            'label', 'state', 'moveType', 'partnerId', 'invoiceUserId', 'fiscalPositionId',
            'invoiceDate', 'invoiceDateDue', 'invoicePaymentTermId', 'partnerBankId',
        ],
        'account.move.line': [
            'quantity', 'priceSubtotal', 'amountResidual', 'balance', 'amountCurrency',
            'moveId', 'productId', 'productUomId', 'accountId', 'analyticAccountId',
            'journalId', 'companyId', 'currencyId', 'partnerId',
        ],
        'product.product': ['productTemplateId'],
        'product.template': ['categId'],
        'uom.uom': ['categoryId', 'factor', 'label', 'uomType'],
        'res.currency.rate': ['currencyId', 'label'],
        'res.partner': ['countryId'],
    });

    static async _tableQuery(self) {
        return f('%s %s %s', await self._select(), await self._from(), await self._where());
    }

    @api.model()
    async _select() {
        return `
            SELECT
                line.id,
                line."moveId",
                line."productId",
                line."accountId",
                line."analyticAccountId",
                line."journalId",
                line."companyId",
                line."companyCurrencyId",
                line."partnerId" AS "commercialPartnerId",
                move.state,
                move."moveType",
                move."partnerId",
                move."invoiceUserId",
                move."fiscalPositionId",
                move."paymentState",
                move."invoiceDate",
                move."invoiceDateDue",
                "uomTemplate".id AS "productUomId",
                template."categId" AS "productCategId",
                line.quantity / NULLIF(COALESCE("uomLine".factor, 1) / COALESCE("uomTemplate".factor, 1), 0.0) * (CASE WHEN move."moveType" IN ('inInvoice','outRefund','inReceipt') THEN -1 ELSE 1 END) AS "quantity",
                -line.balance * "currencyTable".rate AS "priceSubtotal",
                -COALESCE(
                   (line.balance / NULLIF(line.quantity, 0.0)) * (CASE WHEN move."moveType" IN ('inInvoice','outRefund','inReceipt') THEN -1 ELSE 1 END)
                   * (NULLIF(COALESCE("uomLine".factor, 1), 0.0) / NULLIF(COALESCE("uomTemplate".factor, 1), 0.0)),
                   0.0) * "currencyTable".rate AS "priceAverage",
                COALESCE(partner."countryId", "commercialPartner"."countryId") AS "countryId"
        `;
    }

    @api.model()
    async _from() {
        return _f(`
            FROM "accountMoveLine" line
                LEFT JOIN "resPartner" partner ON partner.id = line."partnerId"
                LEFT JOIN "productProduct" product ON product.id = line."productId"
                LEFT JOIN "accountAccount" account ON account.id = line."accountId"
                LEFT JOIN "accountAccountType" "userType" ON "userType".id = account."userTypeId"
                LEFT JOIN "productTemplate" template ON template.id = product."productTemplateId"
                LEFT JOIN "uomUom" "uomLine" ON "uomLine".id = line."productUomId"
                LEFT JOIN "uomUom" "uomTemplate" ON "uomTemplate".id = template."uomId"
                INNER JOIN "accountMove" move ON move.id = line."moveId"
                LEFT JOIN "resPartner" "commercialPartner" ON "commercialPartner".id = move."commercialPartnerId"
                JOIN {currencyTable} ON "currencyTable"."companyId" = line."companyId"
        `, {
            currencyTable: await this.env.items('res.currency')._getQueryCurrencyTable({'multiCompany': true, 'date': {'dateTo': _Date.today()}}),
      });
    }

    @api.model()
    async _where() {
        return `
            WHERE move."moveType" IN ('outInvoice', 'outRefund', 'inInvoice', 'inRefund', 'outReceipt', 'inReceipt')
                AND line."accountId" IS NOT NULL
                AND NOT line."excludeFromInvoiceTab"
        `;
    }
}

@MetaModel.define()
class ReportInvoiceWithoutPayment extends AbstractModel {
    static _module = module;
    static _name = 'report.account.invoice';
    static _description = 'Account report without payment lines';

    @api.model()
    async _getReportValues(docIds, data?: any) {
        const docs = this.env.items('account.move').browse(docIds);

        const qrCodeUrls = {};
        for (const invoice of docs) {
            if (await invoice.displayQrCode) {
                const newCodeUrl = await invoice.generateQrCode();
                if (newCodeUrl) {
                    qrCodeUrls[invoice.id] = newCodeUrl;
                }
            }
        }
        return {
            'docIds': docIds,
            'docModel': 'account.move',
            'docs': docs,
            'qrCodeUrls': qrCodeUrls,
        }
    }
}

@MetaModel.define()
class ReportInvoiceWithPayment extends AbstractModel {
    static _module = module;
    static _name = 'report.account.invoice.with.payment';
    static _description = 'Account report with payment lines';
    static _parents = 'report.account.invoice';

    @api.model()
    async _getReportValues(docIds, data?: any) {
        const rslt = await _super(ReportInvoiceWithPayment, this)._getReportValues(docIds, data);
        rslt['reportType'] = data ? data['reportType'] : '';
        return rslt;
    }
}