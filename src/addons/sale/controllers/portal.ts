import { _Date, _Datetime, Command, http } from "../../../core"
import { AccessError, MapKey, MissingError, ValidationError } from "../../../core/helper";
import { bool, f, isInstance, pop, update } from "../../../core/tools";
import { checkAccessToken } from "../../payment";
import * as paymentPortal from '../../payment/controllers/portal'; 
import * as portal from '../../portal/controllers';
import { pager as portalPager } from '../../portal/controllers';

@http.define()
class CustomerPortal extends portal.CustomerPortal {
    static _module = module;

    async _prepareHomePortalValues(req, counters) {
        const values = await super._prepareHomePortalValues(req, counters);
        const env = await req.getEnv();
        const partner = await (await env.user()).partnerId;

        const saleOrder = env.items('sale.order');
        if ('quotationCount' in counters) {
            values['quotationCount'] = await saleOrder.checkAccessRights('read', false) ? await saleOrder.searchCount(await this._prepareQuotationsDomain(partner)) : 0;
        }
        if ('orderCount' in counters) {
            values['orderCount'] = await saleOrder.checkAccessRights('read', false) ? await saleOrder.searchCount(await this._prepareOrdersDomain(partner)) : 0;
        }

        return values;
    }

    async _prepareQuotationsDomain(partner) {
        return [
            ['messagePartnerIds', 'childOf', [(await partner.commercialPartnerId).id]],
            ['state', 'in', ['sent', 'cancel']]
        ];
    }

    async _prepareOrdersDomain(partner) {
        return [
            ['messagePartnerIds', 'childOf', [(await partner.commercialPartnerId).id]],
            ['state', 'in', ['sale', 'done']]
        ];
    }

    //
    // Quotations and Sales Orders
    //

    async _getSaleSearchbarSortings() {
        return {
            'date': {'label': await this._t('Order Date'), 'order': 'dateOrder desc'},
            'label': {'label': await this._t('Reference'), 'order': 'label'},
            'stage': {'label': await this._t('Stage'), 'order': 'state'},
        }
    }

    @http.route(['/my/quotes', '/my/quotes/page/<int:page>'], {type: 'http', auth: "user", website: true})
    async portalMyQuotes(req, res, post: { page?: any, dateBegin?: any, dateEnd?: any, sortby?: any}={}) {
        let { page, dateBegin, dateEnd, sortby} = post;
        page = page ?? 1;
        const values = await this._preparePortalLayoutValues(req);
        const env = await req.getEnv();
        const partner = await (await env.user()).partnerId;
        const saleOrder = env.items('sale.order');

        let domain = await this._prepareQuotationsDomain(partner);

        const searchbarSortings = await this._getSaleSearchbarSortings();

        // default sortby order
        if (! sortby) {
            sortby = 'date';
        }
        const sortOrder = searchbarSortings[sortby]['order'];

        if (dateBegin && dateEnd) {
            domain = domain.concat([['createdAt', '>', dateBegin], ['createdAt', '<=', dateEnd]]);
        }

        // count for pager
        const quotationCount = await saleOrder.searchCount(domain);
        // make pager
        const pager = portalPager({
            url: "/my/quotes",
            urlArgs: {'dateBegin': dateBegin, 'dateEnd': dateEnd, 'sortby': sortby},
            total: quotationCount,
            page: page,
            step: this._itemsPerPage
        });
        // search the count to display, according to the pager data
        const quotations = await saleOrder.search(domain, {order: sortOrder, limit: this._itemsPerPage, offset: pager['offset']});
        req.session['myQuotationsHistory'] = quotations.ids.slice(0, 100);

        update(values, {
            'date': dateBegin,
            'quotations': await quotations.sudo(),
            'pageName': 'quote',
            'pager': pager,
            'defaultUrl': '/my/quotes',
            'searchbarSortings': searchbarSortings,
            'sortby': sortby,
        });
        return req.render(res, "sale.portalMyQuotations", values);
    }

