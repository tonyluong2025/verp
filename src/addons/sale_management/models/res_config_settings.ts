import { api, Fields } from "../../../core";
import { _super, MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static groupSaleOrderTemplate = Fields.Boolean(
        "Quotation Templates", {impliedGroup: 'sale_management.groupSaleOrderTemplate'});
    static companySoTemplateId = Fields.Many2one({
        related: "companyId.saleOrderTemplateId", string: "Default Template", readonly: false,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});
    static moduleSaleQuotationBuilder = Fields.Boolean("Quotation Builder");

    @api.onchange('groupSaleOrderTemplate')
    async _onchangeGroupSaleOrderTemplate() {
        if (! await this['groupSaleOrderTemplate']) {
            await this.set('moduleSaleQuotationBuilder', false);
        }
    }

    async setValues() {
        if (! await this['groupSaleOrderTemplate']) {
            await this.set('companySoTemplateId', null);
            await (await (await this.env.items('res.company').sudo()).search([])).write({
                'saleOrderTemplateId': false,
            });
        }
        return _super(ResConfigSettings, this).setValues();
    }
}
