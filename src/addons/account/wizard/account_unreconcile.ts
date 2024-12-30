import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class AccountUnreconcile extends TransientModel {
    static _module = module;
    static _name = "account.unreconcile";
    static _description = "Account Unreconcile";

    async transUnrec() {
        const context = Object.assign({}, this._context);
        if (context['activeIds'] ?? false) {
            this.env.items('account.move.line').browse(context['activeIds'].removeMoveReconcile());
        }
        return {'type': 'ir.actions.actwindow.close'}
    }
}