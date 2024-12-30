import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models"
import { extend } from "../../../core/tools";

@MetaModel.define()
class ResUsers extends Model {
    static _module = module;
    static _parents = 'res.users';
    
    //----------------------------------------------------------
    // Defaults
    //----------------------------------------------------------
    
    @api.model()
    async _defaultSidebarType() {
        return await (await (await this.env.user()).companyId).defaultSidebarPreference || 'large';
    }

    @api.model()
    async _defaultChatterPosition() {
        return await (await (await this.env.user()).companyId).defaultChatterPreference || 'sided';
    }

    //----------------------------------------------------------
    // Database
    //----------------------------------------------------------
    
    static sidebarType = Fields.Selection({
        selection: [
            ['invisible', 'Invisible'],
            ['small', 'Small'],
            ['large', 'Large']
        ], 
        required: true,
        string: "Sidebar Type",
        default: self => self._defaultSidebarType()
    });
    static chatterPosition = Fields.Selection({
        selection: [
            ['normal', 'Normal'],
            ['sided', 'Sided']
        ], 
        required: true,
        string: "Chatter Position", 
        default: self => self._defaultChatterPosition()
    });
    
    //----------------------------------------------------------
    // Setup
    //----------------------------------------------------------

    __init__(pool, cr) {
        const cls = this.cls as any;
        const initRes = _super(ResUsers, this).__init__(pool, cr);
        const themeFields = ['sidebarType', 'chatterPosition'];
        const readableFields = Array.from(cls['SELF_READABLE_FIELDS']);
        const writeableFields = Array.from(cls['SELF_WRITEABLE_FIELDS']);
        extend(readableFields, themeFields);
        extend(writeableFields, themeFields);
        cls.SELF_READABLE_FIELDS = readableFields;
        cls.SELF_WRITEABLE_FIELDS = writeableFields;
        return initRes;
    }
}