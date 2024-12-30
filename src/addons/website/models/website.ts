// // -*- coding: utf-8 -*-[a-z]_[a-z]
// // Part of Verp. See LICENSE file for full copyright and licensing details.
import assert from "assert";
import fs from "fs/promises";
import _ from "lodash";
import xpath from "xpath";
import * as iap_tools from "../../../addons/iap/tools/iap_tools";
import { Fields, _Datetime, api, registry, release, tools } from "../../../core";
import { getattr, hasattr, setdefault } from "../../../core/api";
import { AccessError, OrderedMultiDict, UserError, ValueError } from "../../../core/helper";
import { Endpoint, _root, addonsManifest, httpGet } from "../../../core/http";
import { BaseModel, MetaModel, Model, _super } from "../../../core/models";
import { getResourcePath } from "../../../core/modules";
import { expression } from "../../../core/osv";
import { FALSE_DOMAIN } from "../../../core/osv/expression";
import { NotFound } from "../../../core/service";
import { Rule } from "../../../core/service/middleware/rule";
import { urlEncode, urlJoin, urlParse, urlQuotePlus } from "../../../core/service/middleware/utils";
import { _f, b64encode, bool, columnExists, enumerate, equal, escapePsql, f, floatRound, getArgumentNames, imageProcess, isDigit, isInstance, isList, len, parseInt, pop, quote, quoteList, rstrip, sha512, slugify, sorted, tableExists, toText, update, urlFor } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";
import { parseXml, serializeXml } from "../../../core/tools/xml";
import { _guessMimetype } from "../../http_routing";
import { pager } from "../../portal";
import { getUnaccentSqlWrapper, similarityScore, textFromHtml } from "../tools";
import { sitemapQs2dom } from "./ir_http";

const DEFAULT_CDN_FILTERS = [
    "^/[^/]+/static/",
    "^/web/(css|js)/",
    "^/web/image",
    "^/web/content",
    "^/web/assets",
    // retrocompatibility
    "^/website/image/",
]

const DEFAULT_ENDPOINT = 'https://website.api.theverp.com';

@MetaModel.define()
class Website extends Model {
    static _module = module;
    static _name = "website";
    static _description = "Website";
    static _order = "sequence, id";

    @api.model()
    websiteDomain(websiteId: any = false) {
        return [['websiteId', 'in', [false, websiteId || this.id]]];
    }

    async _activeLanguages() {
        return (await this.env.items('res.lang').search([])).ids;
    }

    async _defaultLanguage() {
        const langCode = await this.env.items('ir.default').get('res.partner', 'lang');
        const defLangId = await this.env.items('res.lang')._langGetId(langCode);
        return bool(defLangId) ? defLangId : (await this._activeLanguages())[0];
    }

    static label = Fields.Char('Website Name', { required: true });
    static sequence = Fields.Integer({ default: 10 });
    static domain = Fields.Char('Website Domain', { help: 'E.g. https://www.mydomain.com' });
    static countryGroupIds = Fields.Many2many('res.country.group', { relation: 'websiteCountryGroupRel', column1: 'websiteId', column2: 'countryGroupId', string: 'Country Groups', help: 'Used when multiple websites have the same domain.' });
    static companyId = Fields.Many2one('res.company', { string: "Company", default: self => self.env.company(), required: true });
    static languageIds = Fields.Many2many('res.lang', { relation: 'websiteLangRel', column1: 'websiteId', column2: 'langId', string: 'Languages', default: self => self._activeLanguages() });
    static defaultLangId = Fields.Many2one('res.lang', { string: "Default Language", default: self => self._defaultLanguage(), required: true });
    static autoRedirectLang = Fields.Boolean('Autoredirect Language', { default: true, help: "Should users be redirected to their browser's language" });
    static cookiesBar = Fields.Boolean('Cookies Bar', { help: "Display a customizable cookies bar on your website." });
    static configuratorDone = Fields.Boolean({ help: 'true if configurator has been completed or ignored' });

    async _defaultSocialFacebook() {
        return (await this.env.ref('base.mainCompany')).socialFacebook;
    }

    async _defaultSocialGithub() {
        return (await this.env.ref('base.mainCompany')).socialGithub;
    }

    async _defaultSocialLinkedin() {
        return (await this.env.ref('base.mainCompany')).socialLinkedin;
    }

    async _defaultSocialYoutube() {
        return (await this.env.ref('base.mainCompany')).socialYoutube;
    }

    async _defaultSocialInstagram() {
        return (await this.env.ref('base.mainCompany')).socialInstagram;
    }

    async _defaultSocialTwitter() {
        return (await this.env.ref('base.mainCompany')).socialTwitter;
    }

    async _defaultSocialZalo() {
        return (await this.env.ref('base.mainCompany')).socialZalo;
    }

    async _defaultSocialTiktok() {
        return (await this.env.ref('base.mainCompany')).socialTiktok;
    }


    async _defaultLogo() {
        const imagePath = getResourcePath('website', 'static/src/img', 'website_logo.svg');
        const data = await fs.readFile(imagePath);
        return b64encode(data);
    }

    static logo = Fields.Binary('Website Logo', { default: self => self._defaultLogo(), help: "Display this logo on the website." });
    static socialTwitter = Fields.Char('Twitter Account', { default: self => self._defaultSocialTwitter() });
    static socialFacebook = Fields.Char('Facebook Account', { default: self => self._defaultSocialFacebook() })
    static socialGithub = Fields.Char('GitHub Account', { default: self => self._defaultSocialGithub() });
    static socialLinkedin = Fields.Char('LinkedIn Account', { default: self => self._defaultSocialLinkedin() });
    static socialYoutube = Fields.Char('Youtube Account', { default: self => self._defaultSocialYoutube() });
    static socialInstagram = Fields.Char('Instagram Account', { default: self => self._defaultSocialInstagram() });
    static socialTiktok = Fields.Char('Tiktok Account', { default: self => self._defaultSocialTiktok() });
    static socialZalo = Fields.Char('Zalo Account', { default: self => self._defaultSocialZalo() });
    static socialDefaultImage = Fields.Binary({ string: "Default Social Share Image", help: "If set, replaces the website logo as the default social share image." });
    static hasSocialDefaultImage = Fields.Boolean({ compute: '_computeHasSocialDefaultImage', store: true });

    static googleAnalyticsKey = Fields.Char('Google Analytics Key');
    static googleManagementClientId = Fields.Char('Google Client ID');
    static googleManagementClientSecret = Fields.Char('Google Client Secret');
    static googleSearchConsole = Fields.Char({ help: 'Google key, or Enable to access first reply' });
    static googleMapsApiKey = Fields.Char('Google Maps API Key');

    static userId = Fields.Many2one('res.users', { string: 'Public User', required: true });
    static cdnActivated = Fields.Boolean('Content Delivery Network (CDN)');
    static cdnUrl = Fields.Char('CDN Base URL', { default: '' });
    static cdnFilters = Fields.Text('CDN Filters', { default: DEFAULT_CDN_FILTERS.join('\n'), help: "URL matching those filters will be rewritten using the CDN Base URL" });
    static partnerId = Fields.Many2one({ related: 'userId.partnerId', string: 'Public Partner', readonly: false });
    static menuId = Fields.Many2one('website.menu', { compute: '_computeMenu', string: 'Main Menu' });
    static homepageId = Fields.Many2one('website.page', { string: 'Homepage' });
    static customCodeHead = Fields.Html('Custom <head> code', { sanitize: false });
    static customCodeFooter = Fields.Html('Custom end of <body> code', { sanitize: false });
    static robotsTxt = Fields.Html('Robots.txt', { translate: false, groups: 'website.groupWebsiteDesigner', sanitize: false });

    async _defaultFavicon() {
        const imgPath = getResourcePath('web', 'static/img/favicon.ico');
        const data = await fs.readFile(imgPath);
        return b64encode(data);
    }

    static favicon = Fields.Binary({ string: "Website Favicon", help: "This field holds the image used to display a favicon on the website.", default: self => self._defaultFavicon() });
    static themeId = Fields.Many2one('ir.module.module', { help: 'Installed theme' });

    static specificUserAccount = Fields.Boolean('Specific User Account', { help: 'If true, new accounts will be associated to the current website' });
    static authSignupUninvited = Fields.Selection([
        ['b2b', 'On invitation'],
        ['b2c', 'Free sign up'],
    ], { string: 'Customer Account', default: 'b2b' });

    @api.onchange('languageIds')
    async _onchangeLanguageIds() {
        const languageIds = (await this['languageIds'])._origin;
        if (bool(languageIds) && !languageIds.includes(await this['defaultLangId'])) {
            await this.set('defaultLangId', languageIds[0]);
        }
    }

    @api.depends('socialDefaultImage')
    async _computeHasSocialDefaultImage() {
        for (const website of this) {
            await website.set('hasSocialDefaultImage', bool(await website.socialDefaultImage));
        }
    }

    async _computeMenu() {
        for (const website of this) {
            const menus = this.env.items('website.menu').browse(await website._getMenuIds());

            // use field parentId (1 query) to determine field childId (2 queries by level)"
            for (const menu of menus) {
                menu._cache.set('childId', []);
            }
            for (const menu of menus) {
                // don't add child menu if parent is forbidden
                const parent = await menu.parentId;
                if (parent.ok && menus.includes(parent)) {
                    if (!parent._cache.has('childId')) {
                        parent._cache.set('childId', []);
                    }
                    parent._cache.get('childId').concat([menu.id]);
                }
            }
            // prefetch every website.page and ir.ui.view at once
            await menus.mapped('isVisible');

            const topMenus = await menus.filtered(async (m) => !bool(await m.parentId));
            await website.set('menuId', topMenus.ok && topMenus[0].id || false);
        }
    }

    // self.env.uid for ir.rule groups on menu
    @tools.ormcache('self.env.uid', 'self.id')
    async _getMenuIds() {
        return (await this.env.items('website.menu').search([['websiteId', '=', this.id]])).ids;
    }

    // self.env.uid for ir.rule groups on menu
    @tools.ormcache('self.env.uid', 'self.id')
    async _getMenuPageIds() {
        return (await (await this.env.items('website.menu').search([['websiteId', '=', this.id]])).pageId).ids;
    }

