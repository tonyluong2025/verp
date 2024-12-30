import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ResCompany extends Model {
    static _module = module;
    static _parents = 'res.company';
    
    //----------------------------------------------------------
    // Database
    //----------------------------------------------------------
    
    static backgroundImage = Fields.Binary({
        string: 'Apps Menu Background Image',
        attachment: true
    });
    static backgroundBlendMode = Fields.Selection({
        selection: [
            ['normal', 'Normal'],
            ['multiply', 'Multiply'],
            ['screen', 'Screen'],
            ['overlay', 'Overlay'],
            ['hard-light', 'Hard-light'],
            ['darken', 'Darken'],
            ['lighten', 'Lighten'],
            ['color-dodge', 'Color-dodge'],
            ['color-burn', 'Color-burn'],
            ['hard-light', 'Hard-light'],
            ['difference', 'Difference'],
            ['exclusion', 'Exclusion'],
            ['hue', 'Hue'],
            ['saturation', 'Saturation'],
            ['color', 'Color'],
            ['luminosity', 'Luminosity'],
        ], 
        string: 'Apps Menu Background Blend Mode',
        default: 'normal'
    });
    static defaultSidebarPreference = Fields.Selection({
        selection: [
            ['invisible', 'Invisible'],
            ['small', 'Small'],
            ['large', 'Large']
        ], 
        string: 'Sidebar Type',
        default: 'large'
    });
    static defaultChatterPreference = Fields.Selection({
        selection: [
            ['normal', 'Normal'],
            ['sided', 'Sided'],
        ], 
        string: 'Chatter Position', 
        default: 'sided'
    });
}
