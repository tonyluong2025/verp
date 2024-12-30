import { Fields, api } from "../../../core";
import { AFTER_DIRECTIVE, APPEND_DIRECTIVE, BEFORE_DIRECTIVE, DEFAULT_SEQUENCE, INCLUDE_DIRECTIVE, PREPEND_DIRECTIVE, REMOVE_DIRECTIVE, REPLACE_DIRECTIVE } from "../../../core/addons/base/models/ir_asset";
import { getattr, hasattr } from "../../../core/api";
import { Dict } from "../../../core/helper/collections";
import { AbstractModel, MetaModel, Model, _super } from "../../../core/models";
import { getResourceFromPath } from "../../../core/modules";
import { f, xmlTranslate } from "../../../core/tools";

@MetaModel.define()
class ThemeAsset extends Model {
    static _module = module;
    static _name = 'theme.ir.asset';
    static _description = 'Theme Asset';

    static key = Fields.Char();
    static label = Fields.Char({ required: true });
    static bundle = Fields.Char({ required: true });
    static directive = Fields.Selection({
        selection: [
            [APPEND_DIRECTIVE, 'Append'],
            [PREPEND_DIRECTIVE, 'Prepend'],
            [AFTER_DIRECTIVE, 'After'],
            [BEFORE_DIRECTIVE, 'Before'],
            [REMOVE_DIRECTIVE, 'Remove'],
            [REPLACE_DIRECTIVE, 'Replace'],
            [INCLUDE_DIRECTIVE, 'Include']], default: APPEND_DIRECTIVE
    });
    static path = Fields.Char({ required: true })
    static target = Fields.Char()
    static active = Fields.Boolean({ default: true })
    static sequence = Fields.Integer({ default: DEFAULT_SEQUENCE, required: true });
    static copyIds = Fields.One2many('ir.asset', 'themeTemplateId', { string: 'Assets using a copy of me', copy: false, readonly: true });

    async _convertToBaseModel(website, opts: {} = {}) {
        this.ensureOne();
        const newAsset = await this.getDict('label', 'key', 'bundle', 'directive', 'path', 'target', 'active', 'sequence');
        newAsset['websiteId'] = website.id;
        newAsset['themeTemplateId'] = this.id;
        return newAsset;
    }
}

@MetaModel.define()
class ThemeView extends Model {
    static _module = module;
    static _name = 'theme.ir.ui.view';
    static _description = 'Theme UI View';

    async computeArchFs() {
        if (!('installFilename' in this._context)) {
            return '';
        }
        const pathInfo = getResourceFromPath(this._context['installFilename']);
        if (pathInfo) {
            return pathInfo.slice(0, 2).join('/');
        }
    }

    static label = Fields.Char({ required: true });
    static key = Fields.Char();
    static type = Fields.Char();
    static priority = Fields.Integer({ default: DEFAULT_SEQUENCE, required: true });
    static mode = Fields.Selection([['primary', "Base view"], ['extension', "Extension View"]]);
    static active = Fields.Boolean({ default: true });
    static arch = Fields.Text({ translate: xmlTranslate });
    static archFs = Fields.Char({ default: self => self.computeArchFs() });
    static inheritId = Fields.Reference({ selection: [['ir.ui.view', 'ir.ui.view'], ['theme.ir.ui.view', 'theme.ir.ui.view']] });
    static copyIds = Fields.One2many('ir.ui.view', 'themeTemplateId', { string: 'Views using a copy of me', copy: false, readonly: true });
    static customizeShow = Fields.Boolean();