    @api.model()
    async create(vals) {
        await this._handleCreateWrite(vals);

        if (!('userId' in vals)) {
            const company = this.env.items('res.company').browse(vals['companyId']);
            vals['userId'] = company.ok ? (await company._getPublicUser()).id : (await this.env.ref('base.publicUser')).id;
        }

        const res = await _super(Website, this).create(vals);
        await (await res.companyId)._computeWebsiteId();
        await res._bootstrapHomepage();

        if (! await (await this.env.user()).hasGroup('website.groupMultiWebsite') && await this.searchCount([]) > 1) {
            const allUserGroups = 'base.groupPortal,base.groupUser,base.groupPublic';
            const groups = this.env.items('res.groups').concat(await Promise.all(allUserGroups.split(',').map(async (it) => await this.env.ref(it))));
            await groups.write({ 'impliedIds': [[4, (await this.env.ref('website.groupMultiWebsite')).id]] });
        }
        return res;
    }

    async write(values) {
        let publicUserToChangeWebsites = this.env.items('website');
        const originalCompany = await this['companyId'];
        await this._handleCreateWrite(values);

        this.clearCaches();

        if ('companyId' in values && !('userId' in values)) {
            publicUserToChangeWebsites = await this.filtered(async (w) => (await (await (await w.sudo()).userId).companyId).id != values['companyId']);
            if (publicUserToChangeWebsites.ok) {
                const company = this.env.items('res.company').browse(values['companyId']);
                await _super(Website, publicUserToChangeWebsites).write(Object.assign({}, values, { userId: company.ok && (await company._getPublicUser()).id }));
            }
        }

        const result = await _super(Website, this.sub(publicUserToChangeWebsites)).write(values);

        if ('cdnActivated' in values || 'cdnUrl' in values || 'cdnFilters' in values) {
            // invalidate the caches from static node at compile time
            this.env.items('ir.qweb').clearCaches();
        }

        // invalidate cache for `company.websiteId` to be recomputed
        if ('sequence' in values || 'companyId' in values) {
            await originalCompany.or(await this['companyId'])._computeWebsiteId();
        }
        if ('cookiesBar' in values) {
            const existingPolicyPage = await this.env.items('website.page').search([
                ['websiteId', '=', this.id],
                ['url', '=', '/cookie-policy'],
            ]);
            if (!values['cookiesBar']) {
                await existingPolicyPage.unlink();
            }
            else if (!bool(existingPolicyPage)) {
                const cookiesView = await this.env.ref('website.cookiePolicy', false);
                if (bool(cookiesView)) {
                    await (await cookiesView.withContext({ websiteId: this.id })).write({ 'websiteId': this.id });
                    const specificCookView = await (await this.withContext({ websiteId: this.id })).viewref('website.cookiePolicy');
                    await this.env.items('website.page').create({
                        'isPublished': true,
                        'websiteIndexed': false,
                        'url': '/cookie-policy',
                        'websiteId': this.id,
                        'viewId': specificCookView.id,
                    });
                }
            }
        }
        return result;
    }

    @api.model()
    async _handleCreateWrite(vals) {
        await this._handleFavicon(vals);
        await this._handleDomain(vals);
    }

    @api.model()
    async _handleFavicon(vals) {
        if ('favicon' in vals) {
            vals['favicon'] = await imageProcess(vals['favicon'], { size: [256, 256], crop: 'center', outputFormat: 'ICO' });
        }
    }

    @api.model()
    async _handleDomain(vals) {
        if ('domain' in vals && vals['domain']) {
            if (!vals['domain'].startsWith('http')) {
                vals['domain'] = f('https://%s', vals['domain']);
            }
            vals['domain'] = rstrip(vals['domain'], '/');
        }
    }

    // TODO: rename in master
    @api.ondelete(false)
    async _unlinkExceptLastRemainingWebsite() {
        const website = await this.search([['id', 'not in', this.ids]], { limit: 1 });
        if (!website.ok) {
            throw new UserError(await this._t('You must keep at least one website.'));
        }
        const defaultWebsite = await this.env.ref('website.defaultWebsite', false);
        if (bool(defaultWebsite) && this.includes(defaultWebsite)) {
            throw new UserError(await this._t("You cannot delete default website %s. Try to change its settings instead", await defaultWebsite.label));
        }
    }

    async unlink() {
        await this._removeAttachmentsOnWebsiteUnlink();

        const companies = await this['companyId'];
        const res = await _super(Website, this).unlink();
        await companies._computeWebsiteId();
        return res;
    }

    async _removeAttachmentsOnWebsiteUnlink() {
        // Do not delete invoices, delete what's strictly necessary
        const attachmentsToUnlink = await this.env.items('ir.attachment').search([
            ['websiteId', 'in', this.ids],
            '|', '|',
            ['key', '!=', false],  // theme attachment
            ['url', 'ilike', '.custom.'],  // customized theme attachment
            ['url', 'ilike', '.assets\\_'],
        ])
        await attachmentsToUnlink.unlink();
    }

    async createAndRedirectConfigurator() {
        await this._force();
        const configuratorActionTodo = await this.env.ref('website.websiteConfiguratorTodo');
        return configuratorActionTodo.actionLaunch();
    }

    // Configurator

    async _websiteApiRpc(route, params) {
        params['version'] = release.version;
        const irConfigParameter = await this.env.items('ir.config.parameter').sudo();
        const websiteApiEndpoint = await irConfigParameter.getParam('website.websiteApiEndpoint', DEFAULT_ENDPOINT);
        const endpoint = websiteApiEndpoint + route;
        return iap_tools.iapJsonrpc(this.env, endpoint, { params: params });
    }

    getCtaData(websitePurpose, websiteType) {
        return { 'ctaBtnText': false, 'ctaBtnHref': '/contactus' }
    }

    @api.model()
    getThemeSnippetLists(themeName) {
        const defaultSnippetLists = addonsManifest['theme_default']['snippetLists'] ?? {};
        const themeSnippetLists = addonsManifest[themeName]['snippetLists'] ?? {};
        const snippetLists = { ...defaultSnippetLists, ...themeSnippetLists };
        return snippetLists;
    }

    async configuratorSetMenuLinks(menuCompany, moduleData) {
        const menus = await this.env.items('website.menu').search([['url', 'in', Object.keys(moduleData)], ['websiteId', '=', this.id]]);
        for (const m of menus) {
            await m.set('sequence', moduleData[await m.url]['sequence']);
        }
    }

    async configuratorGetFooterLinks() {
        return [
            { 'text': await this._t("Privacy Policy"), 'href': '/privacy' },
        ]
    }

    @api.model()
    async configuratorInit() {
        const r = {};
        const company = await (await this.getCurrentWebsite()).companyId;
        const code = await (await (await this.getCurrentWebsite()).defaultLangId).code;
        const configuratorFeatures = await (await this.env.items('website.configurator.feature').withContext({ lang: code })).search([]);
        r['features'] = await configuratorFeatures.map(async (feature) => {
            return {
                'id': feature.id,
                'label': await feature.label,
                'description': await feature.description,
                'type': bool(await feature.pageViewId) ? 'page' : 'app',
                'icon': await feature.icon,
                'websiteConfigPreselection': await feature.websiteConfigPreselection,
                'moduleState': await (await feature.moduleId).state,
            }
        });
        r['logo'] = false;
        const logo = await company.logo;
        if (logo && logo !== await company._getLogo()) {
            r['logo'] = Buffer.from(logo).toString('utf-8');
        }
        try {
            const result = await this._websiteApiRpc('/api/website/1/configurator/industries', { 'lang': code });
            r['industries'] = result['industries'];
        } catch (e) {
            if (isInstance(e, AccessError)) {
                console.warn(e.message);
            } else {
                throw e;
            }
        }
        return r;
    }

    @api.model()
    async configuratorRecommendedThemes(industryId, palette) {
        const req = this.env.req;
        const domain = [['label', '=like', 'theme%'], ['label', 'not in', ['theme_default', 'theme_common']], ['state', '!=', 'uninstallable']];
        const clientThemes = await (await this.env.items('ir.module.module').search(domain)).mapped('label');
        const clientThemesImg = Object.fromEntries(clientThemes.filter(f => f in addonsManifest).map(f => [f, addonsManifest[f]['imagesPreviewTheme'] ?? {}]));
        const themesSuggested = await this._websiteApiRpc(
            f('/api/website/2/configurator/recommendedThemes/%s', industryId),
            { 'clientThemes': clientThemesImg }
        );
        const model = this.env.items('website.configurator.feature');
        const processSvg = model._processSvg;
        for (const theme of themesSuggested) {
            theme['svg'] = await processSvg.call(model, theme['this'], palette, pop(theme, 'imageUrls'));
        }
        return themesSuggested;
    }

    @api.model()
    async configuratorSkip() {
        const website = await this.getCurrentWebsite();
        await website.set('configuratorDone', true);
    }


