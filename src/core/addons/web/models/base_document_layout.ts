import sharp from "sharp";
import { api, tools } from "../../..";
import { Fields } from "../../../fields";
import { CompileError } from "../../../helper/errors";
import { MetaModel, TransientModel } from "../../../models";
import { getResourcePath } from "../../../modules/modules";
import { bool, isInstance } from "../../../tools";
import { _f } from "../../../tools/utils";
import { nl2br } from "../../base/models/ir_qweb_fields";
import { markup } from "../../../tools/xml";
import libsass from 'node-sass';

const DEFAULT_PRIMARY = '#000000';
const DEFAULT_SECONDARY = '#000000';

/**
 * Customise the company document layout and display a live preview
 */
@MetaModel.define()
class BaseDocumentLayout extends TransientModel {
    static _module = module;
    static _name = 'base.document.layout';
    static _description = 'Company Document Layout';

    static companyId = Fields.Many2one('res.company', {string: 'Company', default: async (self) => self.env.company(), required: true });

    static logo = Fields.Binary({ related: 'companyId.logo', readonly: false });
    static previewLogo = Fields.Binary({ related: 'logo', string: "Preview logo" });
    static reportHeader = Fields.Html({ related: 'companyId.reportHeader', readonly: false });
    static reportFooter = Fields.Html({ related: 'companyId.reportFooter', readonly: false, default: async (self) => self._defaultReportFooter() });
    static companyDetails = Fields.Html({ related: 'companyId.companyDetails', readonly: false, default: async (self) => self._defaultCompanyDetails() });

    // The paper format changes won't be reflected in the preview.
    static paperformatId = Fields.Many2one({ related: 'companyId.paperformatId', readonly: false });

    static externalReportLayoutId = Fields.Many2one({ related: 'companyId.externalReportLayoutId', readonly: false });

    static font = Fields.Selection({ related: 'companyId.font', readonly: false });
    static primaryColor = Fields.Char({ related: 'companyId.primaryColor', readonly: false });
    static secondaryColor = Fields.Char({ related: 'companyId.secondaryColor', readonly: false });

    static customColors = Fields.Boolean({ compute: "_computeCustomColors", readonly: false });
    static logoPrimaryColor = Fields.Char({ compute: "_computeLogoColors" });
    static logoSecondaryColor = Fields.Char({ compute: "_computeLogoColors" });

    static layoutBackground = Fields.Selection({ related: 'companyId.layoutBackground', readonly: false });
    static layoutBackgroundImage = Fields.Binary({ related: 'companyId.layoutBackgroundImage', readonly: false });

    static reportLayoutId = Fields.Many2one('report.layout', {string: 'Report layout'});

    // All the sanitization get disabled as we want true raw html to be passed to an iframe.
    static preview = Fields.Html({ compute: '_computePreview', sanitize: false });

    // Those following fields are required as a company to create invoice report
    static partnerId = Fields.Many2one({ related: 'companyId.partnerId', readonly: true });
    static phone = Fields.Char({ related: 'companyId.phone', readonly: true });
    static email = Fields.Char({ related: 'companyId.email', readonly: true });
    static website = Fields.Char({ related: 'companyId.website', readonly: true });
    static vat = Fields.Char({ related: 'companyId.vat', readonly: true });
    static label = Fields.Char({ related: 'companyId.label', readonly: true });
    static countryId = Fields.Many2one({ related: "companyId.countryId", readonly: true });

    @api.model()
    async _defaultReportFooter() {
        const company = await (await this.env.company()).getDict(['phone', 'email', 'website', 'vat']);
        const footerFields = Object.values(company).filter(field => typeof (field) === 'string' && field.length > 0);
        return markup(footerFields.join(' '));
    }

    @api.model()
    async _defaultCompanyDetails() {
        const company = await this.env.company();
        let [addressFormat, companyData] = await (await company.partnerId)._prepareDisplayAddress();
        addressFormat = this._cleanAddressFormat(addressFormat, companyData);
        // companyName may *still* be missing from prepared address in case commercialCompanyName is falsy
        if (!addressFormat.includes('companyName')) {
            addressFormat = '%(companyName)s\n' + addressFormat;
            companyData['companyName'] = companyData['companyName'] || await company.label;
        }
        return _f(markup(nl2br(addressFormat)), companyData);
    }

    _cleanAddressFormat(addressFormat, companyData) {
        const missingCompanyData = Object.keys(Object.entries(companyData).filter(([k, v]) => !v));
        for (const key of missingCompanyData) {
            if (addressFormat.includes(key)) {
                addressFormat = addressFormat.replace(`%(${key})s\n`, '');
            }
        }
        return addressFormat;
    }

