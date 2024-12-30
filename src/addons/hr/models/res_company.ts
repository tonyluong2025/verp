import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Company extends Model {
    static _module = module;
    static _parents = 'res.company';

    static hrPresenceControlEmailAmount = Fields.Integer({string: "# emails to send"});
    static hrPresenceControlIpList = Fields.Char({string: "Valid IP addresses"});
}