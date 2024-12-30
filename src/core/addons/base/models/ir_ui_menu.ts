import fs from "fs/promises";
import { api, tools } from "../../..";
import { setdefault } from "../../../api/func";
import { Fields } from "../../../fields";
import { MetaModel, Model, _super } from "../../../models";
import { getResourcePath } from "../../../modules/modules";
import { expression } from "../../../osv";
import { b64encode, filePath } from "../../../tools";
import { bool } from "../../../tools/bool";
import { extend, len, sorted } from "../../../tools/iterable";
import { f } from "../../../tools/utils";

const NUMBER_PARENS = /\(([0-9]+)\)/g;
const MENU_ITEM_SEPARATOR = "/"

@MetaModel.define()
class IrUiMenu extends Model {
  static _module = module;
  static _name = 'ir.ui.menu';
  static _description = 'Menu';
  static _order = "sequence,id";

  constructor() {
    super();
    const cls = this.constructor as any;
    cls.pool.models['ir.model.access'].registerCacheClearingMethod(cls._name, 'clearCaches');
  }

  static label = Fields.Char({ string: 'Menu', required: true, translate: true });
  static active = Fields.Boolean({ default: true });
  static sequence = Fields.Integer({ default: 10 });
  static childId = Fields.One2many('ir.ui.menu', 'parentId', { string: 'Child IDs' });
  static parentId = Fields.Many2one('ir.ui.menu', { string: 'Parent Menu', index: true, ondelete: 'RESTRICT' });
  static parentPath = Fields.Char({ index: true });
  static groupsId = Fields.Many2many('res.groups', { relation: 'irUiMenuGroupRel', column1: 'menuId', column2: 'gid', string: 'Groups', help: "If you have groups, the visibility of this menu will be based on these groups. If this field is empty, Verp will compute visibility based on the related object's read access." });
  static completeName = Fields.Char({ string: 'Full Path', compute: '_computeCompleteName', recursive: true });
  static action = Fields.Reference([
    ['ir.actions.report', 'ir.actions.report'],
    ['ir.actions.actwindow', 'ir.actions.actwindow'],
    ['ir.actions.acturl', 'ir.actions.acturl'],
    ['ir.actions.server', 'ir.actions.server'],
    ['ir.actions.client', 'ir.actions.client'],
    ['ir.actions.actions', 'ir.actions.actions'],
  ]);
  static webIcon = Fields.Char({ string: 'Web Icon File' });
  static webIconData = Fields.Binary({ string: 'Web Icon Image', attachment: true });

  @api.depends('label', 'parentId.completeName')
  async _computeCompleteName() {
    for (const menu of this) {
      await menu.set('completeName', await menu._getFullName());
    }
  }

  @api.model()
  async _search(args, options: { offset?: 0, limit?: null, order?: null, count?: false, accessRightsUid?: null, debug?: boolean } = {}) {
    let menuIds: any = await _super(IrUiMenu, this)._search(args, options);
    let menus: any = this.browse(menuIds);
    if (menus.ok) {
      // menu filtering is done only on main menu tree, not other menu lists
      if (!this._context['ir.ui.menu.fullList']) {
        menus = await menus._filterVisibleMenus(options.debug);
      }
      if (options.offset) {
        menus = menus(options.offset);
      }
      if (options.limit) {
        menus = menus([0, options.limit]);
      }
    }
    return options.count ? len(menus) : menus.ids
  }

