import path from "path";
import { Fields, api } from "../../../core";
import { MODULE_UNINSTALL_FLAG } from "../../../core/addons/base";
import { Dict, MissingError, OrderedDict } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models"
import { bool, f, len, pop, sortedAsync } from "../../../core/tools";
import { getattr } from "../../../core/api";

@MetaModel.define()
class IrModuleModule extends Model {
    static _module = module;
    static _name = "ir.module.module";
    static _description = 'Module';
    static _parents = IrModuleModule._name;

    // The order is important because of dependencies (page need view, menu need page)
    static _themeModelNames = new OrderedDict<string>([
        ['ir.ui.view', 'theme.ir.ui.view'],
        ['ir.asset', 'theme.ir.asset'],
        ['website.page', 'theme.website.page'],
        ['website.menu', 'theme.website.menu'],
        ['ir.attachment', 'theme.ir.attachment'],
    ]);
    static _themeTranslatedFields = Dict.from({
        'theme.ir.ui.view': [['theme.ir.ui.view,arch', 'ir.ui.view,archDb']],
        'theme.website.menu': [['theme.website.menu,label', 'website.menu,label']],
    });

    static imageIds = Fields.One2many('ir.attachment', 'resId', { domain: [['resModel', '=', IrModuleModule._name], ['mimetype', '=like', 'image/%']], string: 'Screenshots', readonly: true});
    // for kanban view
    static isInstalledOnCurrentWebsite = Fields.Boolean({compute: '_computeIsInstalledOnCurrentWebsite'});

    /**
     *  Compute for every theme in ``self`` if the current website is using it or not.

        This method does not take dependencies into account, because if it did, it would show
        the current website as having multiple different themes installed at the same time,
        which would be confusing for the user.

     */
    async _computeIsInstalledOnCurrentWebsite() {
        for (const module of this) {
            await module.set('isInstalledOnCurrentWebsite', module.eq(await (await this.env.items('website').getCurrentWebsite()).themeId));
        }
    }

    /**
     * Override to correctly upgrade themes after upgrade/installation of modules.

            # Install

                If this theme wasn't installed before, then load it for every website
                for which it is in the stream.

                eg. The very first installation of a theme on a website will trigger this.

                eg. If a website uses theme_A and we install sale, then theme_A_sale will be
                    autoinstalled, and in this case we need to load theme_A_sale for the website.

            # Upgrade

                There are 2 cases to handle when upgrading a theme:

                * When clicking on the theme upgrade button on the interface,
                    in which case there will be an http request made.

                    -> We want to upgrade the current website only, not any other.

                * When upgrading with -u, in which case no request should be set.

                    -> We want to upgrade every website using this theme.
     * @param vals 
     * @returns 
     */
    async write(vals) {
        let self: any = this;
        const req = this.env.req;
        if (this.env.req && req.context['applyNewTheme']) {
            self = await self.withContext({applyNewTheme: true});
        }

        for (const module of self) {
            const [label, state] = await module('label', 'state');
            if (label.startsWith('theme_') && vals['state'] === 'installed') {

                console.info('Module %s has been loaded as theme template (%s)', label, state);

                if (['to install', 'to upgrade'].includes(state)) {
                    let websitesToUpdate = await module._themeGetStreamWebsiteIds();

                    if (state === 'to upgrade' && req) {
                        const website = await self.env.items('website');
                        const currentWebsite = await website.getCurrentWebsite();
                        websitesToUpdate = websitesToUpdate.includes(currentWebsite) ? currentWebsite : website;
                    }
                    for (const website of websitesToUpdate) {
                        await module._themeLoad(website);
                    }
                }
            }
        }
        return _super(IrModuleModule, self).write(vals);
    }

    /**
     * Return every theme template model of type ``modelName`` for every theme in ``self``.

            :param modelName: string with the technical name of the model for which to get data.
                (the name must be one of the keys present in ``_theme_model_names``)
            :return: recordset of theme template models (of type defined by ``modelName``)
     * @param modelName 
     * @returns 
     */
    async _getModuleData(modelName) {
        const themeModelName = this.cls._themeModelNames[modelName];
        const irModelData = this.env.items('ir.model.data');
        let records = this.env.items(themeModelName);

        for (const module of this) {
            const imdIds = await (await irModelData.search([['module', '=', await module.label], ['model', '=', themeModelName]])).mapped('resId');
            records = records.or((await this.env.items(themeModelName).withContext({activeTest: false})).browse(imdIds));
        }
        return records;
    }

