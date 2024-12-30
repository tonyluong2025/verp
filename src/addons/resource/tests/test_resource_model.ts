import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ResourceTest extends Model {
    static _module = module;
    static _description = 'Test Resource Model';
    static _name = 'resource.test';
    static _parents = ['resource.mixin'];

    static label = Fields.Char();
}