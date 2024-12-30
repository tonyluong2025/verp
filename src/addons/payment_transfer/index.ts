import { resetPaymentAcquirer } from '../payment';

export * from './controllers';
export * from './models';

async function uninstallHook(cr, registry) {
    await resetPaymentAcquirer(cr, registry, 'transfer');
}
