export async function _postInitHook(cr) {
    const { Environment } = require('../../core/api');
    const env = await Environment.new(cr, global.SUPERUSER_ID);
    await (await env.ref('l10n_vn.vnTemplate')).processCoaTranslations();
}