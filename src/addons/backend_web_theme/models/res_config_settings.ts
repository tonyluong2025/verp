import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { update } from "../../../core/tools";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    //----------------------------------------------------------
    // Database
    //----------------------------------------------------------
    static themeFavicon = Fields.Binary({
        related: 'companyId.favicon',
        readonly: false
    });
    static themeBackgroundImage = Fields.Binary({
        related: 'companyId.backgroundImage',
        readonly: false
    });
    static themeBackgroundBlendMode = Fields.Selection({
        related: 'companyId.backgroundBlendMode',
        readonly: false
    });
    static themeDefaultSidebarPreference = Fields.Selection({
        related: 'companyId.defaultSidebarPreference',
        readonly: false
    });
    static themeDefaultChatterPreference = Fields.Selection({
        related: 'companyId.defaultChatterPreference',
        readonly: false
    });
    static themeColorBrand = Fields.Char('Theme Brand Color');
    static themeColorPrimary = Fields.Char('Theme Primary Color');
    static themeColorRequired = Fields.Char('Theme Required Color');
    static themeColorMenu = Fields.Char('Theme Menu Color');
    static themeColorAppbarColor = Fields.Char('Theme AppBar Color');
    static themeColorAppbarBackground = Fields.Char('Theme AppBar Background');
    
    //----------------------------------------------------------
    // Functions
    //----------------------------------------------------------

    async setValues() {
        const res = await _super(ResConfigSettings, this).setValues();
        const param = await this.env.items('ir.config.parameter').sudo();
        let variables: any[] = [
            'o-brand-verp',
            'o-brand-primary',
            'bw-required-color',
            'bw-apps-color',
            'bw-appbar-color',
            'bw-appbar-background',
        ];
        const colors = await this.env.items('webeditor.assets').getVariablesValues(
            '/backend_web_theme/static/src/colors.scss', 'web._assetsPrimaryVariables', variables
        );
        const colorsChanged = [];
        colorsChanged.push(await this['themeColorBrand'] != colors['o-brand-verp']);
        colorsChanged.push(await this['themeColorPrimary'] != colors['o-brand-primary']);
        colorsChanged.push(await this['themeColorRequired'] != colors['bw-required-color']);
        colorsChanged.push(await this['themeColorMenu'] != colors['bw-apps-color']);
        colorsChanged.push(await this['themeColorAppbarColor'] != colors['bw-appbar-color']);
        colorsChanged.push(await this['themeColorAppbarBackground'] != colors['bw-appbar-background']);
        if (colorsChanged.some(i => i)) {
            variables = [
                {'label': 'o-brand-verp', 'value': await this['themeColorBrand'] || "#243742"},
                {'label': 'o-brand-primary', 'value': await this['themeColorPrimary'] || "#5D8DA8"},
                {'label': 'bw-required-color', 'value': await this['themeColorRequired'] || "#d1dfe6"},
                {'label': 'bw-apps-color', 'value': await this['themeColorMenu'] || "#f8f9fa"},
                {'label': 'bw-appbar-color', 'value': await this['themeColorAppbarColor'] || "#dee2e6"},
                {'label': 'bw-appbar-background', 'value': await this['themeColorAppbarBackground'] || "#000000"},
            ]
            await this.env.items('webeditor.assets').replaceVariablesValues(
                '/backend_web_theme/static/src/colors.scss', 'web._assetsPrimaryVariables', variables
            )
        }
        return res;
    }

    @api.model()
    async getValues() {
        const res = await _super(ResConfigSettings, this).getValues();
        const params = this.env.items('ir.config.parameter').sudo();
        let variables = [
            'o-brand-verp',
            'o-brand-primary',
            'bw-required-color',
            'bw-apps-color',
            'bw-appbar-color',
            'bw-appbar-background',
        ]
        const colors = await this.env.items('webeditor.assets').getVariablesValues(
            '/backend_web_theme/static/src/colors.scss', 'web._assetsPrimaryVariables', variables
        )
        update(res, {
            'themeColorBrand': colors['o-brand-verp'],
            'themeColorPrimary': colors['o-brand-primary'],
            'themeColorRequired': colors['bw-required-color'],
            'themeColorMenu': colors['bw-apps-color'],
            'themeColorAppbarColor': colors['bw-appbar-color'],
            'themeColorAppbarBackground': colors['bw-appbar-background'],
        })
        return res;
    }
}