    @http.route(['/my/orders', '/my/orders/page/<int:page>'], {type: 'http', auth: "user", website: true})
    async portalMyOrders(req, res, post: { page?: any, dateBegin?: any, dateEnd?: any, sortby?: any}={}) {
        let { page, dateBegin, dateEnd, sortby} = post;
        page = page ?? 1;
        const values = await this._preparePortalLayoutValues(req);
        const env = await req.getEnv();
        const partner = await (await env.user()).partnerId;
        const saleOrder = env.items('sale.order');

        let domain = await this._prepareOrdersDomain(partner);

        const searchbarSortings = await this._getSaleSearchbarSortings();

        // default sortby order
        if (! sortby) {
            sortby = 'date';
        }
        const sortOrder = searchbarSortings[sortby]['order'];

        if (dateBegin && dateEnd) {
            domain = domain.concat([['createdAt', '>', dateBegin], ['createdAt', '<=', dateEnd]]);
        }
        // count for pager
        const orderCount = await saleOrder.searchCount(domain);
        // pager
        const pager = portalPager({
            url: "/my/orders",
            urlArgs: {'dateBegin': dateBegin, 'dateEnd': dateEnd, 'sortby': sortby},
            total: orderCount,
            page: page,
            step: this._itemsPerPage
        });
        // content according to pager
        const orders = await saleOrder.search(domain, {order: sortOrder, limit: this._itemsPerPage, offset: pager['offset']});
        req.session['myOrdersHistory'] = orders.ids.slice(0, 100);

        update(values, {
            'date': dateBegin,
            'orders': await orders.sudo(),
            'pageName': 'order',
            'pager': pager,
            'defaultUrl': '/my/orders',
            'searchbarSortings': searchbarSortings,
            'sortby': sortby,
        });
        return req.render(res, "sale.portalMyOrders", values);
    }

    @http.route(['/my/orders/<int:orderId>'], {type: 'http', auth: "public", website: true})
    async portalOrderPage(req, res, post: {orderId?: any, reportType?: any, accessToken?: any, message?: boolean, download?: boolean}={}) {
        const {orderId, reportType, accessToken, message, download} = post;
        let orderSudo;
        try {
            orderSudo = await this._documentCheckAccess(req, 'sale.order', orderId, accessToken);
        } catch(e) {
            if (isInstance(e, AccessError, MissingError)) {
                return req.redirect(req, '/my');
            }
            else {
                throw e;
            }
        }
        if (['html', 'pdf', 'text'].includes(reportType)) {
            return this._showReport(req, res, orderSudo, reportType, 'sale.actionReportSaleorder', download);
        }
        // use sudo to allow accessing/viewing orders for public user
        // only if he knows the private token
        // Log only once a day
        const env = await req.getEnv();
        const user = await env.user();
        if (bool(orderSudo)) {
            // store the date as a string in the session to allow serialization
            const now = _Date.today();//.isoformat()
            const sessionObjDate = req.session.get(f('viewQuote_%s', orderSudo.id));
            if (sessionObjDate != now && await user.share && accessToken) {
                req.session[f('viewQuote_%s', orderSudo.id)] = now;
                const body = await this._t('Quotation viewed by customer %s', await user._isPublic() ? await (await orderSudo.partnerId).label : await (await user.partnerId).label);
                await portal._messagePostHelper(req, {
                    resModel: "sale.order",
                    resId: orderSudo.id,
                    message: body,
                    token: await orderSudo.accessToken,
                    messageType: "notification",
                    subtypeXmlid: "mail.mt_note",
                    partnerIds: (await (await (await orderSudo.userId).sudo()).partnerId).ids,
                });
            }
        }

        const values = {
            'saleOrder': orderSudo,
            'message': message,
            'token': accessToken,
            'landingRoute': '/shop/payment/validate',
            'bootstrapFormatting': true,
            'partnerId': (await orderSudo.partnerId).id,
            'reportType': 'html',
            'action': await orderSudo._getPortalReturnAction(),
        }
        if (bool(await orderSudo.companyId)) {
            values['resCompany'] = await orderSudo.companyId;
        }
        // Payment values
        if (await orderSudo.hasToBePaid()) {
            const loggedIn = ! await user._isPublic();

            let acquirersSudo = await (await env.items('payment.acquirer').sudo())._getCompatibleAcquirers(
                (await orderSudo.companyId).id,
                (await orderSudo.partnerId).id,
                {currencyId: (await orderSudo.currencyId).id,
                saleOrderId: orderSudo.id,}
            );  // In sudo mode to read the fields of acquirers and partner (if not logged in)
            let tokens = loggedIn ? await env.items('payment.token').search([
                ['acquirerId', 'in', acquirersSudo.ids],
                ['partnerId', '=', (await orderSudo.partnerId).id]
            ]) : env.items('payment.token');

            // Make sure that the partner's company matches the order's company.
            if (! paymentPortal.PaymentPortal._canPartnerPayInCompany(
                await orderSudo.partnerId, await orderSudo.companyId
            )) {
                acquirersSudo = await env.items('payment.acquirer').sudo();
                tokens = env.items('payment.token');
            }
            const feesByAcquirer = new MapKey();
            for (const acquirer of await acquirersSudo.filtered('feesActive')) {
                feesByAcquirer.set(acquirer, await acquirer._computeFees(
                    await orderSudo.amountTotal,
                    await orderSudo.currencyId,
                    await (await orderSudo.partnerId).countryId,
                ));
            }
            // Prevent public partner from saving payment methods but force it for logged in partners
            // buying subscription products
            const showTokenizeInput = loggedIn 
                && ! await (await env.items('payment.acquirer').sudo())._isTokenizationRequired({
                    saleOrderId: orderSudo.id
                });
            update(values, {
                'acquirers': acquirersSudo,
                'tokens': tokens,
                'feesByAcquirer': feesByAcquirer,
                'showTokenizeInput': showTokenizeInput,
                'amount': await orderSudo.amountTotal,
                'currency': await (await orderSudo.pricelistId).currencyId,
                'partnerId': (await orderSudo.partnerId).id,
                'accessToken': await orderSudo.accessToken,
                'transactionRoute': await orderSudo.getPortalUrl({suffix: '/transaction'}),
                'landingRoute': await orderSudo.getPortalUrl(),
            });
        }
        if (['draft', 'sent', 'cancel'].includes(await orderSudo.state)) {
            history = req.session.get('myQuotationsHistory', []);
        }
        else {
            history = req.session.get('my_orders_history', []);
        }
        update(values, await portal.getRecordsPager(history, orderSudo));

        return req.render(res, 'sale.saleOrderPortalTemplate', values);
    }

