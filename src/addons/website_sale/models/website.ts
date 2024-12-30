import { api, Fields, tools } from "../../../core";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool, len, update, urlFor } from "../../../core/tools";
import { getRequestWebsite } from "../../website/models";

@MetaModel.define()
class Website extends Model {
    static _module = module;
    static _parents = 'website';

    static pricelistId = Fields.Many2one('product.pricelist', {compute: '_computePricelistId', string: 'Default Pricelist'});
    static currencyId = Fields.Many2one('res.currency',
        {related: 'pricelistId.currencyId', depends: [], relatedSudo: false,
        string: 'Default Currency', readonly: false});
    static salespersonId = Fields.Many2one('res.users', {string:'Salesperson'});

    async _getDefaultWebsiteTeam() {
        try {
            const team = await this.env.ref('sales_team.salesteamWebsiteSales');
            return await team.active ? team : null;
        } catch(e) {
            return null;
        }
    }

    static salesteamId = Fields.Many2one('crm.team', {string: 'Sales Team', ondelete: "SET NULL", default: (self)=> self._getDefaultWebsiteTeam()});
    static pricelistIds = Fields.One2many('product.pricelist', {compute: "_computePricelistIds", string: 'Price list available for this Ecommerce/Website'});
    static allPricelistIds = Fields.One2many('product.pricelist', 'websiteId', {string: 'All pricelists', help: 'Technical: Used to recompute pricelistIds'});

    async _defaultRecoveryMailTemplate() {
        try {
            return (await this.env.ref('website_sale.mailTemplateSaleCartRecovery')).id;
        } catch(e) {
            return false;
        }
    }

    static cartRecoveryMailTemplateId = Fields.Many2one('mail.template', {string: 'Cart Recovery Email', default: (self) => self._defaultRecoveryMailTemplate(), domain: "[['model', '=', 'sale.order']]"});
    static cartAbandonedDelay = Fields.Float("Abandoned Delay", {default: 1.0});

    static shopPpg = Fields.Integer({default: 20, string: "Number of products in the grid on the shop"});
    static shopPpr = Fields.Integer({default: 4, string: "Number of grid columns on the shop"});

    static shopExtraFieldIds = Fields.One2many('website.sale.extra.field', 'websiteId', {string: 'E-Commerce Extra Fields'});

    static cartAddOnPage = Fields.Boolean("Stay on page after adding to cart", {default: true});

    @api.depends('allPricelistIds')
    async _computePricelistIds() {
        const pricelist = this.env.items('product.pricelist');
        for (const website of this) {
            await website.set('pricelistIds', await pricelist.search(
                await pricelist._getWebsitePricelistsDomain(website.id)
            ));
        }
    }

    async _computePricelistId() {
        for (const website of this) {
            await website.set('pricelistId', await (await website.withContext({websiteId: website.id})).getCurrentPricelist(this.env.req));
        }
    }

