import _ from "lodash";
import uuid from "uuid";
import { Fields, api, tools } from "../../../core";
import { getattr, setdefault } from "../../../core/api";
import { AccessError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { Forbidden } from "../../../core/service";
import { bool, equal, f, isInstance, sortedAsync, update } from "../../../core/tools";

@MetaModel.define()
class View extends Model {
    static _module = module;
    static _name = "ir.ui.view";
    static _parents = ["ir.ui.view", "website.seo.metadata"];

    static websiteId = Fields.Many2one('website', { ondelete: 'CASCADE', string: "Website" });
    static pageIds = Fields.One2many('website.page', 'viewId');
    static firstPageId = Fields.Many2one('website.page', { string: 'Website Page', help: 'First page linked to this view', compute: '_computeFirstPageId' });
    static track = Fields.Boolean({ string: 'Track', default: false, help: "Allow to specify for one page of the website to be trackable or not" });
    static visibility = Fields.Selection([['all', 'All'], ['connected', 'Signed In'], ['restrictedGroup', 'Restricted Group'], ['password', 'With Password']], { default: '' });
    static visibilityPassword = Fields.Char({ groups: 'base.groupSystem', copy: false });
    static visibilityPasswordDisplay = Fields.Char({ compute: '_getPwd', inverse: '_setPwd', groups: 'website.groupWebsiteDesigner' });

    @api.depends('visibilityPassword')
    async _getPwd() {
        for (const r of this) {
            await r.set('visibilityPasswordDisplay', await (await r.sudo()).visibilityPassword && '********' || '');
        }
    }

    async _setPwd() {
        const cryptContext = await (await this.env.user())._cryptContext();
        for (const r of this) {
            if (await r.type === 'qweb') {
                await (await r.sudo()).set('visibilityPassword', await r.visibilityPasswordDisplay && cryptContext.encrypt(r.visibilityPasswordDisplay) || '');
                await r.set('visibility', await r.visibility);  // double check access
            }
        }
    }

    async _computeFirstPageId() {
        for (const view of this) {
            await view.set('firstPageId', await this.env.items('website.page').search([['viewId', '=', view.id]], { limit: 1 }));
        }
    }

    /**
     * SOC for ir.ui.view creation. If a view is created without a websiteId,
        it should get one if one is present in the context. Also check that
        an explicit websiteId in create values matches the one in the context.
     * @param valsList 
     * @returns 
     */
    @api.modelCreateMulti()
    async create(valsList) {
        const websiteId = this.env.context['websiteId'] ?? false;
        if (!bool(websiteId)) {
            return _super(View, this).create(valsList);
        }
        for (const vals of valsList) {
            if (!('websiteId' in vals)) {
                // Automatic addition of website ID during view creation if not
                // specified but present in the context
                vals['websiteId'] = websiteId;
            }
            else {
                // If website ID specified, automatic check that it is the same as
                // the one in the context. Otherwise raise an error.
                const newWebsiteId = vals['websiteId'];
                if (!newWebsiteId) {
                    throw new ValueError(`Trying to create a generic view from a website ${websiteId} environment`);
                }
                else if (newWebsiteId != websiteId) {
                    throw new ValueError(`Trying to create a view for website ${newWebsiteId} from a website ${websiteId} environment`);
                }
            }
        }
        return _super(View, this).create(valsList);
    }

    async nameGet() {
        if (!(this._context['displayKey'] || this._context['displayWebsite'])) {
            return _super(View, this).nameGet();
        }

        const res = []
        for (const view of this) {
            let viewName = await view.label;
            if (this._context['displayKey']) {
                viewName += f(' <%s>', await view.key);
            }
            if (this._context['displayWebsite'] && (await view.websiteId).ok) {
                viewName += f(' [%s]', await (await view.websiteId).label);
            }
            res.push([view.id, viewName]);
        }
        return res;
    }

    /**
     * COW for ir.ui.view. This way editing websites does not impact other
        websites. Also this way newly created websites will only
        contain the default views.
     * @param vals 
     * @returns 
     */
    async write(vals) {
        const currentWebsiteId = this.env.context['websiteId'];
        if (!bool(currentWebsiteId) || this.env.context['noCow']) {
            return _super(View, this).write(vals);
        }

        // We need to consider inactive views when handling multi-website cow
        // feature (to copy inactive children views, to search for specific
        // views, ...)
        // Website-specific views need to be updated first because they might
        // be relocated to new ids by the cow if they are involved in the
        // inheritance tree.
        for (const view of await (await this.withContext({ activeTest: false })).sorted('websiteId', true)) {
            // Make sure views which are written in a website context receive
            // a value for their 'key' field
            if (! await view.key && !vals['key']) {
                await (await view.withContext({ noCow: true })).set('key', f('website.key_%s', uuid.v4().slice(0, 6)));
            }
            const pages = await view.pageIds;

            // Disable cache of page if we guess some dynamic content (form with csrf, ...)
            if (vals['arch']) {
                const toInvalidate = await pages.filtered(
                    async (p) => await p.cacheTime && ! await p._canBeCached(vals['arch'])
                );
                if (toInvalidate.ok) console.info('Disable cache for page %s', toInvalidate);
                await toInvalidate.set('cacheTime', 0);
            }
            // No need of COW if the view is already specific
            if ((await view.websiteId).ok) {
                await _super(View, view).write(vals);
                continue;
            }

            // Ensure the cache of the pages stay consistent when doing COW.
            // This is necessary when writing view fields from a page record
            // because the generic page will put the given values on its cache
            // but in reality the values were only meant to go on the specific
            // page. Invalidate all fields and not only those in vals because
            // other fields could have been changed implicitly too.
            await pages.flush(null, pages);
            pages.invalidateCache(null, pages.ids);

            // If already a specific view for this generic view, write on it
            let websiteSpecificView = await view.search([
                ['key', '=', await view.key],
                ['websiteId', '=', currentWebsiteId]
            ], { limit: 1 });
            if (websiteSpecificView.ok) {
                await _super(View, websiteSpecificView).write(vals);
                continue;
            }

            // Set key to avoid copy() to generate an unique key as we want the
            // specific view to have the same key
            const copyVals = { 'websiteId': currentWebsiteId, 'key': await view.key }
            // Copy with the 'inheritId' field value that will be written to
            // ensure the copied view's validation works
            if (vals['inheritId']) {
                copyVals['inheritId'] = vals['inheritId'];
            }
            websiteSpecificView = await view.copy(copyVals);

            await view._createWebsiteSpecificPagesForView(websiteSpecificView,
                view.env.items('website').browse(currentWebsiteId));

            for (const inheritChild of await sortedAsync(await (await view.inheritChildrenIds).filterDuplicate(), async (v) => String([v.priority, v.id]))) {
                if ((await inheritChild.websiteId).id == currentWebsiteId) {
                    // In the case the child was already specific to the current
                    // website, we cannot just reattach it to the new specific
                    // parent: we have to copy it there and remove it from the
                    // original tree. Indeed, the order of children 'id' fields
                    // must remain the same so that the inheritance is applied
                    // in the same order in the copied tree.
                    const child = await inheritChild.copy({ 'inheritId': websiteSpecificView.id, 'key': await inheritChild.key });
                    await (await inheritChild.inheritChildrenIds).write({ 'inheritId': child.id })
                    await inheritChild.unlink();
                }
                else {
                    // Trigger COW on inheriting views
                    await inheritChild.write({ 'inheritId': websiteSpecificView.id });
                }
            }
            await _super(View, websiteSpecificView).write(vals);
        }
        return true;
    }

    async _loadRecordsWriteOnCow(cowView, inheritId, values) {
        inheritId = (await this.search([
            ['key', '=', await this.browse(inheritId).key],
            ['websiteId', 'in', [false, (await cowView.websiteId).id]],
        ], { order: 'websiteId', limit: 1 })).id;
        values['inheritId'] = inheritId;
        await (await cowView.withContext({ noCow: true })).write(values);
    }

    /**
     * When creating a generic child view, we should
            also create that view under specific view trees (COW'd).
            Top level view (no inheritId) do not need that behavior as they
            will be shared between websites since there is no specific yet.
     * @param processedModules 
     */
    async _createAllSpecificViews(processedModules) {
        // Only for the modules being processed
        const regex = f('^(%s)[.]', processedModules.join('|'));
        // Retrieve the views through a SQl query to avoid ORM queries inside of for loop
        // Retrieves all the views that are missing their specific counterpart with all the
        // specific view parent id and their website id in one query
        const query = `
            SELECT generic.id, ARRAY[array_agg("specParent".id), array_agg("specParent"."websiteId")] AS list
              FROM "irUiView" generic
        INNER JOIN "irUiView" "genericParent" ON "genericParent".id = generic."inheritId"
        INNER JOIN "irUiView" "specParent" ON "specParent".key = "genericParent".key
         LEFT JOIN "irUiView" specific ON specific.key = generic.key AND specific."websiteId" = "specParent"."websiteId"
             WHERE generic.type='qweb'
               AND generic."websiteId" IS NULL
               AND generic.key ~ $1
               AND "specParent"."websiteId" IS NOT NULL
               AND specific.id IS NULL
          GROUP BY generic.id
        `;
        const res = await this.env.cr.execute(query, { bind: [regex] });
        const result = Object.fromEntries(res.map(row => [row['id'], row['list']]));
        for (const record of this.browse(Object.keys(result))) {
            const [specificParentViewIds, websiteIds] = result[record.id];
            for (const [specificParentViewId, websiteId] of _.zip([...specificParentViewIds], [...websiteIds])) {
                await (await record.withContext({ websiteId: websiteId })).write({
                    'inheritId': specificParentViewId,
                });
            }
        }
        await _super(View, this)._createAllSpecificViews(processedModules);
    }

    /**
     * This implements COU (copy-on-unlink). When deleting a generic page
        website-specific pages will be created so only the current
        website is affected.
     * @returns 
     */
    async unlink() {
        const currentWebsiteId = this._context['websiteId'];

        if (bool(currentWebsiteId) && !this._context['noCow']) {
            for (const view of await this.filtered(async (view) => !bool(await view.websiteId))) {
                for (const w of await this.env.items('website').search([['id', '!=', currentWebsiteId]])) {
                    // reuse the COW mechanism to create
                    // website-specific copies, it will take
                    // care of creating pages and menus.
                    await (await view.withContext({ websiteId: w.id })).write({ 'label': await view.label });
                }
            }
        }

        let specificViews = this.env.items('ir.ui.view');
        if (this.ok && this.pool._init) {
            for (const view of await this.filtered(async (view) => !bool(await view.websiteId))) {
                specificViews = specificViews.add(await view._getSpecificViews());
            }
        }
        const result = await _super(View, this.add(specificViews)).unlink();
        this.clearCaches();
        return result;
    }

    async _createWebsiteSpecificPagesForView(newView, website) {
        for (const page of await this['pageIds']) {
            // create new pages for this view
            const newPage = await page.copy({
                'viewId': newView.id,
                'isPublished': await page.isPublished,
            });
            await (await (await page.menuIds).filtered(async (m) => (await m.websiteId).id == website.id)).set('pageId', newPage.id);
        }
    }

    async _getTopLevelView() {
        this.ensureOne();
        const inheritId = await this['inheritId'];
        return inheritId.ok ? await inheritId._getTopLevelView() : this;
    }

    /**
     * Make this only return most specific views for website.
     * @param key 
     * @param bundles 
     * @returns 
     */
    @api.model()
    async getRelatedViews(key, bundles: boolean = false) {
        // getRelatedViews can be called through website=false routes
        // (e.g. /web_editor/getAssetsEditorResources), so website
        // dispatchParameters may not be added. Manually set
        // websiteId. (It will then always fallback on a website, this
        // method should never be called in a generic context, even for
        // tests)
        const self = await this.withContext({ websiteId: (await this.env.items('website').getCurrentWebsite()).id });
        return _super(View, self).getRelatedViews(key, bundles);
    }

    /**
     * Filter current recordset only keeping the most suitable view per distinct key.
            Every non-accessible view will be removed from the set:
              * In non website context, every view with a website will be removed
              * In a website context, every view from another website
     * @returns 
     */
    async filterDuplicate() {
        const currentWebsiteId = this._context['websiteId'];
        let mostSpecificViews = this.env.items('ir.ui.view');
        if (!bool(currentWebsiteId)) {
            return await this.filtered(async (view) => !bool(await view.websiteId));
        }
        for (const view of this) {
            // specific view: add it if it's for the current website and ignore
            // it if it's for another website
            if ((await view.websiteId).ok && (await view.websiteId).id == currentWebsiteId) {
                mostSpecificViews = mostSpecificViews.or(view);
            }
            // generic view: add it only if, for the current website, there is no
            // specific view for this view (based on the same `key` attribute)
            else if (!(await view.websiteId).ok && !await this.some(async (view2) => await view.key == await view2.key && (await view2.websiteId).ok && (await view2.websiteId).id == currentWebsiteId)) {
                mostSpecificViews = mostSpecificViews.or(view);
            }
        }
        return mostSpecificViews;
    }

    @api.model()
    async _viewGetInheritedChildren(view) {
        const extensions = await _super(View, this)._viewGetInheritedChildren(view);
        return extensions.filterDuplicate();
    }

    /**
     * Given an xmlid or a viewId, return the corresponding view record.
            In case of website context, return the most specific one.
            :param viewId: either a string xmlid or an integer viewId
            :return: The view record or empty recordset
     * @param viewId 
     * @returns 
     */
    @api.model()
    async _viewObj(viewId) {
        if (typeof (viewId) === 'string' || typeof (viewId) === 'number') {
            return this.env.items('website').viewref(viewId);
        }
        else {
            // It can already be a view object when called by '_viewsGet()' that is calling '_viewObj'
            // for it's inheritChildrenIds, passing them directly as object record. (Note that it might
            // be a viewId from another website but it will be filtered in 'getRelatedViews()')
            return viewId._name == 'ir.ui.view' ? viewId : this.env.items('ir.ui.view');
        }
    }

    @api.model()
    async _getInheritingViewsDomain() {
        let domain = await _super(View, this)._getInheritingViewsDomain();
        const currentWebsite = this.env.items('website').browse(this._context['websiteId']);
        const websiteViewsDomain = currentWebsite.websiteDomain();
        // when rendering for the website we have to include inactive views
        // we will prefer inactive website-specific views over active generic ones
        if (bool(currentWebsite)) {
            domain = domain.filter(leaf => !leaf.includes('active'));
        }
        return expression.AND([websiteViewsDomain, domain]);
    }

    @api.model()
    async _getInheritingViews() {
        if (!this._context['websiteId']) {
            return _super(View, this)._getInheritingViews();
        }
        const views = await _super(View, await this.withContext({ activeTest: false }))._getInheritingViews();
        // prefer inactive website-specific views over active generic ones
        return (await views.filterDuplicate()).filtered('active');
    }

    /**
     * This method add some specific view that do not have XML ID
     */
    @api.model()
    async _getFilterXmlidQuery() {
        if (!this._context['websiteId']) {
            return _super(View, this)._getFilterXmlidQuery();
        }
        else {
            return `SELECT "resId"
                    FROM   "irModelData"
                    WHERE  "resId" IN ({resIds})
                        AND model = 'ir.ui.view'
                        AND module IN ({modules})
                    UNION
                    SELECT sview.id
                    FROM   "irUiView" sview
                        INNER JOIN "irUiView" oview USING (key)
                        INNER JOIN "irModelData" d
                                ON oview.id = d."resId"
                                    AND d.model = 'ir.ui.view'
                                    AND d.module  IN ({modules})
                    WHERE  sview.id IN ({resIds})
                        AND sview."websiteId" IS NOT NULL
                        AND oview."websiteId" IS NULL;
                    `;
        }
    }

    /**
     * If a websiteId is in the context and the given xmlid is not an int
        then try to get the id of the specific view for that website, but
        fallback to the id of the generic view if there is no specific.

        If no websiteId is in the context, it might randomly return the generic
        or the specific view, so it's probably not recommanded to use this
        method. `viewref` is probably more suitable.

        Archived views are ignored (unless the activeTest context is set, but
        then the ormcacheContext will not work as expected).
     * @param xmlid 
     * @returns 
     */
    @api.model()
    @tools.ormcacheContext('self.env.uid', 'self.env.su', 'xmlid', ['websiteId'])
    async getViewId(xmlid) {
        if ('websiteId' in this._context && typeof (xmlid) !== 'number') {
            const currentWebsite = this.env.items('website').browse(this._context['websiteId']);
            const domain = ['&', ['key', '=', xmlid]].concat(currentWebsite.websiteDomain());

            const view = await (await this.sudo()).search(domain, { order: 'websiteId', limit: 1 });
            if (!bool(view)) {
                console.warn("Could not find view object with xmlid '%s'", xmlid);
                throw new ValueError('View %s in website %s not found', xmlid, this._context['websiteId']);
            }
            return view.id;
        }
        return _super(View, await this.sudo()).getViewId(xmlid);
    }

    /**
     * Check the visibility set on the main view and raise 403 if you should not have access.
            Order is: Public, Connected, Has group, Password

            It only check the visibility on the main content, others views called stay available in rpc.
     * @param doRaise 
     */
    async _handleVisibility(req, doRaise: boolean = true) {
        let error;

        const self = await this.sudo();
        const visibility = await self.visibility;
        const user = req && await (await req.getEnv()).user();
        if (visibility && user && ! await user.hasGroup('website.groupWebsiteDesigner')) {
            if (visibility === 'connected' && await req.website.isPublicUser()) {
                error = new Forbidden();
            }
            else if (visibility === 'password' &&
                (await req.website.isPublicUser() || !(req.session['viewsUnlock'] ?? []).includes(self.id))) {
                const pwd = req.params.get('visibilityPassword');
                if (pwd && user._cryptContext().verify(
                    pwd, await (await self.sudo()).visibilityPassword)) {
                    req.session.setdefault('viewsUnlock', []).push(self.id);
                }
                else {
                    error = new Forbidden('websiteVisibilityPasswordRequired');
                }
            }
            if (!['password', 'connected'].includes(visibility)) {
                try {
                    self._checkViewAccess()
                } catch (e) {
                    if (isInstance(e, AccessError)) {
                        error = new Forbidden();
                    }
                    else {
                        throw e;
                    }
                }
            }
        }
        if (error) {
            if (doRaise) {
                throw error;
            }
            else {
                return false;
            }
        }
        return true;
    }

    /**
     * Render the template. If website is enabled on request, then extend rendering context with website values.
     * @param values 
     * @param engine 
     * @param minimalQcontext 
     * @returns 
     */
    async _render(values?: any, engine: string = 'ir.qweb', minimalQcontext: boolean = false) {
        let self = this;
        const req = self.env.req;
        await self._handleVisibility(req, true);
        const newContext = Object.assign({}, self._context);
        if (req && getattr(req, 'isFrontend', false)) {
            const user = await (await req.getEnv()).user();
            let editable = await req.website.isPublisher();
            const translatable = editable && self._context['lang'] !== await (await req.website.defaultLangId).code;
            editable = !translatable && editable;

            // in edit mode ir.ui.view will tag nodes
            if (!translatable && !self.env.context['renderingBundle']) {
                if (editable) {
                    setdefault(newContext, "inheritBranding", true);
                }
                else if (await user.hasGroup('website.groupWebsitePublisher')) {
                    setdefault(newContext, "inheritBrandingAuto", true);
                }
            }
            if (bool(values) && 'mainObject' in values) {
                if (await user.hasGroup('website.groupWebsitePublisher')) {
                    const func = values['mainObject']['getBackendMenuId'];
                    values['backendMenuId'] = func && await func() || await self.env.items('ir.model.data')._xmlidToResId('website.menuWebsiteConfiguration');
                }
            }
        }

        if (!equal(self._context, newContext)) {
            self = await self.withContext(newContext);
        }
        return _super(View, self)._render(values, engine, minimalQcontext);
    }

    /**
     * Returns the qcontext : rendering context with website specific value (required
            to render website layout template)
     * @returns 
     */
    @api.model()
    async _prepareQcontext() {
        const req = this.env.req;
        const qcontext = await _super(View, this)._prepareQcontext();

        if (req && getattr(req, 'isFrontend', false)) {
            const env = await req.getEnv();
            const Website = this.env.items('website');
            let editable = await req.website.isPublisher();
            const translatable = editable && this._context['lang'] !== await (await env.items('ir.http')._getDefaultLang(req)).code;
            editable = !translatable && editable;

            const cur = await Website.getCurrentWebsite();
            const user = await this.env.user();
            if (await user.hasGroup('website.groupWebsitePublisher') && await user.hasGroup('website.groupMultiWebsite')) {
                qcontext['multiWebsiteWebsitesCurrent'] = { 'websiteId': cur.id, 'label': await cur.label, 'domain': await cur._getHttpDomain() }
                qcontext['multiWebsiteWebsites'] = []
                for (const website of await Website.search([])) {
                    if (!website.eq(cur)) {
                        qcontext['multiWebsiteWebsites'].push({ 'websiteId': website.id, 'label': await website.label, 'domain': await website._getHttpDomain() });
                    }
                }
                const curCompany = await this.env.company();
                qcontext['multiWebsiteCompaniesCurrent'] = { 'companyId': curCompany.id, 'label': await curCompany.label }
                qcontext['multiWebsiteCompanies'] = [];
                for (const comp of await user.companyIds) {
                    if (!comp.eq(curCompany)) {
                        qcontext['multiWebsiteCompanies'].push({ 'companyId': comp.id, 'label': await comp.label });
                    }
                }
            }

            update(qcontext, {
                mainObject: this,
                website: req.website,
                isViewActive: await req.website.isViewActive,
                resCompany: await env.items('res.company').browse(await req.website._getCached('companyId')).sudo(),
                translatable: translatable,
                editable: editable,
            });
        }

        return qcontext;
    }

    @api.model()
    async getDefaultLangCode() {
        const websiteId = this.env.context['websiteId'];
        if (bool(websiteId)) {
            const langCode = await (await this.env.items('website').browse(websiteId).defaultLangId).code;
            return langCode;
        }
        else {
            return _super(View, this).getDefaultLangCode();
        }
    }

    async redirectToPageManager() {
        return {
            'type': 'ir.actions.acturl',
            'url': '/website/pages',
            'target': 'self',
        }
    }

    _readTemplateKeys() {
        return _super(View, this)._readTemplateKeys().concat(['websiteId']);
    }

    @api.model()
    async _saveOeStructureHook() {
        const res = await _super(View, this)._saveOeStructureHook();
        res['websiteId'] = (await this.env.items('website').getCurrentWebsite()).id;
        return res;
    }

    /**
     * If website is installed, any call to `save` from the frontend will
        actually write on the specific view (or create it if not exist yet).
        In that case, we don't want to flag the generic view as noupdate.
     */
    @api.model()
    async _setNoupdate() {
        if (!bool(this._context['websiteId'])) {
            await _super(View, this)._setNoupdate();
        }
    }

    async save(value, xpath?: any) {
        this.ensureOne();
        let self = this;
        const currentWebsite = await self.env.items('website').getCurrentWebsite();
        // xpath condition is important to be sure we are editing a view and not
        // a field as in that case `self` might not exist (check commit message)
        if (xpath && await self['key'] && bool(currentWebsite)) {
            // The first time a generic view is edited, if multiple editable parts
            // were edited at the same time, multiple call to this method will be
            // done but the first one may create a website specific view. So if there
            // already is a website specific view, we need to divert the super to it.
            const websiteSpecificView = await self.env.items('ir.ui.view').search([
                ['key', '=', await self['key']],
                ['websiteId', '=', currentWebsite.id]
            ], { limit: 1 });
            if (bool(websiteSpecificView)) {
                self = websiteSpecificView;
            }
        }
        await _super(View, self).save(value, xpath);
    }

    @api.model()
    async _getAllowedRootAttrs() {
        // Related to these options:
        // background-video, background-shapes, parallax
        return (await _super(View, this)._getAllowedRootAttrs()).concat([
            'data-bg-video-src', 'data-shape', 'data-scroll-background-ratio',
        ]);
    }

    // Snippet saving

    @api.model()
    async _snippetSaveViewValuesHook() {
        const res = await _super(View, this)._snippetSaveViewValuesHook();
        const websiteId = this.env.context['websiteId'];
        if (bool(websiteId)) {
            res['websiteId'] = websiteId;
        }
        return res;
    }
}