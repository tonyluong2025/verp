import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { NotFound } from "../../../core/service";
import { urlParse } from "../../../core/service/middleware/utils";
import { bool, f, htmlTranslate, isInstance } from "../../../core/tools";

@MetaModel.define()
class Menu extends Model {
  static _module = module;
  static _name = "website.menu";
  static _description = "Website Menu";

  static _parentStore = true;
  static _order = "sequence, id";

  async _defaultSequence() {
    const menu = await this.search([], { limit: 1, order: "sequence DESC" });
    return await menu.sequence || 0;
  }

  @api.depends('megaMenuContent')
  async _computeFieldIsMegaMenu() {
    for (const menu of this) {
      await menu.set('isMegaMenu', bool(await menu.megaMenuContent));
    }
  }

  async _setFieldIsMegaMenu() {
    for (const menu of this) {
      if (await menu.isMegaMenu) {
        if (! await menu.megaMenuContent) {
          await menu.set('megaMenuContent', await this.env.items('ir.ui.view')._renderTemplate('website.sMegaMenuVerpMenu'));
        }
      }
      else {
        await menu.set('megaMenuContent', false);
        await menu.set('megaMenuClasses', false);
      }
    }
  }

  static label = Fields.Char('Menu', { required: true, translate: true });
  static url = Fields.Char('Url', { default: '' });
  static pageId = Fields.Many2one('website.page', { string: 'Related Page', ondelete: 'CASCADE' });
  static newWindow = Fields.Boolean('New Window');
  static sequence = Fields.Integer({ default: self => self._defaultSequence() });
  static websiteId = Fields.Many2one('website', { string: 'Website', ondelete: 'CASCADE' });
  static parentId = Fields.Many2one('website.menu', { string: 'Parent Menu', index: true, ondelete: "CASCADE" });
  static childId = Fields.One2many('website.menu', 'parentId', { string: 'Child Menus' });
  static parentPath = Fields.Char({ index: true });
  static isVisible = Fields.Boolean({ compute: '_computeVisible', string: 'Is Visible' });
  static groupIds = Fields.Many2many('res.groups', {
    string: 'Visible Groups',
    help: "User need to be at least in one of these groups to see the menu"
  });
  static isMegaMenu = Fields.Boolean({ compute: '_computeFieldIsMegaMenu', inverse: '_setFieldIsMegaMenu' });
  static megaMenuContent = Fields.Html({ translate: htmlTranslate, sanitize: false, prefetch: true });
  static megaMenuClasses = Fields.Char();

  async nameGet() {
    if (!this._context['displayWebsite'] && ! await (await this.env.user()).hasGroup('website.groupMultiWebsite')) {
      return _super(Menu, this).nameGet();
    }

    const res = [];
    for (const menu of this) {
      let [label, website] = await menu('label', 'websiteId');
      if (website.ok) {
        label += f(' [%s]', await website.label);
      }
      res.push([menu.id, label]);
    }
    return res;
  }

  /**
   * In case a menu without a websiteId is trying to be created, we duplicate
          it for every website.
          Note: Particulary useful when installing a module that adds a menu like
                /shop. So every website has the shop menu.
                Be careful to return correct record for ir.model.data xmlid in case
                of default main menus creation.
   * @param vals 
   */
  @api.model()
  async create(vals) {
    this.clearCaches();
    // Only used when creating website_data.xml default menu
    if (vals['url'] === '/default-main-menu') {
      return _super(Menu, this).create(vals);
    }
    let res;
    if ('websiteId' in vals) {
      return _super(Menu, this).create(vals);
    }
    else if (this._context['websiteId']) {
      vals['websiteId'] = this._context['websiteId'];
      return _super(Menu, this).create(vals);
    }
    else {
      // create for every site
      for (const website of await this.env.items('website').search([])) {
        const wVals = Object.assign({}, vals, {
          'websiteId': website.id,
          'parentId': (await website.menuId).id,
        });
        res = await _super(Menu, this).create(wVals);
      }
      // if creating a default menu, we should also save it as such
      const defaultMenu = await this.env.ref('website.mainMenu', false);
      if (defaultMenu && vals['parentId'] == defaultMenu.id) {
        res = await _super(Menu, this).create(vals);
      }
    }
    return res;  // Only one record is returned but multiple could have been created
  }

  async write(values) {
    const res = await _super(Menu, this).write(values);
    if ('websiteId' in values || 'groupIds' in values || 'sequence' in values || 'pageId' in values) {
      this.clearCaches();
    }
    return res;
  }