    @http.route(['/my/orders/<int:orderId>/accept'], {type: 'json', auth: "public", website: true})
    async portalQuoteAccept(req, res, post: {orderId?: any, accessToken?: any, label?: any, signature?: any}={}) {
        // get from query string if not on json param
        const accessToken = post.accessToken || req.httpRequest.params.get('accessToken');
        let orderSudo;
        const env = await req.getEnv();
        try {
            orderSudo = await this._documentCheckAccess(req, 'sale.order', post.orderId, accessToken);
        } catch(e) {
            if (isInstance(e, AccessError, MissingError)) {
                return {'error': await this._t(env, 'Invalid order.')}
            }
        }

        if (! await orderSudo.hasToBeSigned()) {
            return {'error': await this._t(env, 'The order is not in a state requiring customer signature.')};
        }
        if (! post.signature) {
            return {'error': await this._t(env, 'Signature is missing.')}
        }

        try {
            await orderSudo.write({
                'signed_by': post.label,
                'signed_on': _Datetime.now(),
                'signature': post.signature,
            });
            await env.cr.commit();
        } catch(e) {
            return {'error': await this._t(env, 'Invalid signature data.')}
        }

        if (! await orderSudo.hasToBePaid()) {
            await orderSudo.actionConfirm();
            await orderSudo._sendOrderConfirmationMail();
        }

        const pdf = (await (await (await env.ref('sale.actionReportSaleorder')).withUser(global.SUPERUSER_ID))._renderQwebPdf([orderSudo.id]))[0];

        await portal._messagePostHelper(req, {
            resModel: 'sale.order', resId: orderSudo.id, message: await this._t(env, f('Order signed by %s', post.label)),
            attachments: [[f('%s.pdf', await orderSudo.label), pdf]],
            ...(post.accessToken ? {'token': accessToken} : {})
        });
        let queryString = '&message=signOk';
        if (await orderSudo.hasToBePaid(true)) {
            queryString += '#allowPayment=yes';
        }
        return {
            'forceRefresh': true,
            'redirectUrl': await orderSudo.getPortalUrl({queryString}),
        }
    }

    @http.route(['/my/orders/<int:orderId>/decline'], {type: 'http', auth: "public", methods: ['POST'], website: true})
    async decline(req, res, post: {orderId?: any, accessToken?: any}={}) {
        let orderSudo;
        try {
            orderSudo = await this._documentCheckAccess(req, 'sale.order', post.orderId, post.accessToken);
        } catch(e) {
            if (isInstance(e, AccessError, MissingError)) {
                return req.redirect(res, '/my');
            } else {
                throw e;
            }
        }
        const message = post['declineMessage'];

        let queryString;
        if (await orderSudo.hasToBeSigned() && message) {
            await orderSudo.actionCancel();
            portal._messagePostHelper(req, {
                resModel: 'sale.order', 
                resId: post.orderId, 
                message, 
                ...(post.accessToken ? {'token': post.accessToken} : {})
            });
        }
        else {
            queryString = "&message=cantReject";
        }
        return req.redirect(res, await orderSudo.getPortalUrl({queryString}));
    }
}

@http.define()
class PaymentPortal extends paymentPortal.PaymentPortal {
    static _module = module;