    async _convertToBaseModel(website, opts: {} = {}) {
        this.ensureOne();
        let inherit = await this['inheritId'];
        if (inherit.ok && inherit._name === 'theme.ir.ui.view') {
            inherit = await (await (await inherit.withContext({ activeTest: false })).copyIds).filtered(async (x) => (await x.websiteId).eq(website));
            if (!inherit.ok) {
                // inheritId not yet created, add to the queue
                return false;
            }
        }

        if (inherit.ok && !(await inherit.websiteId).eq(website)) {
            const websiteSpecificInherit = await (await this.env.items('ir.ui.view').withContext({ activeTest: false })).search([
                ['key', '=', await inherit.key],
                ['websiteId', '=', website.id]
            ], { limit: 1 });
            if (websiteSpecificInherit) {
                inherit = websiteSpecificInherit;
            }
        }
        const newView = await this.getDict('mode', 'type', 'label', 'arch', 'key', 'inheritId', 'archFs', 'priority', 'active', 'customizeShow');
        newView['type'] = newView['type'] || 'qweb';
        newView['inheritId'] = newView['inheritId'].ok && newView['inheritId'].id;
        newView['websiteId'] = website.id;
        newView['themeTemplateId'] = this.id;

        if (!newView['mode']) {  // if not provided, it will be computed automatically (if inheritId or not)
            delete newView['mode'];
        }

        return newView;
    }
}

@MetaModel.define()
class ThemeAttachment extends Model {
    static _module = module;
    static _name = 'theme.ir.attachment';
    static _description = 'Theme Attachments';

    static label = Fields.Char({ required: true });
    static key = Fields.Char({ required: true });
    static url = Fields.Char();
    static copyIds = Fields.One2many('ir.attachment', 'themeTemplateId', { string: 'Attachment using a copy of me', copy: false, readonly: true });

    async _convertToBaseModel(website, opts) {
        this.ensureOne();
        const newAttach = Dict.from({
            'key': await this['key'],
            'isPublic': true,
            'resModel': 'ir.ui.view',
            'type': 'url',
            'label': await this['label'],
            'url': await this['url'],
            'websiteId': website.id,
            'themeTemplateId': this.id,
        });
        return newAttach;
    }
}

@MetaModel.define()
class ThemePage extends Model {
    static _module = module;
    static _name = 'theme.website.page';
    static _description = 'Website Theme Page';

    static url = Fields.Char();
    static viewId = Fields.Many2one('theme.ir.ui.view', { required: true, ondelete: 'CASCADE' });
    static websiteIndexed = Fields.Boolean('Page Indexed', { default: true });
    static copyIds = Fields.One2many('website.page', 'themeTemplateId', { string: 'Page using a copy of me', copy: false, readonly: true });

    async _convertToBaseModel(website, opts: {} = {}) {
        this.ensureOne();
        const view = await (await (await this['viewId']).copyIds).filtered(async (x) => (await x.websiteId).eq(website));
        if (!view.ok) {
            // inheritId not yet created, add to the queue
            return false
        }
        const newPage = Dict.from({
            'url': await this['url'],
            'viewId': view.id,
            'websiteIndexed': await this['websiteIndexed'],
            'websiteId': website.id,
            'themeTemplateId': this.id,
        })
        return newPage;
    }
}

@MetaModel.define()
class ThemeMenu extends Model {
    static _module = module;
    static _name = 'theme.website.menu';
    static _description = 'Website Theme Menu';

    static label = Fields.Char({ required: true, translate: true });
    static url = Fields.Char({ default: '' });
    static pageId = Fields.Many2one('theme.website.page', { ondelete: 'CASCADE' });
    static newWindow = Fields.Boolean('New Window');
    static sequence = Fields.Integer();
    static parentId = Fields.Many2one('theme.website.menu', { index: true, ondelete: 'CASCADE' });
    static copyIds = Fields.One2many('website.menu', 'themeTemplateId', { string: 'Menu using a copy of me', copy: false, readonly: true });

    async _convertToBaseModel(website, opts: {} = {}) {
        this.ensureOne();
        const page = await (await (await this['pageId']).copyIds).filtered(async (x) => (await x.websiteId).eq(website));
        const parent = await (await (await this['parentId']).copyIds).filtered(async (x) => (await x.websiteId).eq(website));
        const newMenu = await this.getDict('label', 'url', 'newWindow', 'sequence');
        newMenu.update({
            'pageId': page.ok && page.id || false,
            'parentId': parent.ok && parent.id || false,
            'websiteId': website.id,
            'themeTemplateId': this.id,
        });
        return newMenu;
    }
}

