import { MetaModel, AbstractModel } from "../../../core/models"

@MetaModel.define()
class ReceptionReport extends AbstractModel {
    static _module = module;
    static _name = 'stock.report.reception';
    static _description = "Stock Reception Report";
}