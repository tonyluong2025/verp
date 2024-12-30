import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class MrpStockReport extends TransientModel {
    static _module = module;
    static _name = 'stock.traceability.report';
    static _description = 'Traceability Report';
}