  /**
   *  Return the ids of the menu items visible to the user.
   * @param debug 
   * @returns 
   */
  @api.model()
  @tools.ormcache('(await (await self.env.user()).groupsId).ids', 'debug')
  async _visibleMenuIds(debug = false) {
    // retrieve all menus, and determine which ones are visible
    const context = { 'ir.ui.menu.fullList': true };
    let menus = await (await (await this.withContext(context)).search([])).sudo();

    const user = await this.env.user();
    let groups = await user.groupsId;
    if (!debug) {
      groups = groups.sub(await this.env.ref('base.groupNoOne'));
    }
    // first discard all menus with groups the user does not have
    menus = await menus.filtered(async (menu) => {
      const groupsId = await menu.groupsId;
      return !bool(groupsId) || bool(groupsId.and(groups));
    });

    // take apart menus that have an action
    // actionId is baseActionId, set in convert._tagMenuitem()
    const actionMenus = await menus.filtered(async (m) => {
      const action = await m.action;
      if (action) {
        return this.env.items(action._name).browse(action.id).exists();
      } else {
        return false;
      }
    });
    const folderMenus = menus.sub(actionMenus);
    let visible = this.browse();

    // process action menus, check whether their action is allowed
    const access = this.env.items('ir.model.access');
    const MODEL_GETTER = {
      'ir.actions.actwindow': async (action) => action.resModel,
      'ir.actions.report': async (action) => action.model,
      'ir.actions.server': async (action) => (await action.modelId).model,
    }
    for (let menu of actionMenus) {
      const action = await menu.action;
      const getModel = MODEL_GETTER[action._name];
      if (!getModel || ! await getModel(action) || await access.check(await getModel(action), 'read', false)) {
        // make menu visible, and its folder ancestors, too
        visible = visible.add(menu);
        menu = await menu.parentId;
        while (bool(menu) && folderMenus.contains(menu) && !visible.contains(menu)) {
          visible = visible.add(menu);
          menu = await menu.parentId;
        }
      }
    }
    return visible.ids;
  }

  @api.returns('self')
  async _filterVisibleMenus(debug?: any) {
    const visibleIds = await this._visibleMenuIds(debug);
    return this.filtered((menu) => visibleIds.includes(menu.id));
  }

  async nameGet() {
    const res = [];
    for (const menu of this as any) {
      res.push([menu.id, await menu._getFullName()]);
    }
    return res;
  }

  async _getFullName(level = 6) {
    if (level <= 0) {
      return '...';
    }
    const [parentId, label] = await this('parentId', 'label');
    if (parentId.ok) {
      return (await parentId._getFullName(level - 1)) + MENU_ITEM_SEPARATOR + (label || "")
    }
    else {
      return label;
    }
  }

  async readImage(path) {
    if (!path) {
      return false;
    }
    const pathInfo = path.split(',');
    const iconPath = getResourcePath(pathInfo[0], pathInfo[1]);
    let iconImage: any = false;
    if (iconPath) {
      const buffer = await fs.readFile(filePath(iconPath));
      iconImage = b64encode(buffer);
    }
    return iconImage;
  }

  @api.modelCreateMulti()
  async create(valsList) {
    this.clearCaches();
    for (const values of valsList) {
      if ('webIcon' in values) {
        values['webIconData'] = await this._computeWebIconData(values['webIcon']);
      }
    }
    return _super(IrUiMenu, this).create(valsList);
  }

  async write(values) {
    this.clearCaches();
    if ('webIcon' in values) {
      values['webIconData'] = await this._computeWebIconData(values['webIcon']);
    }
    return _super(IrUiMenu, this).write(values);
  }

  /**
   * Returns the image associated to `webIcon`.
    `webIcon` can either be:
      - an image icon [module, path]
      - a built icon [iconClass, iconColor, backgroundColor]
    and it only has to call `readImage` if it's an image.
   * @param webIcon 
   * @returns 
   */
  async _computeWebIconData(webIcon) {
    if (webIcon && len(webIcon.split(',')) == 2) {
      return this.readImage(webIcon);
    }
  }

  async unlink() {
    // Detach children and promote them to top-level, because it would be unwise to
    // CASCADE-delete submenus blindly. We also can't use ondelete=set null because
    // that is not supported when _parentStore is used (would silently corrupt it).
    // TODO: ideally we should move them under a generic "Orphans" menu somewhere?
    const extra = { 'ir.ui.menu.fullList': true, 'activeTest': false }
    const directChildren = await (await this.withContext(extra)).search([['parentId', 'in', this.ids]]);
    await directChildren.write({ 'parentId': false });

    this.clearCaches();
    return _super(IrUiMenu, this).unlink();
  }

  async copy(defaultValue?: any) {
    const record = await _super(IrUiMenu, this).copy(defaultValue);
    const label: string = await record.label;
    const [matche] = label.matchAll(NUMBER_PARENS);
    if (matche?.length > 1) {
      const nextNum = parseInt(matche[1]) + 1;
      record.label = label.replace(NUMBER_PARENS, `(${nextNum})`);
    }
    else
      record.label = label + '(1)';
    return record
  }

  /**
   * Return all root menu ids visible for the user.

   * @returns the root menu ids
   */
  @api.model()
  @api.returns('self')
  async getUserRoots(debug: boolean = false) {
    return this.search([['parentId', '=', null]], { debug: debug });
  }

