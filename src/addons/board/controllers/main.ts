import xpath from 'xpath';
import { http } from "../../../core";
import { bool, E, getrootXml, objectToText, parseXml, pop, serializeXml, stringify } from "../../../core/tools";

@http.define()
class Board extends http.Controller {
    static _module = module;

    @http.route('/board/addToDashboard', { type: 'json', auth: 'user' })
    async addToDashboard(req, res, opts: { actionId?: any, contextToSave?: any, domain?: any, viewMode?: string, name?: string}={}) {
        const { actionId, contextToSave, domain, viewMode, name = '' } = opts;
        const env = await req.getEnv();
        // Retrieve the 'My Dashboard' action from its xmlid
        const action = await (await env.ref('board.openBoardMyDashAction')).sudo();

        if (bool(action) && await action.resModel == 'board.board' && (await action.views)[0][1] == 'form' && actionId) {
            // Maybe should check the content instead of model board.board ?
            const viewId = (await action.views)[0][0];
            const board = await env.items('board.board').fieldsViewGet(viewId, 'form');
            if (bool(board) && 'arch' in board) {
                const doc = getrootXml(parseXml(board['arch']));
                const column = xpath.select1('./board/column', doc) as any as Element;
                if (column != null) {
                    // We don't want to save allowedCompanyIds
                    // Otherwise on dashboard, the multi-company widget does not filter the records
                    if ('allowedCompanyIds' in contextToSave) {
                        pop(contextToSave, 'allowedCompanyIds');
                    }
                    const attr = {
                        'label': String(actionId),
                        'string': name,
                        'viewMode': viewMode,
                        'context': objectToText(contextToSave),
                        'domain': objectToText(domain)
                    }
                    const newAction = E.withType('action', attr);
                    column.insertBefore(newAction, column.firstChild);
                    const arch = serializeXml(doc, 'unicode');
                    await env.items('ir.ui.view.custom').create({
                        'userId': req.session.uid,
                        'refId': viewId,
                        'arch': arch
                    })
                    return true;
                }
            }
        }
        return false;
    }
}