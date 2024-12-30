import { v4 as uuid4 } from 'uuid';
import { MetaModel, Model, _super } from "../../../core/models"
import { _f, bool, camelCaseTo_, dateSetTz, diffDate, f, len, map, some, someAsync, subDate, update } from '../../../core/tools';
import { Fields, _Date, api } from '../../../core';
import { UserError, ValidationError } from '../../../core/helper';
import { getattr, hasattr } from '../../../core/api';

@MetaModel.define()
class PosConfig extends Model {
    static _module = module;
    static _name = 'pos.config';
    static _description = 'Point of Sale Configuration';

    async _defaultWarehouseId() {
        return (await this.env.items('stock.warehouse').search([['companyId', '=', (await this.env.company()).id]], {limit: 1})).id;
    }

    async _defaultPickingTypeId() {
        return (await (await this.env.items('stock.warehouse').search([['companyId', '=', (await this.env.company()).id]], {limit: 1})).posTypeId).id;
    }

    async _defaultSaleJournal() {
        return this.env.items('account.journal').search([['type', 'in', ['sale', 'general']], ['companyId', '=', (await this.env.company()).id], ['code', '=', 'POSS']], {limit: 1});
    }

    async _defaultInvoiceJournal() {
        return this.env.items('account.journal').search([['type', '=', 'sale'], ['companyId', '=', (await this.env.company()).id]], {limit: 1});
    }

    async _defaultPaymentMethods() {
        const domain = [['splitTransactions', '=', false], ['companyId', '=', (await this.env.company()).id]];
        const nonCashPm = await this.env.items('pos.payment.method').search(domain.concat([['isCashCount', '=', false]]));
        const availableCashPm = await this.env.items('pos.payment.method').search(domain.concat([['isCashCount', '=', true], ['configIds', '=', false]]), {limit: 1});
        return nonCashPm.or(availableCashPm);
    }

    async _defaultPricelist() {
        return this.env.items('product.pricelist').search([['companyId', 'in', [false, (await this.env.company()).id]], ['currencyId', '=', (await (await this.env.company()).currencyId).id]], {limit: 1});
    }

    async _getGroupPosManager() {
        return this.env.ref('point_of_sale.groupPosManager');
    }

    async _getGroupPosUser() {
        return this.env.ref('point_of_sale.groupPosUser');
    }

