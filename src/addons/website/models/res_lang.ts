import { api, tools } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";
import { getRequestWebsite } from "./ir_http";

@MetaModel.define()
class Lang extends Model {
  static _module = module;
  static _parents = "res.lang";

  async write(vals) {
    if ('active' in vals && !vals['active']) {
      if ((await this.env.items('website').search([['languageIds', 'in', this._ids]])).ok) {
        throw new UserError(await this._t("Cannot deactivate a language that is currently used on a website."));
      }
    }
    return _super(Lang, this).write(vals);
  }

  @api.model()
  @tools.ormcacheContext(["websiteId"])
  async getAvailable() {
    const req = this.env.req;
    const website = await getRequestWebsite(req);
    if (!bool(website)) {
      return _super(Lang, this).getAvailable();
    }
    // Return the website-available ones in this case
    return (await req.website.languageIds).getSorted();
  }
}