import { Fields, _Datetime, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, bool, escapePsql, escapeRegExp, f, len, parseInt, quote, quoteList, slugify } from "../../../core/tools";
import { safeEval } from "../../../core/tools/save_eval";
import { textFromHtml } from "../tools";

@MetaModel.define()
class Page extends Model {
  static _module = module;
  static _name = 'website.page';
  static _parents = ['website.published.multi.mixin', 'website.searchable.mixin'];
  static _inherits = { 'ir.ui.view': 'viewId' }
  static _description = 'Page';
  static _order = 'websiteId';

  static url = Fields.Char('Page URL');
  static viewId = Fields.Many2one('ir.ui.view', { string: 'View', required: true, ondelete: "CASCADE" });
  static websiteIndexed = Fields.Boolean('Is Indexed', { default: true });
  static datePublish = Fields.Datetime('Publishing Date');
  // This is needed to be able to display if page is a menu in /website/pages
  static menuIds = Fields.One2many('website.menu', 'pageId', { string: 'Related Menus' });
  static isHomepage = Fields.Boolean({ compute: '_computeHomepage', inverse: '_setHomepage', string: 'Homepage' });
  static isVisible = Fields.Boolean({ compute: '_computeVisible', string: 'Is Visible' });

  static cacheTime = Fields.Integer({ default: 3600, help: 'Time to cache the page. (0 = no cache)' });
  static cacheKeyExpr = Fields.Char({ help: 'Expression (tuple) to evaluate the cached key. \nE.g.: "(request.params.get("currency"), )"' });

  // Page options
  static headerOverlay = Fields.Boolean();
  static headerColor = Fields.Char();
  static headerVisible = Fields.Boolean({ default: true });
  static footerVisible = Fields.Boolean({ default: true });

  // don't use mixin websiteId but use websiteId on ir.ui.view instead
  static websiteId = Fields.Many2one({ related: 'viewId.websiteId', store: true, readonly: false, ondelete: 'CASCADE' });
  static arch = Fields.Text({ related: 'viewId.arch', readonly: false, dependsContext: ['websiteId',] });

  async _computeHomepage() {
    for (const page of this) {
      await page.set('isHomepage', page.eq(await (await this.env.items('website').getCurrentWebsite()).homepageId));
    }
  }

  async _setHomepage() {
    for (const page of this) {
      const website = await this.env.items('website').getCurrentWebsite();
      if (await page.isHomepage) {
        if (!(await website.homepageId).eq(page)) {
          await website.write({ 'homepageId': page.id });
        }
      }
      else {
        if (!(await website.homepageId).eq(page)) {
          await website.write({ 'homepageId': null });
        }
      }
    }
  }

  async _computeVisible() {
    for (const page of this) {
      await page.set('isVisible', await page.websitePublished && (
        ! await page.datePublish || await page.datePublish < _Datetime.now()
      ));
    }
  }

  /**
   * Returns the most specific pages in self.
   * @returns 
   */
  async _getMostSpecificPages() {
    const ids = [];
    let previousPage;
    // Iterate a single time on the whole list sorted on specific-website first.
    for (const page of await this.sorted(async (p) => [await p.url || '', !(await p.websiteId)].toString())) {
      if (!bool(previousPage) || await page.url !== await previousPage.url) {
        ids.push(page.id);
      }
      previousPage = page;
    }
    return this.filtered((page) => ids.includes(page.id));
  }

  async getPageProperties() {
    this.ensureOne();
    const res = await this.readOne([
      'id', 'viewId', 'label', 'url', 'websitePublished', 'websiteIndexed', 'datePublish',
      'menuIds', 'isHomepage', 'websiteId', 'visibility', 'groupsId'
    ]);
    if (!res['groupsId']) {
      res['groupId'] = (await (await this.env.ref('base.groupUser')).nameGet())[0];
    }
    else if (len(res['groupsId']) == 1) {
      res['groupId'] = (await this.env.items('res.groups').browse(res['groupsId']).nameGet())[0];
    }
    delete res['groupsId'];

    res['visibilityPassword'] = res['visibility'] == 'password' && await this['visibilityPasswordDisplay'] || '';
    return res;
  }

