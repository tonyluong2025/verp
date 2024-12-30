// from theveb.urls import url_join

import _ from "lodash";
import { Fields, api } from "../../../core";
import { AccessError, NotImplementedError } from "../../../core/helper";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { urlJoin } from "../../../core/service/middleware/utils";
import { bool, escapePsql, f, isdisjoint, strip, urlFor } from "../../../core/tools";
import { jsonParse, stringify } from "../../../core/tools/json";
import { textFromHtml } from "../tools";

@MetaModel.define()
class SeoMetadata extends AbstractModel {
  static _module = module;
  static _name = 'website.seo.metadata';
  static _description = 'SEO metadata';

  static isSeoOptimized = Fields.Boolean("SEO optimized", { compute: '_computeIsSeoOptimized' });
  static websiteMetaTitle = Fields.Char("Website meta title", { translate: true });
  static websiteMetaDescription = Fields.Text("Website meta description", { translate: true });
  static websiteMetaKeywords = Fields.Char("Website meta keywords", { translate: true });
  static websiteMetaOgImg = Fields.Char("Website opengraph image");
  static seoName = Fields.Char("Seo name", { translate: true });

  async _computeIsSeoOptimized() {
    for (const record of this) {
      await record.set('isSeoOptimized', await record.websiteMetaTitle && await record.websiteMetaDescription && await record.websiteMetaKeywords);
    }
  }

  /**
   * This method will return default meta information. It return the dict
          contains meta property as a key and meta content as a value.
          e.g. 'og:type': 'website'.

          Override this method in case you want to change default value
          from any model. e.g. change value of og:image to product specific
          images instead of default images
   * @returns 
   */
  async _defaultWebsiteMeta() {
    this.ensureOne();
    const req = this.env.req;
    const company = await (await req.website.companyId).sudo();
    let title = await (req.website.ok ? req.website : company).label;
    if ('label' in this._fields) {
      title = f('%s | %s', await this['label'], title);
    }
    const imgField = (await req.website.hasSocialDefaultImage) ? 'socialDefaultImage' : 'logo';

    // Default meta for OpenGraph
    const defaultOpengraph = {
      'og:type': 'website',
      'og:title': title,
      'og:siteName': await company.label,
      'og:url': urlJoin(req.httpRequest.urlRoot, await urlFor(req, req.httpRequest.uri.pathname)),
      'og:image': await req.website.imageUrl(req.website, imgField),
    }
    // Default meta for Twitter
    const defaultTwitter = {
      'twitter:card': 'summaryLargeImage',
      'twitter:title': title,
      'twitter:image': await req.website.imageUrl(req.website, imgField, '300x300'),
    }
    const socialTwitter = await company.socialTwitter;
    if (socialTwitter) {
      defaultTwitter['twitter:site'] = f("@%s", socialTwitter.split('/').slice(-1)[0]);
    }
    return {
      'defaultOpengraph': defaultOpengraph,
      'defaultTwitter': defaultTwitter
    }
  }

  /**
   * This method will return final meta information. It will replace
          default values with user's custom value (if user modified it from
          the seo popup of frontend)

          This method is not meant for overridden. To customize meta values
          override `_defaultWebsiteMeta` method instead of this method. This
          method only replaces user custom values in defaults.
   * @returns 
   */
  async getWebsiteMeta() {
    const req = this.env.req;
    const rootUrl = strip(req.httpRequest.urlRoot, '/');
    const defaultMeta = await this._defaultWebsiteMeta();
    const [opengraphMeta, twitterMeta] = [defaultMeta['defaultOpengraph'], defaultMeta['defaultTwitter']];
    const [websiteMetaTitle, websiteMetaDescription, websiteMetaOgImg] = await this('websiteMetaTitle', 'websiteMetaDescription', 'websiteMetaOgImg');
    if (websiteMetaTitle) {
      opengraphMeta['og:title'] = websiteMetaTitle;
      twitterMeta['twitter:title'] = websiteMetaTitle;
    }
    if (websiteMetaDescription) {
      opengraphMeta['og:description'] = websiteMetaDescription;
      twitterMeta['twitter:description'] = websiteMetaDescription;
    }
    opengraphMeta['og:image'] = urlJoin(rootUrl, await urlFor(req, websiteMetaOgImg || opengraphMeta['og:image']));
    twitterMeta['twitter:image'] = urlJoin(rootUrl, await urlFor(req, websiteMetaOgImg || twitterMeta['twitter:image']));
    return {
      'opengraphMeta': opengraphMeta,
      'twitterMeta': twitterMeta,
      'metaDescription': defaultMeta['default_metaDescription']
    }
  }
}

