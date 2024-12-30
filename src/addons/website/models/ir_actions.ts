import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { urlJoin } from "../../../core/service/middleware/utils";
import { f } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";

/**
 * Add website option in server actions.
 */
@MetaModel.define()
class ServerAction extends Model {
  static _module = module;
  static _name = 'ir.actions.server';
  static _parents = 'ir.actions.server';

  static xmlid = Fields.Char('External ID', { compute: '_computeXmlid', help: "ID of the action if defined in a XML file" });
  static websitePath = Fields.Char('Website Path');
  static websiteUrl = Fields.Char('Website Url', { compute: '_getWebsiteUrl', help: 'The full URL to access the server action through the website.' });
  static websitePublished = Fields.Boolean('Available on the Website', {
    copy: false,
    help: 'A code server action can be executed from the website, using a dedicated \
                                            controller. The address is <base>/website/action/<websitePath>. \
                                            Set this field as true to allow users to run this action. If it \
                                            is set to false the action cannot be run through the website.'});

  async _computeXmlid() {
    const res = await this.getExternalId();
    for (const action of this) {
      await action.set('xmlid', res[action.id]);
    }
  }

  async _computeWebsiteUrl(websitePath, xmlid) {
    const baseUrl = await this.getBaseUrl();
    const link = websitePath || xmlid || (this.id && f('%d', this.id)) || '';
    if (baseUrl && link) {
      const path = f('%s/%s', '/website/action', link);
      return urlJoin(baseUrl, path);
    }
    return '';
  }

  @api.depends('state', 'websitePublished', 'websitePath', 'xmlid')
  async _getWebsiteUrl() {
    for (const action of this) {
      if (await action.state === 'code' && await action.websitePublished) {
        await action.set('websiteUrl', await action._computeWebsiteUrl(await action.websitePath, await action.xmlid));
      }
      else {
        await action.set('websiteUrl', false);
      }
    }
  }

  /**
   * Override to add the request object in eval_context.
   * @param action 
   * @returns 
   */
  @api.model()
  async _getEvalContext(action) {
    const evalContext = await _super(ServerAction, this)._getEvalContext(action);
    if (await action.state === 'code') {
      evalContext['request'] = this.env.req;
      evalContext['json'] = stringify;
    }
    return evalContext;
  }

  /**
   * Override to allow returning response the same way action is already
          returned by the basic server action behavior. Note that response has
          priority over action, avoid using both.
   * @param evalContext 
   * @returns 
   */
  @api.model()
  async _runActionCodeMulti(evalContext) {
    const res = await _super(ServerAction, this)._runActionCodeMulti(evalContext);
    return evalContext['response'] ?? res;
  }
}