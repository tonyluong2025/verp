import xpath from "xpath";
import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { bool, extend, floatCompare, len, update } from "../../../core/tools";
import { getrootXml, parseXml } from "../../../core/tools/xml";
import { ValidationError } from "../../../core/helper";
import { generateAccessToken } from "../utils";
import { urlQuote } from "../../../core/service/middleware/utils";

@MetaModel.define()
class PaymentLinkWizard extends TransientModel {
    static _module = module;
    static _name = "payment.link.wizard";
    static _description = "Generate Payment Link";

    @api.model()
    async defaultGet(fields) {
        const res = await (await _super(PaymentLinkWizard, this)).defaultGet(fields);
        const resId = this._context['activeId'];
        const resModel = this._context['activeModel'];
        update(res, {resId, resModel});
        const amountField = resModel === 'account.move' ? 'amountResidual' : 'amountTotal';
        if (resId && resModel === 'account.move') {
            const record = this.env.items(resModel).browse(resId);
            update(res, {
                'description': await record.paymentReference,
                'amount': await record[amountField],
                'currencyId': (await record.currencyId).id,
                'partnerId': (await record.partnerId).id,
                'amountMax': record[amountField],
            });
        }
        return res;
    }

    /**
     * Overrides orm fields_view_get

        Using a Many2One field, when a user opens this wizard and tries to select a preferred
        payment acquirer, he will get an AccessError telling that he is not allowed to access
        'payment.acquirer' records. This error is thrown because the Many2One field is filled
        by the nameGet() function and users don't have clearance to read 'payment.acquirer' records.

        This override allows replacing the Many2One with a selection field, that is prefilled in the
        backend with the name of available acquirers. Therefore, Users will be able to select their
        preferred acquirer.

        :return: composition of the requested view (including inherited views and extensions)
        :rtype: dict
     * @param viewId 
     * @param viewType 
     * @param toolbar 
     * @param submenu 
     * @returns 
     */
    @api.model()
    async fieldsViewGet(...args: any[]) {
        const res = await _super(PaymentLinkWizard, this).fieldsViewGet(...args);
        if (res['type'] === 'form') {
            const doc = getrootXml(parseXml(res['arch']));

            // Replace acquirerId with payment_acquirer_selection in the view
            const acq = xpath.select1('//field[@name="acquirerId"]', doc) as Element;
            acq.setAttribute('name', 'paymentAcquirerSelection');
            acq.setAttribute('widget', 'selection');
            acq.setAttribute('string', await this._t('Force Payment Acquirer'));
            acq.removeAttribute('options');
            acq.removeAttribute('placeholder');

            // Replace acquirerId with payment_acquirer_selection in the fields list
            const [dom, xarch, xfields] = await this.env.items('ir.ui.view').postprocessAndFields(doc, this._name);
            res['dom'] = dom;
            res['arch'] = xarch;
            res['fields'] = xfields;
        }
        return res;
    }

    static resModel = Fields.Char('Related Document Model', {required: true});
    static resId = Fields.Integer('Related Document ID', {required: true});
    static amount = Fields.Monetary({currencyField: 'currencyId', required: true});
    static amountMax = Fields.Monetary({currencyField: 'currencyId'});
    static currencyId = Fields.Many2one('res.currency');
    static partnerId = Fields.Many2one('res.partner');
    static partnerEmail = Fields.Char({related: 'partnerId.email'});
    static link = Fields.Char({string: 'Payment Link', compute: '_computeValues'});
    static description = Fields.Char('Payment Ref');
    static accessToken = Fields.Char({compute: '_computeValues'});
    static companyId = Fields.Many2one('res.company', {compute: '_computeCompany'});
    static availableAcquirerIds = Fields.Many2many({
        comodelName: 'payment.acquirer',
        string: "Payment Acquirers Available",
        compute: '_computeAvailableAcquirerIds',
        computeSudo: true,
    });
    static acquirerId = Fields.Many2one({
        comodelName: 'payment.acquirer',
        string: "Force Payment Acquirer",
        domain: "[['id', 'in', availableAcquirerIds]]",
        help: "Force the customer to pay via the specified payment acquirer. Leave empty to allow the customer to choose among all acquirers."
    });
    static hasMultipleAcquirers = Fields.Boolean({
        string: "Has Multiple Acquirers",
        compute: '_computeHasMultipleAcquirers',
    });
    static paymentAcquirerSelection = Fields.Selection({
        string: "Payment acquirer selected",
        selection: '_selectionPaymentAcquirerSelection',
        default: 'all',
        compute: '_computePaymentAcquirerSelection',
        inverse: '_inversePaymentAcquirerSelection',
        required: true,
    });

