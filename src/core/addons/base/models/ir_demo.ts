import { MetaModel, TransientModel } from "../../../models"
import { forceDemo } from "../../../modules/loading";

@MetaModel.define()
class IrDemo extends TransientModel {
    static _module = module;
    static _name = 'ir.demo';
    static _description = 'Demo';

    async installDemo() {
        await forceDemo(this.env);
        return {
            'type': 'ir.actions.acturl',
            'target': 'self',
            'url': '/web',
        }
    }
}