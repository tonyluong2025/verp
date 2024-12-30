import { api } from '../../core';

export * from './models';

async function _uninstallResetChanges(cr, registry) {
    const env = await api.Environment.new(cr, global.SUPERUSER_ID);
    await env.items('webeditor.assets').resetAsset(
        '/backend_web_theme/static/src/colors.scss', 
        'web._assetsPrimaryVariables'
    )
}