    /**
     * This method:

            - Find and update existing records.

                For each model, overwrite the fields that are defined in the template (except few
                cases such as active) but keep inherited models to not lose customizations.

            - Create new records from templates for those that didn't exist.

            - Remove the models that existed before but are not in the template anymore.

                See _theme_cleanup for more information.


            There is a special 'while' loop around the 'for' to be able queue back models at the end
            of the iteration when they have unmet dependencies. Hopefully the dependency will be
            found after all models have been processed, but if it's not the case an error message will be shown.


            :param modelName: string with the technical name of the model to handle
                (the name must be one of the keys present in ``_theme_model_names``)
            :param website: ``website`` model for which the records have to be updated

            :raise MissingError: if there is a missing dependency.
     * @param modelName 
     * @param website 
     */
    async _updateRecords(modelName, website) {
        this.ensureOne();

        let remaining = await this._getModuleData(modelName);
        let lastLen = -1;
        while (len(remaining) != lastLen) {
            lastLen = len(remaining);
            for (const rec of remaining) {
                const recData = await rec._convertToBaseModel(website);
                if (! bool(recData)) {
                    console.info('Record queued: %s', await rec.displayName);
                    continue;
                }

                let find = await (await (await rec.withContext({activeTest: false})).mapped('copyIds')).filtered(async (m) => (await m.websiteId).eq(website));

                // special case for attachment
                // if module B override attachment from dependence A, we update it
                if (! bool(find) && modelName === 'ir.attachment') {
                    // In master, a unique constraint over (theme_template_id, websiteId)
                    // will be introduced, thus ensuring unicity of 'find'
                    find = await (await rec.copyIds).search([['key', '=', await rec.key], ['websiteId', '=', website.id], ["originalId", "=", false]]);
                }
                if (bool(find)) {
                    const imd = await this.env.items('ir.model.data').search([['model', '=', find._name], ['resId', '=', find.id]]);
                    if (imd.ok && await imd.noupdate) {
                        console.info('Noupdate set for %s (%s)', find, imd);
                    }
                    else {
                        // at update, ignore active field
                        if ('active' in recData) {
                            pop(recData, 'active');
                        }
                        if (modelName === 'ir.ui.view' && (await find.archUpdated || await find.arch == recData['arch'])) {
                            pop(recData, 'arch');
                        }
                        await find.update(recData);
                        await this._postCopy(rec, find);
                    }
                }
                else {
                    const newRec = await this.env.items(modelName).create(recData);
                    await this._postCopy(rec, newRec);
                }

                remaining = remaining.sub(rec);
            }
        }

        if (len(remaining)) {
            const error = f('Error - Remaining: %s', await remaining.mapped('displayName'));
            console.error(error);
            throw new MissingError(error);
        }
        await this._themeCleanup(modelName, website);
    }

    async _postCopy(oldRec, newRec) {
        this.ensureOne();
        const translatedFields = this.cls._themeTranslatedFields.get(oldRec._name, []);
        for (const [srcField, dstField] of translatedFields) {
            await this._cr.execute(`INSERT INTO "irTranslation" (lang, src, label, "resId", state, value, type, module)
                                SELECT t.lang, t.src, $1, $2, t.state, t.value, t.type, t.module
                                FROM "irTranslation" t
                                WHERE label = $3
                                  AND "resId" = $4
                                ON CONFLICT DO NOTHING`,
                             {bind: [dstField, newRec.id, srcField, oldRec.id]});
        }
    }

    /**
     * For every type of model in ``self._theme_model_names``, and for every theme in ``self``:
            create/update real models for the website ``website`` based on the theme template models.

            :param website: ``website`` model on which to load the themes
     * @param website 
     */
    async _themeLoad(website) {
        for (const module of this) {
            console.info('Load theme %s for website %s from template.', await module.mapped('label'), website.id);

            for (const modelName of this.cls._themeModelNames.keys()) {
                await module._updateRecords(modelName, website);
            }
            if (this._context['applyNewTheme']) {
                // Both the theme install and upgrade flow ends up here.
                // The _post_copy() is supposed to be called only when the theme
                // is installed for the first time on a website.
                // It will basically select some header and footer template.
                // We don't want the system to select again the theme footer or
                // header template when that theme is updated later. It could
                // erase the change the user made after the theme install.
                await (await this.env.items('theme.utils').withContext({websiteId: website.id}))._postCopy(module);
            }
        }
    }

