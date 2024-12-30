import { Fields, api } from "../../../core";
import { ValidationError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { Router, Rule } from "../../../core/service/middleware";
import { bool, f, isInstance, len, pop } from "../../../core/tools";

@MetaModel.define()
class WebsiteRoute extends Model {
  static _module = module;
  static _recName = 'path';
  static _name = 'website.route';
  static _description = "All Website Route";
  static _order = 'path';

  static path = Fields.Char('Route');

  @api.model()
  async _nameSearch(name: string = '', args?: any, operator: string = 'ilike', { limit=100, nameGetUid=false } = {}) {
    const res = await _super(WebsiteRoute, this)._nameSearch(name, args, operator, {limit, nameGetUid});
    if (!len(res)) {
      await this._refresh();
      return _super(WebsiteRoute, this)._nameSearch(name, args, operator, {limit, nameGetUid});
    }
    return res;
  }

  async _refresh(req?: any) {
    console.debug("Refreshing website.route");
    const irHttp = this.env.items('ir.http');
    const tocreate = [];
    const paths = {}
    for (const rec of await this.search([])) {
      paths[await rec.path] = rec;
    }
    for await (const [url, x, routing] of irHttp.cls._generateRoutingRules(this.env.req, this.pool._initModules, irHttp._getConverters())) {
      if ((routing.get('methods') || ['GET']).includes('GET')) {
        if (paths[url]) {
          pop(paths, url);
        }
        else {
          tocreate.push({ 'path': url });
        }
      }
    }

    if (tocreate.length) {
      console.info("Add %s website.route", len(tocreate));
      await this.create(tocreate);
    }
    if (bool(paths)) {
      const find = await this.search([['path', 'in', Object.keys(paths)]]);
      console.info("Delete %s website.route", len(find));
      await find.unlink();
    }
  }
}

@MetaModel.define()
class WebsiteRewrite extends Model {
  static _module = module;
  static _name = 'website.rewrite';
  static _description = "Website rewrite";

  static label = Fields.Char('Name', { required: true });
  static websiteId = Fields.Many2one('website', { string: "Website", ondelete: 'CASCADE', index: true });
  static active = Fields.Boolean({ default: true });
  static urlFrom = Fields.Char('URL from', { index: true });
  static routeId = Fields.Many2one('website.route');
  static urlTo = Fields.Char("URL to");
  static redirectType = Fields.Selection([
    ['404', '404 Not Found'],
    ['301', '301 Moved permanently'],
    ['302', '302 Moved temporarily'],
    ['308', '308 Redirect / Rewrite'],
  ], {
    string: 'Action', default: "302",
    help: `Type of redirect/Rewrite:\n
        301 Moved permanently: The browser will keep in cache the new url.
        302 Moved temporarily: The browser will not keep in cache the new url and ask again the next time the new url.
        404 Not Found: If you want remove a specific page/controller (e.g. Ecommerce is installed, but you don't want /shop on a specific website)
        308 Redirect / Rewrite: If you want rename a controller with a new url. (Eg: /shop -> /garden - Both url will be accessible but /shop will automatically be redirected to /garden)
    `});

  static sequence = Fields.Integer();

  @api.onchange('routeId')
  async _onchangeRouteId() {
    const path = await (await this['routeId']).path;
    await this.set('urlFrom', path);
    await this.set('urlTo', path);
  }

  @api.constrains('urlTo', 'urlFrom', 'redirectType')
  async _checkUrlTo() {
    for (const rewrite of this) {
      const [urlFrom, urlTo, redirectType] = await rewrite('urlFrom', 'urlTo', 'redirectType');
      if (['301', '302', '308'].includes(redirectType)) {
        if (!urlTo) {
          throw new ValidationError(await this._t('"URL to" can not be empty.'));
        }
        if (!urlFrom) {
          throw new ValidationError(await this._t('"URL from" can not be empty.'));
        }
      }
      if (redirectType === '308') {
        if (!urlTo.startsWith('/')) {
          throw new ValidationError(await this._t('"URL to" must start with a leading slash.'));
        }
        for (const param of urlFrom.matchAll(/\/<.*?>/g)) {
          if (!urlTo.includes(param)) {
            throw new ValidationError(await this._t('"URL to" must contain parameter %s used in "URL from".', param));
          }
        }
        for (const param of urlTo.matchAll(/\/<.*?>/g)) {
          if (!urlFrom.includes(param)) {
            throw new ValidationError(await this._t('"URL to" cannot contain parameter %s which is not used in "URL from".', param));
          }
        }
        try {
          const converters = this.env.items('ir.http')._getConverters();
          const routingMap = await Router.new({ strictSlashes: false, converters: converters });
          const rule = new Rule(urlTo);
          await routingMap.add(rule);
        } catch (e) {
          if (isInstance(e, ValueError)) {
            throw new ValidationError(await this._t('"URL to" is invalid: %s'), e);
          } else {
            throw e;
          }
        }
      }
    }
  }

  async nameGet() {
    const result = [];
    for (const rewrite of this) {
      const label = f("%s - %s", await rewrite.redirectType, await rewrite.label);
      result.push([rewrite.id, label]);
    }
    return result;
  }

  @api.model()
  async create(vals) {
    const res = await _super(WebsiteRewrite, this).create(vals);
    this._invalidateRouting();
    return res;
  }

  async write(vals) {
    const res = await _super(WebsiteRewrite, this).write(vals);
    this._invalidateRouting();
    return res;
  }

  async unlink() {
    const res = await _super(WebsiteRewrite, this).unlink();
    this._invalidateRouting();
    return res
  }

  _invalidateRouting() {
    // call clear_caches on this worker to reload routing table
    this.env.items('ir.http').clearCaches();
  }

  async refreshRoutes() {
    await this.env.items('website.route')._refresh();
  }
}