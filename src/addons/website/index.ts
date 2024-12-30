import { Environment } from '../../core/api';
import { Registry } from '../../core/modules/registry';
import { Cursor } from '../../core/sql_db';
import { doWith, partial } from '../../core/tools';

export * from './controllers'
export * from './models';
export * from './wizard';

async function uninstallHook(cr: Cursor, registry: Registry) {
    // Force remove ondelete='CASCADE' elements,
    // This might be prevented by another ondelete='RESTRICT' field
    // TODO: This should be an Verp generic fix, not a website specific one
    const env = await Environment.new(cr, global.SUPERUSER_ID, {});
    const websiteDomain = [['websiteId', '!=', false]];
    await (await env.items('ir.asset').search(websiteDomain)).unlink();
    await (await (await env.items('ir.ui.view').search(websiteDomain)).withContext({activeTest: false, _forceUnlink: true})).unlink();

    // Cleanup records which are related to websites and will not be autocleaned
    // by the uninstall operation. This must be done here in the uninstall_hook
    // as during an uninstallation, `unlink` is not called for records which were
    // created by the user (not XML data).
    await (await env.items('website').search([]))._removeAttachmentsOnWebsiteUnlink();

    // Properly unlink websiteId from ir.model.fields
    async function remWebsiteIdNull(dbname) {
        const dbRegistry = await Registry.new(dbname);
        const cr = dbRegistry.cursor();
        await doWith(cr, async () => {
            const env = await Environment.new(cr, global.SUPERUSER_ID, {});
            await (await env.items('ir.model.fields').search([
                ['label', '=', 'websiteId'],
                ['model', '=', 'res.config.settings'],
            ])).unlink();
        });
    }
    cr.postcommit.add(partial(remWebsiteIdNull, cr.dbName));
}

async function postInitHook(cr: Cursor, registry: Registry) {
    const env = await Environment.new(cr, global.SUPERUSER_ID, {});
    await env.items('ir.module.module').updateThemeImages();
}