    /**
     * Return the list of pricelists that can be used on website for the current user.
        :param str countryCode: code iso or False, If set, we search only price list available for this country
        :param bool showVisible: if True, we don't display pricelist where selectable is False (Eg: Code promo)
        :param int websitePl: The default pricelist used on this website
        :param int currentPl: The current pricelist used on the website
                               (If not selectable but the current pricelist we had this pricelist anyway)
        :param list allPl: List of all pricelist available for this website
        :param int partnerPl: the partner pricelist
        :param int orderPl: the current cart pricelist
        :returns: list of pricelist ids
     * @param countryCode 
     * @param showVisible 
     * @param websitePl 
     * @param currentPl 
     * @param allPl 
     * @param partnerPl 
     * @param orderPl 
     * @returns 
     */
    @tools.ormcache('self.env.uid', 'countryCode', 'showVisible', 'websitePl', 'currentPl', 'allPl', 'partnerPl', 'orderPl')
    async _getPlPartnerOrder(countryCode, showVisible, websitePl, currentPl, allPl, partnerPl: any=false, orderPl=false) {
        /**
         * If `showVisible` is True, we will only show the pricelist if
            one of this condition is met:
            - The pricelist is `selectable`.
            - The pricelist is either the currently used pricelist or the
            current cart pricelist, we should consider it as available even if
            it might not be website compliant (eg: it is not selectable anymore,
            it is a backend pricelist, it is not active anymore..).
         * @param pl 
         * @returns 
         */
        async function _checkShowVisible(pl) {
            return ! showVisible || await pl.selectable || [currentPl, orderPl].includes(pl.id);
        }
        // Note: 1. pricelists from all_pl are already website compliant (went through
        //          `_getWebsitePricelistsDomain`)
        //       2. do not read `propertyProductPricelist` here as `_getPlPartnerOrder`
        //          is cached and the result of this method will be impacted by that field value.
        //          Pass it through `partnerPl` parameter instead to invalidate the cache.

        // If there is a GeoIP country, find a pricelist for it
        this.ensureOne();
        let pricelists = this.env.items('product.pricelist');
        if (countryCode) {
            for (const cgroup of await this.env.items('res.country.group').search([['countryIds.code', '=', countryCode]])) {
                pricelists = pricelists.or(await (await cgroup.pricelistIds).filtered(
                    async (pl) => await pl._isAvailableOnWebsite(this.id) && await _checkShowVisible(pl)
                ));
            }
        }

        // no GeoIP or no pricelist for this country
        if (!countryCode || !pricelists.ok) {
            pricelists = pricelists.or(await allPl.filtered(pl => _checkShowVisible(pl)));
        }
        // if logged in, add partner pl (which is `property_product_pricelist`, might not be website compliant)
        const isPublic = (await this['userId']).id == (await this.env.user()).id;
        if (! isPublic) {
            // keep partnerPl only if website compliant
            partnerPl = await pricelists.browse(partnerPl).filtered(async (pl) => await pl._isAvailableOnWebsite(this.id) && await _checkShowVisible(pl));
            if (countryCode) {
                // keep partner_pl only if GeoIP compliant in case of GeoIP enabled
                partnerPl = await partnerPl.filtered(
                    async (pl) => bool(await pl.countryGroupIds) && (await (await pl.countryGroupIds).mapped('countryIds.code')).includes(countryCode) || !bool(await pl.countryGroupIds)
                );
            }
            pricelists = pricelists.or(partnerPl);
        }
        // This method is cached, must not return records! See also #8795
        return pricelists.ids;
    }

    /**
     * Return the list of pricelists that can be used on website for the current user.
        Country restrictions will be detected with GeoIP (if installed).
        :param bool showVisible: if True, we don't display pricelist where selectable is False (Eg: Code promo)
        :returns: pricelist recordset
     * @param req 
     * @param showVisible 
     * @returns 
     */
    async _getPricelistAvailable(req, showVisible=false) {
        let website = getRequestWebsite(req);
        if (! website) {
            if (this.env.context['websiteId']) {
                website = this.browse(this.env.context['websiteId']);
            }
            else {
                // In the weird case we are coming from the backend (https://github.com/verp/verp/issues/20245)
                website = len(this) == 1 && this;
                website = bool(website) ? website : await this.search([], {limit: 1});
            }
        }
        const isocountry = req && req.session.geoip && req.session.geoip['countryCode'] || false,
        partner = await (await this.env.user()).partnerId,
        lastOrderPl = await (await partner.lastWebsiteSoId).pricelistId,
        partnerPl = await partner.propertyProductPricelist,
        pricelists = await website._getPlPartnerOrder(isocountry, showVisible,
                                                   (await (await await (await (await website.userId).sudo()).partnerId).propertyProductPricelist).id,
                                                   req && req.session.get('websiteSaleCurrentPl') || null,
                                                   await website.pricelistIds,
                                                   bool(partnerPl) && partnerPl.id || null,
                                                   bool(lastOrderPl) && lastOrderPl.id || null);
        return this.env.items('product.pricelist').browse(pricelists);
    }

    async getPricelistAvailable(req, showVisible=false) {
        return this._getPricelistAvailable(req, showVisible);
    }

    /**
     * Return a boolean to specify if a specific pricelist can be manually set on the website.
        Warning: It check only if pricelist is in the 'selectable' pricelists or the current pricelist.
        :param int pl_id: The pricelist id to check
        :returns: Boolean, True if valid / available
     * @param plId 
     * @returns 
     */
    async isPricelistAvailable(plId) {
        return (await this.getPricelistAvailable({showVisible: false})).ids.includes(plId);
    }

