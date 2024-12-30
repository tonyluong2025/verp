import { api } from "../../../../core";
import { bool } from "../../../../core/tools/bool";

const FIXED_ACCOUNTS_MAP = {
    '5221': '5211',
    '5222': '5212',
    '5223': '5213'
}

async function _fixRevenueDeductionAccountsCode(env) {
    const vnTemplate = await env.ref('l10n_vn.vnTemplate');
    for (const company of await (await env.items('res.company').withContext({activeTest: false})).search([['chartTemplateId', '=', vnTemplate.id]])) {
        for (const [incorrectCode, correctCode] of Object.entries(FIXED_ACCOUNTS_MAP)) {
            const account = await env.items('account.account').search([['code', '=', incorrectCode], ['companyId', '=', company.id]]);
            if (bool(account)) {
                await account.write({'code': correctCode});
            }
        }
    }
}

async function migrate(cr, version) {
    const env = await api.Environment.new(cr, global.SUPERUSER_ID);
    await _fixRevenueDeductionAccountsCode(env);
}