    @api.onchange('amount', 'description')
    async _onchangeAmount() {
        const [amountMax, amount] = await this('amountMax','amount')
        if (floatCompare(amountMax, amount, {precisionRounding: await (await this['currencyId']).rounding || 0.01}) == -1) {
            throw new ValidationError(await this._t("Please set an amount smaller than %s.", amountMax));
        }
        if (amount <= 0) {
            throw new ValidationError(await this._t("The value of the payment amount must be positive."));
        }
    }

    @api.depends('amount', 'description', 'partnerId', 'currencyId', 'paymentAcquirerSelection')
    async _computeValues() {
        for (const paymentLink of this) {
            await paymentLink.set('accessToken', await generateAccessToken(this.env,
                (await paymentLink.partnerId).id, await paymentLink.amount, (await paymentLink.currencyId).id
            ));
        }
        // must be called after token generation, obvsly - the link needs an up-to-date token
        await this._generateLink();
    }

    @api.depends('resModel', 'resId')
    async _computeCompany() {
        for (const link of this) {
            const record = this.env.items(await link.resModel).browse(await link.resId);
            await link.set('companyId', 'companyId' in record._fields ? await record.companyId : false);
        }
    }

    @api.depends('companyId', 'partnerId', 'currencyId')
    async _computeAvailableAcquirerIds() {
        for (const link of this) {
            await link.set('availableAcquirerIds', await link._getPaymentAcquirerAvailable());
        }
    }

    @api.depends('acquirerId')
    async _computePaymentAcquirerSelection() {
        for (const link of this) {
            await link.set('paymentAcquirerSelection', bool(await link.acquirerId) ? (await link.acquirerId).id : 'all');
        }
    }

    async _inversePaymentAcquirerSelection() {
        for (const link of this) {
            await link.set('acquirerId', await link.paymentAcquirerSelection != 'all' ? link.paymentAcquirerSelection : false);
        }
    }

    /**
     * 
     */
    async _selectionPaymentAcquirerSelection() {
        const defaults = await this.defaultGet(['resModel', 'resId']);
        const selection = [['all', "All"]];
        const {resModel, resId} = defaults;
        if (resId && ['account.move', "sale.order"].includes(resModel)) {
            // At module install, the selection method is called
            // but the document context isn't specified.
            const relatedDocument = this.env.items(resModel).browse(resId);
            const [company, partner, currency] = await relatedDocument('companyId', 'partnerId', 'currencyId');
            if (resModel === "sale.order") {
                // If the Order contains a recurring product but is not already linked to a
                // subscription, the payment acquirer must support tokenization. The resId allows
                // the overrides of sale_subscription to check this condition.
                extend(selection,
                    await (await this._getPaymentAcquirerAvailable(
                        company.id, partner.id, currency.id,
                    )).nameGet()
                );
            }
            else {
                extend(selection,
                    await (await this._getPaymentAcquirerAvailable(
                        company.id, partner.id, currency.id,
                    )).nameGet()
                );
            }
        }
        return selection;
    }

    /**
     * Select and return the acquirers matching the criteria.

        :param int companyId: The company to which acquirers must belong, as a `res.company` id
        :param int partnerId: The partner making the payment, as a `res.partner` id
        :param int currencyId: The payment currency if known beforehand, as a `res.currency` id
        :return: The compatible acquirers
        :rtype: recordset of `payment.acquirer`
     * @param companyId 
     * @param partnerId 
     * @param currencyId 
     * @returns 
     */
    async _getPaymentAcquirerAvailable(companyId?: number, partnerId?: number, currencyId?: number) {
        return (await this.env.items('payment.acquirer').sudo())._getCompatibleAcquirers(
            bool(companyId) ? companyId : (await this['companyId']).id,
            bool(partnerId) ? partnerId : (await this['partnerId']).id,
            {currencyId: bool(currencyId) ? currencyId : (await this['currencyId']).id}
        );
    }

    @api.depends('availableAcquirerIds')
    async _computeHasMultipleAcquirers() {
        for (const link of this) {
            await link.set('hasMultipleAcquirers', len(await link.availableAcquirerIds) > 1);
        }
    }

    async _generateLink() {
        for (const paymentLink of this) {
            const relatedDocument = this.env.items(await paymentLink.resModel).browse(await paymentLink.resId);
            const baseUrl = await relatedDocument.getBaseUrl();  // Don't generate links for the wrong website
            await paymentLink.set('link', `${baseUrl}/payment/pay \
                   ?reference=${urlQuote(await paymentLink.description)} \
                   &amount=${await paymentLink.amount} \
                   &currencyId=${(await paymentLink.currencyId).id} \
                   &partnerId=${(await paymentLink.partnerId).id} \
                   &companyId=${(await paymentLink.companyId).id} \
                   &invoiceId=${await paymentLink.resId}' \
                   ${"&acquirerId=" + paymentLink.paymentAcquirerSelection != "all" ? await paymentLink.paymentAcquirerSelection : "" } \
                   &accessToken=${await paymentLink.accessToken}`)
        }
    }
}
