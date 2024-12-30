import { ServerResponse } from "http";
import { http } from "../../../core";
import { AccessError } from "../../../core/helper";
import { WebRequest } from "../../../core/http";
import { bool, parseInt } from "../../../core/tools";

@http.define()
class BaseSetup extends http.Controller {
    static _module = module;
    
    @http.route('/base_setup/data', {type: 'json', auth: 'user'})
    async baseSetupData(req: WebRequest, res: ServerResponse, opts: {}={}) {
        if (! await (await (await req.getEnv()).user()).hasGroup('base.groupErpManager')) {
            throw new AccessError(await this._t(await req.getEnv(), "Access Denied"));
        }

        const cr = await req.getCr();
        let activeCount = await cr.execute(`
            SELECT COUNT(*)::int
              FROM "resUsers"
            WHERE active=true AND share=false
        `);
        activeCount = parseInt(activeCount[0]['count']);

        let pendingCount = await cr.execute(`
            SELECT COUNT(u.*)::int
            FROM "resUsers" u
            WHERE active=true AND share=false AND NOT exists(SELECT 1 FROM "resUsersLog" WHERE "createdUid"=u.id)
        `);
        pendingCount = parseInt(pendingCount[0]['count']);

        const pendingUsers = await cr.execute(`
            SELECT id, login
            FROM "resUsers" u
            WHERE active=true AND share=false AND NOT exists(SELECT 1 FROM "resUsersLog" WHERE "createdUid"=u.id)
            ORDER BY id desc
            LIMIT 10
        `)
        const actionPendingUsers = await (await req.getEnv()).items('res.users')
            .browse(pendingUsers.map(user => user.id))
            ._actionShow();

        return {
            'activeUsers': activeCount,
            'pendingCount': pendingCount,
            'pendingUsers': pendingUsers,
            'actionPendingUsers': actionPendingUsers,
        }
    }

    @http.route('/base_setup/demoActive', {type: 'json', auth: 'user'})
    async baseSetupIsDemo(req: WebRequest, res: ServerResponse, opts: {}={}) {
        // We assume that if there's at least one module with demo data active, then the db was
        // initialized with demo=true or it has been force-activated by the `Load demo data` button
        // in the settings dashboard.
        const demoActive = bool(await (await req.getEnv()).items('ir.module.module').searchCount([['demo', '=', true]]));
        return demoActive;
    }
}