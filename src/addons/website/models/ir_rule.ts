import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";
import { getRequestWebsite } from "./ir_http";

@MetaModel.define()
class IrRule extends Model {
  static _module = module;
  static _parents = 'ir.rule';

  @api.model()
  async _evalContext() {
    const res = await _super(IrRule, this)._evalContext();

    // We need isFrontend to avoid showing website's company items in backend
    // (that could be different than current company). We can't use
    // `get_current_website(falback=false)` as it could also return a website
    // in backend (if domain set & match)..
    const req = this.env.req;
    const isFrontend = getRequestWebsite(req);
    const website = this.env.items('website');
    res['website'] = isFrontend && await website.getCurrentWebsite();
    res['website'] = bool(res['website']) ? res['website'] : website;
    return res;
  }

  /**
   * Return the list of context keys to use for caching ``_computeDomain``.
   * @returns 
   */
  async _computeDomainKeys() {
    return (await _super(IrRule, this)._computeDomainKeys()).concat(['websiteId']);
  }
}