  @api.model()
  async savePageInfo(websiteId, data) {
    const website = this.env.items('website').browse(websiteId);
    let page = this.browse(parseInt(data['id']));

    // If URL has been edited, slug it
    const originalUrl = await page.url;
    let url = data['url'];
    if (!url.startsWith('/')) {
      url = '/' + url;
    }
    if (await page.url !== url) {
      url = '/' + slugify(url, 1024, true);
      url = this.env.items('website').getUniquePath(url);
    }

    // If name has changed, check for key uniqueness
    let pageKey;
    if (await page.label !== data['label']) {
      pageKey = await this.env.items('website').getUniqueKey(slugify(data['label']));
    }
    else {
      pageKey = await page.key;
    }

    const menu = await this.env.items('website.menu').search([['pageId', '=', parseInt(data['id'])]]);
    if (!data['isMenu']) {
      // If the page is no longer in menu, we should remove its website_menu
      if (bool(menu)) {
        await menu.unlink();
      }
    }
    else {
      // The page is now a menu, check if has already one
      if (bool(menu)) {
        await menu.write({ 'url': url });
      }
      else {
        await this.env.items('website.menu').create({
          'label': data['label'],
          'url': url,
          'pageId': data['id'],
          'parentId': (await website.menuId).id,
          'websiteId': website.id,
        })
      }
    }
    // Edits via the page manager shouldn't trigger the COW
    // mechanism and generate new pages. The user manages page
    // visibility manually with isPublished here.
    const wVals = {
      'key': pageKey,
      'label': data['label'],
      'url': url,
      'isPublished': data['websitePublished'],
      'websiteIndexed': data['websiteIndexed'],
      'datePublish': data['datePublish'] || null,
      'isHomepage': data['isHomepage'],
      'visibility': data['visibility'],
    }
    if (await page.visibility === 'restrictedGroup' && data['visibility'] !== "restrictedGroup") {
      wVals['groupsId'] = false;
    }
    else if ('groupId' in data) {
      wVals['groupsId'] = [data['groupId']];
    }
    if ('visibilityPwd' in data) {
      wVals['visibilityPasswordDisplay'] = data['visibilityPwd'] || '';
    }
    await (await page.withContext({ noCow: true })).write(wVals);

    // Create redirect if needed
    if (data['createRedirect']) {
      await this.env.items('website.rewrite').create({
        'label': data['label'],
        'redirectType': data['redirectType'],
        'urlFrom': originalUrl,
        'urlTo': url,
        'websiteId': website.id,
      });
    }

    return url;
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    if (defaultValue) {
      if (!defaultValue['viewId']) {
        const view = this.env.items('ir.ui.view').browse((await this['viewId']).id);
        const newView = await view.copy({ 'websiteId': defaultValue['websiteId'] });
        defaultValue['viewId'] = newView.id;
      }
      defaultValue['url'] = defaultValue['url'] || await this.env.items('website').getUniquePath(await this['url']);
    }
    return _super(Page, this).copy(defaultValue);
  }

  /**
   * Clone a page, given its identifier
          :param pageId : website.page identifier
   * @param pageId 
   * @param pageName 
   * @param cloneMenu 
   * @returns 
   */
  @api.model()
  async clonePage(pageId, pageName?: any, cloneMenu: boolean = true) {
    const page = this.browse(parseInt(pageId));
    const copyParam = Object.assign({}, { label: pageName || await page.label, websiteId: (await this.env.items('website').getCurrentWebsite()).id });
    if (pageName) {
      const pageUrl = '/' + slugify(pageName, 1024, true);
      copyParam['url'] = await this.env.items('website').getUniquePath(pageUrl);
    }

    const newPage = await page.copy(copyParam);
    // Should not clone menu if the page was cloned from one website to another
    // Eg: Cloning a generic page (no website) will create a page with a website, we can't clone menu (not same container)
    if (cloneMenu && (await newPage.websiteId).eq(await page.websiteId)) {
      const menu = await this.env.items('website.menu').search([['pageId', '=', pageId]], { limit: 1 });
      if (menu.ok) {
        // If the page being cloned has a menu, clone it too
        await menu.copy({ 'url': await newPage.url, 'label': await newPage.label, 'pageId': newPage.id });
      }
    }
    return await newPage.url + '?enableEditor=1';
  }

