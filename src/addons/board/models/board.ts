import { api, Fields } from "../../../core";
import { _super, AbstractModel, MetaModel } from "../../../core/models";
import { bool, getrootXml, iterchildren, parseXml, serializeXml, update } from "../../../core/tools";


@MetaModel.define()
class Board extends AbstractModel {
    static _module = module;
    static _name = 'board.board';
    static _description = "Board";
    static _auto = false;

    // This is necessary for when the web client opens a dashboard. Technically
    // speaking, the dashboard is a form view, and opening it makes the client
    // initialize a dummy record by invoking onchange(). And the latter requires
    // an 'id' field to work properly...
    static id = Fields.Id();

    @api.modelCreateMulti()
    async create(valsList) {
        return this;
    }

    /**
     * Overrides orm fieldViewGet.
     * @returns Dictionary of Fields, arch and toolbar.
     */
    @api.model()
    async fieldsViewGet(viewId?: any, viewType = 'form', toolbar = false, submenu = false) {
        const res = await _super(Board, this).fieldsViewGet(viewId, viewType, toolbar, submenu);

        const customView = await this.env.items('ir.ui.view.custom').search([['userId', '=', this.env.uid], ['refId', '=', viewId]], { limit: 1 });
        if (bool(customView)) {
            Object.assign(res, {
                'customViewId': customView.id,
                'arch': await customView.arch
            });
        }
        Object.assign(res, {
            'arch': await this._archPreprocessing(res['arch']),
            'toolbar': { 'print': [], 'action': [], 'relate': [] }
        });
        return res;
    }

    @api.model()
    async _archPreprocessing(arch) {
        function removeUnauthorizedChildren(node: Element) {
            for (const child of iterchildren(node) as Element[]) {
                if (child.tagName == 'action' && child.getAttribute('invisible')) {
                    node.removeChild(child);
                }
                else {
                    removeUnauthorizedChildren(child);
                }
            }
            return node;
        }

        const archnode = getrootXml(parseXml(arch));
        // add the jsClass 'board' on the fly to force the webclient to
        // instantiate a BoardView instead of FormView
        archnode.setAttribute('jsClass', 'board');
        const result = serializeXml(removeUnauthorizedChildren(archnode), 'unicode', true);
        return result;
    }
}
