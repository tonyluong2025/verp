import { Command, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountJournal extends Model {
    static _module = module;
    static _parents = "account.journal";

    async _getAvailablePaymentMethodLines(paymentType) {
        const lines = await _super(AccountJournal, this)._getAvailablePaymentMethodLines(paymentType);

        return lines.filtered(async (l) => await l.paymentAcquirerState !== 'disabled');
    }

    @api.depends('outboundPaymentMethodLineIds', 'inboundPaymentMethodLineIds')
    async _computeAvailablePaymentMethodIds() {
        await _super(AccountJournal, this)._computeAvailablePaymentMethodIds();

        const installedAcquirers = await (await this.env.items('payment.acquirer').sudo()).search([]);
        const methodInformation = await this.env.items('account.payment.method')._getPaymentMethodInformation();
        const payMethods = await this.env.items('account.payment.method').search([['code', 'in', Object.keys(methodInformation)]]);
        const payMethodByCode = Object.fromEntries(await payMethods.map(async (x) => [[await x.code + await x.paymentType], x]));

        // On top of the basic filtering, filter to hide unavailable acquirers.
        // This avoid allowing payment method lines linked to an acquirer that has no record.
        for (const [code, vals] of Object.entries(methodInformation)) {
            const paymentMethod = payMethodByCode[code + 'inbound'];

            if (! paymentMethod) {
                continue;
            }

            for (const journal of this) {
                const toRemove = [];

                const availableProviders = await (await installedAcquirers.filtered(
                    async (a) => (await a.companyId).eq(await journal.companyId)
                )).mapped('provider');
                const available = availableProviders.includes(await paymentMethod.code);

                if (vals['mode'] === 'unique' && !available) {
                    toRemove.push(paymentMethod.id);
                }

                await journal.set('availablePaymentMethodIds', toRemove.map(paymentMethod => Command.unlink(paymentMethod)));
            }
        }
    }

    @api.ondelete(false)
    async _unlinkExceptLinkedToPaymentAcquirer() {
        const linkedAcquirers = await (await (await this.env.items('payment.acquirer').sudo()).search([])).filtered(
            async (acq) => this.ids.includes((await acq.journalId).id) && await acq.state !== 'disabled'
        );
        if (bool(linkedAcquirers)) {
            throw new UserError(await this._t(
                "You must first deactivate a payment acquirer before deleting its journal.\n"+
                "Linked acquirer(s): %s", (await linkedAcquirers.map(acq => acq.displayName)).join(', ')
            ));
        }
    }
}