  async unlink() {
    this.clearCaches();
    const defaultMenu = await this.env.ref('website.mainMenu', false);
    let menusToRemove = this;
    for (const menu of await this.filtered(async (m) => bool(defaultMenu) && (await m.parentId).id == defaultMenu.id)) {
      menusToRemove = menusToRemove.or(await this.env.items('website.menu').search([['url', '=', await menu.url],
      ['websiteId', '!=', false],
      ['id', '!=', menu.id]]));
    }
    return _super(Menu, menusToRemove).unlink();
  }

  async _computeVisible() {
    const req = this.env.req;
    for (const menu of this) {
      let visible = true;
      const page = await menu.pageId;
      if (page.ok && ! await menu.userHasGroups('base.groupUser')) {
        const pageSudo = await page.sudo();
        if (! await pageSudo.isVisible || (! await (await pageSudo.viewId)._handleVisibility(req, false)
          && await (await pageSudo.viewId).visibility !== "password")) {
          visible = false;
        }
      }
      await menu.set('isVisible', visible);
    }
  }

  @api.model()
  async cleanUrl() {
    // clean the url with heuristic
    let [page, url] = await this('pageId', 'url');
    if (page.ok) {
      url = await (await page.sudo()).url;
    }
    else {
      if (url && !url.startsWith('/')) {
        if (url.includes('@')) {
          if (!url.startsWith('mailto')) {
            url = f('mailto:%s', url);
          }
        }
        else if (!url.startsWith('http')) {
          url = f('/%s', url);
        }
      }
    }
    return url;
  }

  // would be better to take a menuId as argument
  @api.model()
  async getTree(websiteId, menuId?: any) {
    async function makeTree(node) {
      const [page, label, newWindow, isMegaMenu, sequence, parent, children] = await node('pageId', 'label', 'newWindow', 'isMegaMenu', 'sequence', 'parentId', 'childId');
      const isHomepage = bool(page.ok && (await this.env.items('website').browse(websiteId).homepageId).id == page.id);
      const menuNode = {
        'fields': {
          'id': node.id,
          'label': label,
          'url': page.ok ? await page.url : await node.url,
          'newWindow': newWindow,
          'isMegaMenu': isMegaMenu,
          'sequence': sequence,
          'parentId': parent.id,
        },
        'children': [],
        'isHomepage': isHomepage,
      }
      for (const child of children) {
        menuNode['children'].push(await makeTree(child));
      }
      return menuNode;
    }
    const menu = menuId && this.browse(menuId) || await this.env.items('website').browse(websiteId).menuId;
    return makeTree(menu);
  }

  @api.model()
  async save(req, websiteId, data) {
    function replaceId(oldId, newId) {
      for (const menu of data['data']) {
        if (menu['id'] == oldId) {
          menu['id'] = newId;
        }
        if (menu['parentId'] == oldId) {
          menu['parentId'] = newId;
        }
      }
    }

    const toDelete = data['toDelete'];
    if (bool(toDelete)) {
      await this.browse(toDelete).unlink();
    }
    for (const menu of data['data']) {
      const mid = menu['id'];
      // new menu are prefixed by new-
      if (typeof mid === 'string') {
        const newMenu = await this.create({ 'label': menu['label'], 'websiteId': websiteId });
        replaceId(mid, newMenu.id);
      }
    }
    for (const menu of data['data']) {
      const menuId = this.browse(menu['id']);
      // Check if the url match a website.page (to set the m2o relation),
      // except if the menu url contains '#', we then unset the pageId
      if (menu['url'].includes('#')) {
        // Multiple case possible
        // 1. `#` => menu container (dropdown, ..)
        // 2. `#anchor` => anchor on current page
        // 3. `/url#something` => valid internal URL
        // 4. https://google.com#smth => valid external URL
        if (bool(await menuId.pageId)) {
          await menuId.set('pageId', null);
        }
        if (req && menu['url'].startsWith('#') && menu['url'].length > 1) {
          // Working on case 2.: prefix anchor with referer URL
          const refererUrl = urlParse(req.httpRequest.setHeader('Referer', '')).pathname;
          menu['url'] = refererUrl + menu['url'];
        }
      }
      else {
        const domain = this.env.items("website").websiteDomain(websiteId).concat([
          "|",
          ["url", "=", menu["url"]],
          ["url", "=", "/" + menu["url"]],
        ]);
        const page = await this.env.items("website.page").search(domain, { limit: 1 });
        if (page.ok) {
          menu['pageId'] = page.id;
          menu['url'] = await page.url;
        }
        else if ((await menuId.pageId).ok) {
          try {
            // a page shouldn't have the same url as a controller
            await this.env.items('ir.http')._match(req, menu['url']);
            await menuId.set('pageId', null);
          } catch (e) {
            if (isInstance(e, NotFound)) {
              await (await menuId.pageId).write({ 'url': menu['url'] })
            }
            else {
              throw e;
            }
          }
        }
      }
      await menuId.write(menu);
    }

    return true;
  }
}