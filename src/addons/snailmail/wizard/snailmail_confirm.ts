import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { AbstractModel, MetaModel } from "../../../core/models";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class SnailmailConfirm extends AbstractModel {
    static _module = module;
    static _name = 'snailmail.confirm';
    static _description = 'Snailmail Confirm';

    static modelName = Fields.Char();

    @api.model()
    async showWarning() {
        return !(await this.env.items('ir.config.parameter').sudo()).getParam(f('%s.warningShown', this._name), false);
    }
    
    async actionOpen() {
        const view = await this.env.ref('snailmail.snailmailConfirmView');
        return {
            'label': await this._t('Snailmail'),
            'type': 'ir.actions.actwindow',
            'viewMode': 'form',
            'resModel': this._name,
            'views': [[view.id, 'form']],
            'viewId': view.id,
            'target': 'new',
            'resId': this.id,
            'context': this.env.context
        }
    }

    async actionConfirm() {
        await (await this.env.items('ir.config.parameter').sudo()).setParam(f('%s.warningShown', this._name), true);
        await this._confirm();
        return this._continue();
    }

    async actionCancel() {
        await (await this.env.items('ir.config.parameter').sudo()).setParam(f('%s.warningShown', this._name), true);
        return this._continue();
    }

    /**
    * Called whether the user confirms or cancels posting the letter, e.g. to continue the action
    */
    async _continue() {
        // pass
    }

    /*
    * Called only when the user confirms sending the letter
    */
    async _confirm() {
        // pass
    }
}