@MetaModel.define()
class WebsiteCoverPropertiesMixin extends AbstractModel {
  static _module = module;
  static _name = 'website.cover.properties.mixin';
  static _description = 'Cover Properties Website Mixin';

  static coverProperties = Fields.Text('Cover Properties', { default: async (self) => stringify(await self._defaultCoverProperties()) });

  async _defaultCoverProperties() {
    return {
      "backgroundColorClass": "o-cc3",
      "background-image": "none",
      "opacity": "0.2",
      "resizeClass": "o-half-screen-height",
    }
  }

  async _getBackground(height?: any, width?: any) {
    this.ensureOne();
    const properties = JSON.parse(await this['coverProperties']);
    let img = properties['background-image'] ?? "none";

    if (img.startsWith('url(/web/image/')) {
      let suffix = "";
      if (height != null) {
        suffix += f("&height=%s", height);
      }
      if (width != null) {
        suffix += f("&width=%s", width);
      }
      if (suffix) {
        suffix = !img.includes('?') && f("?%s", suffix) || suffix;
        img = img.slice(0, -1) + suffix + ')'
      }
    }
    return img;
  }

  async write(vals) {
    if (!('coverProperties' in vals)) {
      return _super(WebsiteCoverPropertiesMixin, this).write(vals);
    }
    const coverProperties = jsonParse(vals['coverProperties']);
    const resizeClasses = (coverProperties['resizeClass'] || '').replace('  ', ' ').split(' ');
    const classes = ['o-half-screen-height', 'o-full-screen-height', 'cover_auto'];
    if (!isdisjoint(classes)) {
      // Updating cover properties and the given 'resize_class' set is
      // valid, normal write.
      return _super(WebsiteCoverPropertiesMixin, this).write(vals);
    }

    // If we do not receive a valid resize_class via the coverProperties, we
    // keep the original one (prevents updates on list displays from
    // destroying resize_class).
    const copyVals = Object.assign({}, vals);
    for (const item of this) {
      const oldCoverProperties = jsonParse(await item.coverProperties);
      coverProperties['resizeClass'] = oldCoverProperties['resizeClass'] ?? classes[0];
      copyVals['coverProperties'] = stringify(coverProperties);
      await _super(WebsiteCoverPropertiesMixin, item).write(copyVals);
    }
    return true;
  }
}

@MetaModel.define()
class WebsiteMultiMixin extends AbstractModel {
  static _module = module;
  static _name = 'website.multi.mixin';
  static _description = 'Multi Website Mixin';

  static websiteId = Fields.Many2one(
    "website",
    {
      string: "Website",
      ondelete: "RESTRICT",
      help: "Restrict publishing to this website.",
      index: true,
    }
  );

  async canAccessFromCurrentWebsite(websiteId: any = false) {
    let canAccess = true;
    const req = this.env.req;
    for (const record of this) {
      if (websiteId || ![false, (await (await req.getEnv()).items('website').getCurrentWebsite()).id].includes((await record.websiteId).id)) {
        canAccess = false;
        continue;
      }
    }
    return canAccess;
  }
}

@MetaModel.define()
class WebsitePublishedMixin extends AbstractModel {
  static _module = module;
  static _name = "website.published.mixin";
  static _description = 'Website Published Mixin';