    @api.model()
    async configuratorApply(kwargs: {} = {}) {
        async function setColors(selectedPalette) {
            let url = '/website/static/src/scss/options/user_values.scss';
            const selectedPaletteName = typeof (selectedPalette) === 'string' ? selectedPalette : 'base-1';
            const values = { 'color-palettes-name': f("'%s'", selectedPaletteName) }
            await self.env.items('webeditor.assets').makeScssCustomization(url, values);

            if (isList(selectedPalette)) {
                url = '/website/static/src/scss/options/colors/user_color_palette.scss';
                const values = {}
                for (const [i, color] of enumerate(selectedPalette, 1)) {
                    values[`o-color-${i}`] = color
                }
                await self.env.items('webeditor.assets').makeScssCustomization(url, values);
            }
        }

        async function setFeatures(selectedFeatures) {
            const features = self.env.items('website.configurator.feature').browse(selectedFeatures);

            let menuCompany = self.env.items('website.menu')
            if (len(await features.filtered('menuSequence')) > 5 && len(await features.filtered('menuCompany')) > 1) {
                menuCompany = await self.env.items('website.menu').create({
                    'label': await this._t('Company'),
                    'parentId': (await website.menuId).id,
                    'websiteId': website.id,
                    'sequence': 40,
                });
            }

            const pagesViews = {}
            let modules = self.env.items('ir.module.module');
            const moduleData = {}
            for (const feature of features) {
                const [modul, featureUrl, menuSequence] = await feature('moduleId', 'featureUrl', 'menuSequence');
                const addMenu = bool(menuSequence);
                if (modul.ok) {
                    if (await modul.state !== 'installed') {
                        modules = modules.add(modul);
                    }
                    if (addMenu) {
                        if (await modul.label !== 'website_blog') {
                            moduleData[featureUrl] = { 'sequence': menuSequence };
                        }
                        else {
                            const blogs = setdefault(moduleData, '#blog', []);
                            blogs.push({ 'label': await feature.label, 'sequence': menuSequence });
                        }
                    }
                }
                else if (bool(await feature.pageViewIdvalues)) {
                    let menuId = bool(await feature.menuCompany) && menuCompany.id;
                    menuId = bool(menuId) ? menuId : (await website.menuId).id;
                    const result = await self.env.items('website').newPage({
                        label: await feature.label, 
                        addMenu: addMenu,
                        pageValues: Object.assign({}, { url: featureUrl, isPublished: true }),
                        menuValues: addMenu && {
                            'url': featureUrl,
                            'sequence': menuSequence,
                            'parentId': menuId,
                        },
                        template: await (await feature.pageViewId).key
                    });
                    pagesViews[await feature.iapPageCode] = result['viewId'];
                }
            }

            if (bool(modules)) {
                await modules.buttonImmediateInstall()
                assert(self.env.registry === await registry());
            }
            await self.env.items('website').browse(website.id).configuratorSetMenuLinks(menuCompany, moduleData);

            return pagesViews;
        }

        async function configurePage(pageCode, snippetList, pagesViews, ctaData) {
            let pageViewId;
            if (pageCode === 'homepage') {
                pageViewId = await (await website.homepageId).viewId;
            }
            else {
                pageViewId = this.env.items('ir.ui.view').browse(await pagesViews[pageCode]);
            }
            const renderedSnippets = [];
            let nbSnippets = len(snippetList);
            for (const [i, snippet] of enumerate(snippetList, 1)) {
                try {
                    const viewId = await (await this.env.items('website').withContext({ websiteId: website.id, lang: await (await website.defaultLangId).code })).viewref('website.' + snippet);
                    if (viewId.ok) {
                        const el = parseXml(await viewId._render(ctaData));

                        // Add the data-snippet attribute to identify the snippet
                        // for compatibility code
                        el.setAttribute('data-snippet', snippet);

                        // Tweak the shape of the first snippet to connect it
                        // properly with the header color in some themes
                        if (i == 1) {
                            const shapeEl = xpath.select1('//*[contains(@class, "o-we-shape")]', el) as Element;
                            if (shapeEl) {
                                shapeEl.setAttribute('class', shapeEl.getAttribute('class') + ' o-header-extra-shape-mapping');
                            }
                        }
                        // Tweak the shape of the last snippet to connect it
                        // properly with the footer color in some themes
                        if (i == nbSnippets) {
                            const shapeEl = xpath.select1('//*[contains(@class, "o-we-shape")]', el) as Element;
                            if (shapeEl) {
                                shapeEl.setAttribute('class', shapeEl.getAttribute('class') + ' o-footer-extra-shape-mapping');
                            }
                        }
                        const renderedSnippet = toText(serializeXml(el));
                        renderedSnippets.push(renderedSnippet);
                    }
                } catch (e) {
                    if (isInstance(e, ValueError)) {
                        console.warn(e);
                    } else {
                        throw e;
                    }
                }
            }
            await pageViewId.save(renderedSnippets.join(''), "(//div[contains(@class, 'oe-structure')])[last()]");
        }

        async function setImages(images) {
            const names = await (await this.env.items('ir.model.data').search([
                ['label', '=ilike', `configurator\\_${website.id}\\_%`],
                ['module', '=', 'website'],
                ['model', '=', 'ir.attachment']
            ])).mapped('label');
            for (const [name, url] of Object.entries<string>(images)) {
                const extnIdentifier = f('configurator_%s_%s', website.id, name.split('.')[1]);
                if (names.includes(extnIdentifier)) {
                    continue;
                }
                let err, res;
                try {
                    res = await httpGet(url, { timeout: 3 });
                    res.raiseForStatus();
                } catch (e) {
                    console.warn("Failed to download image: %s.\n%s", url, e.message);
                    err = e;
                }
                if (!err) {
                    const attachment = await this.env.items('ir.attachment').create({
                        'label': name,
                        'websiteId': website.id,
                        'key': name,
                        'type': 'binary',
                        'raw': res.content,
                        'isPublic': true,
                    })
                    await this.env.items('ir.model.data').create({
                        'label': extnIdentifier,
                        'module': 'website',
                        'model': 'ir.attachment',
                        'resId': attachment.id,
                        'noupdate': true,
                    })
                }
            }
        }

        const self = this;
        let website = await this.getCurrentWebsite();
        const themeName = kwargs['themeName'];
        const theme = await this.env.items('ir.module.module').search([['label', '=', themeName]]);
        const url = await theme.buttonChooseTheme();

        // Force to refresh env after install of module
        assert(this.env.registry === await registry());

        await website.set('configuratorDone', true);

        // Enable tour
        const tourAssetId = await this.env.ref('website.configuratorTour');
        await tourAssetId.copy({ 'key': await tourAssetId.key, 'websiteId': website.id, 'active': true });

        // Set logo from generated attachment or from company's logo
        const logoAttachmentId = kwargs['logoAttachmentId'];
        const company = await website.companyId;
        const logo = await company.logo;
        if (bool(logoAttachmentId)) {
            const attachment = this.env.items('ir.attachment').browse(logoAttachmentId);
            await attachment.write({
                'resModel': 'website',
                'resField': 'logo',
                'resId': website.id,
            });
        }
        else if (!bool(logoAttachmentId) && logo && logo !== await company._getLogo()) {
            await website.set('logo', Buffer.from(logo).toString('utf-8'));
        }

        // palette
        const palette = kwargs['selectedPalette'];
        if (bool(palette)) {
            await setColors(palette);
        }

        // Update CTA
        const ctaData = await website.getCtaData(kwargs['websitePurpose'], kwargs['websiteType']);
        if (ctaData['ctaBtnText']) {
            const xpathView = 'website.snippets';
            const parentView = await (await this.env.items('website').withContext({ websiteId: website.id })).viewref(xpathView);
            await this.env.items('ir.ui.view').create({
                'label': await parentView.key + ' CTA',
                'key': await parentView.key + "_cta",
                'inheritId': parentView.id,
                'websiteId': website.id,
                'type': 'qweb',
                'priority': 32,
                'archDb': f(`
                        <data>
                            <xpath expr="//t[@t-set='ctaBtnHref']" position="replace">
                                <t t-set="ctaBtnHref">%s</t>
                            </xpath>
                            <xpath expr="//t[@t-set='ctaBtnText']" position="replace">
                                <t t-set="ctaBtnText">%s</t>
                            </xpath>
                        </data>
                    `, ctaData['ctaBtnHref'], ctaData['ctaBtnText'])
            });
            try {
                const viewId = await this.env.items('website').viewref('website.headerCallToAction');
                if (bool(viewId)) {
                    const el = parseXml(await viewId.archDb);
                    const btnCtaEl = xpath.select1('//a[contains(@class, "btn-cta")]', el) as Element;
                    if (btnCtaEl) {
                        btnCtaEl.setAttribute('href', ctaData['ctaBtnHref']);
                        btnCtaEl.nodeValue = ctaData['ctaBtnText'];
                    }
                    await (await viewId.withContext({ websiteId: website.id })).write({ 'archDb': serializeXml(el) });
                }
            } catch (e) {
                if (isInstance(e, ValueError)) {
                    console.warn(e)
                } else {
                    throw e;
                }
            }
        }
        // modules
        const pagesViews = await setFeatures(kwargs['selectedFeatures']);
        // We need to refresh the environment of website because set_features installed some new module
        // and we need the overrides of these new menus e.g. for .get_cta_data()
        website = this.env.items('website').browse(website.id);

        // Update footers links, needs to be done after `set_features` to go
        // through module overide of `configurator_get_footer_links`
        const footerLinks = await website.configuratorGetFooterLinks();
        const footerIds = [
            'website.templateFooterContact', 'website.templateFooterHeadline',
            'website.footerCustom', 'website.templateFooterLinks',
            'website.templateFooterMinimalist',
        ]
        for (const footerId of footerIds) {
            try {
                const viewId = this.env.items('website').viewref(footerId);
                if (bool(viewId)) {
                    // Deliberately hardcode dynamic code inside the view arch,
                    // it will be transformed into static nodes after a save/edit
                    // thanks to the t-ignore in parents node.
                    const archString = parseXml(await viewId.archDb);
                    const el = xpath.select1('//t[@t-set="configuratorFooterLinks"]', archString) as Element;
                    el.setAttribute('t-value', stringify(footerLinks));
                    await (await viewId.withContext({ websiteId: website.id })).write({ 'archDb': serializeXml(archString) });
                }
            } catch (e) {
                // The xml view could have been modified in the backend, we don't
                // want the xpath error to break the configurator feature
                console.warn(e);
            }
        }
        // Load suggestion from iap for selected pages
        const customResources = await this._websiteApiRpc(
            f('/api/website/2/configurator/custom_resources/%s', kwargs['industryId']),
            { 'theme': themeName, }
        )

        // Update pages
        const requestedPages = Object.keys(pagesViews).concat(['homepage']);
        const snippetLists = await website.getThemeSnippetLists(themeName);
        for (const pageCode of requestedPages) {
            await configurePage(pageCode, snippetLists[pageCode] ?? [], pagesViews, ctaData);
        }
        const images = customResources['images'] ?? {};
        await setImages(images);
        return url;
    }

    // Page Management
    async _bootstrapHomepage() {
        let page = this.env.items('website.page');
        const standardHomepage = await this.env.ref('website.homepage', false);
        if (!bool(standardHomepage)) {
            return;
        }

        // keep strange indentation in file, to get it correctly in database
        const newHomepageView = f(`<t name="Homepage" t-name="website.homepage%s">
            <t t-call="website.layout">
                <t t-set="pageName" t-value="'homepage'"/>
                <div id="wrap" class="oe-structure oe-empty"/>
            </t>
        </t>`, this.id);
        await (await standardHomepage.withContext({ websiteId: this.id })).set('archDb', newHomepageView);

        let homepagePage = await page.search([
            ['websiteId', '=', this.id],
            ['key', '=', standardHomepage.key],
        ], { limit: 1 });
        if (!homepagePage.ok) {
            homepagePage = await page.create({
                'websitePublished': true,
                'url': '/',
                'viewId': (await (await this.withContext({ websiteId: this.id })).viewref('website.homepage')).id,
            })
        }
        // prevent /-1 as homepage URL
        await homepagePage.set('url', '/');
        await this.set('homepageId', homepagePage);

        // Bootstrap default menu hierarchy, create a new minimalist one if no default
        const defaultMenu = await this.env.ref('website.mainMenu');
        await this.copyMenuHierarchy(defaultMenu);
        const homeMenu = await this.env.items('website.menu').search([['websiteId', '=', this.id], ['url', '=', '/']]);
        await homeMenu.set('pageId', await this['homepageId']);
    }

