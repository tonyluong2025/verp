import { http } from '../../../core';
import { AccessError, MissingError } from '../../../core/helper';
import { WebRequest } from '../../../core/http';
import { isInstance, parseInt } from '../../../core/tools';
import * as portal from '../../portal/controllers';

@http.define()
class CustomerPortal extends portal.CustomerPortal {
    static _module = module;

    @http.route(['/my/orders/<int:orderId>/updateLineDict'], { type: 'json', auth: "public", website: true })
    async updateLineDict(req: WebRequest, res, opts: { lineId?: any, remove?: boolean, unlink?: boolean, orderId?: any, accessToken?: any, inputQuantity?: any } = {}) {
        let orderSudo;
        try {
            orderSudo = await this._documentCheckAccess(req, 'sale.order', opts.orderId, opts.accessToken);
        } catch (e) {
            if (isInstance(e, AccessError, MissingError)) {
                return req.redirect(res, '/my');
            }
            else {
                throw e;
            }
        }

        if (!['draft', 'sent'].includes(await orderSudo.state)) {
            return false;
        }
        const orderLine = (await (await req.getEnv()).items('sale.order.line').sudo()).browse(parseInt(opts.lineId));
        if ((await orderLine.orderId).ne(orderSudo)) {
            return false;
        }

        let quantity;
        if (opts.inputQuantity != false) {
            quantity = opts.inputQuantity;
        }
        else {
            quantity = await orderLine.productUomQty + (opts.remove ? -1 : 1);
        }
        if (opts.unlink || quantity <= 0) {
            await orderLine.unlink();
            return;
        }

        await orderLine.write({ 'productUomQty': quantity });
    }

    @http.route(["/my/orders/<int:orderId>/addOption/<int:optionId>"], { type: 'json', auth: "public", website: true })
    async add(req, res, opts: { orderId?: any, optionId?: any, accessToken?: any } = {}) {
        let orderSudo;
        try {
            orderSudo = await this._documentCheckAccess(req, 'sale.order', opts.orderId, opts.accessToken);
        } catch (e) {
            if (isInstance(e, AccessError, MissingError)) {
                return req.redirect(res, '/my');
            } else {
                throw e;
            }
        }

        const optionSudo = (await (await req.getEnv()).items('sale.order.option').sudo()).browse(opts.optionId);

        if (orderSudo.ne(await optionSudo.orderId)) {
            return req.redirect(res, await orderSudo.getPortalUrl());
        }

        await optionSudo.addOptionToOrder();
    }
}
