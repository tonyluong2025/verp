import { WARNING_HELP, WARNING_MESSAGE } from "../../../core/addons/base/models";
import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Partner extends Model {
    static _module = module;
    static _parents = 'res.partner';
    static _checkCompanyAuto = true;

    static propertyStockCustomer = Fields.Many2one(
        'stock.location', {string: "Customer Location", companyDependent: true, checkCompany: true,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', allowedCompanyIds[0]]]",
        help: "The stock location used as destination when sending goods to this contact."});
    static propertyStockSupplier = Fields.Many2one(
        'stock.location', {string: "Vendor Location", companyDependent: true, checkCompany: true,
        domain: "['|', ['companyId', '=', false], ['companyId', '=', allowedCompanyIds[0]]]",
        help: "The stock location used as source when receiving goods from this contact."});
    static pickingWarn = Fields.Selection(WARNING_MESSAGE, {string: 'Stock Picking', help: WARNING_HELP, default: 'no-message'});
    static pickingWarnMsg = Fields.Text('Message for Stock Picking');
}