    /**
     * Create a draft transaction and return its processing values.

        :param int orderId: The sales order to pay, as a `sale.order` id
        :param str accessToken: The access token used to authenticate the request
        :param dict kwargs: Locally unused data passed to `_create_transaction`
        :return: The mandatory values for the processing of the transaction
        :rtype: dict
        :raise: ValidationError if the invoice id or the access token is invalid
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/my/orders/<int:orderId>/transaction', {type: 'json', auth: 'public'})
    async portalOrderTransaction(req, res, post: {orderId?: any, accessToken?: any}={}) {
        // Check the order id and the access token
        let orderSudo;
        try {
            orderSudo = await this._documentCheckAccess(req, 'sale.order', post.orderId, post.accessToken);
        } catch(e) {
            if (isInstance(e, MissingError)) {
                throw e;
            }
            if (isInstance(e, AccessError)) {
                throw new ValidationError("The access token is invalid.");
            }
        }
        update(post, {
            'referencePrefix': null,  // Allow the reference to be computed based on the order
            'partnerId': (await orderSudo.partnerInvoiceId).id,
            'saleOrderId': post.orderId,  // Include the SO to allow Subscriptions tokenizing the tx
        });
        pop(post, 'customCreateValues', null);  // Don't allow passing arbitrary create values
        const txSudo = await this._createTransaction(req, {
            ...post,
            customCreateValues: {'saleOrderIds': [Command.set([post.orderId])]},
        });

        return txSudo._getProcessingValues();
    }

    // Payment overrides

    /**
     * Override of payment to replace the missing transaction values by that of the sale order.

        This is necessary for the reconciliation as all transaction values, excepted the amount,
        need to match exactly that of the sale order.

        :param str amount: The (possibly partial) amount to pay used to check the access token
        :param str saleOrderId: The sale order for which a payment id made, as a `sale.order` id
        :param str accessToken: The access token used to authenticate the partner
        :return: The result of the parent method
        :rtype: str
        :raise: ValidationError if the order id is invalid
     * @param req 
     * @param res 
     * @param post 
     * @returns 
     */
    @http.route()
    async paymentPay(req, res, post: {args?: any, amount?: any, saleOrderId?: any, accessToken?: any}={}) {
        // Cast numeric parameters as int or float and void them if their str value is malformed
        const amount = this._castAsFloat(post.amount);
        const saleOrderId = this._castAsInt(post.saleOrderId);
        if (saleOrderId) {
            const env  = await req.getEnv();
            const orderSudo = await (await env.items('sale.order').sudo()).browse(saleOrderId).exists();
            if (! bool(orderSudo)) {
                throw new ValidationError(await this._t(env, "The provided parameters are invalid."));
            }

            // Check the access token against the order values. Done after fetching the order as we
            // need the order fields to check the access token.
            if (! await checkAccessToken(
                req, post.accessToken, (await orderSudo.partnerInvoiceId).id, amount, (await orderSudo.currencyId).id
            )) {
                throw new ValidationError(await this._t(env, "The provided parameters are invalid."));
            }

            update(post, {
                'currencyId': (await orderSudo.currencyId).id,
                'partnerId': (await orderSudo.partnerInvoiceId).id,
                'companyId': (await orderSudo.companyId).id,
                'saleOrderId': saleOrderId,
            });
        }
        return super.paymentPay(req, res, {...post, amount});
    }

    /**
     * Override of payment to add the sale order id in the custom rendering context values.

        :param int sale_order_id: The sale order for which a payment id made, as a `sale.order` id
        :return: The extended rendering context values
        :rtype: dict
     * @param opts 
     * @returns 
     */
    async _getCustomRenderingContextValues(env, opts: {saleOrderId?: any}={}) {
        const renderingContextValues = await super._getCustomRenderingContextValues(env, opts);
        if (opts.saleOrderId) {
            renderingContextValues['saleOrderId'] = opts.saleOrderId;
        }
        return renderingContextValues;
    }

    /**
     * Override of payment to add the sale order id in the custom create values.

        :param int sale_order_id: The sale order for which a payment id made, as a `sale.order` id
        :param dict custom_create_values: Additional create values overwriting the default ones
        :return: The result of the parent method
        :rtype: recordset of `payment.transaction`
     * @param req 
     * @param opts 
     */
    async _createTransaction(req, opts: any={}) {
        let customCreateValues = opts.customCreateValues;
        if (opts.saleOrderId) {
            if (customCreateValues == null) {
                customCreateValues = {};
            }
            // As this override is also called if the flow is initiated from sale or website_sale, we
            // need not to override whatever value these modules could have already set
            if (!('saleOrderIds' in opts.customCreateValues)) { // We are in the payment module's flow
                customCreateValues['saleOrderIds'] = [Command.set([parseInt(opts.saleOrderId)])];
            }
        }
        return super._createTransaction(
            req, {...opts, customCreateValues}
        );
    }
}