    /**
     * For every type of model in ``self._theme_model_names``, and for every theme in ``self``:
            remove real models that were generated based on the theme template models
            for the website ``website``.

            :param website: ``website`` model on which to unload the themes
     * @param website 
     */
    async _themeUnload(website) {
        for (const modul of this) {
            console.info('Unload theme %s for website %s from template.', await this.mapped('label'), website.id);

            for (const modelName of this.cls._themeModelNames.keys()) {
                const template = await this._getModuleData(modelName);
                const models = await (await (await template.withContext({'activeTest': false, [MODULE_UNINSTALL_FLAG]: true})).mapped('copyIds')).filtered(async (m) => (await m.websiteId).eq(website));
                await models.unlink();
                await this._themeCleanup(modelName, website);
            }
        }
    }

    /**
     * Remove orphan models of type ``modelName`` from the current theme and
            for the website ``website``.

            We need to compute it this way because if the upgrade (or deletion) of a theme module
            removes a model template, then in the model itself the variable
            ``theme_template_id`` will be set to NULL and the reference to the theme being removed
            will be lost. However we do want the ophan to be deleted from the website when
            we upgrade or delete the theme from the website.

            ``website.page`` and ``website.menu`` don't have ``key`` field so we don't clean them.
            TODO in master: add a field ``themeId`` on the models to more cleanly compute orphans.

            :param modelName: string with the technical name of the model to cleanup
                (the name must be one of the keys present in ``_theme_model_names``)
            :param website: ``website`` model for which the models have to be cleaned
     * @param modelName 
     * @param website 
     * @returns 
     */
    async _themeCleanup(modelName, website) {
        this.ensureOne();
        const model = this.env.items(modelName);

        if (['website.page', 'website.menu'].includes(modelName)) {
            return model;
        }
        // use activeTest to also unlink archived models
        // and use MODULE_UNINSTALL_FLAG to also unlink inherited models
        const orphans = await (await model.withContext({'activeTest': false, [MODULE_UNINSTALL_FLAG]: true})).search([
            ['key', '=like', await this['label'] + '.%'],
            ['websiteId', '=', website.id],
            ['themeTemplateId', '=', false],
        ]);
        await orphans.unlink();
    }

    /**
     * Return installed upstream themes.

            :return: recordset of themes ``ir.module.module``
     * @returns 
     */
    async _themeGetUpstream() {
        this.ensureOne();
        return (await (this as any).upstreamDependencies({excludeStates: ['',]})).filtered(async (x) => (await x.label).startsWith('theme_'));
    }

    /**
     * Return installed downstream themes that starts with the same name.

            eg. For theme_A, this will return theme_A_sale, but not theme_B even if theme B
                depends on theme_A.

            :return: recordset of themes ``ir.module.module``
     * @returns 
     */
    async _themeGetDownstream() {
        this.ensureOne();
        return (await (this as any).downstreamDependencies()).filtered(async (x) => (await x.label).startsWith(await this['label']));
    }

    /**
     * Returns all the themes in the stream of the current theme.

            First find all its downstream themes, and all of the upstream themes of both
            sorted by their level in hierarchy, up first.

            :return: recordset of themes ``ir.module.module``
     * @returns 
     */
    async _themeGetStreamThemes() {
        this.ensureOne();
        let allMods = this.add(await this._themeGetDownstream());
        for (const downMod of (await this._themeGetDownstream()).add(this)) {
            for (const upMod of await downMod._themeGetUpstream()) {
                allMods = upMod.or(allMods);
            }
        }
        return allMods;
    }

    /**
     * Websites for which this theme (self) is in the stream (up or down) of their theme.

            :return: recordset of websites ``website``
     * @returns 
     */
    async _themeGetStreamWebsiteIds() {
        this.ensureOne();
        let websites = this.env.items('website');
        for (const website of await websites.search([['themeId', '!=', false]])) {
            if ((await (await website.themeId)._themeGetStreamThemes()).includes(this)) {
                websites = websites.or(website);
            }
        }
        return websites;
    }

    /**
     * Upgrade the upstream dependencies of a theme, and install it if necessary.
     */
    async _themeUpgradeUpstream() {
        async function installOrUpgrade(theme) {
            if (await theme.state !== 'installed') {
                await theme.buttonInstall();
            }
            const themes = theme.add(await theme._themeGetUpstream());
            await (await themes.filtered(async (m) => await m.state === 'installed')).buttonUpgrade();
        }

        await (this as any)._buttonImmediateFunction(installOrUpgrade);
    }

    /**
     * Remove from ``website`` its current theme, including all the themes in the stream.

            The order of removal will be reverse of installation to handle dependencies correctly.

            :param website: ``website`` model for which the themes have to be removed
     * @param website 
     */
    @api.model()
    async _themeRemove(website) {
        // _theme_remove is the entry point of any change of theme for a website
        // (either removal or installation of a theme and its dependencies). In
        // either case, we need to reset some default configuration before.
        await (await this.env.items('theme.utils').withContext({websiteId: website.id}))._resetDefaultConfig();

        const themeId = await website.themeId;
        if (! themeId.ok) {
            return;
        }

        for (const theme of await sortedAsync(await themeId._themeGetStreamThemes(), (it) => it.id, true)) {
            await theme._themeUnload(website);
        }
        await website.set('themeId', false);
    }