    async copyMenuHierarchy(topMenu) {
        async function copyMenu(websiteId, menu, tMenu) {
            const newMenu = await menu.copy({
                'parentId': tMenu.id,
                'websiteId': websiteId,
            })
            for (const submenu of await menu.childId) {
                await copyMenu(websiteId, submenu, newMenu);
            }
        }
        
        for (const website of this) {
            const newTopMenu = await topMenu.copy({
                'label': await this._t('Top Menu for Website %s', website.id),
                'websiteId': website.id,
            })
            for (const submenu of await topMenu.childId) {
                await copyMenu(this.id, submenu, newTopMenu);
            }
        }
    }
    /**
     * Create a new website page, and assign it a xmlid based on the given one
            :param name : the name of the page
            :param add_menu : if true, add a menu for that page
            :param template : potential xmlid of the page to create
            :param namespace : module part of the xmlid if none, the template module name is used
            :param page_values : default values for the page to be created
            :param menu_values : default values for the menu to be created
     * @param name 
     * @param addMenu 
     * @param template 
     * @param ispage 
     * @param namespace 
     * @param pageValues 
     * @param menuValues 
     * @returns 
     */
    @api.model()
    async newPage(obj: {label?: any, addMenu?: any, template?: any, ispage?: boolean, namespace?: any, pageValues?: any, menuValues?: any}={}) {
        const template = obj.template || 'website.defaultPage';
        const ispage = obj.ispage || true;
        let label = obj.label;
        let templateModule;
        if (obj.namespace) {
            templateModule = obj.namespace;
        }
        else {
            [templateModule,] = template.split('.');
        }
        let pageUrl = '/' + slugify(label, 1024, true);
        pageUrl = await this.getUniquePath(pageUrl);
        let pageKey = slugify(label);
        const result = { 'url': pageUrl }

        if (!label) {
            label = 'Home';
            pageKey = 'home';
        }
        const templateRecord = await this.env.ref(template);
        const websiteId = this._context['websiteId'];
        const key = await this.getUniqueKey(pageKey, templateModule);
        const view = await templateRecord.copy({ 'websiteId': websiteId, 'key': key });

        await (await view.withContext({ lang: null })).write({
            'arch': (await templateRecord.arch).replace(template, key),
            'label': label,
        })
        result['viewId'] = view.id;

        if (await view.archFs) {
            await view.set('archFs', false);
        }
        let page;
        let website = await this.getCurrentWebsite();
        if (ispage) {
            const defaultPageValues = {
                'url': pageUrl,
                'websiteId': website.id,  // remove it if only one website or not?
                'viewId': view.id,
                'track': true,
            }
            if (bool(obj.pageValues)) {
                update(defaultPageValues, obj.pageValues);
            }
            page = await this.env.items('website.page').create(defaultPageValues);
            result['pageId'] = page.id;
        }
        if (obj.addMenu) {
            const defaultMenuValues = {
                'label': label,
                'url': pageUrl,
                'parentId': (await website.menuId).id,
                'pageId': page.id,
                'websiteId': website.id,
            }
            if (bool(obj.menuValues)) {
                update(defaultMenuValues, obj.menuValues);
            }
            const menu = await this.env.items('website.menu').create(defaultMenuValues);
            result['menuId'] = menu.id;
        }
        return result;
    }

    @api.model()
    async guessMimetype() {
        return _guessMimetype();
    }

    /**
     * Given an url, return that url suffixed by counter if it already exists
            :param pageUrl : the url to be checked for uniqueness
     * @param pageUrl 
     * @returns 
     */
    async getUniquePath(pageUrl) {
        let inc = 0;
        // we only want a unique_path for website specific.
        // we need to be able to have /url for website: false, and /url for website=1
        // in case of duplicate, page manager will allow you to manage this case
        const domainStatic = [['websiteId', '=', (await this.getCurrentWebsite()).id]]  // .website_domain()
        let pageTemp = pageUrl;
        do {
            const page = await (await (await this.env.items('website.page').withContext({ activeTest: false })).sudo()).search([['url', '=', pageTemp]].concat(domainStatic));
            if (!page.ok) {
                break;
            }
            inc += 1;
            pageTemp = pageUrl + (inc && f("-%s", inc) || "");
        } while (true);
        return pageTemp;
    }

    /**
     * Given a string, return an unique key including module prefix.
            It will be suffixed by a counter if it already exists to garantee uniqueness.
            :param string : the key to be checked for uniqueness, you can pass it with 'website.' or not
            :param template_module : the module to be prefixed on the key, if not set, we will use website
     * @param text 
     * @param templateModule 
     * @returns 
     */
    async getUniqueKey(text, templateModule?: false) {
        if (templateModule) {
            text = templateModule + '.' + text;
        }
        else {
            if (!text.startsWith('website.')) {
                text = 'website.' + text;
            }
        }
        // Look for unique key
        let keyCopy = text;
        let inc = 0;
        const domainStatic = (await this.getCurrentWebsite()).websiteDomain();
        do {
            const view = await (await (await this.env.items('ir.ui.view').withContext({ activeTest: false })).sudo()).search([['key', '=', keyCopy]].concat(domainStatic));
            if (!view.ok) {
                break;
            }
            inc += 1;
            keyCopy = text + (inc && f("-%s", inc) || "");
        } while (true);
        return keyCopy;
    }

    /**
     * Search dependencies just for information. It will not catch 100%
            of dependencies and false positive is more than possible
            Each module could add dependences in this dict
            :returns a dictionnary where key is the 'categorie' of object related to the given
                view, and the value is the list of text and link to the resource using given page
     * @param pageId 
     * @returns 
     */
    @api.model()
    async pageSearchDependencies(pageId?: any) {
        const dependencies = {};
        if (!pageId) {
            return dependencies;
        }
        const page = this.env.items('website.page').browse(parseInt(pageId));
        const website = this.env.items('website').browse(this._context['websiteId']);
        let url = await page.url;

        // search for website_page with link
        const websitePageSearchDom = [['viewId.archDb', 'ilike', url]].concat(website.websiteDomain());
        const pages = await this.env.items('website.page').search(websitePageSearchDom);
        let pageKey = await this._t('Page');
        if (len(pages) > 1) {
            pageKey = await this._t('Pages');
        }
        const pageViewIds = [];
        for (const p of pages) {
            setdefault(dependencies, pageKey, []);
            dependencies[pageKey].push({
                'text': await this._t('Page <b>%s</b> contains a link to this page', await p.url),
                'item': await p.label,
                'link': p.url,
            });
            pageViewIds.push((await p.viewId).id);
        }
        // search for ir_ui_view (not from a website_page) with link
        const pageSearchDom = [['archDb', 'ilike', url], ['id', 'not in', pageViewIds]].concat(website.websiteDomain());
        const views = await this.env.items('ir.ui.view').search(pageSearchDom);
        let viewKey = await this._t('Template');
        if (len(views) > 1) {
            viewKey = await this._t('Templates');
        }
        for (const view of views) {
            const [key, label] = await view('key', 'label');
            setdefault(dependencies, viewKey, []);
            dependencies[viewKey].push({
                'text': await this._t('Template <b>%s (id:%s)</b> contains a link to this page', key || label, view.id),
                'link': f('/web#id=%s&viewType=form&model=ir.ui.view', view.id),
                'item': await this._t('%s (id:%s)', key || label, view.id),
            });
        }
        // search for menu with link
        const menuSearchDom = [['url', 'ilike', f('%s', url)]].concat(website.websiteDomain());

        const menus = await this.env.items('website.menu').search(menuSearchDom);
        let menuKey = await this._t('Menu');
        if (len(menus) > 1) {
            menuKey = await this._t('Menus');
        }
        for (const menu of menus) {
            setdefault(dependencies, menuKey, []).push({
                'text': await this._t('This page is in the menu <b>%s</b>', await menu.label),
                'link': f('/web#id=%s&viewType=form&model=website.menu', menu.id),
                'item': await menu.label,
            })
        }
        return dependencies
    }

    /**
     * Search dependencies just for information. It will not catch 100%
            of dependencies and false positive is more than possible
            Each module could add dependences in this dict
            :returns a dictionnary where key is the 'categorie' of object related to the given
                view, and the value is the list of text and link to the resource using given page
     * @param pageId 
     * @returns 
     */
    @api.model()
    async pageSearchKeyDependencies(pageId?: any) {
        const dependencies = {}
        if (!pageId) {
            return dependencies;
        }
        const page = this.env.items('website.page').browse(parseInt(pageId));
        const website = this.env.items('website').browse(this._context['websiteId']);
        let key = await page.key;

        // search for website_page with link
        const websitePageSearchDom = [
            ['viewId.archDb', 'ilike', key],
            ['id', '!=', page.id]
        ].concat(website.websiteDomain());
        const pages = await this.env.items('website.page').search(websitePageSearchDom);
        let pageKey = await this._t('Page');
        if (len(pages) > 1) {
            pageKey = await this._t('Pages');
        }
        const pageViewIds = [];
        for (const p of pages) {
            setdefault(dependencies, pageKey, []);
            dependencies[pageKey].push({
                'text': await this._t('Page <b>%s</b> is calling this file', await p.url),
                'item': await p.label,
                'link': await p.url,
            })
            pageViewIds.push((await p.viewId).id);
        }
        // search for ir_ui_view (not from a website_page) with link
        const pageSearchDom = [
            ['archDb', 'ilike', key], ['id', 'not in', pageViewIds],
            ['id', '!=', (await page.viewId).id],
        ].concat(website.websiteDomain());
        const views = await this.env.items('ir.ui.view').search(pageSearchDom);
        let viewKey = await this._t('Template');
        if (len(views) > 1) {
            viewKey = await this._t('Templates');
        }
        for (const view of views) {
            const [key, label] = await view('key', 'label');
            setdefault(dependencies, viewKey, []);
            dependencies[viewKey].push({
                'text': await this._t('Template <b>%s (id:%s)</b> is calling this file', key || label, view.id),
                'item': await this._t('%s (id:%s)', key || label, view.id),
                'link': f('/web#id=%s&viewType=form&model=ir.ui.view', view.id),
            });
        }
        return dependencies;
    }

    // Languages