  @api.model()
  @tools.ormcacheContext('self._uid', ['lang'])
  async loadMenusRoot(debug: boolean = false) {
    const fields = ['label', 'sequence', 'parentId', 'action', 'webIconData']
    const menuRoots = await this.getUserRoots(debug);
    const menuRootsData = menuRoots.ok ? await menuRoots.read(fields) : [];

    const menuRoot = {
      'id': false,
      'label': 'root',
      'parentId': [-1, ''],
      'children': menuRootsData,
      'allMenuIds': menuRoots.ids,
    }

    const xmlids = await menuRoots._getMenuitemsXmlids();
    for (const menu of Object.values(menuRootsData)) {
      menu['xmlid'] = xmlids[menu['id']];
    }

    return menuRoot;
  }

  async _loadMenusBlacklist() {
    return [];
  }

  /**
   * Loads all menu items (all applications and their sub-menus).

   * @param debug 
   * @returns the menu root
   */
  @api.model()
  @tools.ormcacheContext('self._uid', 'debug', ['lang'])
  async loadMenus(debug) {
    const fields = ['label', 'sequence', 'parentId', 'action', 'webIcon', 'webIconData'];
    const menuRoots = await this.getUserRoots(debug);
    const menuRootsData = menuRoots.ok ? await menuRoots.read(fields) : [];
    const menuRoot = {
      'id': false,
      'label': 'root',
      'parentId': [-1, ''],
      'children': menuRootsData.map(menu => menu['id']),
    }

    let resMenus = { 'root': menuRoot };

    if (!menuRootsData.length) {
      return resMenus;
    }

    // menus are loaded fully unlike a regular tree view, cause there are a
    // limited number of items (752 when all 6.1 addons are installed)
    let menusDomain = [['id', 'childOf', menuRoots.ids]];
    const blacklistedMenuIds = await this._loadMenusBlacklist();
    if (blacklistedMenuIds.length) {
      menusDomain = expression.AND([menusDomain, [['id', 'not in', blacklistedMenuIds]]]);
    }
    const menuRecs = await this.search(menusDomain);
    let menuItems = await menuRecs.read(fields);
    const xmlids = await menuRoots.add(menuRecs)._getMenuitemsXmlids();

    // add roots at the end of the sequence, so that they will overwrite
    // equivalent menu items from full menu read when put into id:item
    // mapping, resulting in children being correctly set on the roots.
    menuItems = extend(menuItems, menuRootsData);

    // set children ids and xmlids
    const menuItemsMap = Object.fromEntries(menuItems.map(menuItem => [menuItem["id"], menuItem]));

    for (const menuItem of menuItems) {
      setdefault(menuItem, 'children', []);
      const parent = menuItem['parentId'] && menuItem['parentId'][0];
      menuItem['xmlid'] = xmlids[menuItem['id']] || "";
      if (parent in menuItemsMap) {
        setdefault(menuItemsMap[parent], 'children', []).push(menuItem['id']);
      }
      if (menuItem['action']) { // convert actionId to baseActionId
        const [type, id] = menuItem['action'].split(',');
        menuItem['action'] = f('%s,%s', type, (await this.env.items(type).browse(id).actionId).id);
      }
    }
    Object.assign(resMenus, menuItemsMap);

    // sort by sequence
    for (const menuId of Object.keys(resMenus)) {
      resMenus[menuId]['children'] = sorted(resMenus[menuId]['children'], (id) => resMenus[id]['sequence']);
    }

    // recursively set app ids to related children
    function _setAppId(appId, menu) {
      menu['appId'] = appId
      for (const childId of menu['children']) {
        _setAppId(appId, resMenus[childId]);
      }
    }

    for (const app of menuRootsData) {
      const appId = app['id'];
      _setAppId(appId, resMenus[appId]);
    }

    // filter out menus not related to an app (+ keep root menu)
    resMenus = Object.fromEntries(Object.values<any>(resMenus).filter(menu => menu['appId']).map(menu => [menu['id'], menu]))
    resMenus['root'] = menuRoot;

    return resMenus;
  }

  async _getMenuitemsXmlids() {
    const menuitems = await (await this.env.items('ir.model.data').sudo()).search([
      ['resId', 'in', this.ids],
      ['model', '=', 'ir.ui.menu']
    ]);

    const res = {};
    for (const menu of menuitems) {
      res[await menu.resId] = await menu.completeName;
    }
    return res;
  }
}