    /**
     * Remove any existing theme on the current website and install the theme ``self`` instead.

            The actual loading of the theme on the current website will be done
            automatically on ``write`` thanks to the upgrade and/or install.

            When installating a new theme, upgrade the upstream chain first to make sure
            we have the latest version of the dependencies to prevent inconsistencies.

            :return: dict with the next action to execute
     * @returns 
     */
    async buttonChooseTheme() {
        this.ensureOne();
        const website = await this.env.items('website').getCurrentWebsite();

        await this._themeRemove(website);

        // website.themeId must be set before upgrade/install to trigger the load in ``write``
        await website.set('themeId', this);

        // this will install 'self' if it is not installed yet
        const req = this.env.req;
        if (req) {
            const context = Object.assign({}, req.context);
            context['applyNewTheme'] = true;
            req.context = context;
        }
        await this._themeUpgradeUpstream();

        const activeTodo = await this.env.items('ir.actions.todo').search([['state', '=', 'open']], {limit: 1});
        let result;
        if (activeTodo.ok) {
            result = await activeTodo.actionLaunch();
        }
        else {
            result = await website.buttonGoWebsite(req, '/', true);
        }
        if (result['url'] && result['url'].includes('enableEditor')) {
            result['url'] = result['url'].replace('enableEditor', 'withLoader=1&enableEditor');
        }
        return result;
    }

    /**
     * Remove the current theme of the current website.
     */
    async buttonRemoveTheme() {
        const website = await this.env.items('website').getCurrentWebsite();
        await this._themeRemove(website);
    }

    /**
     * Refresh the current theme of the current website.

            To refresh it, we only need to upgrade the modules.
            Indeed the (re)loading of the theme will be done automatically on ``write``.
     */
    async buttonRefreshTheme() {
        const website = await this.env.items('website').getCurrentWebsite();
        await (await website.themeId)._themeUpgradeUpstream();
    }

    @api.model()
    async updateList() {
        const res = await _super(IrModuleModule, this).updateList();
        await this.updateThemeImages();
        return res;
    }

    @api.model()
    async updateThemeImages() {
        const irAttachment = this.env.items('ir.attachment');
        let existingUrls = await irAttachment.searchRead([['resModel', '=', this._name], ['type', '=', 'url']], ['url']);
        existingUrls = existingUrls.map(urlWrapped => urlWrapped['url']);

        const themes = await (await this.env.items('ir.module.module').withContext({activeTest: false})).search([
            ['categoryId', 'childOf', (await this.env.ref('base.category_theme')).id],
        ], {order: 'label'});

        for (const theme of themes) {
            const label = await theme.label;
            const terp = await (this as any).getModuleInfo(label);
            const images = terp['images'] ?? [];
            for (const image of images) {
                const imagePath = '/' + path.join(label, image);
                if (!existingUrls.includes(imagePath)) {
                    const imageName = path.parse(imagePath).base;
                    await irAttachment.create({
                        'type': 'url',
                        'label': imageName,
                        'url': imagePath,
                        'resModel': this._name,
                        'resId': theme.id,
                    });
                }
            }
        }
    }

    /**
     * Returns the 'ir.module.module' search domain matching all available themes.
     * @returns 
     */
    async getThemesDomain() {
        const self = this;
        async function getId(modelId) {
            return self.env.items('ir.model.data')._xmlidToResId(modelId);
        }
        return [
            ['categoryId', 'not in', [
                await getId('base.category_hidden'),
                await getId('base.category_themeHidden'),
            ]],
            '|',
            ['categoryId', '=', await getId('base.category_theme')],
            ['categoryId.parentId', '=', await getId('base.category_theme')]
        ];
    }

    async _check() {
        await _super(IrModuleModule, this)._check();
        const view = this.env.items('ir.ui.view');
        const websiteViewsToAdapt = getattr(this.pool, 'websiteViewsToAdapt', []);
        if (bool(websiteViewsToAdapt)) {
            for (const viewReplay of websiteViewsToAdapt) {
                const cowView = view.browse(viewReplay[0]);
                await view._loadRecordsWriteOnCow(cowView, viewReplay[1], viewReplay[2]);
            }
            this.pool.websiteViewsToAdapt.length = 0;
        }
    }
}