import { Environment } from '../../core/api';
import { bool } from '../../core/tools';

export * from './controllers';
export * from './models';
export * from './wizard';
export * from './report';

async function _postInitHook(cr, registry) {
    const env = await Environment.new(cr, global.SUPERUSER_ID);
    const parameter = env.items('ir.config.parameter');
    const termsConditions = await parameter.getParam('account.useInvoiceTerms');
    if (!bool(termsConditions)) {
        await parameter.setParam('account.useInvoiceTerms', true);
    }
    const companies = await env.items('res.company').search([]);
    for (const company of companies) {
        await company.set('termsType', 'html');
    }
}

/**
 * Need to reenable the `product` pricelist multi-company rule that were
        disabled to be 'overridden' for multi-website purpose
 * @param cr 
 * @param registry 
 */
async function uninstallHook(cr, registry) {
    const env = await Environment.new(cr, global.SUPERUSER_ID);
    const plRule = await env.ref('product.productPricelistCompRule', false);
    const plItemRule = await env.ref('product.productPricelistItemCompRule', false);
    let multiCompanyRules = bool(plRule) ? plRule : env.items('ir.rule');
    if (bool(plItemRule)) {
        multiCompanyRules = multiCompanyRules.add(plItemRule);
    }
    await multiCompanyRules.write({'active': true});
}