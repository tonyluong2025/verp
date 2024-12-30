import { AssetsBundle } from "../../../core/addons/base";
import { OrderedDict } from "../../../core/helper";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, f, replaceAsync, urlFor } from "../../../core/tools";
import { getRequestWebsite } from "./ir_http";

const reBackgroundImage = new RegExp("(background-image\\s*:\\s*url\\(\\s*['\"]?\\s*)([^)'\"]+)", 'g');

class AssetsBundleMultiWebsite extends AssetsBundle {
  _getAssetUrlValues(options: { extra?: string } = {}) {
    const websiteId = this.env.context['websiteId'];
    const websiteIdPath = websiteId && f('%s/', websiteId) || '';
    options.extra = websiteIdPath + options.extra;
    const res = super._getAssetUrlValues(options);
    return res;
  }

  async _getAssetsDomainForAlreadyProcessedCss(assets) {
    let res = await super._getAssetsDomainForAlreadyProcessedCss(assets);
    const currentWebsite = this.env.items('website').getCurrentWebsite(false);
    res = expression.AND([res, currentWebsite.websiteDomain()]);
    return res;
  }

  getDebugAssetUrl(extra = '', name = '%', extension = '%') {
    const websiteId = this.env.context['websiteId'];
    const websiteIdPath = websiteId && f('%s/', websiteId) || '';
    extra = websiteIdPath + extra;
    return super.getDebugAssetUrl(extra, name, extension);
  }
}

/**
 * QWeb object for rendering stuff in the website context
 */
@MetaModel.define()
class QWeb extends AbstractModel {
  static _module = module;
  static _parents = 'ir.qweb';

  static URL_ATTRS = {
    'form': 'action',
    'a': 'href',
    'link': 'href',
    'script': 'src',
    'img': 'src',
  }

  async getAssetBundle(xmlid, files, options?: { env?: any, request?: any, css?: boolean, js?: boolean }) {
    return AssetsBundleMultiWebsite.new(xmlid, files, options);
  }

  async _postProcessingAttr(tagName, atts, options) {
    if (atts['data-no-post-process']) {
      return atts;
    }

    atts = await _super(QWeb, this)._postProcessingAttr(tagName, atts, options);

    if (tagName === 'img' && !('loading' in atts)) {
      atts['loading'] = 'lazy'  // default is auto;
    }

    const req = this.env.req;
    if (options['inheritBranding'] || options['renderingBundle'] ||
      options['editTranslations'] || options['debug'] || (req && req.session.debug)) {
      return atts;
    }

    let website = getRequestWebsite(req);
    if (!bool(website) && options['websiteId']) {
      website = this.env.items('website').browse(options['websiteId']);
    }
    if (!bool(website)) {
      return atts;
    }

    const name = this.cls.URL_ATTRS[tagName];
    if (req && name && name in atts) {
      atts[name] = await urlFor(req, atts[name]);
    }

    if (! await website.cdnActivated) {
      return atts;
    }

    const dataName = `data-${name}`;
    if (name && (name in atts || dataName in atts)) {
      atts = new OrderedDict(atts);
      if (name in atts) {
        atts[name] = await website.getCdnUrl(atts[name]);
      }
      if (dataName in atts) {
        atts[dataName] = await website.getCdnUrl(atts[dataName]);
      }
    }
    if (typeof (atts.get('style')) === 'string' && atts['style'].includes('background-image')) {
      atts = new OrderedDict(atts);
      atts['style'] = await replaceAsync(atts['style'], reBackgroundImage, async (...m) => f('%s%s', m[1], await website.getCdnUrl(m[2])));
    }

    return atts;
  }
}