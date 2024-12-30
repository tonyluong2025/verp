import { Environment } from '../../core/api';
import { bool } from '../../core/tools';

export * from './models';
export * from './controllers';
export * from './report';
export * from './wizard';
// export * from './populate';

async function _synchronizeCron(cr, registry) {
    const env = await Environment.new(cr, global.SUPERUSER_ID, {'activeTest': false});
    const sendInvoiceCron = await env.ref('sale.sendInvoiceCron', false);
    if (sendInvoiceCron) {
        const config = await env.items('ir.config.parameter').getParam('sale.automaticInvoice', false);
        await sendInvoiceCron.set('active', bool(config));
    }
}
