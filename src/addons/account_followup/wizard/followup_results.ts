import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class FollowupSendingResults extends TransientModel {
    static _module = module;
    static _name = 'followup.sending.results';
    static _description = 'Results from the sending of the different letters and emails';

    async doReport() {
        return this.env.context['reportData'];
    }

    async doDone() {
        return {};
    }

    async _getDescription() {
        return this.env.context['description'];
    }

    async _getNeedPrinting() {
        return this.env.context['needprinting'];
    }

    static description = Fields.Text("Description", {readonly: true, default: self => self._getDescription()});
    static needprinting = Fields.Boolean("Needs Printing", {default: self => self._getNeedPrinting()});
}