@MetaModel.define()
class Theme extends AbstractModel {
    static _module = module;
    static _name = 'theme.utils';
    static _description = 'Theme Utils';
    static _auto = false;

    _headerTemplates = [
        'website.templateHeaderHamburger',
        'website.templateHeaderVertical',
        'website.templateHeaderSidebar',
        'website.templateHeaderSlogan',
        'website.templateHeaderContact',
        'website.templateHeaderBoxed',
        'website.templateHeaderCenteredLogo',
        'website.templateHeaderImage',
        'website.templateHeaderHamburgerFull',
        'website.templateHeaderMagazine',
        // Default one, keep it last
        'website.templateHeaderDefault',
    ]

    _footerTemplates = [
        'website.templateFooterDescriptive',
        'website.templateFooterCentered',
        'website.templateFooterLinks',
        'website.templateFooterMinimalist',
        'website.templateFooterContact',
        'website.templateFooterCallToAction',
        'website.templateFooterHeadline',
        // Default one, keep it last
        'website.footerCustom',
    ]

    async _postCopy(mod) {
        // Call specific theme post copy
        const themePostCopy = f('_%sPostCopy', await mod.label);
        if (hasattr(this, themePostCopy)) { // themePostCopy in this 
            console.info('Executing method %s', themePostCopy);
            const method = this[themePostCopy];
            return method.call(this, mod);
        }
        return false;
    }

    @api.model()
    async _resetDefaultConfig() {
        // Reinitialize some css customizations
        await this.env.items('webeditor.assets').makeScssCustomization(
            '/website/static/src/scss/options/user_values.scss',
            {
                'font': 'null',
                'headings-font': 'null',
                'navbar-font': 'null',
                'buttons-font': 'null',
                'color-palettes-number': 'null',
                'color-palettes-name': 'null',
                'btn-ripple': 'null',
                'header-template': 'null',
                'footer-template': 'null',
                'footer-scrolltop': 'null',
            }
        );

        // Reinitialize effets
        await this.disableAsset('Ripple effect SCSS');
        await this.disableAsset('Ripple effect JS');

        // Reinitialize header templates
        for (const view of this._headerTemplates.slice(0, -1)) {
            await this.disableView(view);
        }
        await this.enableView(this._headerTemplates.slice(-1)[0]);

        // Reinitialize footer templates
        for (const view of this._footerTemplates.slice(0, -1)) {
            await this.disableView(view);
        }
        await this.enableView(this._footerTemplates.slice(-1)[0]);

        // Reinitialize footer scrolltop template
        await this.disableView('website.optionFooterScrolltop');
    }

    // TODO Rename name in key and search with the key in master
    @api.model()
    async _toggleAsset(name, active) {
        const themeAsset = await (await this.env.items('theme.ir.asset').sudo()).withContext({ activeTest: false });
        let obj = await themeAsset.search([['label', '=', name]]);
        const website = await this.env.items('website').getCurrentWebsite();
        if (obj.ok) {
            obj = await (await obj.copyIds).filtered(async (x) => (await x.websiteId).eq(website));
        }
        else {
            const asset = await (await this.env.items('ir.asset').sudo()).withContext({ activeTest: false });
            obj = await asset.search([['label', '=', name]], { limit: 1 });
            const hasSpecific = await obj['key'] && await asset.searchCount([
                ['key', '=', await obj['key']],
                ['websiteId', '=', website.id]
            ]) >= 1;
            if (!hasSpecific && active == await obj['active']) {
                return;
            }
        }
        await obj.write({ 'active': active });
    }