  static websitePublished = Fields.Boolean('Visible on current website', { related: 'isPublished', readonly: false });
  static isPublished = Fields.Boolean('Is Published', { copy: false, default: self => self._defaultIsPublished(), index: true });
  static canPublish = Fields.Boolean('Can Publish', { compute: '_computeCanPublish' });
  static websiteUrl = Fields.Char('Website URL', { compute: '_computeWebsiteUrl', help: 'The full URL to access the document through the website.' });

  @api.dependsContext('lang')
  async _computeWebsiteUrl() {
    for (const record of this) {
      await record.set('websiteUrl', '#');
    }
  }

  async _defaultIsPublished() {
    return false;
  }

  async websitePublishButton() {
    this.ensureOne();
    return this.write({ 'websitePublished': ! await this['websitePublished'] });
  }

  async openWebsiteUrl() {
    return {
      'type': 'ir.actions.acturl',
      'url': await this['websiteUrl'],
      'target': 'self',
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const records = await _super(WebsitePublishedMixin, this).create(valsList);
    const isPublishModified = valsList.some(val => _.intersection(Object.keys(val), ['isPublished', 'websitePublished']).length > 0);
    if (isPublishModified && await records.some(async (rec) => !await rec.canPublish)) {
      throw new AccessError(await this._getCanPublishErrorMessage());
    }

    return records;
  }

  async write(values) {
    if ('isPublished' in values && await this.some(async (rec) => !await rec.canPublish)) {
      throw new AccessError(await this._getCanPublishErrorMessage());
    }

    return _super(WebsitePublishedMixin, this).write(values);
  }

  async createAndGetWebsiteUrl(opts: any = {}) {
    return (await this.create(opts)).websiteUrl;
  }

  /**
   * This method can be overridden if you need more complex rights management than just 'website_publisher'
      The publish widget will be hidden and the user won't be able to change the 'websitePublished' value
      if this method sets can_publish false
   */
  async _computeCanPublish() {
    for (const record of this) {
      await record.set('canPublish', true);
    }
  }

  /**
   * Override this method to customize the error message shown when the user doesn't
      have the rights to publish/unpublish.
   * @returns 
   */
  @api.model()
  async _getCanPublishErrorMessage() {
    return this._t("You do not have the rights to publish/unpublish");
  }
}

@MetaModel.define()
class WebsitePublishedMultiMixin extends WebsitePublishedMixin {
  static _module = module;
  static _name = 'website.published.multi.mixin';
  static _parents = ['website.published.mixin', 'website.multi.mixin'];
  static _description = 'Multi Website Published Mixin';

  static websitePublished = Fields.Boolean({
    compute: '_computeWebsitePublished',
    inverse: '_inverseWebsitePublished',
    search: '_searchWebsitePublished',
    related: false, readonly: false
  });

  @api.depends('isPublished', 'websiteId')
  @api.dependsContext('websiteId')
  async _computeWebsitePublished() {
    const currentWebsiteId = this._context['websiteId'];
    for (const record of this) {
      if (currentWebsiteId) {
        await record.set('websitePublished', await record.isPublished && (!bool(await record.websiteId) || (await record.websiteId).id == currentWebsiteId));
      }
      else {
        await record.set('websitePublished', await record.isPublished);
      }
    }
  }

  async _inverseWebsitePublished() {
    for (const record of this) {
      await record.set('isPublished', await record.websitePublished);
    }
  }

  _searchWebsitePublished(operator, value) {
    if (typeof (value) !== 'boolean' || !['=', '!='].includes(operator)) {
      console.warn('unsupported search on websitePublished: %s, %s', operator, value);
      return [[]];
    }

    if (expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
      value = !bool(value);
    }

    const currentWebsiteId = this._context['websiteId'];
    const isPublished = [['isPublished', '=', value]];
    if (currentWebsiteId) {
      const onCurrentWebsite = this.env.items('website').websiteDomain(currentWebsiteId);
      return (value == false ? ['!'] : []).concat(expression.AND([isPublished, onCurrentWebsite]));
    }
    else {  // should be in the backend, return things that are published anywhere
      return isPublished;
    }
  }

