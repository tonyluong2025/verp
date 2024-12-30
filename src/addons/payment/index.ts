export * from './controllers';
export * from './models';
export * from './utils';
export * from './wizards';

import { Environment } from "../../core/api"

export async function resetPaymentAcquirer(cr, registry, provider) {
    const env = await Environment.new(cr, global.SUPERUSER_ID);
    const acquirers = await env.items('payment.acquirer').search([['provider', '=', provider]]);
    await acquirers.write({
        'provider': 'none',
        'state': 'disabled',
    })
}