    @api.model()
    async _toggleView(xmlid, active) {
        let obj = await this.env.ref(xmlid);
        const website = await this.env.items('website').getCurrentWebsite();
        if (obj._name === 'theme.ir.ui.view') {
            obj = await obj.withContext({ activeTest: false });
            obj = await (await obj.copyIds).filtered(async (x) => (await x.websiteId).eq(website));
        }
        else {
            // If a theme post copy wants to enable/disable a view, this is to
            // enable/disable a given functionality which is disabled/enabled
            // by default. So if a post copy asks to enable/disable a view which
            // is already enabled/disabled, we would not consider it otherwise it
            // would COW the view for nothing.
            const view = await this.env.items('ir.ui.view').withContext({ activeTest: false });
            const hasSpecific = await obj['key'] && await view.searchCount([
                ['key', '=', await obj['key']],
                ['websiteId', '=', website.id]
            ]) >= 1;
            if (!hasSpecific && active == await obj['active']) {
                return;
            }
        }
        await obj.write({ 'active': active });
    }

    @api.model()
    async enableAsset(name) {
        await this._toggleAsset(name, true);
    }

    @api.model()
    async disableAsset(name) {
        await this._toggleAsset(name, false);
    }

    @api.model()
    async enableView(xmlid) {
        if (xmlid in this._headerTemplates) {
            for (const view of this._headerTemplates) {
                await this.disableView(view);
            }
        }
        else if (xmlid in this._footerTemplates) {
            for (const view of this._footerTemplates) {
                await this.disableView(view);
            }
        }
        await this._toggleView(xmlid, true);
    }

    @api.model()
    async disableView(xmlid) {
        await this._toggleView(xmlid, false);
    }

    /**
     * Enabling off canvas require to enable quite a lot of template so
            this shortcut was made to make it easier.
     */
    @api.model()
    async enableHeaderOffCanvas() {
        await this.enableView("website.optionHeaderOffCanvas");
        await this.enableView("website.optionHeaderOffCanvasTemplateHeaderHamburger");
        await this.enableView("website.optionHeaderOffCanvasTemplateHeaderSidebar");
        await this.enableView("website.optionHeaderOffCanvasTemplateHeaderHamburgerFull");
    }
}

@MetaModel.define()
class IrAsset extends Model {
    static _module = module;
    static _parents = 'ir.asset';

    static themeTemplateId = Fields.Many2one('theme.ir.asset', { copy: false });
}

@MetaModel.define()
class IrUiView extends Model {
    static _module = module;
    static _parents = 'ir.ui.view';

    static themeTemplateId = Fields.Many2one('theme.ir.ui.view', { copy: false });

    async write(vals) {
        // During a theme module update, theme views' copies receiving an arch
        // update should not be considered as `arch_updated`, as this is not a
        // user made change.
        const testMode = getattr(this.env, 'testing', false);
        if (!(testMode || this.pool._init)) {
            return _super(IrUiView, this).write(vals);
        }
        let noArchUpdatedViews = this.env.items('ir.ui.view');
        let otherViews = this.env.items('ir.ui.view');
        for (const record of this) {
            // Do not mark the view as user updated if original view arch is similar
            const arch = vals['arch'] ?? vals['archBase'];
            if ((await record.themeTemplateId).ok && await (await record.themeTemplateId).arch == arch) {
                noArchUpdatedViews = noArchUpdatedViews.add(record);
            }
            else {
                otherViews = otherViews.add(record);
            }
        }
        let res = await _super(IrUiView, otherViews).write(vals);
        if (noArchUpdatedViews.ok) {
            vals['archUpdated'] = false;
            res = res.and(await _super(IrUiView, noArchUpdatedViews).write(vals));
        }
        return res;
    }
}

@MetaModel.define()
class IrAttachment extends Model {
    static _module = module;
    static _parents = 'ir.attachment';

    static key = Fields.Char({ copy: false });
    static themeTemplateId = Fields.Many2one('theme.ir.attachment', { copy: false });
}

@MetaModel.define()
class WebsitePage extends Model {
    static _module = module;
    static _parents = 'website.page';

    static themeTemplateId = Fields.Many2one('theme.website.page', { copy: false })
}

@MetaModel.define()
class WebsiteMenu extends Model {
    static _module = module;
    static _parents = 'website.menu';

    static themeTemplateId = Fields.Many2one('theme.website.menu', { copy: false });
}