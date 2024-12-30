import { AbstractModel, MetaModel } from "../../../core/models"

@MetaModel.define()
class ReplenishmentReport extends AbstractModel {
    static _module = module;
    static _name = 'stock.report.productproductreplenishment';
    static _description = "Stock Replenishment Report";
}

@MetaModel.define()
class ReplenishmentTemplateReport extends AbstractModel {
    static _module = module;
    static _name = 'stock.report.producttemplatereplenishment';
    static _description = "Stock Replenishment Report";
    static _parents = 'stock.report.productproductreplenishment';
}