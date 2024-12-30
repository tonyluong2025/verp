import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { f } from "../../../core/tools";

@MetaModel.define()
class Attachment extends Model {
  static _module = module;
  static _parents = "ir.attachment";

  // related for backward compatibility with saas-6
  static websiteUrl = Fields.Char({ string: "Website URL", related: 'localUrl', deprecated: true, readonly: false });
  static key = Fields.Char({ help: 'Technical field used to resolve multiple attachments in a multi-website environment.' });
  static websiteId = Fields.Many2one('website');

  @api.model()
  async create(vals) {
    const website = await this.env.items('website').getCurrentWebsite(false);
    if (website.ok && !('websiteId' in vals) && !('notForceWebsiteId' in this.env.context)) {
      vals['websiteId'] = website.id;
    }
    return _super(Attachment, this).create(vals);
  }

  @api.model()
  async getServingGroups() {
    return (await _super(Attachment, this).getServingGroups()).concat(['website.groupWebsiteDesigner']);
  }

  @api.model()
  async getServeAttachment(url, extraDomain?: any, extraFields?: any, order?: any) {
    const website = await this.env.items('website').getCurrentWebsite();
    extraDomain = (extraDomain ?? []).concat(website.websiteDomain());
    order = order ? f('websiteId, %s', order) : 'websiteId';
    return _super(Attachment, this).getServeAttachment(url, extraDomain, extraFields, order);
  }
}