    static label = Fields.Char({string: 'Point of Sale', index: true, required: true, help: "An internal identification of the point of sale."});
    static isInstalledAccountAccountant = Fields.Boolean({string: "Is the Full Accounting Installed",
        compute: "_computeIsInstalledAccountAccountant"});
    static pickingTypeId = Fields.Many2one(
        'stock.picking.type', {
        string: 'Operation Type',
        default: self => self._defaultPickingTypeId(),
        required: true,
        domain: "[['code', '=', 'outgoing'], ['warehouseId.companyId', '=', companyId]]",
        ondelete: 'RESTRICT'});
    static journalId = Fields.Many2one(
        'account.journal', {string: 'Point of Sale Journal',
        domain: [['type', 'in', ['general', 'sale']]],
        help:"Accounting journal used to post POS session journal entries and POS invoice payments.",
        default: self => self._defaultSaleJournal(),
        ondelete: 'RESTRICT'})
    static invoiceJournalId = Fields.Many2one(
        'account.journal', {string: 'Invoice Journal',
        domain: [['type', '=', 'sale']],
        help: "Accounting journal used to create invoices.",
        default: self => self._defaultInvoiceJournal()});
    static currencyId = Fields.Many2one('res.currency', {compute: '_computeCurrency', string: "Currency"});
    static ifaceCashdrawer = Fields.Boolean({string: 'Cashdrawer', help: "Automatically open the cashdrawer."});
    static ifaceElectronicScale = Fields.Boolean({string: 'Electronic Scale', help: "Enables Electronic Scale integration."})
    static ifaceCustomerFacingDisplay = Fields.Boolean({compute: '_computeCustomerFacingDisplay'});
    static ifaceCustomerFacingDisplayViaProxy = Fields.Boolean({string: 'Customer Facing Display', help: "Show checkout to customers with a remotely-connected screen."});
    static ifaceCustomerFacingDisplayLocal = Fields.Boolean({string: 'Local Customer Facing Display', help: "Show customers checkout in a pop-up window. Recommend to be moved to a second screen visible to the client."});
    static ifacePrintViaProxy = Fields.Boolean({string: 'Print via Proxy', help: "Bypass browser printing and prints via the hardware proxy."});
    static ifaceScanViaProxy = Fields.Boolean({string: 'Scan via Proxy', help: "Enable barcode scanning with a remotely connected barcode scanner and card swiping with a Vantiv card reader."});
    static ifaceBigScrollbars = Fields.Boolean('Large Scrollbars', {help: 'For imprecise industrial touchscreens.'});
    static ifaceOrderlineCustomerNotes = Fields.Boolean({string: 'Customer Notes', help: 'Allow to write notes for customer on Orderlines. This will be shown in the receipt.'});
    static ifacePrintAuto = Fields.Boolean({string: 'Automatic Receipt Printing', default: false,
        help: 'The receipt will automatically be printed at the end of each order.'});
    static ifacePrintSkipScreen = Fields.Boolean({string: 'Skip Preview Screen', default: true,
        help: 'The receipt screen will be skipped if the receipt can be printed automatically.'})
    static ifaceTaxIncluded = Fields.Selection([['subtotal', 'Tax-Excluded Price'], ['total', 'Tax-Included Price']], {string: "Tax Display", default: 'subtotal', required: true});
    static ifaceStartCategId = Fields.Many2one('pos.category', {string: 'Initial Category',
        help: 'The point of sale will display this product category by default. If no category is specified, all available products will be shown.'});
    static ifaceAvailableCategIds = Fields.Many2many('pos.category', {string: 'Available PoS Product Categories',
        help: 'The point of sale will only display products which are within one of the selected category trees. If no category is specified, all available products will be shown'});
    static selectableCategIds = Fields.Many2many('pos.category', {compute: '_computeSelectableCategories'});
    static ifaceDisplayCategImages = Fields.Boolean({string: 'Display Category Pictures',
        help: "The product categories will be displayed with pictures."});
    static restrictPriceControl = Fields.Boolean({string: 'Restrict Price Modifications to Managers',
        help: "Only users with Manager access rights for PoS app can modify the product prices on orders."});
    static cashControl = Fields.Boolean({string: 'Advanced Cash Control', compute: '_computeCashControl', help: "Check the amount of the cashbox at opening and closing."});
    static setMaximumDifference = Fields.Boolean('Set Maximum Difference', {help: "Set a maximum difference allowed between the expected and counted money during the closing of the session."});
    static receiptHeader = Fields.Text({string: 'Receipt Header', help: "A short text that will be inserted as a header in the printed receipt."});
    static receiptFooter = Fields.Text({string: 'Receipt Footer', help: "A short text that will be inserted as a footer in the printed receipt."});
    static proxyIp = Fields.Char({string: 'IP Address', size: 45,
        help: 'The hostname or ip address of the hardware proxy, Will be autodetected if left empty.'});
    static active = Fields.Boolean({default: true});
    static uuid = Fields.Char({readonly: true, default: () => uuid4(), copy: false,
        help: 'A globally unique identifier for this pos configuration, used to prevent conflicts in client-generated data.'});
    static sequenceId = Fields.Many2one('ir.sequence', {string: 'Order IDs Sequence', readonly: true,
        help: "This sequence is automatically created by Verp but you can change it "+
        "to customize the reference numbers of your orders.", copy: false, ondelete: 'RESTRICT'});
    static sequenceLineId = Fields.Many2one('ir.sequence', {string: 'Order Line IDs Sequence', readonly: true,
        help: "This sequence is automatically created by Verp but you can change it "+
        "to customize the reference numbers of your orders lines.", copy: false});
    static sessionIds = Fields.One2many('pos.session', 'configId', {string: 'Sessions'});
    static currentSessionId = Fields.Many2one('pos.session', {compute: '_computeCurrentSession', string: "Current Session"});
    static currentSessionState = Fields.Char({compute: '_computeCurrentSession'});
    static numberOfOpenedSession = Fields.Integer({string: "Number of Opened Session", compute: '_computeCurrentSession'});
    static lastSessionClosingCash = Fields.Float({compute: '_computeLastSession'});
    static lastSessionClosingDate = Fields.Date({compute: '_computeLastSession'});
    static posSessionUsername = Fields.Char({compute: '_computeCurrentSessionUser'});
    static posSessionState = Fields.Char({compute: '_computeCurrentSessionUser'});
    static posSessionDuration = Fields.Char({compute: '_computeCurrentSessionUser'});
    static pricelistId = Fields.Many2one('product.pricelist', {string: 'Default Pricelist', required: true, default: self => self._defaultPricelist(),
        help: "The pricelist used if no customer is selected or if the customer has no Sale Pricelist configured."});
    static availablePricelistIds = Fields.Many2many('product.pricelist', {string: 'Available Pricelists', default: self => self._defaultPricelist(),
        help: "Make several pricelists available in the Point of Sale. You can also apply a pricelist to specific customers from their contact form (in Sales tab). To be valid, this pricelist must be listed here as an available pricelist. Otherwise the default pricelist will apply."});
    static allowedPricelistIds = Fields.Many2many(
        'product.pricelist',
        {string: 'Allowed Pricelists',
        compute: '_computeAllowedPricelistIds',
        help: 'This is a technical field used for the domain of pricelistId.',
    });
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true, default: self => self.env.company()});
    static barcodeNomenclatureId = Fields.Many2one('barcode.nomenclature', {string: 'Barcode Nomenclature',
        help: 'Defines what kind of barcodes are available and how they are assigned to products, customers and cashiers.',
        default: async (self) => (await self.env.company()).nomenclatureId, required: true});
    static groupPosManagerId = Fields.Many2one('res.groups', {string: 'Point of Sale Manager Group', default: self => self._getGroupPosManager(),
        help: 'This field is there to pass the id of the pos manager group to the point of sale client.'});
    static groupPosUserId = Fields.Many2one('res.groups', {string: 'Point of Sale User Group', default: self => self._getGroupPosUser(),
        help: 'This field is there to pass the id of the pos user group to the point of sale client.'});
    static ifaceTipproduct = Fields.Boolean({string: "Product tips"});
    static tipProductId = Fields.Many2one('product.product', {string: 'Tip Product',
        help: "This product is used as reference on customer receipts."});
    static fiscalPositionIds = Fields.Many2many('account.fiscal.position', {string: 'Fiscal Positions', help: 'This is useful for restaurants with onsite and take-away services that imply specific tax rates.'});
    static defaultFiscalPositionId = Fields.Many2one('account.fiscal.position', {string: 'Default Fiscal Position'});
    static defaultBillIds = Fields.Many2many('pos.bill', {string: "Coins/Bills"});
    static usePricelist = Fields.Boolean("Use a pricelist.");
    static taxRegime = Fields.Boolean("Tax Regime");
    static taxRegimeSelection = Fields.Boolean("Tax Regime Selection value");
    static startCategory = Fields.Boolean("Start Category", {default: false});
    static limitCategories = Fields.Boolean("Restrict Product Categories");
    static moduleAccount = Fields.Boolean({string: 'Invoicing', default: true, help: 'Enables invoice generation from the Point of Sale.'});
    static modulePosRestaurant = Fields.Boolean("Is a Bar/Restaurant");
    static modulePosDiscount = Fields.Boolean("Global Discounts");
    static modulePosLoyalty = Fields.Boolean("Loyalty Program");
    static modulePosMercury = Fields.Boolean({string: "Integrated Card Payments"});
    static productConfigurator = Fields.Boolean({string: "Product Configurator"});
    static isPosbox = Fields.Boolean("PosBox");
    static isHeaderOrFooter = Fields.Boolean("Header & Footer");
    static modulePosHr = Fields.Boolean({help: "Show employee login screen"});
    static amountAuthorizedDiff = Fields.Float('Amount Authorized Difference', {
        help: "This field depicts the maximum difference allowed between the ending balance and the theoretical cash when closing a session, for non-POS managers. If this maximum is reached, the user will have an error message at the closing of his session saying that he needs to contact his manager."});
    static paymentMethodIds = Fields.Many2many('pos.payment.method', {string: 'Payment Methods', default: self => self._defaultPaymentMethods()});
    static companyHasTemplate = Fields.Boolean({string: "Company has chart of accounts", compute: "_computeCompanyHasTemplate"});
    static currentUserId = Fields.Many2one('res.users', {string: 'Current Session Responsible', compute: '_computeCurrentSessionUser'});
    static otherDevices = Fields.Boolean({string: "Other Devices", help: "Connect devices to your PoS without an IoT Box."});
    static roundingMethod = Fields.Many2one('account.cash.rounding', {string: "Cash rounding"});
    static cashRounding = Fields.Boolean({string: "Cash Rounding"});
    static onlyRoundCashMethod = Fields.Boolean({string: "Only apply rounding on cash"});
    static hasActiveSession = Fields.Boolean({compute: '_computeCurrentSession'});
    static manualDiscount = Fields.Boolean({string: "Manual Discounts", default: true});
    static shipLater = Fields.Boolean({string: "Ship Later"});
    static warehouseId = Fields.Many2one('stock.warehouse', {default: self => self._defaultWarehouseId(), ondelete: 'RESTRICT'});
    static routeId = Fields.Many2one('stock.location.route', {string: "Spefic route for products delivered later."});
    static pickingPolicy = Fields.Selection([
        ['direct', 'As soon as possible'],
        ['one', 'When all products are ready']],
        {string: 'Shipping Policy', required: true, default: 'direct',
        help: "If you deliver all products at once, the delivery order will be scheduled based on the greatest " +
        "product lead time. Otherwise, it will be based on the shortest."});
    static limitedProductsLoading = Fields.Boolean('Limited Product Loading', {
        help: "we load all starred products (favorite), all services, recent inventory movements of products, and the most recently updated products.\n"+
        "When the session is open, we keep on loading all remaining products in the background.\n"+
        "In the meantime, you can click on the 'database icon' in the searchbar to load products from database."});
    static limitedProductsAmount = Fields.Integer({default: 20000});
    static productLoadBackground = Fields.Boolean();
    static limitedPartnersLoading = Fields.Boolean('Limited Partners Loading', {
        help: "By default, 100 partners are loaded.\n"+
        "When the session is open, we keep on loading all remaining partners in the background.\n"+
        "In the meantime, you can use the 'Load Customers' button to load partners from database."});
    static limitedPartnersAmount = Fields.Integer({default: 100});
    static partnerLoadBackground = Fields.Boolean();

    @api.depends('paymentMethodIds')
    async _computeCashControl() {
        for (const config of this) {
            await config.set('cashControl', bool(await (await config.paymentMethodIds).filtered('isCashCount')));
        }
    }

    @api.depends('usePricelist', 'availablePricelistIds')
    async _computeAllowedPricelistIds() {
        for (const config of this) {
            if (await config.usePricelist) {
                await config.set('allowedPricelistIds', (await config.availablePricelistIds).ids);
            }
            else {
                await config.set('allowedPricelistIds', (await this.env.items('product.pricelist').search([])).ids);
            }
        }
    }

    @api.depends('companyId')
    async _computeCompanyHasTemplate() {
        for (const config of this) {
            await config.set('companyHasTemplate', await this.env.items('account.chart.template').existingAccounting(await config.companyId) || await (await config.companyId).chartTemplateId);
        }
    }

    async _computeIsInstalledAccountAccountant() {
        const accountAccountant = await (await this.env.items('ir.module.module').sudo()).search([['label', '=', 'accountAccountant'], ['state', '=', 'installed']]);
        for (const posConfig of this) {
            await posConfig.set('isInstalledAccountAccountant', bool(accountAccountant) && accountAccountant.id);
        }
    }

    @api.depends('journalId.currencyId', 'journalId.companyId.currencyId', 'companyId', 'companyId.currencyId')
    async _computeCurrency() {
        for (const posConfig of this) {
            const journal = await posConfig.journalId;
            if (bool(journal)) {
                const currency = await journal.currencyId;
                await posConfig.set('currencyId', currency.id || (await (await journal.companyId).currencyId).id);
            }
            else {
                await posConfig.set('currencyId', (await (await posConfig.companyId).currencyId).id);
            }
        }
    }

    /**
     * If there is an open session, store it to currentSessionId / currentSessionState.
     */
    @api.depends('sessionIds', 'sessionIds.state')
    async _computeCurrentSession() {
        for (const posConfig of this) {
            const sessionIds = await posConfig.sessionIds;
            const openedSessions = await sessionIds.filtered(async (s) => await s.state !== 'closed');
            const session = await sessionIds.filtered(async (s) => await s.state !== 'closed' && ! await s.rescue);
            // sessions ordered by id desc
            await posConfig.update({
                numberOfOpenedSession: len(openedSessions),
                hasActiveSession: bool(openedSessions) && true || false,
                currentSessionId: bool(session) && session[0].id || false,
                currentSessionState: bool(session) && await session[0].state || false
            });
        }
    }

    @api.depends('sessionIds')
    async _computeLastSession() {
        let posSession = this.env.items('pos.session');
        for (const posConfig of this) {
            const session = await posSession.searchRead(
                [['configId', '=', posConfig.id], ['state', '=', 'closed']],
                ['cashRegisterBalanceEndReal', 'stopAt', 'cashRegisterId'],
                {order: "stopAt desc", limit: 1});
            if (bool(session)) {
                const timezone = this._context['tz'] || await (await this.env.user()).tz || 'UTC';
                await posConfig.set('lastSessionClosingDate', _Date.toDate(dateSetTz(session[0]['stopAt'], timezone)));
                if (bool(session[0]['cashRegisterId'])) {
                    await posConfig.set('lastSessionClosingDate', session[0]['cashRegisterBalanceEndReal']);
                }
                else {
                    await posConfig.set('lastSessionClosingDate', 0);
                }
            }
            else {
                await posConfig.set('lastSessionClosingCash', 0);
                await posConfig.set('lastSessionClosingDate', false);
            }
        }
    }

    @api.depends('sessionIds')
    async _computeCurrentSessionUser() {
        for (const posConfig of this) {
            const session = await (await posConfig.sessionIds).filtered(async (s)=> ['openingControl', 'opened', 'closingControl'].includes(await s.state) && ! await s.rescue);
            if (bool(session)) {
                await posConfig.update({
                    posSessionUsername: await (await (await session[0].userId).sudo()).label,
                    posSessionState: await session[0].state,
                    posSessionDuration: await session[0].startAt ? diffDate(new Date(), await session[0].startAt, 'days'
                    ).days : 0,
                    currentUserId: await session[0].userId
                });
            }
            else {
                await posConfig.update({
                    posSessionUsername: false,
                    posSessionState: false,
                    posSessionDuration: 0,
                    currentUserId: false
                });
            }
        }
    }

    @api.depends('ifaceAvailableCategIds')
    async _computeSelectableCategories() {
        for (const config of this) {
            const ifaceAvailableCategIds = await config.ifaceAvailableCategIds;
            if (bool(ifaceAvailableCategIds)) {
                await config.set('selectableCategIds', ifaceAvailableCategIds);
            }
            else {
                await config.set('selectableCategIds', await this.env.items('pos.category').search([]));
            }
        }
    }

    @api.depends('ifaceCustomerFacingDisplayViaProxy', 'ifaceCustomerFacingDisplayLocal')
    async _computeCustomerFacingDisplay() {
        for (const config of this) {
            await config.set('ifaceCustomerFacingDisplay', await config.ifaceCustomerFacingDisplayViaProxy || await config.ifaceCustomerFacingDisplayLocal);
        }
    }

    @api.constrains('roundingMethod')
    async _checkRoundingMethodStrategy() {
        const field = this.env.items("account.cash.rounding")._fields["strategy"];
        for (const config of this) {
            if (await config.cashRounding && await (await config.roundingMethod).strategy !== 'addInvoiceLine') {
                let selectionValue = "Add a rounding line";
                for (const [key, val] of await field._descriptionSelection(field, config.env)) {
                    if (key === "addInvoiceLine") {
                        selectionValue = val;
                        break;
                    }
                }
                throw new ValidationError(_f(await this._t(
                    "The cash rounding strategy of the point of sale {pos} must be: '{value}'"), {
                    pos: await config.label,
                    value: selectionValue,
                }));
            }
        }
    }

    @api.constrains('companyId', 'journalId')
    async _checkCompanyJournal() {
        for (const config of this) {
            const journal = await config.journalId;
            if (bool(journal) && (await journal.companyId).id != (await config.companyId).id) {
                throw new ValidationError(await this._t("The sales journal of the point of sale %s must belong to its company.", await config.label));
            }
        }
    }

    async _checkProfitLossCashJournal() {
        const [cashControl, paymentMethodIds] = await this('cashControl', 'paymentMethodIds');
        if (cashControl && bool(paymentMethodIds)) {
            for (const method of paymentMethodIds) {
                if (await method.isCashCount && (! bool(await (await method.journalId).lossAccountId) || ! bool(await (await method.journalId).profitAccountId))) {
                    throw new ValidationError(await this._t("You need a loss and profit account on your cash journal."));
                }
            }
        }
    }

    @api.constrains('companyId', 'invoiceJournalId')
    async _checkCompanyInvoiceJournal() {
        for (const config of this) {
            if (bool(await config.invoiceJournalId) && (await (await config.invoiceJournalId).companyId).id != (await config.companyId).id) {
                throw new ValidationError(await this._t("The invoice journal of the point of sale %s must belong to the same company.", config.name));
            }
        }
    }

    @api.constrains('companyId', 'paymentMethodIds')
    async _checkCompanyPayment() {
        const label = await this['label'];
        for (const config of this) {
            if (bool(await this.env.items('pos.payment.method').searchCount([['id', 'in', (await config.paymentMethodIds).ids], ['companyId', '!=', (await config.companyId).id]]))) {
                throw new ValidationError(await this._t("The payment methods for the point of sale %s must belong to its company.", label));
            }
        }
    }

    @api.constrains('pricelistId', 'usePricelist', 'availablePricelistIds', 'journalId', 'invoiceJournalId', 'paymentMethodIds')
    async _checkCurrencies() {
        for (const config of this) {
            if (await config.usePricelist && ! (await config.availablePricelistIds).includes(await config.pricelistId)) {
                throw new ValidationError(await this._t("The default pricelist must be included in the available pricelists."));
            }
        }
        if (some(await (await this['availablePricelistIds']).mapped(async (pricelist) => !(await pricelist.currencyId).eq(await this['currencyId'])))) {
            throw new ValidationError(await this._t("All available pricelists must be in the same currency as the company or"+
                                    " as the Sales Journal set on this point of sale if you use"+
                                    " the Accounting application."));
        }
        const [currency, company] = await this('currencyId', 'companyId');
        const invoiceJournalCurrency = await (await this['invoiceJournalId']).currencyId;
        if (bool(invoiceJournalCurrency) && !invoiceJournalCurrency.eq(currency)) {
            throw new ValidationError(await this._t("The invoice journal must be in the same currency as the Sales Journal or the company currency if that is not set."));
        }
        if (some(
            await (await (await this['paymentMethodIds'])
                .filtered(pm => pm.isCashCount))
                .mapped(async (pm) => !(await company.currencyId).or(await (await pm.journalId).currencyId).eq(currency))
        )) {
            throw new ValidationError(await this._t("All payment methods must be in the same currency as the Sales Journal or the company currency if that is not set."));
        }
    }

    async _checkPaymentMethodIds() {
        this.ensureOne();
        if (! bool(await this['paymentMethodIds'])) {
            throw new ValidationError(
                await this._t("You must have at least one payment method configured to launch a session.")
            );
        }
    }

    @api.constrains('limitedPartnersAmount', 'limitedPartnersLoading')
    async _checkLimitedPartners() {
        for (const rec of this) {
            if (await rec.limitedPartnersLoading && ! await rec.limitedPartnersAmount) {
                throw new ValidationError(
                    await this._t("Number of partners loaded can not be 0")
                );
            }
        }
    }

    @api.constrains('limitedProductsAmount', 'limitedProductsLoading')
    async _checkLimitedProducts() {
        for (const rec of this) {
            if (await rec.limitedProductsLoading && ! await rec.limitedProductsAmount) {
                throw new ValidationError(
                    await this._t("Number of product loaded can not be 0")
                );
            }
        }
    }

    @api.constrains('pricelistId', 'availablePricelistIds')
    async _checkPricelists() {
        await this._checkCompanies();
        let self = await this.sudo();
        const company = await (await self.pricelistId).companyId;
        if (bool(company) && !company.eq(await self.companyId)) {
            throw new ValidationError(
                await self._t("The default pricelist must belong to no company or the company of the point of sale.")
            );
        }
    }

    @api.constrains('companyId', 'availablePricelistIds')
    async _checkCompanies() {
        for (const config of this) {
            if (await (await config.availablePricelistIds).some(async (pricelist) => ![false, (await config.companyId).id].includes((await pricelist.companyId).id))) {
                throw new ValidationError(await this._t("The selected pricelists must belong to no company or the company of the point of sale."));
            }
        }
    }

    @api.onchange('ifaceTipproduct')
    async _onchangeTipproduct() {
        if (await this['ifaceTipproduct']) {
            await this.set('tipProductId', await this.env.ref('point_of_sale.productProductTip', false));
        }
        else {
            await this.set('tipProductId', false);
        }
    }

    @api.onchange('ifacePrintViaProxy')
    async _onchangeIfacePrintViaProxy() {
        const ifacePrintViaProxy = await this['ifacePrintViaProxy'];
        await this.set('ifacePrintAuto', ifacePrintViaProxy);
        if (!ifacePrintViaProxy) {
            await this.set('ifaceCashdrawer', false);
        }
    }

    @api.onchange('moduleAccount')
    async _onchangeModuleAccount() {
        if (await this['moduleAccount'] && ! bool(await this['invoiceJournalId'])) {
            await this.set('invoiceJournalId', await this._defaultInvoiceJournal());
        }
    }

    /**
     *  If the 'pricelist' box is unchecked, we reset the pricelistId to stop
        using a pricelist for this iotbox.
     * @returns 
     */
    @api.onchange('usePricelist')
    async _onchangeUsePricelist() {
        if (! await this['usePricelist']) {
            await this.set('pricelistId', await this._defaultPricelist());
        }
    }

    @api.onchange('availablePricelistIds')
    async _onchangeAvailablePricelistIds() {
        if (!(await this['availablePricelistIds'])._origin.includes(await this['pricelistId'])) {
            await this.set('pricelistId', false);
        }
    }

    @api.onchange('isPosbox')
    async _onchangeIsPosbox() {
        if (! await this['isPosbox']) {
            await this.update({
                proxyIp: false,
                ifaceScanViaProxy: false,
                ifaceElectronicScale: false,
                ifaceCashdrawer: false,
                ifacePrintViaProxy: false,
                ifaceCustomerFacingDisplayViaProxy: false
            });
        }
    }

    @api.onchange('taxRegime')
    async _onchangeTaxRegime() {
        if (! await this['taxRegime']) {
            await this.set('defaultFiscalPositionId', false);
        }
    }

    @api.onchange('taxRegimeSelection')
    async _onchangeTaxRegimeSelection() {
        if (!await this['taxRegimeSelection']) {
            await this.set('fiscalPositionIds', [[5, 0, 0]]);
        }
    }

    @api.onchange('startCategory')
    async _onchangeStartCategory() {
        if (! await this['startCategory']) {
            await this.set('ifaceStartCategId', false);
        }
    }

    @api.onchange('limitCategories', 'ifaceAvailableCategIds', 'ifaceStartCategId')
    async _onchangeLimitCategories() {
        const res = {}
        if (!await this['limitCategories']) {
            await this.set('ifaceAvailableCategIds', false);
        }
        const ifaceAvailableCategIds = await this['ifaceAvailableCategIds'];
        if (bool(ifaceAvailableCategIds) && ! ifaceAvailableCategIds.ids.includes((await this['ifaceStartCategId']).id)) {
            await this.set('ifaceStartCategId', false);
        }
        return res;
    }

    @api.onchange('isHeaderOrFooter')
    async _onchangeHeaderFooter() {
        if (! await this['isHeaderOrFooter']) {
            await this.set('receiptHeader', false);
            await this.set('receiptFooter', false);
        }
    }

    async nameGet() {
        const result = [];
        for (const config of this) {
            const lastSession = await this.env.items('pos.session').search([['configId', '=', config.id]], {limit: 1});
            if (!bool(lastSession) || await lastSession.state === 'closed') {
                result.push([config.id, _f(await this._t("{posName} (not used)"), {posName: await config.label})]);
            }
            else {
                result.push([config.id, f("%s (%s)", await config.label, await (await lastSession.userId).label)]);
            }
        }
        return result;
    }

    @api.model()
    async create(values) {
        const irSequence = await this.env.items('ir.sequence').sudo();
        const val = {
            'label': await this._t('POS Order %s', values['label']),
            'padding': 4,
            'prefix': f("%s/", values['label']),
            'code': "pos.order",
            'companyId': values['companyId'] ?? false,
        }
        // force sequence_id field to new pos.order sequence
        values['sequenceId'] = (await irSequence.create(val)).id;

        update(val, {label: await this._t('POS order line %s', values['label']), code: 'pos.order.line'});
        values['sequenceLineId'] = (await irSequence.create(val)).id;
        const posConfig = await _super(PosConfig, this).create(values);
        const sudo = await posConfig.sudo();
        await sudo._checkModulesToInstall();
        await sudo._checkGroupsImplied();
        // If you plan to add something after this, use a new environment. The one above is no longer valid after the modules install.
        return posConfig;
    }

    async write(vals) {
        const openedSession = await (await this.mapped('sessionIds')).filtered(async (s) => await s.state !== 'closed');
        if (bool(openedSession)) {
            const forbiddenFields = [];
            for (const key of this._getForbiddenChangeFields()) {
                if (Object.keys(vals).includes(key)) {
                    const fieldName = (await this._fields[key].getDescription(this.env))["string"];
                    forbiddenFields.push(fieldName);
                }
            }
            if (forbiddenFields.length > 0) {
                throw new UserError(await this._t(
                    "Unable to modify this PoS Configuration because you can't modify %s while a session is open.",
                    String(forbiddenFields)
                ));
            }
        }
        const result = await _super(PosConfig, this).write(vals);
        const sudo = await this.sudo();
        await sudo._setFiscalPosition();
        await sudo._checkModulesToInstall();
        await sudo._checkGroupsImplied();
        return result;
    }

    _getForbiddenChangeFields() {
        const forbiddenKeys = ['modulePosHr', 'modulePosRestaurant', 'availablePricelistIds',
                          'limitCategories', 'ifaceAvailableCategIds', 'usePricelist', 'modulePosDiscount',
                          'paymentMethodIds', 'ifaceTipproduc'];
        return forbiddenKeys;
    }

    async unlink() {
        // Delete the pos.config records first then delete the sequences linked to them
        const sequencesToDelete = (await this['sequenceId']).or(await this['sequenceLineId']);
        const res = await _super(PosConfig, this).unlink();
        await sequencesToDelete.unlink();
        return res;
    }

    async _setFiscalPosition() {
        for (const config of this) {
            const [taxRegime, taxRegimeSelection, defaultFiscalPosition, fiscalPositionIds] = await config('taxRegime', 'taxRegimeSelection',  'defaultFiscalPositionId', 'fiscalPositionIds');
            if (taxRegime && !fiscalPositionIds.ids.includes(defaultFiscalPosition.id)) {
                await config.set('fiscalPositionIds', [[4, defaultFiscalPosition.id]]);
            }
            else if (!taxRegimeSelection && !taxRegime && bool(fiscalPositionIds.ids)) {
                await config.set('fiscalPositionIds', [[5, 0, 0]]);
            }
        }
    }

    async _checkModulesToInstall() {
        // determine modules to install
        const expected = [];
        for (const fname of this.fieldsGetKeys()) {
            if (fname.startsWith('module')) {
                if (await this.some(posConfig => posConfig[fname])) {
                    expected.push(camelCaseTo_(fname.slice(6))); //'moduleAccountAnalyst' -> 'account_analyst'
                }
            }
        }
        if (expected.length) {
            const STATES = ['installed', 'to install', 'to upgrade'];
            let modules = await (await this.env.items('ir.module.module').sudo()).search([['label', 'in', expected]]);
            modules = await modules.filtered(async (module) => !STATES.includes(await module.state));
            if (bool(modules)) {
                await modules.buttonImmediateInstall();
                // just in case we want to do something if we install a module. (like a refresh ...)
                return true;
            }
        }
        return false;
    }

    async _checkGroupsImplied() {
        for (const posConfig of this) {
            for (const fieldName of posConfig.fieldsGetKeys().filter(f => f.startsWith('group'))) {
                const field = posConfig._fields[fieldName];
                if (['boolean', 'selection'].includes(field.type) && ('impliedGroup' in field)) { // Tony must check
                    const fieldGroupXmlids = getattr(field, 'group', 'base.groupUser').split(',');
                    const fieldGroups = this.env.items('res.groups').concat(...await Promise.all(fieldGroupXmlids.map((it) => this.env.ref(it))));
                    await fieldGroups.write({'impliedIds': [[4, (await this.env.ref(field.impliedGroup)).id]]})
                }
            }
        }
    }

    async execute() {
        return {
            'type': 'ir.actions.client',
            'tag': 'reload',
            'params': {'wait': true}
        }
    }

    async _forceHttp() {
        const enforceHttps = await (await this.env.items('ir.config.parameter').sudo()).getParam('point_of_sale.enforceHttps');
        if (!enforceHttps && await this['otherDevices']) {
            return true;
        }
        return false;
    }

    async _getPosBaseUrl() {
        return await this._forceHttp() ? '/pos/web' : '/pos/ui';
    }

    // Methods to open the POS
    /**
     * Open the pos interface with configId as an extra argument.

        In vanilla PoS each user can only have one active session, therefore it was not needed to pass the configId
        on opening a session. It is also possible to login to sessions created by other users.

        :returns: dict
     * @returns 
     */
    async openUi() {
        this.ensureOne();
        // check all constraints, raises if any is not met
        await this._validateFields(this._fields.keys());
        return {
            'type': 'ir.actions.acturl',
            'url': await this._getPosBaseUrl() + f('?configId=%d', this.id),
            'target': 'self',
        }
    }

    /**
     * new session button

        create one if none exist
        access cash control interface if enabled or start a session
     * @param checkCoa 
     * @returns 
     */
    async openSessionCb(checkCoa=true) {
        this.ensureOne();
        if (! bool(await this['currentSessionId'])) {
            await this._checkPricelists();
            await this._checkCompanyJournal();
            await this._checkCompanyInvoiceJournal();
            await this._checkCompanyPayment();
            await this._checkCurrencies();
            await this._checkProfitLossCashJournal();
            await this._checkPaymentMethodIds();
            await this.env.items('pos.session').create({
                'userId': this.env.uid,
                'configId': this.id
            });
        }
        return this.openUi();
    }

    /**
     *  close session button
        access session form to validate entries
     * @returns 
     */
    async openExistingSessionCb() {
        this.ensureOne();
        return this._openSession((await this['currentSessionId']).id);
    }

    async _openSession(sessionId) {
        await this._checkPricelists();  // The pricelist company might have changed after the first opening of the session
        return {
            'label': await this._t('Session'),
            'viewMode': 'form,tree',
            'resModel': 'pos.session',
            'resId': sessionId,
            'viewId': false,
            'type': 'ir.actions.actwindow',
        }
    }

    async openOpenedSessionList() {
        return {
            'label': await this._t('Opened Sessions'),
            'resModel': 'pos.session',
            'viewMode': 'tree,kanban,form',
            'type': 'ir.actions.actwindow',
            'domain': [['state', '!=', 'closed'], ['configId', '=', this.id]]
        }
    }

    // All following methods are made to create data needed in POS, when a localisation
    // is installed, or if POS is installed on database having companies that already have
    // a localisation installed
    @api.model()
    async postInstallPosLocalisation(companies?: any) {
        let self = await this.sudo();
        if (!bool(companies)) {
            companies = await self.env.items('res.company').search([]);
        }
        for (const company of await companies.filtered('chartTemplateId')) {
            const posConfigs = await self.search([['companyId', '=', company.id]]);
            await posConfigs.setupDefaults(company);
        }
    }

    /**
     * Extend this method to customize the existing pos.config of the company during the installation
        of a localisation.

        :param self pos.config: pos.config records present in the company during the installation of localisation.
        :param company res.company: the single company where the pos.config defaults will be setup.
     * @param company 
     */
    async setupDefaults(company) {
        await this.assignPaymentJournals(company);
        await this.generatePosJournal(company);
        await this.setupInvoiceJournal(company);
    }

    async assignPaymentJournals(company) {
        for (const posConfig of this) {
            if (bool(await posConfig.paymentMethodIds) || await posConfig.hasActiveSession) {
                continue;
            }
            const cashJournal = await this.env.items('account.journal').search([['companyId', '=', company.id], ['type', '=', 'cash']], {limit: 1});
            const bankJournal = await this.env.items('account.journal').search([['companyId', '=', company.id], ['type', '=', 'bank']], {limit: 1});
            let paymentMethods = this.env.items('pos.payment.method');
            if (bool(cashJournal)) {
                paymentMethods = paymentMethods.or(await paymentMethods.create({
                    'label': await this._t('Cash'),
                    'journalId': cashJournal.id,
                    'companyId': company.id,
                }));
            }
            if (bool(bankJournal)) {
                paymentMethods = paymentMethods.or(await paymentMethods.create({
                    'label': await this._t('Bank'),
                    'journalId': bankJournal.id,
                    'companyId': company.id,
                }));
            }
            paymentMethods = paymentMethods.or(await paymentMethods.create({
                'label': await this._t('Customer Account'),
                'companyId': company.id,
                'splitTransactions': true,
            }));
            await posConfig.write({'paymentMethodIds': [[6, 0, paymentMethods.ids]]});
        }
    }

    async generatePosJournal(company) {
        for (const posConfig of this) {
            if (bool(await posConfig.journalId)) {
                continue;
            }
            let posJournal = await this.env.items('account.journal').search([['companyId', '=', company.id], ['code', '=', 'POSS']]);
            if (! bool(posJournal)) {
                posJournal = await this.env.items('account.journal').create({
                    'type': 'general',
                    'label': await this._t('Point of Sale'),
                    'code': 'POSS',
                    'companyId': company.id,
                    'sequence': 20
                });
            }
            await posConfig.write({'journalId': posJournal.id});
        }
    }

    async setupInvoiceJournal(company) {
        for (const posConfig of this) {
            let invoiceJournalId = await posConfig.invoiceJournalId;
            invoiceJournalId = bool(invoiceJournalId) ? invoiceJournalId : await this.env.items('account.journal').search([['type', '=', 'sale'], ['companyId', '=', company.id]], {limit: 1});
            if (invoiceJournalId.ok) {
                await posConfig.write({'invoiceJournalId': invoiceJournalId.id});
            }
            else {
                await posConfig.write({'moduleAccount': false});
            }
        }
    }

    async getLimitedProductsLoading(fields) {
        const query = `
            WITH pm AS (
                  SELECT "productId",
                         Max("updatedAt") date
                    FROM "stockQuant"
                GROUP BY "productId"
            )
               SELECT p.id
                 FROM "productProduct" p
            LEFT JOIN "productTemplate" t ON "productTemplateId"=t.id
            LEFT JOIN pm ON p.id=pm."productId"
                WHERE (
                        t."availableInPos"
                    AND t."saleOk"
                    AND (t."companyId"={companyId} OR t."companyId" IS NULL)
                    AND {availableCategIds} IS NULL OR t."posCategId" IN ({availableCategIds})
                )    OR p.id={tipProductId}
             ORDER BY t.priority DESC,
                      t."detailedType" DESC,
                      COALESCE(pm.date,p."updatedAt") DESC 
                LIMIT {limit}
        `;
        const [company, tipProduct, ifaceAvailableCategIds, limitedProductsAmount] = await this('tipProductId', 'ifaceAvailableCategIds', 'limitedProductsAmount');
        const params = {
            'companyId': company.id,
            'availableCategIds': ifaceAvailableCategIds.ok ? String(await ifaceAvailableCategIds.mapped('id')) : 'null',
            'tipProductId': tipProduct.ok ? tipProduct.id : null,
            'limit': limitedProductsAmount
        }
        const productIds = await this.env.cr.execute(_f(query, params));
        const products = await this.env.items('product.product').searchRead([['id', 'in', productIds]], fields);
        return products;
    }

    async getLimitedPartnersLoading() {
        const result = await this.env.cr.execute(`
            WITH pm AS
            (
                     SELECT   "partnerId",
                              Count("partnerId") "orderCount"
                     FROM     "posOrder"
                     GROUP BY "partnerId")
            SELECT    id
            FROM      "resPartner" AS partner
            LEFT JOIN pm
            ON        (
                                partner.id = pm."partnerId")
            ORDER BY  COALESCE(pm."orderCount", 0) DESC,
                      NAME limit %s;
        `, [await this['limitedPartnersAmount']]);
        return result;
    }
}