    async _getAlternateLanguages(req, canonicalParams) {
        this.ensureOne();

        if (! await this._isCanonicalUrl(req, canonicalParams)) {
            // no hreflang on non-canonical pages
            return [];
        }

        const languages = await this['languageIds'];
        if (len(languages) <= 1) {
            // no hreflang if no alternate language
            return [];
        }

        const langs = [];
        const shorts = [];

        for (const lg of languages) {
            const lgCodes = (await lg.code).split('_');
            const short = lgCodes[0];
            shorts.push(short);
            langs.push({
                'hreflang': lgCodes.join('-').toLowerCase(),
                'short': short,
                'href': await this._getCanonicalUrlLocalized(req, lg, canonicalParams),
            });
        }
        // if there is only one region for a language, use only the language code
        for (const lang of langs) {
            if (shorts.filter(x => x === lang['short']).length == 1) {
                lang['hreflang'] = lang['short'];
            }
        }
        // add the default
        langs.push({
            'hreflang': 'x-default',
            'href': await this._getCanonicalUrlLocalized(req, await this['defaultLangId'], canonicalParams),
        })

        return langs;
    }

    // Utilities

    /**
     * The current website is returned in the following order:
        - the website forced in session `force_website_id`
        - the website set in context
        - (if frontend or fallback) the website matching the request's "domain"
        - arbitrary the first website found in the database if `fallback` is set
          to `true`
        - empty browse record
     * @param fallback 
     */
    @api.model()
    async getCurrentWebsite(fallback: boolean = true) {
        const req = this.env.req;
        const isFrontendRequest = req && getattr(req, 'isFrontend', false);
        let websiteId;
        if (req && req.session['forceWebsiteId']) {
            websiteId = await this.browse(req.session['forceWebsiteId']).exists();
            if (!bool(websiteId)) {
                // Don't crash is session website got deleted
                req.session.pop('forceWebsiteId');
            }
            else {
                return websiteId;
            }
        }
        websiteId = await this.env.context['websiteId'];
        if (bool(websiteId)) {
            return this.browse(websiteId);
        }

        if (!isFrontendRequest && !fallback) {
            // It's important than backend requests with no fallback requested
            // don't go through
            return this.browse(false);
        }
        // Reaching this point means that:
        // - We didn't find a website in the session or in the context.
        // - And we are either:
        //   - in a frontend context
        //   - in a backend context (or early in the dispatch stack) and a
        //     fallback website is requested.
        // We will now try to find a website matching the request host/domain (if
        // there is one on request) or return a random one.

        // The format of `httpRequest.host` is `domain:port`
        const domainName = req && req.uri.hostname || '';

        const country = req && req.session.geoip ? req.session.geoip['countryCode'] : false
        let countryId = false;
        if (bool(country)) {
            countryId = (await this.env.items('res.country').search([['code', '=', country]], { limit: 1 })).id;
        }
        websiteId = await this._getCurrentWebsiteId(domainName, countryId, fallback);
        return this.browse(websiteId);
    }

    /**
     * Get the current website id.
  
          First find all the websites for which the configured `domain` (after
          ignoring a potential scheme) is equal to the given
          `domain_name`. If there is only one result, return it immediately.
  
          If there are no website found for the given `domain_name`, either
          fallback to the first found website (no matter its `domain`) or return
          false depending on the `fallback` parameter.
  
          If there are multiple websites for the same `domain_name`, we need to
          filter them out by country. We return the first found website matching
          the given `countryId`. If no found website matching `domain_name`
          corresponds to the given `countryId`, the first found website for
          `domain_name` will be returned (no matter its country).
  
          :param domain_name: the domain for which we want the website.
              In regard to the `url_parse` method, only the `netloc` part should
              be given here, no `scheme`.
          :type domain_name: string
  
          :param countryId: id of the country for which we want the website
          :type countryId: int
  
          :param fallback: if true and no website is found for the specificed
              `domain_name`, return the first website (without filtering them)
          :type fallback: bool
  
          :return: id of the found website, or false if no website is found and
              `fallback` is false
          :rtype: int or false
  
          :raises: if `fallback` is true but no website at all is found
     * @param domainName 
     * @param countryId 
     * @param fallback 
     * @returns 
     */
    @tools.ormcache('domainName', 'countryId', 'fallback')
    @api.model()
    async _getCurrentWebsiteId(domainName, countryId, fallback: boolean = true) {

        function _removePort(domainName) {
            return (domainName || '').split(':')[0];
        }

        /**
         * Ignore `scheme` from the `domain`, just match the `netloc` which
            is host:port in the version of `url_parse` we use.
         * @param website 
         * @param domainName 
         * @param ignorePort 
         * @returns 
         */
        async function _filterDomain(website, domainName, ignorePort: boolean = false) {
            // Here we add http:// to the domain if it's not set because
            // `url_parse` expects it to be set to correctly return the `netloc`.
            let websiteDomain = urlParse(await website._getHttpDomain()).host || '';
            if (ignorePort) {
                websiteDomain = _removePort(websiteDomain);
                domainName = _removePort(domainName);
            }
            return websiteDomain.toLowerCase() === (domainName || '').toLowerCase();
        }

        // Sort on countryGroupIds so that we fall back on a generic website:
        // websites with empty countryGroupIds will be first.
        const foundWebsites = await (await this.search([['domain', 'ilike', _removePort(domainName)]])).sorted('countryGroupIds');
        // Filter for the exact domain (to filter out potential subdomains) due
        // to the use of ilike.
        let websites = await foundWebsites.filtered(async (w) => _filterDomain(w, domainName));
        // If there is no domain matching for the given port, ignore the port.
        websites = websites.ok ? websites : await foundWebsites.filtered(async (w) => _filterDomain(w, domainName, true));

        if (!bool(websites)) {
            if (!fallback) {
                return false;
            }
            return (await this.search([], { limit: 1 })).id;
        }
        else if (len(websites) == 1) {
            return websites.id;
        }
        else {  // > 1 website with the same domain
            const countrySpecificWebsites = await websites.filtered(async (website) => (await (await website.countryGroupIds).mapped('countryIds')).ids.includes(countryId));
            return countrySpecificWebsites.ok ? countrySpecificWebsites[0].id : websites[0].id;
        }
    }

    async _force() {
        await this._forceWebsite(this.id);
    }

    async _forceWebsite(websiteId) {
        if (this.env.req) {
            this.env.req.session['forceWebsiteId'] = websiteId && isDigit(String(websiteId)) && parseInt(websiteId);
        }
    }

    @api.model()
    async isPublisher() {
        return this.env.items('ir.model.access').check('ir.ui.view', 'write', false);
    }

    @api.model()
    async isUser() {
        return this.env.items('ir.model.access').check('ir.ui.menu', 'read', false);
    }

    @api.model()
    async isPublicUser() {
        const req = this.env.req;
        return (await (await req.getEnv()).user()).id == await req.website._getCached('userId');
    }

    /**
     * Given an xmlid or a viewId, return the corresponding view record.
            In case of website context, return the most specific one.

            If no websiteId is in the context, it will return the generic view,
            instead of a random one like `get_view_id`.

            Look also for archived views, no matter the context.

            :param viewId: either a string xmlid or an integer viewId
            :param raise_if_not_found: should the method raise an error if no view found
            :return: The view record or empty recordset
     * @param viewId 
     * @param raiseIfNotFound 
     * @returns 
     */
    @api.model()
    async viewref(viewId, raiseIfNotFound: true) {
        const viewSudo = await this.env.items('ir.ui.view').sudo();
        let view = viewSudo;
        if (typeof viewId === 'string') {
            let domain, order;
            if ('websiteId' in this._context) {
                domain = [['key', '=', viewId]].concat(this.env.items('website').websiteDomain(this._context['websiteId']));
                order = 'websiteId';
            }
            else {
                domain = [['key', '=', viewId]];
                order = viewSudo._order;
            }
            const views = await (await viewSudo.withContext({ activeTest: false })).search(domain, { order: order });
            if (views.ok) {
                view = await views.filterDuplicate();
            }
            else {
                // we handle the raise below
                view = await this.env.ref(viewId, false);
                // self.env.ref might return something else than an ir.ui.view (eg: a theme.ir.ui.view)
                if (!bool(view) || view._name !== 'ir.ui.view') {
                    // make sure we always return a recordset
                    view = viewSudo;
                }
            }
        }
        else if (typeof (viewId) == 'number') {
            view = viewSudo.browse(viewId);
        }
        else {
            throw new ValueError('Expecting a string or an integer, not a %s.', typeof (viewId));
        }
        if (!bool(view) && raiseIfNotFound) {
            throw new ValueError('No record found for unique ID %s. It may have been deleted.', viewId);
        }
        return view;
    }

    @tools.ormcacheContext(['websiteId'])
    async _cacheCustomizeShowViews() {
        let views = await (await (await this.env.items('ir.ui.view').withContext({ activeTest: false })).sudo()).search([['customizeShow', '=', true]]);
        views = await views.filterDuplicate();
        return Object.fromEntries(await views.map(async (v) => v('key', 'active')));
    }

    @tools.ormcacheContext('key', ['websiteId'])
    async isViewActive(key, raiseIfNotFound: false) {
        const views = await this._cacheCustomizeShowViews();
        const view = key in views && views[key];
        if (view == null && raiseIfNotFound) {
            throw new ValueError('No view of type customizeShow found for key %s', key);
        }
        return view;
    }

    @api.model()
    async getTemplate(template) {
        const view = this.env.items('ir.ui.view');
        let viewId;
        if (typeof (template) === 'number') {
            viewId = template;
        }
        else {
            if (!template.includes('.')) {
                template = f('website.%s', template);
            }
            viewId = await view.getViewId(template);
        }
        if (!bool(viewId)) {
            throw new NotFound();
        }
        return (await view.sudo()).browse(viewId);
    }

    @api.model()
    async pager(opts: { url?: string, total?: number, page?: number, step?: number, scope?: number, urlArgs?: any } = {}) {
        update(opts, { page: 1, step: 30, scope: 5 });
        return pager(opts);
    }

    /**
     * Checks that it is possible to generate sensible GET queries for
            a given rule (if the endpoint matches its own requirements)
            :type rule: theveb.routing.Rule
            :rtype: bool
     * @param rule 
     * @returns 
     */
    async ruleIsEnumerable(rule: Rule) {
        const endpoint = rule.endpoint;
        const methods = endpoint.routing.get('methods') || ['GET'];

        const converters = Object.values(rule.converters);
        if (!(methods.includes('GET') &&
            endpoint.routing['type'] === 'http' &&
            ['none', 'public'].includes(endpoint.routing['auth']) &&
            endpoint.routing.get('website', false) &&
            converters.every(converter => hasattr(converter, 'generate')))) {
            return false;
        }

        // dont't list routes without argument having no default value or converter
        const params = getArgumentNames(endpoint.method.originalFunc);
        const hasNoDefault = (p) => p[2] === undefined;

        // check that all args have a converter
        return params.filter(p => hasNoDefault(p)).every(p => p[0] in rule.converters)
    }

