import { Command, Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountPaymentRegister extends TransientModel {
    static _module = module;
    static _parents = 'account.payment.register';

    // == Business fields ==
    static paymentTokenId = Fields.Many2one({
        comodelName: 'payment.token',
        string: "Saved payment token",
        store: true, readonly: false,
        compute: '_computePaymentTokenId',
        domain: `[
            ['id', 'in', suitablePaymentTokenIds],
        ]`,
        help: "Note that tokens from acquirers set to only authorize transactions (instead of capturing the amount) are not available."});

    // == Display purpose fields ==
    static suitablePaymentTokenIds = Fields.Many2many({
        comodelName: 'payment.token',
        compute: '_computeSuitablePaymentTokenIds'
    });
    static useElectronicPaymentMethod = Fields.Boolean({
        compute: '_computeUseElectronicPaymentMethod',
        help: 'Technical field used to hide or show the paymentTokenId if needed.'
    });
    static paymentMethodCode = Fields.Char({related: 'paymentMethodLineId.code'});

    // -------------------------------------------------------------------------
    // COMPUTE METHODS
    // -------------------------------------------------------------------------

    @api.depends('paymentMethodLineId')
    async _computeSuitablePaymentTokenIds() {
        for (const wizard of this) {
            if (await wizard.canEditWizard && await wizard.useElectronicPaymentMethod) {
                const relatedPartnerIds = (
                        (await wizard.partnerId)
                        .or(await (await wizard.partnerId).commercialPartnerId)
                        .or(await (await (await wizard.partnerId).commercialPartnerId).childIds)
                )._origin;

                await wizard.set('suitablePaymentTokenIds', await (await this.env.items('payment.token').sudo()).search([
                    ['companyId', '=', (await wizard.companyId).id],
                    ['acquirerId.captureManually', '=', false],
                    ['partnerId', 'in', relatedPartnerIds.ids],
                    ['acquirerId', '=', (await (await wizard.paymentMethodLineId).paymentAcquirerId).id],
                ]));
            }
            else {
                await wizard.set('suitablePaymentTokenIds', [Command.clear()]);
            }
        }
    }

    @api.depends('paymentMethodLineId')
    async _computeUseElectronicPaymentMethod() {
        const field = await this.env.models['payment.acquirer']._fields['provider'];
        for (const wizard of this) {
            // Get a list of all electronic payment method codes.
            // These codes are comprised of the providers of each payment acquirer.
            const codes = (await field._descriptionSelection(field, this.env)).map(sel => sel[0]);
            await wizard.set('useElectronicPaymentMethod', codes.includes(await wizard.paymentMethodCode));
        }
    }

    @api.onchange('canEditWizard', 'paymentMethodLineId', 'journalId')
    async _computePaymentTokenId() {
        const field = await this.env.models['payment.acquirer']._fields['provider'];
        const codes = (await field._descriptionSelection(field, this.env)).map(sel => sel[0]);
        for (const wizard of this) {
            const relatedPartnerIds = (
                    (await wizard.partnerId)
                    .or(await (await wizard.partnerId).commercialPartnerId)
                    .or(await (await (await wizard.partnerId).commercialPartnerId).childIds)
            )._origin;
            if (bool(await wizard.canEditWizard) 
                    && codes.includes(await (await wizard.paymentMethodLineId).code)
                    && bool(await wizard.journalId)
                    && bool(relatedPartnerIds)) {
                await wizard.set('paymentTokenId', await (await this.env.items('payment.token').sudo()).search([
                    ['companyId', '=', (await wizard.companyId).id],
                    ['partnerId', 'in', relatedPartnerIds.ids],
                    ['acquirerId.captureManually', '=', false],
                    ['acquirerId', '=', (await (await wizard.paymentMethodLineId).paymentAcquirerId).id],
                ], {limit: 1}));
            }
            else {
                await wizard.set('paymentTokenId', false);
            }
        }
    }

    // -------------------------------------------------------------------------
    // BUSINESS METHODS
    // -------------------------------------------------------------------------

    async _createPaymentValsFromWizard() {
        // OVERRIDE
        const paymentVals = _super(AccountPaymentRegister, this)._createPaymentValsFromWizard();
        paymentVals['paymentTokenId'] = (await this['paymentTokenId']).id;
        return paymentVals;
    }
}
