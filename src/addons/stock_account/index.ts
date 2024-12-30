import { Environment } from '../../core/api';
import { _t, bool } from '../../core/tools';

export * from './models';
export * from './report';
export * from './wizard';

/**
 * Setting journal and property field (if needed)
 * @param cr 
 * @param registry 
 */
async function configureJournals(cr, registry) {
    const env = await Environment.new(cr, global.SUPERUSER_ID);

    // if we already have a coa installed, create journal and set property field
    const companyIds = await env.items('res.company').search([['chartTemplateId', '!=', false]]);
    const todoList = [
        'propertyStockAccountInputCategId',
        'propertyStockAccountOutputCategId',
        'propertyStockValuationAccountId',
    ];
    // Property Stock Accounts
    const categValues = Object.fromEntries(await (await env.items('product.category').search([])).map(category => [category.id, false]));
    for (const company of companyIds) {
        // Check if property exists for stock account journal exists
        const field = await env.items('ir.model.fields')._get("product.category", "propertyStockJournal");
        const properties = await (await env.items('ir.property').sudo()).search([
            ['fieldsId', '=', field.id],
            ['companyId', '=', company.id]]);

        // If not, check if you can find a journal that is already there with the same code, otherwise create one
        if (!bool(properties)) {
            let journalId = (await env.items('account.journal').search([
                ['code', '=', 'STJ'],
                ['companyId', '=', company.id],
                ['type', '=', 'general']], { limit: 1 })).id;
            if (!bool(journalId)) {
                journalId = (await env.items('account.journal').create({
                    'label': await _t('Inventory Valuation'),
                    'type': 'general',
                    'code': 'STJ',
                    'companyId': company.id,
                    'showOnDashboard': false
                })).id;
            }
            await env.items('ir.property')._setDefault(
                'propertyStockJournal',
                'product.category',
                journalId,
                company,
            );
        }
        for (const name of todoList) {
            const account = await company[name];
            if (bool(account)) {
                await env.items('ir.property')._setDefault(
                    name,
                    'product.category',
                    account,
                    company,
                );
            }
            await (await env.items('ir.property').withCompany(company.id))._setMulti(name, 'product.category', categValues, true);
        }
    }
}