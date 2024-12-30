import { AbstractModel, MetaModel, _super } from "../../../core/models";

@MetaModel.define()
class BaseModel extends AbstractModel {
  static _module = module;
  static _parents = 'base';

  /**
   * Returns the base url for a given record, given the following priority:
      1. If the record has a `websiteId` field, we use the url from this
         website as base url, if set.
      2. If the record has a `companyId` field, we use the website from that
         company (if set). Note that a company doesn't really have a website,
         it is retrieve through some heuristic in its `websiteId`'s compute.
      3. Use the ICP `web.base.url` (super)

      :return: the base url for this record
      :rtype: string
   * @returns 
   */
  async getBaseUrl() {
    // Ensure zero or one record
    if (!this.ok) {
      return _super(BaseModel, this).getBaseUrl();
    }
    this.ensureOne();

    if (this._name === 'website') {
      // Note that website_1.companyId.websiteId might not be website_1
      return await (this as any)._getHttpDomain() || await _super(BaseModel, this).getBaseUrl();
    }
    if ('websiteId' in this._fields && await (await this['websiteId']).domain) {
      return (await this['websiteId'])._getHttpDomain();
    }
    if ('companyId' in this._fields && await (await (await this['companyId']).websiteId).domain) {
      return (await (await this['companyId']).websiteId)._getHttpDomain();
    }
    return _super(BaseModel, this).getBaseUrl();
  }

  async getWebsiteMeta() {
    // dummy version of 'getWebsiteMeta' above; this is a graceful fallback
    // for models that don't inherit from 'website.seo.metadata'
    return {}
  }
}