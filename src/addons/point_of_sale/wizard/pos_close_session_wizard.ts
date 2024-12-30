import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class PosCloseSessionWizard extends TransientModel {
    static _module = module;
    static _name = "pos.close.session.wizard";
    static _description = "Close Session Wizard";

    static amountToBalance = Fields.Float("Amount to balance");
    static accountId = Fields.Many2one("account.account", {string: "Destination account"});
    static accountReadonly = Fields.Boolean("Destination account is readonly");
    static message = Fields.Text("Information message");

    async closeSession() {
        const session = this.env.items("pos.session").browse(this.env.context["activeIds"]);
        return session.actionPosSessionClosingControl(
            await this['accountId'], await this['amountToBalance']
        );
    }
}