    @api.depends('logoPrimaryColor', 'logoSecondaryColor', 'primaryColor', 'secondaryColor',)
    async _computeCustomColors() {
        for (const wizard of this) {
            const logoPrimary = await wizard.logoPrimaryColor || '';       
            const logoSecondary = await wizard.logoSecondaryColor || '';
            // Force lower case on color to ensure that FF01AA == ff01aa
            const primaryColor = await wizard.primaryColor;
            const secondaryColor = await wizard.secondaryColor;
            await wizard.set('customColors', (
                await wizard.logo && primaryColor && secondaryColor
                && !(
                    primaryColor.toLowerCase() === logoPrimary.toLowerCase()
                    && secondaryColor.toLowerCase() === logoSecondary.toLowerCase()
                )
            ));
        }
    }

    @api.depends('logo')
    async _computeLogoColors() {
        for (const wizard of this) {
            let wizardForImage;
            if (wizard._context['binSize']) {
                wizardForImage = await wizard.withContext({binSize: false});
            }
            else {
                wizardForImage = wizard;
            }
            const [logoPrimaryColor, logoSecondaryColor] = await wizard.extractImagePrimarySecondaryColors(await wizardForImage.logo);
            await wizard.set('logoPrimaryColor', logoPrimaryColor);
            await wizard.set('logoSecondaryColor', logoSecondaryColor);
        }
    }

    /**
     * compute a qweb based preview to display on the wizard
     */
    @api.depends('reportLayoutId', 'logo', 'font', 'primaryColor', 'secondaryColor', 'reportHeader', 'reportFooter', 'layoutBackground', 'layoutBackgroundImage', 'companyDetails')
    async _computePreview() {
        const styles = await this._getAssetStyle();

        for (const wizard of this) {
            if ((await wizard.reportLayoutId).ok) {
                // guarantees that binSize is always set to false,
                // so the logo always contains the bin data instead of the binary size
                let wizardWithLogo;
                if (wizard.env.context['binSize']) {
                    wizardWithLogo = await wizard.withContext({binSize : false});
                }
                else {
                    wizardWithLogo = wizard;
                }
                const previewCss = markup(this._getCssForPreview(styles, wizardWithLogo.id));
                const irUiView = wizardWithLogo.env.items('ir.ui.view');
                await wizard.set('preview', await irUiView._renderTemplate('web.reportInvoiceWizardPreview', {'company': wizardWithLogo, 'previewCss': previewCss}));
            }
            else {
                await wizard.set('preview', false);
            }
        }
    }

    @api.onchange('companyId')
    async _onchangeCompanyId() {
        for (const wizard of this) {
            const company = await wizard.companyId;
            await wizard.set('logo', await company.logo),
            await wizard.set('reportHeader', await company.reportHeader),
            // companyDetails and report_footer can store empty strings(set by the user) or false(meaning the user didn't set a value). Since both are falsy values, we use isinstance of string to differentiate them
            await wizard.set('reportFooter', typeof(await company.reportFooter) === 'string' ? await company.reportFooter : await wizard.reportFooter),
            await wizard.set('companyDetails', typeof(await company.companyDetails) === 'string' ? await company.companyDetails : await wizard.companyDetails),
            await wizard.set('paperformatId', await company.paperformatId),
            await wizard.set('externalReportLayoutId', await company.externalReportLayoutId),
            await wizard.set('font', await company.font),
            await wizard.set('primaryColor', await company.primaryColor),
            await wizard.set('secondaryColor', await company.secondaryColor)
            const wizardLayout = await wizard.env.items("report.layout").search([
                ['viewId.key', '=', await (await company.externalReportLayoutId).key]
            ]);
            await wizard.set('reportLayoutId', bool(wizardLayout) ? wizardLayout : await wizardLayout.search([], {limit: 1}));

            if (! await wizard.primaryColor) {
                await wizard.set('primaryColor', await wizard.logoPrimaryColor || DEFAULT_PRIMARY);
            }
            if (! await wizard.secondaryColor) {
                await wizard.set('secondaryColor', await wizard.logoSecondaryColor || DEFAULT_SECONDARY);
            }
        }
    }

    @api.onchange('customColors')
    async _onchangeCustomColors() {
        for (const wizard of this) {
            if (await wizard.logo && ! await wizard.customColors) {
                await wizard.set('primaryColor', await wizard.logoPrimaryColor || DEFAULT_PRIMARY),
                await wizard.set('secondaryColor', await wizard.logoSecondaryColor || DEFAULT_SECONDARY)
            }
        }
    }

    @api.onchange('reportLayoutId')
    async _onchangeReportLayoutId() {
        for (const wizard of this) {
            await wizard.set('externalReportLayoutId', await (await wizard.reportLayoutId).viewId);
        }
    }

    @api.onchange('logo')
    async _onchangeLogo() {
        for (const wizard of this) {
            // It is admitted that if the user puts the original image back, it won't change colors
            const company = await wizard.companyId;
            // at that point wizard.logo has been assigned the value present in DB
            if (await wizard.logo === await company.logo && await company.primaryColor && await company.secondaryColor) {
                continue;
            }

            if (await wizard.logoPrimaryColor) {
                await wizard.set('primaryColor', await wizard.logoPrimaryColor);
            }
            if (await wizard.logoSecondaryColor) {
                await wizard.set('secondaryColor', await wizard.logoSecondaryColor);
            }
        }
    }

