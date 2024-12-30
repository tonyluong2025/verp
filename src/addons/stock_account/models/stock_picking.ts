import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { update } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";

@MetaModel.define()
class StockPicking extends Model {
    static _module = module;
    static _parents = 'stock.picking';

    static countryCode = Fields.Char({related: "companyId.accountFiscalCountryId.code"});

    async actionViewStockValuationLayers() {
        this.ensureOne();
        const scraps = await this.env.items('stock.scrap').search([['pickingId', '=', this.id]]);
        const domain = [['id', 'in', (await (await this['moveLines']).add(await scraps.moveId).stockValuationLayerIds).ids]];
        const action = await this.env.items("ir.actions.actions")._forXmlid("stock_account.stockValuationLayerAction");
        const context = literalEval(action['context']);
        update(context, this.env.context);
        context['noAtDate'] = true;
        return Object.assign({}, action, {domain: domain, context: context});
    }
}