    /**
     * :returns: The current pricelist record
     */
    async getCurrentPricelist(req) {
        // The list of available pricelists for this user.
        // If the user is signed in, and has a pricelist set different than the public user pricelist
        // then this pricelist will always be considered as available
        const availablePricelists = await this.getPricelistAvailable(req);
        let pl,
        partner = await (await this.env.user()).partnerId;
        if (req && req.session.get('websiteSaleCurrentPl')) {
            // `websiteSaleCurrentPl` is set only if the user specifically chose it:
            //  - Either, he chose it from the pricelist selection
            //  - Either, he entered a coupon code
            pl = this.env.items('product.pricelist').browse(req.session['websiteSaleCurrentPl']);
            if (!availablePricelists.includes(pl)) {
                pl = null;
                req.session.pop('websiteSaleCurrentPl');
            }
        }
        if (!bool(pl)) {
            // If the user has a saved cart, it take the pricelist of this last unconfirmed cart
            pl = await (await partner.lastWebsiteSoId).pricelistId;
            if (!bool(pl)) {
                // The pricelist of the user set on its partner form.
                // If the user is not signed in, it's the public user pricelist
                pl = await partner.propertyProductPricelist;
            }
            if (bool(availablePricelists) && !availablePricelists.includes(pl)) {
                // If there is at least one pricelist in the available pricelists
                // and the chosen pricelist is not within them
                // it then choose the first available pricelist.
                // This can only happen when the pricelist is the public user pricelist and this pricelist is not in the available pricelist for this localization
                // If the user is signed in, and has a special pricelist (different than the public user pricelist),
                // then this special pricelist is amongs these available pricelists, and therefore it won't fall in this case.
                pl = availablePricelists[0];
            }
        }

        if (!bool(pl)) {
            console.error('Fail to find pricelist for partner "%s" (id %s)', await partner.label, partner.id);
        }
        return pl;
    }

    async saleProductDomain() {
        return [["saleOk", "=", true]].concat(await (await (this as any).getCurrentWebsite()).websiteDomain());
    }

    @api.model()
    async saleGetPaymentTerm(partner) {
        let pt = await (await this.env.ref('account.accountPaymentTermImmediate', false)).sudo();
        if (bool(pt)) {
            pt = (! (await pt.companyId).id || (await this['companyId']).id == (await pt.companyId).id) && pt;
        }
        let res = await partner.propertyPaymentTermId;
        if (!bool(res)) {
            res = pt;
            if (bool(res)) {
                res = await (await this.env.items('account.payment.term').sudo()).search([['companyId', '=', (await this['companyId']).id]], {limit: 1});
            }
        }
        return res.id;
    }

    async _prepareSaleOrderValues(req, partner, pricelist) {
        this.ensureOne();
        const affiliateId = req.session.get('affiliateId'),
        salespersonId = bool(await (await this.env.items('res.users').sudo()).browse(affiliateId).exists()) ? affiliateId : (await req.website.salespersonId).id,
        addr = await partner.addressGet(['delivery']);
        if (! await req.website.isPublicUser()) {
            const lastSaleOrder = await (await this.env.items('sale.order').sudo()).search([['partnerId', '=', partner.id]], {limit: 1, order: "dateOrder desc, id desc"});
            if (lastSaleOrder.ok && await (await lastSaleOrder.partnerShippingId).active) { // first = me
                addr['delivery'] = (await lastSaleOrder.partnerShippingId).id;
            }
        }

        let defaultUserId = (await (await partner.parentId).userId).id;
        defaultUserId = bool(defaultUserId) ? defaultUserId : (await partner.userId).id;

        let teamId = (await this['salesteamId']).id;
        teamId = bool(teamId) ? teamId : (await (await partner.parentId).teamId).id;
        teamId = bool(teamId) ? teamId : (await partner.teamId).id;
        
        let userId = bool(salespersonId) ? salespersonId : (await this['salespersonId']).id;
        userId = bool(userId) ? userId : defaultUserId;
        
        const values = {
            'partnerId': partner.id,
            'pricelistId': pricelist.id,
            'paymentTermId': await this.saleGetPaymentTerm(partner),
            'teamId': teamId,
            'partnerInvoiceId': partner.id,
            'partnerShippingId': addr['delivery'],
            'userId': userId,
            'websiteId': this._context['websiteId'],
            'companyId': (await this['companyId']).id,
        }
        return values;
    }

