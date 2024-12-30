import fs from "fs/promises";
import http from 'http';
import { api, conf, service, tools } from "../../..";
import { HttpRequest, WebRequest, setSafeImageHeaders } from "../../../http";
import { AbstractModel, MetaModel, _super } from "../../../models";
import { expVersion } from "../../../service/common";
import { b64decode, b64encode, imageGuessSizeFromFieldName, imageProcess } from '../../../tools/image';
import { len } from '../../../tools/iterable';
import { stringify } from '../../../tools/json';
import { setOptions, sha512 } from "../../../tools/misc";
import { filePath } from '../../../tools/models';
import { HomeStaticTemplateHelpers } from '../controllers/main';

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http';

  async webclientRenderingContext(req) {
    return {
      'menuData': await (await req.getEnv()).items('ir.ui.menu').loadMenus(req.session.debug),
      'sessionInfo': await this.sessionInfo(req),
    }
  }

  async sessionInfo(req: WebRequest) {
    const env = await req.getEnv();
    const user = await env.user();
    const [label, login, partnerId, companyId, actionId] = await user('label', 'login', 'partnerId', 'companyId', 'actionId');
    const versionInfo = service.common.expVersion();

    const sessionUid = req.session.uid;
    const userContext = sessionUid ? await req.session.getContext(req) : {}
    const IrConfigSudo = await this.env.items('ir.config.parameter').sudo();
    const maxFileUploadSize = tools.parseInt(await IrConfigSudo.getParam(
      'web.maxFileUploadSize',
      128 * 1024 * 1024,  // 128MiB
    ));
    let mods = conf.serverWideModules || [];
    if (req.db) {
      mods = Array.from((await req.getRegistry())._initModules).concat(mods);
    }
    const lang = userContext["lang"];
    const translationHash = await (await env.items('ir.translation').sudo()).getWebTranslationsHash(mods, lang);
    const sessionInfo = {
      "uid": sessionUid,
      "isSystem": sessionUid ? await user._isSystem() : false,
      "isAdmin": sessionUid ? await user._isAdmin() : false,
      "userContext": userContext,
      "db": req.session.db,
      "serverVersion": versionInfo['serverVersion'],
      "serverVersionInfo": versionInfo['serverVersionInfo'],
      "supportUrl": "https://www.theverp.com/buy",
      "label": label,
      "username": login,
      "partnerDisplayName": await (await user.partnerId).displayName,
      "companyId": sessionUid ? companyId?.id : null,  // YTI TODO: Remove this from the user context
      "partnerId": sessionUid && partnerId.ok ? partnerId.id : null,
      "web.base.url": await IrConfigSudo.getParam('web.base.url', ''),
      "activeIdsLimit": tools.parseInt(await IrConfigSudo.getParam('web.activeIdsLimit', '20000')),
      'profileSession': req.session.profileSession,
      'profileCollectors': req.session.profileCollectors,
      'profileParams': req.session.profileParams,
      "maxFileUploadSize": maxFileUploadSize,
      "homeActionId": actionId.id,
      "cacheHashes": {
        "translations": translationHash,
      },
      "currencies": await (await this.sudo()).getCurrencies(req),
    }
    if (await (await this.env.user()).hasGroup('base.groupUser')) {
      // the following is only useful in the context of a webclient bootstrapping
      // but is still included in some other calls (e.g. '/web/session/authenticate')
      // to avoid access errors and unnecessary information, it is only included for users
      // with access to the backend ('internal'-type users)
      const qwebChecksum = await HomeStaticTemplateHelpers.getQwebTemplatesChecksum(req, { debug: req.session.debug, bundle: "web.assetsQweb" });
      const menus = await (await req.getEnv()).items('ir.ui.menu').loadMenus(req.session.debug);
      const orderedMenus = Object.fromEntries(Object.entries(menus).map(([k, v]) => [String(k), v]));
      const menuJsonUtf8 = stringify(orderedMenus);
      Object.assign(sessionInfo['cacheHashes'], {
        "loadMenus": sha512(menuJsonUtf8).slice(0, 64),
        "qweb": qwebChecksum,
      })
      const allowedCompanies: any = {};
      for await (const comp of await user.companyIds) {
        allowedCompanies[comp.id] = {
          'id': comp.id,
          'label': await comp.label,
          'sequence': await comp.sequence,
        }
      }
      Object.assign(sessionInfo, {
        // currentCompany should be default_company
        "userCompanies": {
          'currentCompany': (await user.companyId).id,
          'allowedCompanies': allowedCompanies
        },
        "showEffect": true,
        "displaySwitchCompanyMenu": (await user.hasGroup('base.groupMultiCompany')) && len(await user.companyIds) > 1,
      })
    }
    return sessionInfo;
  }

  @api.model()
  async _getContentCommon(req, res, options: { xmlid?: string, model?: string, id?: string, field?: string, unique?: string, filename?: string, filenameField?: string, download?: string, mimetype?: string, accessToken?: string, token?: string } = {}) {
    setOptions(options, { model: 'ir.attachment', field: 'datas', filenameField: 'label' });

    const [status, headers, content] = await (this as any).binaryContent(req, options);
    if (status != 200) {
      return (this as any)._responseByStatus(req, res, status, headers, content)
    }
    else {
      const contentBase64 = b64decode(content);
      // headers.push(['content-length', contentBase64.length]);
      const response = req.makeResponse(res, contentBase64, headers);
      return response;
    }
  }

  async getCurrencies(req) {
    const Currency = (await req.getEnv()).items('res.currency');
    const currencies = await (await Currency.search([])).read(['symbol', 'position', 'decimalPlaces']);
    return Object.fromEntries(currencies.map(c => [c['id'], { 'symbol': c['symbol'], 'position': c['position'], 'digits': [69, c['decimalPlaces']] }]))
  }

  @api.model()
  async getFrontendSessionInfo(req: WebRequest) {
    const sessionUid = req.session.uid;
    const sessionInfo = {
      'isAdmin': sessionUid && await (await this.env.user())._isAdmin() || false,
      'isSystem': sessionUid && await (await this.env.user())._isSystem() || false,
      'isWebsiteUser': sessionUid && await (await this.env.user())._isPublic() || false,
      'userId': sessionUid && (await this.env.user()).id || false,
      'isFrontend': true,
      'profileSession': req.session.profileSession,
      'profileCollectors': req.session.profileCollectors,
      'profileParams': req.session.profileParams,
      'showEffect': await (await (await req.getEnv()).items('ir.config.parameter').sudo()).getParam('baseSetup.showEffect'),
    };
    if (sessionUid) {
      const versionInfo = expVersion();
      Object.assign(sessionInfo, {
        'serverVersion': versionInfo['serverVersion'],
        'serverVersionInfo': versionInfo['serverVersionInfo']
      });
    }
    return sessionInfo;
  }

  @api.model()
  async _contentImage(req, res, kw: { xmlid?: any, model?: string, resId?: any, field?: string, filenameField?: string, unique?: any, filename?: any, mimetype?: any, download?: any, width?: number, height?: number, crop?: boolean, quality?: number, accessToken?: any } = {}) {
    setOptions(kw, { model: 'ir.attachment', field: 'datas', filenameField: 'label', width: 0, height: 0, crop: false, quality: 0, defaultMimetype: 'image/png' });
    const [status, headers, imageBase64] = await (this as any).binaryContent(req, kw);
    return this._contentImageGetResponse(req, res, status, headers, imageBase64, kw);
  }

  @api.model()
  async _contentImageGetResponse(req: HttpRequest, res: http.ServerResponse, status: number, headers, imageBase64, options: { model?: string, field?: string, download?: any, width?: number, height?: number, crop?: boolean, quality?: number } = {}) {
    setOptions(options, { model: 'ir.attachment', field: 'datas', width: 0, height: 0, crop: false, quality: 0 });
    if ([301, 304].includes(status) || (status != 200 && options.download)) {
      return (this as any)._responseByStatus(req, res, status, headers, imageBase64);
    }
    if (!imageBase64) {
      let placeholderFilename;
      if (options.model in this.env.models) {
        placeholderFilename = await this.env.items(options.model)._getPlaceholderFilename(options.field);
      }
      const placeholderContent: any = await this._placeholder(placeholderFilename);
      // Since we set a placeholder for any missing image, the status must be 200. In case one wants to configure a specific 404 page (e.g. though nginx), a 404 status will cause troubles.
      status = 200;
      imageBase64 = b64encode(placeholderContent);
      if (!(options.width || options.height)) {
        [options.width, options.height] = imageGuessSizeFromFieldName(options.field);
      }
    }
    try {
      imageBase64 = await imageProcess(imageBase64, { size: [Math.round(options.width), Math.round(options.height)], crop: options.crop, quality: Math.round(options.quality) });
    } catch (e) {
      console.log(e.message);
      return req.notFound(res);
    }
    const content = b64decode(imageBase64);
    headers = setSafeImageHeaders(headers, content);
    const response = req.makeResponse(res, content, headers);
    response.statusCode = status;
    return response;
  }

  @api.model()
  _placeholderImageGetResponse(req: HttpRequest, res: http.ServerResponse, placeholderBase64) {
    const content = b64decode(placeholderBase64);
    const headers = setSafeImageHeaders([], content);
    const response = req.makeResponse(res, content, headers);
    response.statusCode = 200;
    return response;
  }

  @api.model()
  async _placeholder(image: string) {
    if (!image) {
      image = 'web/static/img/placeholder.png';
    }
    const buffer = await fs.readFile(filePath(image, ['.png', '.jpg']));
    return buffer;
  }

  async _xmlidToObj(req, env, xmlid) {
    const websiteId = await env.items('website').getCurrentWebsite();
    if (websiteId.ok && await websiteId.themeId) {
      const domain = [['key', '=', xmlid], ['websiteId', '=', websiteId.id]];
      let attachment = env.items('ir.attachment');
      if (await (await (await (await req.getEnv()).user())).share) {
        domain.push(['isPublic', '=', true]);
        attachment = await attachment.sudo();
      }
      const obj = await attachment.search(domain);
      if (obj.ok) {
        return obj(0);
      }
    }
    return _super(IrHttp, this)._xmlidToObj(req, env, xmlid);
  }
}