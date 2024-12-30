import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class WebsiteRobots extends TransientModel {
    static _module = module;
    static _name = "website.robots";
    static _description = "Robots.txt Editor";

    static content = Fields.Text({default: async (self) =>  (await self.env.items('website').getCurrentWebsite()).robotsTxt});

    async actionSave() {
        await (await this.env.items('website').getCurrentWebsite()).set("robotsTxt", await this['content']);
        return {'type': 'ir.actions.actwindow.close'}
    }
}