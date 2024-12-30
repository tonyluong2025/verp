import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class WorkLocation extends Model {
    static _module = module;
    static _name = "hr.work.location";
    static _description = "Work Location";
    static _order = 'label';

    static active = Fields.Boolean({default: true});
    static label = Fields.Char({string: "Work Location", required: true});
    static companyId = Fields.Many2one('res.company', {required: true, default: self => self.env.company()});
    static addressId = Fields.Many2one('res.partner', {required: true, string: "Work Address", domain: "['|', ['companyId', '=', false], ['companyId', '=', companyId]]"});
    static locationNumber = Fields.Char();
}