  async openWebsiteUrl() {
    const [websiteId, websiteUrl] = await this('websiteId', 'websiteUrl');
    return {
      'type': 'ir.actions.acturl',
      'url': bool(websiteId) ? urlJoin(await websiteId._getHttpDomain(), websiteUrl) : websiteUrl,
      'target': 'self',
    }
  }
}

/**
 * Mixin to be inherited by all models that need to searchable through website
 */
@MetaModel.define()
class WebsiteSearchableMixin extends AbstractModel {
  static _module = module;
  static _name = 'website.searchable.mixin';
  static _description = 'Website Searchable Mixin';

  /**
   * Builds a search domain AND-combining a base domain with partial matches of each term in
      the search expression in any of the fields.

      :param domain_list: base domain list combined in the search expression
      :param search: search expression string
      :param fields: list of field names to match the terms of the search expression with
      :param extra: function that returns an additional subdomain for a search term

      :return: domain limited to the matches of the search expression
   * @param domainList 
   * @param search 
   * @param fields 
   * @param extra 
   * @returns 
   */
  @api.model()
  async _searchBuildDomain(domainList, search, fields, extra?: any) {
    const domains = Array.from(domainList);
    if (search) {
      for (const searchTerm of search.split(' ')) {
        const subdomains = fields.map(field => [[field, 'ilike', escapePsql(searchTerm)]]);
        if (extra) {
          subdomains.push(await extra(this.env, searchTerm));
        }
        domains.push(expression.OR(subdomains));
      }
    }
    return expression.AND(domains);
  }

  /**
   * Returns indications on how to perform the searches

      :param website: website within which the search is done
      :param order: order in which the results are to be returned
      :param options: search options

      :return: search detail as expected in elements of the result of website._search_get_details()
          These elements contain the following fields:
          - model: name of the searched model
          - base_domain: list of domains within which to perform the search
          - search_fields: fields within which the search term must be found
          - fetch_fields: fields from which data must be fetched
          - mapping: mapping from the results towards the structure used in rendering templates.
              The mapping is a dict that associates the rendering name of each field
              to a dict containing the 'name' of the field in the results list and the 'type'
              that must be used for rendering the value
          - icon: name of the icon to use if there is no image

      This method must be implemented by all models that inherit this mixin.
   * @param website 
   * @param order 
   * @param options 
   */
  @api.model()
  async _searchGetDetail(website, order, options) {
    throw new NotImplementedError();
  }

  @api.model()
  async _searchFetch(searchDetail, search, limit, order) {
    const fields = searchDetail['searchFields'];
    const baseDomain = searchDetail['baseDomain'];
    const domain = await this._searchBuildDomain(baseDomain, search, fields, searchDetail['searchExtra']);
    const model = searchDetail['requiresSudo'] ? await this.sudo() : this;
    const results = await model.search(
      domain,
      {
        limit: limit,
        order: searchDetail['order'] ?? order
      }
    );
    const count = await model.searchCount(domain);
    return [results, count];
  }

  async _searchRenderResults(fetchFields, mapping, icon, limit) {
    const resultsData = (await this.read(fetchFields)).slice(0, limit);
    for (const result of resultsData) {
      result['_fa'] = icon;
      result['_mapping'] = mapping;
    }
    const htmlFields = Object.values(mapping).filter(config => bool(config['html'])).map(config => config['name']);
    if (bool(htmlFields)) {
      for (const [result, data] of _.zip([...this], [...resultsData])) {
        for (const htmlField of htmlFields) {
          if (data[htmlField]) {
            if (htmlField == 'arch') {
              // Undo second escape of text nodes from wywsiwyg.js _getEscapedElement.
              data[htmlField] = data[htmlField].replace(/&amp;(?=\w+;)/g, '&');
            }
            let text = textFromHtml(data[htmlField]);
            text = text.replace(/\s+/g, ' ').trim();
            data[htmlField] = text;
          }
        }
      }
    }
    return resultsData;
  }
}