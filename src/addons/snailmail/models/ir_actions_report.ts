import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class IrActionsReport extends Model {
    static _module = module;
    static _parents = 'ir.actions.report';

    async retrieveAttachment(record) {
        // Override this method in order to force to re-render the pdf in case of using snailmail
        if (this.env.context['snailmailLayout']) {
            return false;
        }
        return _super(IrActionsReport, this).retrieveAttachment(record);
    }

    @api.model()
    async getPaperformat() {
        // force the right format (euro/A4) when sending letters, only if we are not using the l10n_DE layout
        const res = await _super(IrActionsReport, this).getPaperformat();
        if (this.env.context['snailmailLayout'] && !res.eq(await this.env.ref('l10n_de.paperformatEuroDin', false))) {
            return this.env.ref('base.paperformatEuro');
        }
        else {
            return res;
        }
    }
}