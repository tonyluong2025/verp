import { http } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { bool, f, parseFloat, parseInt, pop, stringify, update } from "../../../core/tools";
import { generateAccessToken } from "../../payment";
import * as portal from '../../payment/controllers/portal';

@http.define()
class PaymentPortal extends portal.PaymentPortal {
    static _module = module;

    /**
     * Behaves like PaymentPortal.payment_pay but for donation

        :param dict kwargs: As the parameters of in payment_pay, with the additional:
            - str donation_options: The options settled in the donation snippet
            - str donation_descriptions: The descriptions for all prefilled amounts
        :return: The rendered donation form
        :rtype: str
        :raise: theveb.exceptions.NotFound if the access token is invalid
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/donation/pay', {type: 'http', methods:['GET', 'POST'], auth:'public', website: true, sitemap: false})
    async donationPay(req, res, opts={}) {
        const env = await req.getEnv();
        opts['isDonation'] = true;
        opts['currencyId'] = parseInt(opts['currencyId'] ?? (await (await env.company).currencyId).id);
        opts['amount'] = parseFloat(opts['amount'] ?? 25);
        opts['donationOptions'] = opts['donationOptions'] ?? stringify({customAmount: "freeAmount"});

        const user = await env.user();
        if (await user._isPublic()) {
            opts['partnerId'] = (await user.partnerId).id;
            opts['accessToken'] = await generateAccessToken(env, opts['partnerId'], opts['amount'], opts['currencyId']);
        }

        return this.paymentPay(req, res, opts);
    }

    @http.route('/donation/getAcquirerFees', {type: 'json', auth: 'public', website: true, sitemap: false})
    async getAcquirerFees(req, res, opts: {acquirerIds?: any, amount?: any, currencyId?: any, countryId?: any}={}) {
        const env = await req.getEnv(),
        acquirersSudo = (await env.items('payment.acquirer').sudo()).browse(opts.acquirerIds),
        currency = env.items('res.currency').browse(opts.currencyId),
        country = env.items('res.country').browse(opts.countryId);

        // Compute the fees taken by acquirers supporting the feature
        const feesByAcquirer = Object.fromEntries(await (await acquirersSudo.filtered('feesActive')).map(async (acqSudo) => [acqSudo.id, await acqSudo._computeFees(opts.amount, currency, country)]));
        return feesByAcquirer;
    }

    @http.route('/donation/transaction/<minimumAmount>', {type: 'json', auth: 'public', website: true, sitemap: false})
    async donationTransaction(req, res, opts: {amount?: any, currencyId?: any, partnerId?: any, accessToken?: any, minimumAmount?: number}={}) {
        if (parseFloat(opts.amount) < parseFloat(opts.minimumAmount)) {
            throw new ValidationError(await this._t('Donation amount must be at least %.2f.', parseFloat(opts.minimumAmount)));
        }
        const env = await req.getEnv(),
        user = await env.user(),
        usePublicPartner = await user._isPublic() || !bool(opts.partnerId);
        let details;
        if (usePublicPartner) {
            details = opts['partnerDetails'];
            if (! details['label']) {
                throw new ValidationError(await this._t('Label is required.'));
            }
            if (! details['email']) {
                throw new ValidationError(await this._t('Email is required.'));
            }
            if (! details['countryId']) {
                throw new ValidationError(await this._t('Country is required.'));
            }
            opts.partnerId = (await (await req.website.userId).partnerId).id;
            delete opts['partnerDetails'];
        }
        else {
            opts.partnerId = (await user.partnerId).id;
        }
        pop(opts, 'customCreateValues', null);  // Don't allow passing arbitrary create values
        const txSudo = await this._createTransaction(req, opts);
        await txSudo.set('isDonation', true);
        if (usePublicPartner) {
            await txSudo.update({
                'partnerName': details['label'],
                'partnerEmail': details['email'],
                'partnerCountryId': details['countryId'],
            });
        }
        else if (! bool(await txSudo.partnerCountryId)) {
            await txSudo.set('partnerCountryId', opts['partnerDetails']['countryId']);
        }
        // the user can change the donation amount on the payment page,
        // therefor we need to recompute the accessToken
        const accessToken = await generateAccessToken(
            env, (await txSudo.partnerId).id, await txSudo.amount, (await txSudo.currencyId).id
        );
        await this._updateLandingRoute(env, txSudo, accessToken);

        // Send a notification to warn that a donation has been made
        const recipientEmail = opts['donationRecipientEmail'],
        comment = opts['donationComment'];
        await txSudo._sendDonationEmail(true, comment, recipientEmail);

        return txSudo._getProcessingValues();
    }

    async _getCustomRenderingContextValues(env, opts: {donationOptions?: any, donationDescriptions?: any, isDonation?: boolean}={}) {
        const renderingContext = await super._getCustomRenderingContextValues(env, opts);
        if (opts.isDonation) {
            const userSudo = await env.user();
            const loggedIn = ! await userSudo._isPublic();
            // If the user is logged in, take their partner rather than the partner set in the params.
            // This is something that we want, since security rules are based on the partner, and created
            // tokens should not be assigned to the public user. This should have no impact on the
            // transaction itself besides making reconciliation possibly more difficult (e.g. The
            // transaction and invoice partners are different).
            let partnerSudo = await userSudo.partnerId,
            partnerDetails = {},
            countries = env.items('res.country');
            if (loggedIn) {
                partnerDetails = {
                    'label': await partnerSudo.label,
                    'email': await partnerSudo.email,
                    'countryId': (await partnerSudo.countryId).id,
                }
            }

            countries = await (await env.items('res.country').sudo()).search([]);
            const descriptions = env.req.httpRequest.form.getlist('donationDescriptions');

            const donationOptions = opts.donationOptions ? JSON.parse(opts.donationOptions) : {},
            donationAmounts = JSON.parse(donationOptions['donationAmounts'] ?? '[]');

            update(renderingContext, {
                'isDonation': true,
                'partner': partnerSudo,
                'transactionRoute': f('/donation/transaction/%s', donationOptions['minimumAmount'] ?? 0),
                'partnerDetails': partnerDetails,
                'error': {},
                'countries': countries,
                'donationOptions': donationOptions,
                'donationAmounts': donationAmounts,
                'donationDescriptions': descriptions,
            });
        }
        return renderingContext;
    }

    async _getPaymentPageTemplateXmlid(opts) {
        if (opts('isDonation')) {
            return 'website_payment.donation_pay';
        }
        return super._getPaymentPageTemplateXmlid(opts);
    }
}