import { api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class IrUiView extends Model {
    static _module = module;
    static _parents = 'ir.ui.view';

    @api.ondelete(false)
    async _unlinkIfNotReferencedByAcquirer() {
        const referencingAcquirersSudo = await (await this.env.items('payment.acquirer').sudo()).search([
            '|', ['redirectFormViewId', 'in', this.ids], ['inlineFormViewId', 'in', this.ids]
        ]);  // In sudo mode to allow non-admin users (e.g., Website designers) to read the view ids.
        if (bool(referencingAcquirersSudo)) {
            throw new UserError(await this._t("You cannot delete a view that is used by a payment acquirer."));
        }
    }
}