    /**
     * Return the current sales order after mofications specified by params.
        :param bool force_create: Create sales order if not already existing
        :param str code: Code to force a pricelist (promo code) If empty, it's a special case to reset the pricelist with the first available else the default.
        :param bool update_pricelist: Force to recompute all the lines from sales order to adapt the price with the current pricelist.
        :param int force_pricelist: pricelistId - if set,  we change the pricelist with this one
        :returns: browse record for the current sales order
     * @param forceCreate 
     * @param code 
     * @param updatePricelist 
     * @param forcePricelist 
     * @returns 
     */
    async saleGetOrder(opts: {forceCreate?: boolean, code?: any, updatePricelist?: boolean, forcePricelist?: boolean}={}) {
        this.ensureOne();
        let {forceCreate, code, updatePricelist, forcePricelist} = opts;
        const req = this.env.req;
        const user = await this.env.user(); 
        let partner = await user.partnerId,
        saleOrderId = req.session.get('saleOrderId'),
        checkFpos = false;
        if (! bool(saleOrderId) && ! await user._isPublic()) {
            const lastOrder = await partner.lastWebsiteSoId;
            if (bool(lastOrder)) {
                const availablePricelists = await this.getPricelistAvailable(req);
                // Do not reload the cart of this user last visit if the cart uses a pricelist no longer available.
                saleOrderId = availablePricelists.includes(await lastOrder.pricelistId) && lastOrder.id;
                checkFpos = true;
            }
        }

        // Test validity of the saleOrderId
        let saleOrder = bool(saleOrderId) ? await (await (await this.env.items('sale.order').withCompany((await req.website.companyId).id)).sudo()).browse(saleOrderId).exists() : null;

        // Ignore the current order if a payment has been initiated. We don't want to retrieve the
        // cart and allow the user to update it when the payment is about to confirm it.
        if (bool(saleOrder) && ['pending', 'authorized', 'done'].includes(await (await saleOrder.getPortalLastTransaction()).state)) {
            saleOrder = null;
        }

        // Do not reload the cart of this user last visit if the Fiscal Position has changed.
        if (checkFpos && bool(saleOrder)) {
            const fposId = (
                await (await (await this.env.items('account.fiscal.position').sudo())
                .withCompany((await saleOrder.companyId).id))
                .getFiscalPosition((await saleOrder.partnerId).id, (await saleOrder.partnerShippingId).id)
            ).id;
            if ((await saleOrder.fiscalPositionId).id != fposId) {
                saleOrder = null;
            }
        }
        if (! (bool(saleOrder) || forceCreate || code)) {
            if (req.session.get('saleOrderId')) {
                req.session['saleOrderId'] = null;
            }
            return this.env.items('sale.order');
        }

        let pricelistId;
        if (bool(await this.env.items('product.pricelist').browse(forcePricelist).exists())) {
            pricelistId = forcePricelist;
            req.session['websiteSaleCurrentPl'] = pricelistId;
            updatePricelist = true;
        }
        else {
            pricelistId = req.session.get('websiteSaleCurrentPl') || (await this.getCurrentPricelist(req)).id;
        }

        let self = this;
        if (! this._context['pricelist']) {
            self = await self.withContext({pricelist: pricelistId});
        }
        // cart creation was requested (either explicitly or to configure a promo code)
        if (! bool(saleOrder)) {
            // TODO cache partnerId session
            const pricelist = await self.env.items('product.pricelist').browse(pricelistId).sudo(),
            soData = await self._prepareSaleOrderValues(req, partner, pricelist);
            saleOrder = await (await (await self.env.items('sale.order').withCompany((await req.website.companyId).id)).withUser(global.SUPERUSER_ID)).create(soData);

            // set fiscal position
            if ((await req.website.partnerId).id !== partner.id) {
                await saleOrder.onchangePartnerShippingId();
            }
            else { // For public user, fiscal position based on geolocation
                const countryCode = req.session.geoip['countryCode'];
                if (countryCode) {
                    const env = await req.getEnv();
                    const countryId = (await env.items('res.country').search([['code', '=', countryCode]], {limit: 1})).id;
                    await saleOrder.set('fiscalPositionId', await (await (await env.items('account.fiscal.position').sudo()).withCompany((await req.website.companyId).id))._getFposByRegion(countryId));
                }
                else {
                    // if no geolocation, use the public user fp
                    await saleOrder.onchangePartnerShippingId();
                }
            }
            req.session['saleOrderId'] = saleOrder.id;

            // The order was created with SUPERUSER_ID, revert back to request user.
            saleOrder = await (await saleOrder.withUser(await self.env.user())).sudo();
        }

        // case when user emptied the cart
        if (! req.session.get('saleOrderId')) {
            req.session['saleOrderId'] = saleOrder.id;
        }

        // check for change of pricelist with a coupon
        pricelistId = bool(pricelistId) ? pricelistId : (await partner.propertyProductPricelist).id;

        // check for change of partnerId ie after signup
        if ((await saleOrder.partnerId).id != partner.id && (await req.website.partnerId).id != partner.id) {
            let flagPricelist = false;
            if (pricelistId != (await saleOrder.pricelistId).id) {
                flagPricelist = true;
            }
            const fiscalPosition = (await saleOrder.fiscalPositionId).id;

            // change the partner, and trigger the onchange
            await saleOrder.write({'partnerId': partner.id});
            await (await saleOrder.withContext({notSelfSaleperson: true})).onchangePartnerId();
            await saleOrder.write({'partnerInvoiceId': partner.id});
            await saleOrder.onchangePartnerShippingId(); // fiscal position
            saleOrder['paymentTermId'] = await self.saleGetPaymentTerm(partner);

            // check the pricelist : update it if the pricelist is not the 'forced' one
            const values = {}
            if (bool(await saleOrder.pricelistId)) {
                if ((await saleOrder.pricelistId).id != pricelistId) {
                    values['pricelistId'] = pricelistId;
                    updatePricelist = true;
                }
            }

            // if fiscal position, update the order lines taxes
            if (bool(await saleOrder.fiscalPositionId)) {
                await saleOrder._computeTaxId();
            }

            // if values, then make the SO update
            if (bool(values)) {
                await saleOrder.write(values);
            }
            // check if the fiscal position has changed with the partnerId update
            const recentFiscalPosition = (await saleOrder.fiscalPositionId).id;
            // when buying a free product with public user and trying to log in, SO state is not draft
            if ((flagPricelist || recentFiscalPosition != fiscalPosition) && await saleOrder.state == 'draft') {
                updatePricelist = true;
            }
        }

        if (code && code != await (await saleOrder.pricelistId).code) {
            const codePricelist = await (await self.env.items('product.pricelist').sudo()).search([['code', '=', code]], {limit: 1});
            if (bool(codePricelist)) {
                pricelistId = codePricelist.id;
                updatePricelist = true;
            }
        }
        else if (code != null && await (saleOrder.pricelistId).code && code != await (await saleOrder.pricelistId).code) {
            // code is not None when user removes code and click on "Apply"
            pricelistId = (await partner.propertyProductPricelist).id;
            updatePricelist = true;
        }

        // update the pricelist
        if (updatePricelist) {
            req.session['websiteSaleCurrentPl'] = pricelistId;
            const values = {'pricelistId': pricelistId};
            await saleOrder.write(values);
            for (const line of await saleOrder.orderLine) {
                if (bool(await line.exists())) {
                    await saleOrder._cartUpdate({productId: (await line.productId).id, lineId: line.id, addQty: 0});
                }
            }
        }

        return saleOrder;
    }