    /**
     * Available pages in the website/CMS. This is mostly used for links
            generation and can be overridden by modules setting up new HTML
            controllers for dynamic pages (e.g. blog).
            By default, returns template views marked as pages.
            :param str query_string: a (user-provided) string, fetches pages
                                     matching the string
            :returns: a list of mappings with two keys: ``name`` is the displayable
                      name of the resource (page), ``url`` is the absolute URL
                      of the same.
            :rtype: list({name: str, url: str})
     * @param searchQuery 
     * @param force 
     */
    async* _enumeratePages(searchQuery: any = null, force: boolean = false) {
        const router = await _root.getDbRouter(this.env.req, this.env.req.db);
        const urlSet = new Set();

        const sitemapEndpointDone = new Set<Endpoint>();

        for (const rule of router.iterRules()) {
            if ('sitemap' in rule.endpoint.routing && rule.endpoint.routing['sitemap'] != true) {
                if (sitemapEndpointDone.has(rule.endpoint)) {
                    continue;
                }
                sitemapEndpointDone.add(rule.endpoint);

                const func = rule.endpoint.routing['sitemap'];
                if (func == false) {
                    continue;
                }
                for (const loc of await func(this.env, rule, searchQuery)) {
                    yield loc;
                }
                continue;
            }

            if (! await this.ruleIsEnumerable(rule)) {
                continue;
            }

            if (!('sitemap' in rule.endpoint.routing)) {
                console.warn('No Sitemap value provided for controller %s (%s)', rule.endpoint.method, rule.endpoint.routing['routes'].join(','));
            }
            const converters = rule.converters ?? {};
            if (searchQuery && !bool(converters) && (!(searchQuery in rule.build({}, false)[1]))) {
                continue;
            }

            let values = [{}];
            // converters with a domain are processed after the other ones
            const convitems = sorted(
                Object.entries(converters),
                (x) => (hasattr(x[1], 'domain') && (x[1].domain !== '[]'), rule._trace.index([true, x[0]]))
            );

            for (const [i, [name, converter]] of enumerate(convitems)) {
                if ('websiteId' in this.env.items(converter.model)._fields && (!converter.domain || converter.domain == '[]')) {
                    converter.domain = "[['websiteId', 'in', [false, currentWebsiteId]]]";
                }

                const newval = [];
                for (const val of values) {
                    let query = (i == len(convitems) - 1) && searchQuery;
                    if (query) {
                        const r = rule._trace.slice(1).filter(x => !x[0]).map(x => x[1]).join("")  // remove model converter from route
                        query = sitemapQs2dom(query, r, this.env.items(converter.model)._recName);
                        if (query == FALSE_DOMAIN) {
                            continue;
                        }
                    }
                    for (const rec of converter.generate({ uid: this.env.uid, dom: query, args: val })) {
                        newval.push(Object.assign({}, val));
                        update(newval.slice(-1)[0], { [name]: rec });
                    }
                }
                values = newval;
            }

            for (const value of values) {
                const [domainPart, url] = rule.build(value, false);
                if (!searchQuery || url.toLowerCase().includes(searchQuery.toLowerCase())) {
                    const page = { 'loc': url }
                    if (urlSet.has(url)) {
                        continue;
                    }
                    urlSet.add(url);

                    yield page;
                }
            }
        }
        // '/' already has a http.route & is in the routing_map so it will already have an entry in the xml
        let domain: any[] = [['url', '!=', '/']];
        if (!force) {
            domain = domain.concat([['websiteIndexed', '=', true], ['visibility', '=', false]]);
            // isVisible
            domain = domain.concat([
                ['websitePublished', '=', true], ['visibility', '=', false],
                '|', ['datePublish', '=', false], ['datePublish', '<=', _Datetime.now()]
            ]);
        }
        if (searchQuery) {
            domain = domain.concat([['url', 'like', searchQuery]]);
        }

        const pages = await this._getWebsitePages(domain);

        for (const page of pages) {
            const record = { 'loc': page['url'], 'id': page['id'], 'label': page['label'] };
            const viewId = await page.viewId;
            if (bool(viewId) && await viewId.priority != 16) {
                record['priority'] = Math.min(floatRound(await viewId.priority / 32.0, { precisionDigits: 1 }), 1);
            }
            if (await page['updatedAt']) {
                record['lastmod'] = (await page['updatedAt']).date();
            }
            yield record;
        }
    }

    async _getWebsitePages(domain?: any, order: string = 'name', limit?: any) {
        if (domain == null) {
            domain = [];
        }
        domain = domain.concat((await this.getCurrentWebsite()).websiteDomain());
        domain = expression.AND([domain, [['url', '!=', false]]]);
        let pages = await (await this.env.items('website.page').sudo()).search(domain, { order: order, limit: limit });
        // TODO In 16.0 remove condition on _filter_duplicate_pages.
        if (this.env.context['_filterDuplicatePages']) {
            pages = await pages._getMostSpecificPages();
        }
        return pages;
    }

    async searchPages(needle?: any, limit?: any) {
        const name = slugify(needle, 50, true);
        const res = [];
        for await (const page of this._enumeratePages(name, true)) {
            res.push(page);
            if (len(res) == limit) {
                break;
            }
        }
        return res;
    }

    /**
     * Returns a tuple (name, url, icon).
            Where icon can be a module name, or a path
     */
    async getSuggestedControllers(req) {
        const suggestedControllers = [
            [await this._t('Homepage'), await urlFor(req, '/'), 'website'],
            [await this._t('Contact Us'), await urlFor(req, '/contactus'), 'website_crm'],
        ];
        return suggestedControllers;
    }

    /**
     * Returns a local url that points to the image field of a given browse record.
     * @param record 
     * @param field 
     * @param size 
     * @returns 
     */
    @api.model()
    async imageUrl(record, field, size?: any) {
        const sudoRecord = await record.sudo();
        const sha = sha512(String(await sudoRecord['__lastUpdate'])).slice(0, 7);
        size = size == null ? '' : f('/%s', size);
        const url = f('/web/image/%s/%s/%s%s?unique=%s', record._name, record.id, field, size, sha);
        return url;
    }

    async getCdnUrl(uri) {
        this.ensureOne();
        if (!uri) {
            return '';
        }
        const cdnUrl = await this['cdnUrl'];
        const cdnFilters = (await this['cdnFilters'] || '').split('\n');
        for (const flt of cdnFilters) {
            if (flt && uri.match(flt)) {
                return urlJoin(cdnUrl, uri);
            }
        }
        return uri;
    }

    @api.model()
    async actionDashboardRedirect() {
        const user = await this.env.user();
        if (await user.hasGroup('base.groupSystem') || await user.hasGroup('website.groupWebsiteDesigner')) {
            return this.env.items("ir.actions.actions")._forXmlid("website.backendDashboard");
        }
        return this.env.items("ir.actions.actions")._forXmlid("website.actionWebsite");
    }

    async buttonGoWebsite(req, path: string = '/', modeEdit: boolean = false) {
        await this._force();
        if (modeEdit) {
            // If the user gets on a translated page (e.g /fr) the editor will
            // never start. Forcing the default language fixes this issue.
            path = await urlFor(req, path, await (await this['defaultLangId']).urlCode);
            path += '?enableEditor=1';
        }
        return {
            'type': 'ir.actions.acturl',
            'url': path,
            'target': 'self',
        }
    }

    /**
     * Get the domain of the current website, prefixed by http if no
        scheme is specified.

        Empty string if no domain is specified on the website.
     * @returns 
     */
    async _getHttpDomain() {
        this.ensureOne();
        const domain = await this['domain'];
        if (!domain) {
            return '';
        }
        const res = urlParse(domain);
        return !res.protocol ? 'http://' + domain : domain;
    }

    /**
     * Returns the canonical URL for the current request with translatable
        elements appropriately translated in `lang`.

        If `request.endpoint` is not true, returns the current `path` instead.

        `url_quote_plus` is applied on the returned path.
     * @param req 
     * @param lang 
     * @param canonicalParams 
     */
    async _getCanonicalUrlLocalized(req, lang, canonicalParams) {
        this.ensureOne();
        let path;
        if (req.endpoint) {
            const router = (await _root.getDbRouter(req, req.db)).bindToRoute({ serverName: '' });
            const args = Object.assign({}, req.endpointArgs);
            for (const [key, val] of Object.entries<BaseModel>(args)) {
                if (isInstance(val, BaseModel)) {
                    const code = await lang.code;
                    if (val.env.context['lang'] !== code) {
                        args[key] = await val.withContext({ lang: code });
                    }
                }
            }
            path = await router.build(req.endpoint, args);
        }
        else {
            // The build method returns a quoted URL so convert in this case for consistency.
            path = urlQuotePlus(req.httpRequest.pathname, '/');
        }
        const langPath = !lang.eq(await this['defaultLangId']) ? ('/' + await lang.urlCode) : '';
        const canonicalQueryString = f('?%s', canonicalParams ? urlEncode(canonicalParams) : '');

        let localizedPath;
        if (langPath && path === '/') {
            // We want `/fr_BE` not `/fr_BE/` for correct canonical on homepage
            localizedPath = langPath;
        }
        else {
            localizedPath = langPath + path;
        }
        return await this.getBaseUrl() + localizedPath + canonicalQueryString;
    }

    async _getCanonicalUrl(req, canonicalParams) {
        this.ensureOne();
        return this._getCanonicalUrlLocalized(req, req.lang, canonicalParams);
    }

    /**
     * Returns whether the current request URL is canonical.
     * @param canonicalParams 
     * @returns 
     */
    async _isCanonicalUrl(req, canonicalParams) {
        this.ensureOne();
        // Compare OrderedMultiDict because the order is important, there must be
        // only one canonical and not params permutations.
        const params = req.params;
        canonicalParams = canonicalParams || new OrderedMultiDict();
        if (!equal(params, canonicalParams)) { // Tony check
            return false;
        }
        // Compare URL at the first rerouting iteration (if available) because
        // it's the one with the language in the path.
        // It is important to also test the domain of the current URL.
        const currentUrl = req.httpRequest.urlRoot.slice(0, -1) + (hasattr(req, 'rerouting') && req.rerouting[0] || req.httpRequest.pathname);
        const canonicalUrl = await this._getCanonicalUrlLocalized(req, req.lang, null);
        // A request path with quotable characters (such as ",") is never
        // canonical because request.httpRequest.baseUrl is always unquoted,
        // and canonical url is always quoted, so it is never possible to tell
        // if the current URL is indeed canonical or not.
        return currentUrl == canonicalUrl;
    }