  async unlink() {
    // When a website_page is deleted, the ORM does not delete its
    // ir_ui_view. So we got to delete it ourself, but only if the
    // ir_ui_view is not used by another website_page.
    for (const page of this) {
      // Other pages linked to the ir_ui_view of the page being deleted (will it even be possible?)
      const view = await page.viewId;
      const pagesLinkedToIruiview = await this.search(
        [['viewId', '=', view.id], ['id', '!=', page.id]]
      );
      if (!pagesLinkedToIruiview.ok && !(await view.inheritChildrenIds).ok) {
        // If there is no other pages linked to that ir_ui_view, we can delete the ir_ui_view
        await view.unlink();
      }
    }
    // Make sure website._get_menu_ids() will be recomputed
    this.clearCaches();
    return _super(Page, this).unlink();
  }

  async write(vals) {
    if ('url' in vals && !vals['url'].startsWith('/')) {
      vals['url'] = '/' + vals['url'];
    }
    this.clearCaches()  // write on page == write on view that invalid cache
    return _super(Page, this).write(vals);
  }

  async getWebsiteMeta() {
    this.ensureOne();
    return (await this['viewId']).getWebsiteMeta();
  }

  static _getCachedBlacklist() {
    return ['data-snippet="sWebsiteForm"', 'data-no-page-cache=',];
  }

  /**
   * return false if at least one blacklisted's word is present in content
   * @param response 
   * @returns 
   */
  _canBeCached(response) {
    const blacklist = this.cls._getCachedBlacklist();
    return !blacklist.some(black => String(response).includes(black));
  }

  async _getCacheKey(req) {
    // Always call me with super() AT THE END to have cacheKeyExpr appended as last element
    // It is the only way for end user to not use cache via expr.
    // E.g  (None if 'token' in request.params else 1,)  will bypass cacheTime
    let cacheKey = [req.website.id, req.lang, req.httpRequest.pathname];
    if (await this['cacheKeyExpr']) { // e.g. (request.session.geoip['countryCode'],)
      cacheKey = cacheKey.concat(safeEval(await this['cacheKeyExpr'], { 'request': req }));
    }
    return cacheKey;
  }

  /**
   * Return the cached response corresponding to ``self`` and ``cache_key``.
      Raise a KeyError if the item is not in cache.
   * @param cacheKey 
   * @returns 
   */
  _getCacheResponse(cacheKey) {
    // HACK: we use the same LRU as ormcache to take advantage from its
    // distributed invalidation, but we don't explicitly use ormcache
    return this.pool.__cache.get(String(['website.page', '_cachedResponse', this.id, cacheKey]));
  }

  /**
   * Put in cache the given response.
   * @param cacheKey 
   * @param response 
   */
  _setCacheResponse(cacheKey, response) {
    this.pool.__cache.set(String(['website.page', '_cachedResponse', this.id, cacheKey]), response);
  }