    /**
     * Identifies dominant colors

        First resizes the original image to improve performance, then discards
        transparent colors and white - ish colors, then calls the averaging
        method twice to evaluate both primary and secondary colors.

        @param logo logo to process
        @param whiteThreshold arbitrary value defining the maximum value a color can reach
        @param mitigate arbitrary value defining the maximum value a band can reach

        @returns colors hex values of primary and secondary colors
     */
    @api.model()
    async extractImagePrimarySecondaryColors(logo, whiteThreshold = 225, mitigate = 175) {
        if (! logo) {
            return [false, false];
        }
        if (isInstance(logo, Uint8Array)) {
            logo = Buffer.concat([logo, Buffer.from('===')]);
        } else {
            logo += '===';
        }
        let image: sharp.Sharp;
        try {
            // Catches exceptions caused by logo not being an image
            image = await tools.imageFixOrientation(sharp(Buffer.from(logo, 'base64')));
        } catch(e) {
            return [false, false];
        }
        const metadata = await image.metadata();
        const [baseW, baseH] = [metadata.width, metadata.height];
        const w = Math.round(50 * baseW / baseH);
        const h = 50

        // Converts to RGBA(if already RGBA, this is a noop)
        const imageConverted = image.pipelineColourspace('rgb');
        const imageResized: any = imageConverted.resize(w, h);//, Resampling.NEAREST);

        const colors = [];
        for (const color of imageResized.getcolors(w * h)) {
            if (!(color[1][0] > whiteThreshold &&
                color[1][1] > whiteThreshold &&
                color[1][2] > whiteThreshold) && color[1][3] > 0) {
                colors.push(color);
            }
        }

        if (! bool(colors)) { // May happen when the whole image is white
            return [false, false];
        }
        let [primary, remaining] = tools.averageDominantColor(colors, mitigate);
        let secondary = remaining ? tools.averageDominantColor(remaining, mitigate)[0] : primary;

        // Lightness and saturation are calculated here.
        // - If both colors have a similar lightness, the most colorful becomes primary
        // - When the difference in lightness is too great, the brightest color becomes primary
        const l_primary = tools.getLightness(primary)
        const l_secondary = tools.getLightness(secondary)
        if ((l_primary < 0.2 && l_secondary < 0.2) || (l_primary >= 0.2 && l_secondary >= 0.2)) {
            const s_primary = tools.getSaturation(primary)
            const s_secondary = tools.getSaturation(secondary)
            if (s_primary < s_secondary) {
                [primary, secondary] = [secondary, primary]
            }
        }
        else if (l_secondary > l_primary) {
            [primary, secondary] = [secondary, primary]
        }
        return [tools.rgbToHex(primary), tools.rgbToHex(secondary)];
    }

    @api.model()
    async actionOpenBaseDocumentLayout(actionRef) {
        if (typeof(actionRef) != 'string') {
            actionRef = 'web.actionBaseDocumentLayoutConfigurator';
        }
        const res = await this.env.items("ir.actions.actions")._forXmlid(actionRef);
        await this.env.items(res["resModel"]).checkAccessRights('write');
        return res;
    }

    documentLayoutSave() {
        // meant to be overridden
        return this.env.context['reportAction'] || {'type': 'ir.actions.actwindow.close' }
    }

    /**
     * Compile the style template.It is a qweb template expecting company ids to generate all the code in one batch.
        We give a useless companyIds arg, but provide the PREVIEW_ID arg that will prepare the template for
        '_getCssForPreview' processing later.
     */
    async _getAssetStyle() {
        const templateStyle = await this.env.ref('web.stylesCompanyReport', false);
        if (! templateStyle.ok) {
            return '';
        }

        const companyStyles = await templateStyle._render({
            'companyIds': this,
        })

        return companyStyles;
    }

    @api.model()
    _getCssForPreview(scss, newid) {
        const cssCode = this._compileScss(scss);
        return cssCode;
    }

    /** 
     * This code will compile valid scss into css.
        Parameters are the same from verp / addons / base / models / assetsbundle.js
        Simply copied and adapted slightly
    */
    @api.model()
    _compileScss(scssSource) {
        // No scss ? still valid, returns empty css
        if (! scssSource.trim()) {
            return "";
        }

        const precision = 8
        const outputStyle = 'expanded'
        const bootstrapPath = getResourcePath('web', 'static', 'lib', 'bootstrap', 'scss')

        try {
            return  libsass.renderSync({
                data: scssSource,
                includePaths: [
                  bootstrapPath,
                ],
                outputStyle: outputStyle,
                precision: precision
            }).css.toString();
        } catch(e) {
            throw new CompileError(e)
        }
    }
}