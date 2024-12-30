import { format as f } from "util";
import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models";
import { len } from "../../../core/tools";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings'

    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true,
        default: async (self) => await self.env.company()})
    static userDefaultRights = Fields.Boolean(
        "Default Access Rights",
        {configParameter: 'base_setup.defaultUserRights'})
    static externalEmailServerDefault = Fields.Boolean(
        "Custom Email Servers",
        {configParameter: 'base_setup.defaultExternalEmailServer'})
    static moduleBaseImport = Fields.Boolean("Allow users to import data from CSV/XLS/XLSX/ODS files")
    static moduleGoogleCalendar = Fields.Boolean(
        {string: 'Allow the users to synchronize their calendar  with Google Calendar'})
    static moduleMicrosoftCalendar = Fields.Boolean(
        {string: 'Allow the users to synchronize their calendar with Outlook Calendar'})
    static moduleMailPlugin = Fields.Boolean(
        {string: 'Allow integration with the mail plugins'}
    )
    static moduleGoogleDrive = Fields.Boolean("Attach Google documents to any record")
    static moduleGoogleSpreadsheet = Fields.Boolean("Google Spreadsheet")
    static moduleAuthOauth = Fields.Boolean("Use external authentication providers (OAuth)")
    static moduleAuthLdap = Fields.Boolean("LDAP Authentication")
    // TODO: remove in master
    static moduleBaseGengo = Fields.Boolean("Translate Your Website with Gengo")
    static moduleAccountInterCompanyRules = Fields.Boolean("Manage Inter Company")
    static modulePad = Fields.Boolean("Collaborative Pads")
    static moduleVoip = Fields.Boolean("Asterisk (VoIP)")
    static moduleWebUnsplash = Fields.Boolean("Unsplash Image Library")
    static modulePartnerAutocomplete = Fields.Boolean("Partner Autocomplete")
    static moduleBaseGeolocalize = Fields.Boolean("GeoLocalize")
    static moduleGoogleRecaptcha = Fields.Boolean("reCAPTCHA")
    static moduleProductImages = Fields.Boolean("Get product pictures using barcode")
    static reportFooter = Fields.Html({related: "companyId.reportFooter", string: 'Custom Report Footer', help: "Footer text displayed at the bottom of all reports.", readonly: false})
    static groupMultiCurrency = Fields.Boolean({string: 'Multi-Currencies',
        impliedGroup: 'base.groupMultiCurrency',
        help: "Allows to work in a multi currency environment"})
    static externalReportLayoutId = Fields.Many2one({related: "companyId.externalReportLayoutId", readonly: false})
    static showEffect = Fields.Boolean({string: "Show Effect", configParameter: 'base_setup.showEffect'})
    static companyCount = Fields.Integer('Number of Companies', {compute: "_computeCompanyCount"})
    static activeUserCount = Fields.Integer('Number of Active Users', {compute: "_computeActiveUserCount"})
    static languageCount = Fields.Integer('Number of Languages', {compute: "_computeLanguageCount"})
    static companyName = Fields.Char({related: "companyId.displayName", string: "Company Name"})
    static companyInformations = Fields.Text({compute: "_computeCompanyInformations"})
    static profilingEnabledUntil = Fields.Datetime("Profiling enabled until", {configParameter: 'base.profilingEnabledUntil'})

    async openCompany() {
        return {
            'type': 'ir.actions.actwindow',
            'label': 'My Company',
            'viewMode': 'form',
            'resModel': 'res.company',
            'resId': (await this.env.company()).id,
            'target': 'current',
            'context': {
                'formViewInitialMode': 'edit',
            }
        }
    }

    async openDefaultUser() {
        const action = this.env.items("ir.actions.actions")._forXmlid("base.actionResUsers")
        if (await this.env.ref('base.defaultUser', false)) {
            action['resId'] = (await this.env.ref('base.defaultUser')).id;
        }
        else {
            throw new UserError(await this._t("Default User Template not found."));
        }
        action['views'] = [[(await this.env.ref('base.viewUsersForm')).id, 'form']];
        return action;
    }

    @api.model()
    async _prepareReportViewAction(template) {
        const templateId = await this.env.ref(template);
        return {
            'type': 'ir.actions.actwindow',
            'resModel': 'ir.ui.view',
            'viewMode': 'form',
            'resId': templateId.id,
        }
    }

    async editExternalHeader() {
        const externalReportLayoutId = await this['externalReportLayoutId'];
        if (! externalReportLayoutId.ok) {
            return false;
        }
        return this._prepareReportViewAction(await externalReportLayoutId.key)
    }

    // NOTE: These fields depend on the context, if we want them to be computed
    // we have to make them depend on a field.This is because we are on a TransientModel.
    @api.depends('companyId')
    async _computeCompanyCount() {
        const companyCount = await (await this.env.items('res.company').sudo()).searchCount([]);
        for (const record of this) {
            await record.set('companyCount', companyCount);
        }
    }

    @api.depends('companyId')
    async _computeActiveUserCount() {
        const activeUserCount = await (await this.env.items('res.users').sudo()).searchCount([['share', '=', false]]);
        for (const record of this) {
            await record.set('activeUserCount', activeUserCount);
        }
    }

    @api.depends('companyId')
    async _computeLanguageCount() {
        const languageCount = len(await this.env.items('res.lang').getInstalled());
        for (const record of this) {
            await record.set('languageCount', languageCount);
        }
    }

    @api.depends('companyId')
    async _computeCompanyInformations() {
        const company = await this['companyId'];
        const [street, street2, zip, city, stateId, countryId, vat] = await company('street', 'street2', 'zip', 'city', 'stateId', 'countryId', 'vat');
        let informations = f('%s\n', street ? street : '')
        informations += f('%s\n', street2 ? street2 : '')
        informations += f('%s', zip ? zip : '')
        informations += zip && !city ? '\n' : ''
        informations += zip && city ? ' - ' : ''
        informations += f('%s\n', city ? city : '')
        informations += f('%s\n', stateId.ok ? await stateId.displayName : '')
        informations += f('%s', countryId.ok ? await countryId.displayName : '')
        informations += f('\nVAT: %s', vat ? vat : '')

        for (const record of this) {
            await record.set('companyInformations', informations);
        }
    }
}