  @api.model()
  async _searchGetDetail(website, order, options) {
    const withDescription = options['displayDescription'];
    // Read access on website.page requires sudo.
    let requiresSudo = true;
    let domain = [website.websiteDomain()];
    if (! await (await this.env.user()).hasGroup('website.groupWebsiteDesigner')) {
      // Rule must be reinforced because of sudo.
      domain.push([['websitePublished', '=', true]]);
    }
    const searchFields = ['label', 'url'];
    const fetchFields = ['id', 'label', 'url'];
    const mapping = {
      'label': { 'label': 'label', 'type': 'text', 'match': true },
      'websiteUrl': { 'label': 'url', 'type': 'text', 'truncate': false },
    }
    if (withDescription) {
      searchFields.push('archDb');
      fetchFields.push('arch');
      mapping['description'] = { 'label': 'arch', 'type': 'text', 'html': true, 'match': true }
    }
    return {
      'model': 'website.page',
      'baseDomain': domain,
      'requiresSudo': requiresSudo,
      'searchFields': searchFields,
      'fetchFields': fetchFields,
      'mapping': mapping,
      'icon': 'fa-file-o',
    }
  }

  @api.model()
  async _searchFetch(searchDetail, search, limit, order) {
    const withDescription = 'description' in searchDetail['mapping'];
    // Cannot rely on the super's _search_fetch because the search must be
    // performed among the most specific pages only.
    const fields = searchDetail['searchFields'];
    const baseDomain = searchDetail['baseDomain'];
    const domain = await (this as any)._searchBuildDomain(baseDomain, search, fields, searchDetail['searchExtra']);
    // TODO In 16.0 do not rely on _filter_duplicate_pages.
    const mostSpecificPages = await (await this.env.items('website').withContext({ _filterDuplicatePages: !order.includes('url') }))._getWebsitePages(expression.AND(baseDomain), order);
    let results = await mostSpecificPages.filteredDomain(domain);  // already sudo

    if (withDescription && search) {
      // Perform search in translations
      // TODO Remove when domains will support xml_translate fields
      const query = _f(`
                SELECT DISTINCT "{table}".{id}
                FROM "{table}"
                LEFT JOIN "irTranslation" t ON "{table}"."{viewId}" = t."{resId}"
                WHERE t.lang = {lang}
                AND t.label = ANY({names})
                AND t.type = 'modelTerms'
                AND t.value ilike {search}
                AND "{table}".{id} IN {ids}
                LIMIT {limit}
            `, {
        table: this.cls._table,
        id: 'id',
        viewId: 'viewId',
        resId: 'resId',
        lang: '{lang}',
        names: '{names}',
        search: '{search}',
        ids: '{ids}',
        limit: '{limit}',
      });
      const res = await this.env.cr.execute(_f(query, {
        'lang': quote(this.env.lang),
        'names': quoteList(['ir.ui.view,archDb', 'ir.ui.view,label']),
        'search': f("'%%s%'", escapePsql(search)),
        'ids': String(mostSpecificPages.ids),
        'limit': mostSpecificPages.ids.length,
      }));
      const ids = new Set(res.map(row => row['id']));
      if (ids.size) {
        results.ids.forEach(id => ids.add(id));
        const domains = structuredClone(searchDetail['baseDomain']);
        domains.push([['id', 'in', Array.from(ids)]]);
        const domain = expression.AND(domains);
        const model = searchDetail['requiresSudo'] ? await this.sudo() : this;
        results = await model.search(
          domain,
          {
            limit: len(ids),
            order: searchDetail['order'] ?? order
          }
        );
      }
    }


    async function filterPage(search, page, allPages) {
      // Search might have matched words in the xml tags and parameters therefore we make
      // sure the terms actually appear inside the text.
      const text = f('%s %s %s', await page.label, await page.url, textFromHtml(await page.arch));
      const pattern = search.replace('  ', ' ').split(' ').map(searchTerm => escapeRegExp(searchTerm)).join('|');
      return pattern ? text.matchAll(new RegExp(f('(%s)', pattern), 'gi')) : false;
    }

    if (search && withDescription) {
      results = await results.filtered(async (result) => filterPage(search, result, results));
    }
    return [results.slice(0, limit), len(results)]
  }
}

// this is just a dummy function to be used as ormcache key
function _cachedResponse() {
  // pass
}
