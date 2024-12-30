import { Fields, api } from "../../../core";
import { MapKey, UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { expression } from "../../../core/osv";
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountPaymentMethodLine extends Model {
    static _module = module;
    static _parents = "account.payment.method.line";

    static paymentAcquirerId = Fields.Many2one({
        comodelName: 'payment.acquirer',
        compute: '_computePaymentAcquirerId',
        store: true
    });
    static paymentAcquirerState = Fields.Selection({
        related: 'paymentAcquirerId.state'
    });

    @api.depends('paymentMethodId')
    async _computePaymentAcquirerId() {
        const acquirers = await (await this.env.items('payment.acquirer').sudo()).search([
            ['provider', 'in', await this.mapped('code')],
            ['companyId', 'in', (await (await this['journalId']).companyId).ids],
        ]);

        // Make sure to pick the active acquirer, if any.
        const acquirersMap = new MapKey(([pro, com]) => String([pro, com.id]));
        for (const acquirer of acquirers) {
            const currentValue = acquirersMap.get(await acquirer('provider', 'companyId'), false);
            if (bool(currentValue) && await currentValue.state !== 'disabled') {
                continue;
            }

            acquirersMap.set(await acquirer('provider', 'companyId'), acquirer);
        }
        for (const line of this) {
            const code = await (await line.paymentMethodId).code;
            const company = await (await line.journalId).companyId;
            await line.set('paymentAcquirerId', acquirersMap.get([code, company], false));
        }
    }

    async _getPaymentMethodDomain() {
        // OVERRIDE
        let domain = await _super(AccountPaymentMethodLine, this)._getPaymentMethodDomain();
        const information = (this as any)._getPaymentMethodInformation()[await this['code']];

        const unique = information['mode'] === 'unique';
        if (unique) {
            const companyIds = await (await (await this.env.items('payment.acquirer').sudo()).search([['provider', '=', await this['code']]])).mapped('companyId');
            if (bool(companyIds)) {
                domain = expression.AND([domain, [['companyId', 'in', companyIds.ids]]]);
            }
        }
        return domain;
    }

    /**
     * Ensure we don't remove an account.payment.method.line that is linked to an acquirer
        in the test or enabled state.
     */
    @api.ondelete(false)
    async _unlinkExceptActiveAcquirer() {
        const activeAcquirer = await (await this['paymentAcquirerId']).filtered(async (acquirer) => ['enabled', 'test'].includes(await acquirer.state));
        if (bool(activeAcquirer)) {
            throw new UserError(await this._t(
                "You can't delete a payment method that is linked to a provider in the enabled "+
                "or test state.\nLinked providers(s): %s",
                (await activeAcquirer.map(a => a.displayName)).join(', '),
            ))
        }
    }

    async actionOpenAcquirerForm() {
        this.ensureOne();
        return {
            'type': 'ir.actions.actwindow',
            'label': this._t('Acquirer'),
            'viewMode': 'form',
            'resModel': 'payment.acquirer',
            'target': 'current',
            'resId': (await this['paymentAcquirerId']).id
        }
    }
}