    async saleReset() {
        update(this.env.req.session, {
            'saleOrderId': false,
            'websiteSaleCurrentPl': false,
        });
    }

    @api.model()
    async actionDashboardRedirect() {
        if (await (await this.env.user()).hasGroup('sales_team.groupSaleSalesman')) {
            return this.env.items("ir.actions.actions")._forXmlid("website.backendDashboard");
        }
        return _super(Website, this).actionDashboardRedirect();
    }

    async getSuggestedControllers() {
        const suggestedControllers = await _super(Website, this).getSuggestedControllers();
        suggestedControllers.push([await this._t('eCommerce'), await urlFor(this.env.reset, '/shop'), 'website_sale']);
        return suggestedControllers;
    }

    async _searchGetDetails(searchType, order, options) {
        const result = await _super(Website, this)._searchGetDetails(searchType, order, options);
        if (['products', 'productCategoriesOnly', 'all'].includes(searchType)) {
            result.push(await this.env.items('product.public.category')._searchGetDetail(this, order, options));
        }
        if (['products', 'productsOnly', 'all'].includes(searchType)) {
            result.push(await this.env.items('product.template')._searchGetDetail(this, order, options));
        }
        return result;
    }
}

@MetaModel.define()
class WebsiteSaleExtraField extends Model {
    static _module = module;
    static _name = 'website.sale.extra.field';
    static _description = 'E-Commerce Extra Info Shown on product page';
    static _order = 'sequence';

    static websiteId = Fields.Many2one('website');
    static sequence = Fields.Integer({default: 10});
    static fieldId = Fields.Many2one(
        'ir.model.fields',
        {domain: [['modelId.model', '=', 'product.template'], ['ttype', 'in', ['char', 'binary']]]}
    );
    static description = Fields.Char({related: 'fieldId.fieldDescription'});
    static label = Fields.Char({related: 'fieldId.label'});
}
