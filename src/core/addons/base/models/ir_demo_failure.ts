import { api } from "../../..";
import { Fields } from "../../../fields";
import { MetaModel, TransientModel } from "../../../models"
import { len } from "../../../tools/iterable";

/**
 * Stores modules for which we could not install demo data
 */
@MetaModel.define()
class DemoFailure extends TransientModel {
    static _module = module;
    static _name = 'ir.demo.failure';
    static _description = 'Demo failure';

    static moduleId = Fields.Many2one('ir.module.module', {required: true, string: "Module"});
    static error = Fields.Char({string: "Error"});
    static wizardId = Fields.Many2one('ir.demo.failure.wizard');
}

@MetaModel.define()
class DemoFailureWizard extends TransientModel {
    static _module = module;
    static _name = 'ir.demo.failure.wizard';
    static _description = 'Demo Failure wizard';

    static failureIds = Fields.One2many('ir.demo.failure', 'wizardId', { readonly: true, string: "Demo Installation Failures"});
    static failuresCount = Fields.Integer({compute: '_computeFailuresCount'});

    @api.depends('failureIds')
    async _computeFailuresCount() {
        for (const r of this as any) {
            await r.set('failuresCount', len(await r.failureIds));
        }
    }

    async done() {
        return this.env.items('ir.module.module').next();
    }
}