    @tools.ormcache('self.id')
    async _getCachedValues() {
        this.ensureOne();
        return {
            'userId': (await this['userId']).id,
            'companyId': (await this['companyId']).id,
            'defaultLangId': (await this['defaultLangId']).id,
            'homepageId': (await this['homepageId']).id,
        }
    }

    async _getCached(field) {
        return (await this._getCachedValues())[field];
    }

    async _getHtmlFields() {
        const htmlFields = [['irUiView', 'archDb']];
        const cr = this.env.cr;
        const res = await cr.execute(`
            SELECT f.model,
                   f.label
              FROM "irModelFields" f
              JOIN "irModel" m
                ON m.id = f."modelId"
             WHERE f.ttype = 'html'
               AND f.store = true
               AND m.transient = false
               AND f.model NOT LIKE 'ir.actions%'
               AND f.model != 'mail.message'
        `)
        for (const row of res) {
            const table = this.env.models[row['model']]._table;
            if (await tableExists(cr, table) && columnExists(cr, table, row['label'])) {
                htmlFields.push([table, row['label']]);
            }
        }
        return htmlFields;
    }

    /**
     * Returns every parent snippet asset from the database, filtering out
        their potential overrides defined in other modules. As they share the same
        snippet_id, asset_version and asset_type, it is possible to do that using
        Postgres' DISTINCT ON and ordering by asset_id, as overriden assets will be
        created later than their parents.
        The assets are returned in the form of a list of tuples :
        [(snippet_module, snippet_id, asset_version, asset_type, asset_id)]
     * @returns 
     */
    async _getSnippetsAssets() {
        const res = await this.env.cr.execute(`
            SELECT DISTINCT ON ("snippetId", "assetVersion", "assetType")
                   regexp_matches[1] AS "snippetModule",
                   regexp_matches[2] AS "snippetId",
                   regexp_matches[3] AS "assetVersion",
                   CASE
                       WHEN regexp_matches[4]='scss' THEN 'css'
                       ELSE regexp_matches[4]
                   END AS "assetType",
                   id AS "assetId"
            FROM (
                SELECT REGEXP_MATCHES(PATH, '(\w*)\/.*\/snippets\/(\w*)\/(\d{3})\.(js|scss)'),
                       id
                FROM "irAsset"
            ) AS regexp
            ORDER BY "snippetId", "assetVersion", "assetType", "assetId";
        `)
        return res;
    }

