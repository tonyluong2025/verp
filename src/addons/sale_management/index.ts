import { Environment } from '../../core/api';

export * from './models';
export * from './controllers';

async function uninstallHook(cr, registry) {
    const env = await Environment.new(cr, global.SUPERUSER_ID);
    const resIds = await (await env.items('ir.model.data').search([
        ['model', '=', 'ir.ui.menu'],
        ['module', '=', 'sale']
    ])).mapped('resId');
    await env.items('ir.ui.menu').browse(resIds).update({'active': false});
}

async function postInitHook(cr, registry) {
    const env = await Environment.new(cr, global.SUPERUSER_ID);
    const resIds = await (await env.items('ir.model.data').search([
        ['model', '=', 'ir.ui.menu'],
        ['module', '=', 'sale']
    ])).mapped('resId');
    await env.items('ir.ui.menu').browse(resIds).update({'active': true});
}