    async _isSnippetUsed(snippetModule, snippetId, assetVersion, assetType, htmlFields) {
        let snippetOccurences = [];
        // Check snippet template definition to avoid disabling its related assets.
        // This special case is needed because snippet template definitions do not
        // have a `data-snippet` attribute (which is added during drag&drop).
        const snippetTemplate = await this.env.ref(`${snippetModule}.${snippetId}`, false);
        if (bool(snippetTemplate)) {
            const snippetTemplateHtml = await snippetTemplate._render();
            const match = snippetTemplateHtml.matchAll(/<([^>]*class="[^>]*)>/g);
            snippetOccurences.push(match.next().value.groups);
        }

        if (await this._checkSnippetUsed(snippetOccurences, assetType, assetVersion)) {
            return true;
        }

        // As well as every snippet dropped in html fields
        const res = await this.env.cr.execute(_f(
            htmlFields.map(([table, column]) => _f(`SELECT regexp_matches("{column}", '{placeholder}', 'g') AS reg FROM "{table}"`, {
                column: column,
                placeholder: '{snippetRegex}',
                table: table
            })).join(' UNION ')
        ), { snippetRegex: `<([^>]*data-snippet="${snippetId}"[^>]*)>` });

        snippetOccurences = res.map(r => r['reg'][0]);
        return this._checkSnippetUsed(snippetOccurences, assetType, assetVersion);
    }

    async _checkSnippetUsed(snippetOccurences, assetType, assetVersion) {
        for (const snippet of snippetOccurences) {
            if (assetVersion === '000') {
                if (!snippet.includes(`data-v${assetType}`)) {
                    return true;
                }
            }
            else {
                if (snippet.includes(`data-v${assetType}="${assetVersion}"`)) {
                    return true;
                }
            }
        }
        return false;
    }

    async _disableUnusedSnippetsAssets() {
        const snippetsAssets = await this._getSnippetsAssets();
        const htmlFields = await this._getHtmlFields();

        for (const { snippetModule, snippetId, assetVersion, assetType } of snippetsAssets) {
            const isSnippetUsed = await this._isSnippetUsed(snippetModule, snippetId, assetVersion, assetType, htmlFields);

            // The regex catches XXX.scss, XXX.js and XXX_variables.scss
            const assetsRegex = `${snippetId}/${assetVersion}.+${assetType}`;

            // The query will also set to active or inactive assets overrides, as they
            // share the same snippet_id, asset_version and filename_type as their parents
            await this.env.cr.execute(_f(`
                UPDATE "irAsset"
                SET active = {active}
                WHERE path ~ '{assetsRegex}'
            `, { "active": isSnippetUsed, "assetsRegex": assetsRegex }));
        }
    }

    /**
     * Builds a search domain AND-combining a base domain with partial matches of each term in
        the search expression in any of the Fields.

        :param domain: base domain combined in the search expression
        :param search: search expression string
        :param fields: list of field names to match the terms of the search expression with
        :param extra: function that returns an additional subdomain for a search term

        :return: domain limited to the matches of the search expression
     * @param domain 
     * @param search 
     * @param fields 
     * @param extra 
     * @returns 
     */
    async _searchBuildDomain(domain, search, fields, extra?: any) {
        const domains = structuredClone(domain);
        if (search) {
            for (const searchTerm of search.split(' ')) {
                const subdomains = [];
                for (const field of fields) {
                    subdomains.push([[field, 'ilike', escapePsql(searchTerm)]]);
                }
                if (extra) {
                    subdomains.push(await extra(this.env, searchTerm));
                }
                domains.push(expression.OR(subdomains));
            }
        }
        return expression.AND(domains);
    }

    /**
     * Returns the plain non-tag text from an html

        :param htmlFragment: document from which text must be extracted

        :return text extracted from the html
     * @param htmlFragment 
     * @returns 
     */
    _searchTextFromHtml(htmlFragment) {
        // lxml requires one single root element
        const tree = parseXml(f('<p>%s</p>', htmlFragment));//, etree.XMLParser(recover: true))
        return tree.toString();
    }

    /**
     * Returns indications on how to perform the searches

        :param searchType: type of search
        :param order: order in which the results are to be returned
        :param options: search options

        :return: list of search details obtained from the `website.searchable.mixin`'s `_search_get_detail()`
     * @param searchType 
     * @param order 
     * @param options 
     * @returns 
     */
    async _searchGetDetails(searchType, order, options) {
        const result = [];
        if (['pages', 'all'].includes(searchType)) {
            result.push(await this.env.items('website.page')._searchGetDetail(this, order, options));
        }
        return result;
    }

    /**
     * Performs a search with a search text or with a resembling word

        :param searchType: indicates what to search within, 'all' matches all available types
        :param search: text against which to match results
        :param limit: maximum number of results per model type involved in the result
        :param order: order on which to sort results within a model type
        :param options: search options from the submitted form containing:
            - allowFuzzy: boolean indicating whether the fuzzy matching must be done
            - other options used by `_search_get_details()`

        :return: tuple containing:
            - count: total number of results across all involved models
            - results: list of results per model (see _search_exact)
            - fuzzy_term: similar word against which results were obtained, indicates there were
                no results for the initially requested search
     * @param searchType 
     * @param search 
     * @param limit 
     * @param order 
     * @param options 
     */
    async _searchWithFuzzy(searchType, search, limit, order, options) {
        let fuzzyTerm: any = false;
        const searchDetails = await this._searchGetDetails(searchType, order, options);
        let count, results;
        if (search && (options['allowFuzzy'] ?? true)) {
            fuzzyTerm = await this._searchFindFuzzyTerm(searchDetails, search);
            if (fuzzyTerm) {
                [count, results] = await this._searchExact(searchDetails, fuzzyTerm, limit, order);
                if (fuzzyTerm.toLowerCase() === search.toLowerCase()) {
                    fuzzyTerm = false;
                }
            }
            else {
                [count, results] = await this._searchExact(searchDetails, search, limit, order);
            }
        }
        else {
            [count, results] = await this._searchExact(searchDetails, search, limit, order);
        }
        return [count, results, fuzzyTerm];
    }

    /**
     * Performs a search with a search text

        :param search_details: see :meth:`_search_get_details`
        :param search: text against which to match results
        :param limit: maximum number of results per model type involved in the result
        :param order: order on which to sort results within a model type

        :return: tuple containing:
            - total number of results across all involved models
            - list of results per model made of:
                - initial search_detail for the model
                - count: number of results for the model
                - results: model list equivalent to a `model.search()`
     * @param searchDetails 
     * @param search 
     * @param limit 
     * @param order 
     * @returns 
     */
    async _searchExact(searchDetails, search, limit, order) {
        const allResults = [];
        let totalCount = 0;
        for (const searchDetail of searchDetails) {
            const model = this.env.items(searchDetail['model']);
            const [results, count] = await model._searchFetch(searchDetail, search, limit, order);
            searchDetail['results'] = results;
            totalCount += count;
            searchDetail['count'] = count;
            allResults.push(searchDetail);
        }
        return [totalCount, allResults];
    }

    /**
     * Prepares data for the autocomplete and hybrid list rendering

        :param search_details: obtained from `_search_exact()`
        :param limit: maximum number or rows to render

        :return: the updated `search_details` containing an additional `results_data` field equivalent
            to the result of a `model.read()`
     * @param searchDetails 
     * @param limit 
     * @returns 
     */
    async _searchRenderResults(searchDetails, limit) {
        for (const searchDetail of searchDetails) {
            const fields = searchDetail['fetchFields'];
            const results = searchDetail['results'];
            const icon = searchDetail['icon'];
            const mapping = searchDetail['mapping'];
            const resultsData = await results._searchRenderResults(fields, mapping, icon, limit);
            searchDetail['resultsData'] = resultsData;
        }
        return searchDetails;
    }

    /**
     * Returns the "closest" match of the search parameter within available words.

        :param search_details: obtained from `_search_get_details()`
        :param search: search term to which words must be matched against
        :param limit: maximum number of records fetched per model to build the word list
        :param word_list: if specified, this list of words is used as possible targets instead of
            the words contained in the match fields of each involved model

        :return: term on which a search can be performed instead of the initial search
     * @param searchDetails 
     * @param search 
     * @param opts 
     * @returns 
     */
    async _searchFindFuzzyTerm(searchDetails, search, opts: { limit?: number, wordList?: any } = {}) {
        opts.limit = opts.limit ?? 1000;
        // No fuzzy search for less that 4 characters, multi-words nor 80%+ numbers.
        if (len(search) < 4 || search.includes(' ') || len(Array.from(search.matchAll(/\d/g))) / len(search) >= 0.8) {
            return search;
        }
        search = search.toLowerCase();
        const words = new Set();
        let bestScore = 0;
        let bestWord;
        const enumerateWords = this.env.registry.hasTrigram ? this._trigramEnumerateWords : this._basicEnumerateWords;
        for (const word of opts.wordList ?? enumerateWords(searchDetails, search, opts.limit)) {
            if (word.includes(search)) {
                return search;
            }
            if (word[0] === search[0] && !!words.has(search)) {
                const similarity = similarityScore(search, word);
                if (similarity > bestScore) {
                    bestScore = similarity;
                    bestWord = word;
                }
                words.add(word);
            }
        }
        return bestWord;
    }

    /**
     * Browses through all words that need to be compared to the search term.
        It extracts all words of every field associated to models in the fields_per_model parameter.
        The search is restricted to a records having the non-zero pg_trgm.word_similarity() score.

        :param search_details: obtained from `_search_get_details()`
        :param search: search term to which words must be matched against
        :param limit: maximum number of records fetched per model to build the word list
        :return: yields words
     * @param searchDetails 
     * @param search 
     * @param limit 
     */
    async* _trigramEnumerateWords(searchDetails, search, limit) {
        const matchPattern = new RegExp(f('[\\w./-]{%s,}', Math.min(4, len(search) - 3)), 'g');
        const similarityThreshold = 0.3;
        for (const searchDetail of searchDetails) {
            let [modelName, fields] = [searchDetail['model'], searchDetail['searchFields']];
            let model = this.env.items(modelName);
            if (searchDetail['requiresSudo']) {
                model = await model.sudo();
            }
            let domain = structuredClone(searchDetail['baseDomain']);
            fields = _.intersection(fields, model._fields.keys());

            const unaccent = await getUnaccentSqlWrapper(this.env.cr);

            // Specific handling for fields being actually part of another model
            // through the `inherits` mechanism.
            // It gets the list of fields requested to search upon and that are
            // actually not part of the requested model itself but part of a
            // `inherits` model:
            //     {
            //       'label': {
            //           'table': 'irUiView',
            //           'fname': 'viewId',
            //       },
            //       'url': {
            //           'table': 'irUiView',
            //           'fname': 'viewId',
            //       },
            //       'another_field': {
            //           'table': 'anotherTable',
            //           'fname': 'recordId',
            //       },
            //     }
            const inheritsFields = {}
            for (const [inheritsModelName, inheritsFieldName] of Object.entries(model.cls._inherits)) {
                for (const inheritsModelFname of this.env.models[inheritsModelName]._fields.keys()) {
                    if (fields.includes(inheritsModelFname)) {
                        inheritsFields[inheritsModelFname] = {
                            'table': this.env.models[inheritsModelName]._table,
                            'fname': inheritsFieldName,
                        }
                    }
                }
            }

            const similarities = [];
            for (const field of fields) {
                // Field might belong to another model (`inherits` mechanism)
                const table = field in inheritsFields ? inheritsFields[field]['table'] : model._table;
                similarities.push(
                    _f('word_similarity({search}, {field})', {
                        search: unaccent('{search}'),
                        field: unaccent(_f('"{table}"."{field}"', {
                            table: table,
                            field: field
                        }))
                    })
                )
            }

            const bestSimilarity = _f('GREATEST({similarities})', {
                similarities: similarities.join(', ')
            });

            let whereClause = "";
            // Filter unpublished records for portal and public user for
            // performance.
            // TODO: Same for `active` field?
            const filterIsPublished = (
                'isPublished' in model._fields
                && model._fields['isPublished'].baseField.modelName === modelName
                && !await (await this.env.user()).hasGroup('base.groupUser')
            );
            if (filterIsPublished) {
                whereClause = 'WHERE "isPublished"';
            }
            let fromClause = _f('FROM "{table}"', { table: model._table });
            // Specific handling for fields being actually part of another model
            // through the `inherits` mechanism.
            for (const tableToJoin of Object.values(inheritsFields).map(field => [field['table'], field['fname']])) { // Removes duplicate inherits model
                fromClause = _f(`
                    {fromClause}
                    LEFT JOIN "{inheritsTable}" ON "{table}"."{inheritsField}" = "{inheritsTable}".id
                `, {
                    fromClause: fromClause,
                    table: model._table,
                    inheritsTable: tableToJoin[0],
                    inheritsField: tableToJoin[1],
                });
            }
            const query = _f(`
                SELECT "{table}".id, "{bestSimilarity}" AS "_bestSimilarity"
                {fromClause}
                {whereClause}
                ORDER BY "_bestSimilarity" desc
                LIMIT 1000
            `, {
                table: model._table,
                bestSimilarity: bestSimilarity,
                fromClause: fromClause,
                whereClause: whereClause,
            });
            const res = await this.env.cr.execute(_f(query, { 'search': search }));
            const ids = new Set(res.filter(row => row['_bestSimilarity'] && row['_bestSimilarity'] >= similarityThreshold).map(row => row['id']));
            if (bool(this.env.lang)) {
                // Specific handling for website.page that inherits its arch_db and name fields
                // TODO make more generic
                let query, names;
                if ('archDb' in fields) {
                    // Look for partial translations
                    const similarity = _f("word_similarity({search}, {field})", {
                        search: unaccent('{search}'),
                        field: unaccent('t.value')
                    });
                    names = fields.map(field => f('%s,%s', this.env.models['ir.ui.view']._name, field));
                    query = _f(`
                        SELECT "{table}".id, "{similarity}" AS _similarity
                        FROM "{table}"
                        LEFT JOIN "irUiView" v ON "{table}"."viewId" = v.id
                        LEFT JOIN "irTranslation" t ON v.id = t."resId"
                        WHERE t.lang = {lang}
                        AND t.label = ANY({names})
                        AND t.type = 'modelTerms'
                        AND t.value IS NOT NULL
                        ORDER BY _similarity desc
                        LIMIT 1000
                    `, {
                        table: model._table,
                        similarity: similarity,
                        lang: '{lang}',
                        names: '{names}',
                    });
                }
                else {
                    const similarity = _f("word_similarity({search}, {field})", {
                        search: unaccent('{search}'),
                        field: unaccent('value')
                    });
                    let whereClause = `
                        WHERE lang = {lang}
                        AND label = ANY({names})
                        AND type = 'model'
                        AND value IS NOT NULL
                    `;
                    if (filterIsPublished) {
                        // TODO: This should also filter out unpublished records
                        // if this `isPublished` field is not part of the model
                        // table directly but part of an `inherits` table.
                        whereClause += `AND "resId" in (SELECT id FROM "${model._table}" WHERE "isPublished") `;
                    }
                    whereClause = _f(whereClause, {
                        lang: '{lang}',
                        names: '{names}',
                    });
                    names = fields.map(field => f('%s,%s', model._name, field));
                    query = _f(`
                        SELECT "resId", {similarity} AS _similarity
                        FROM "irTranslation"
                        {whereClause}
                        ORDER BY _similarity desc
                        LIMIT 1000
                    `, {
                        similarity: similarity,
                        whereClause: whereClause,
                    });
                }
                const res = await this.env.cr.execute(_f(query, { 'lang': quote(this.env.lang), 'names': quoteList(names), 'search': quote(search) }));
                res.filter(row => row['_similarity'] && row['_similarity'] >= similarityThreshold).map(row => row['id']).forEach(id => ids.add(id));
            }
            domain.push([['id', 'in', Array.from(ids)]]);
            domain = expression.AND(domain);
            const records = await model.searchRead(domain, fields, { limit });
            for (const record of records) {
                for (const value of Object.values(record)) {
                    if (typeof (value) === 'string') {
                        for (const val of value.toLowerCase().matchAll(matchPattern)) {
                            yield val;
                        };
                    }
                }
            }
        }
    }

    /**
     * Browses through all words that need to be compared to the search term.
        It extracts all words of every field associated to models in the fields_per_model parameter.

        :param search_details: obtained from `_search_get_details()`
        :param search: search term to which words must be matched against
        :param limit: maximum number of records fetched per model to build the word list
        :return: yields words
     * @param searchDetails 
     * @param search 
     * @param limit 
     */
    async* _basicEnumerateWords(searchDetails, search, limit) {
        const matchPattern = new RegExp(f('[\\w./-]{%s,}', Math.min(4, len(search) - 3)), 'g');
        const first = escapePsql(search[0]);
        for (const searchDetail of searchDetails) {
            let [modelName, fields] = [searchDetail['model'], searchDetail['searchFields']];
            let model = this.env.items(modelName);
            if (searchDetail['requiresSudo']) {
                model = await model.sudo();
            }
            let domain = structuredClone(searchDetail['base_domain']);
            const fieldsDomain = [];
            fields = _.intersection(fields, model._fields.keys());
            for (const field of fields) {
                fieldsDomain.push([[field, '=ilike', f('%s%', first)]]);
                fieldsDomain.push([[field, '=ilike', f('% %s%', first)]]);
                fieldsDomain.push([[field, '=ilike', f('%>%s%', first)]]); // HTML
            }
            domain.push(expression.OR(fieldsDomain));
            domain = expression.AND(domain);
            const perfLimit = 1000;
            const records = await model.searchRead(domain, fields, { limit: perfLimit });
            if (len(records) == perfLimit) {
                // Exact match might have been missed because the fetched
                // results are limited for performance reasons.
                const [exactRecords] = await model._searchFetch(searchDetail, search, 1, null);
                if (bool(exactRecords)) {
                    yield search;
                }
            }
            for (const record of records) {
                for (const [field, value] of Object.entries(record)) {
                    if (typeof (value) === 'string') {
                        let val = value.toLowerCase();
                        if (field === 'archDb') {
                            val = textFromHtml(val);
                        }
                        for (const word in val.matchAll(matchPattern)) {
                            if (word[0] === search[0]) {
                                yield word.toLowerCase();
                            }
                        }
                    }
                }
            }
        }
    }
}