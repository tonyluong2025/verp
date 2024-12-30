import fs from 'fs/promises';
import { ServerResponse } from "http";
import _ from "lodash";
import { http } from "../../../core";
import { Dict } from "../../../core/helper/collections";
import { AccessDenied, AccessError, MissingError, UserError, ValidationError } from "../../../core/helper/errors";
import { WebRequest, contentDisposition } from "../../../core/http";
import { isSubclass } from "../../../core/models";
import { urlEncode, urlParse } from "../../../core/service/middleware/utils";
import { b64encode, bool, consteq, f, isDigit, isInstance, len, parseFloat, parseInt, pop, range, singleEmailRe, update } from "../../../core/tools";
import { stringify } from '../../../core/tools/json';

/**
 * Generate a dict with required value to render `website.pager` template. This method compute url, page range to display, ... in the pager.
    :param url : base url of the page link
    :param total : number total of item to be splitted into pages
    :param page : current page
    :param step : item per page
    :param scope : number of page to display on pager
    :param urlArgs : additionnal parameters to add as query params to page url
    :type urlArgs : dict
    :returns dict
 * @param url 
 * @param total 
 * @param page 
 * @param step 
 * @param scope 
 * @param urlArgs 
 * @returns 
 */
export function pager(opts: { url?: string, total?: number, page?: number, step?: number, scope?: number, urlArgs?: any } = {}) {
  let page = opts.page || 1;
  let step = opts.step || 30;
  let scope = opts.scope || 5;
  // Compute Pager
  const pageCount = parseInt(Math.ceil(parseFloat(opts.total) / step));

  page = Math.max(1, Math.min(parseInt(isDigit(page) ? page : 1), pageCount));
  scope -= 1;

  let pmin = Math.max(page - parseInt(Math.floor(scope / 2)), 1);
  let pmax = Math.min(pmin + scope, pageCount);

  if (pmax - pmin < scope) {
    pmin = pmax - scope > 0 ? pmax - scope : 1;
  }

  function getUrl(page) {
    let _url = page > 1 ? f("%s/page/%s", opts.url, page) : opts.url
    if (opts.urlArgs) {
      _url = f("%s?%s", _url, urlEncode(opts.urlArgs));
    }
    return _url;
  }

  return {
    "pageCount": pageCount,
    "offset": (page - 1) * step,
    "page": {
      'url': getUrl(page),
      'num': page
    },
    "pageFirst": {
      'url': getUrl(1),
      'num': 1
    },
    "pageStart": {
      'url': getUrl(pmin),
      'num': pmin
    },
    "pagePrevious": {
      'url': getUrl(Math.max(pmin, page - 1)),
      'num': Math.max(pmin, page - 1)
    },
    "pageNext": {
      'url': getUrl(Math.min(pmax, page + 1)),
      'num': Math.min(pmax, page + 1)
    },
    "pageEnd": {
      'url': getUrl(pmax),
      'num': pmax
    },
    "pageLast": {
      'url': getUrl(pageCount),
      'num': pageCount
    },
    "pages": Array.from(range(pmin, pmax + 1)).map(pageNum => { return { 'url': getUrl(pageNum), 'num': pageNum } })
  }
}

export async function getRecordsPager(ids, current) {
  if (ids.includes(current.id) && (bool(await current['websiteUrl']) || bool(await current['accessUrl']))) {
    const attrName = bool(await current['accessUrl']) ? 'accessUrl' : 'websiteUrl';
    const idx = ids.indexOf(current.id);
    const prevRecord = idx != 0 && current.browse(ids[idx - 1]);
    const nextRecord = idx < len(ids) - 1 && current.browse(ids[idx + 1]);

    let prevUrl, nextUrl;
    const prevRecordAttr = await prevRecord[attrName];
    if (bool(prevRecord) && prevRecordAttr && attrName === "accessUrl") {
      prevUrl = f('%s?accessToken=%s', prevRecordAttr, await prevRecord._portalEnsureToken());
    }
    else if (bool(prevRecord) && prevRecordAttr) {
      prevUrl = prevRecordAttr;
    }
    else {
      prevUrl = prevRecord;
    }

    const nextRecordAttr = await nextRecord[attrName];
    if (bool(nextRecord) && nextRecordAttr && attrName === "accessUrl") {
      nextUrl = f('%s?accessToken=%s', nextRecordAttr, await nextRecord._portalEnsureToken());
    }
    else if (bool(nextRecord) && nextRecordAttr) {
      nextUrl = nextRecordAttr;
    }
    else {
      nextUrl = nextRecord;
    }
    return {
      'prevRecord': prevUrl,
      'nextRecord': nextUrl,
    }
  }
  return {};
}

/**
 * Rebuild a string url based on url_string and correctly compute query parameters
    using those present in the url and those given by query_params. Having duplicates in
    the final url is optional. For example:

     * urlString = '/my?foo=bar&error=pay'
     * queryParams = {'foo': 'bar2', 'alice': 'bob'}
     * if remove duplicates: result = '/my?foo=bar2&error=pay&alice=bob'
     * else: result = '/my?foo=bar&foo=bar2&error=pay&alice=bob'
 * @param urlString 
 * @param queryParams 
 * @param removeDuplicates 
 * @returns 
 */
export function buildUrlWParams(urlString, queryParams, removeDuplicates = true) {
  const url = urlParse(urlString || '');
  const urlParams = url.searchQuery;
  update(urlParams, queryParams || {});
  url.search = urlEncode(urlParams);
  return url.toString();
}

@http.define()
export class CustomerPortal extends http.Controller {
  static _module = module;

  MANDATORY_BILLING_FIELDS = ["label", "phone", "email", "street", "city", "countryId"];
  OPTIONAL_BILLING_FIELDS = ["zipcode", "stateId", "vat", "companyName"];

  _itemsPerPage = 80;

  /**
   * Values for /my/* templates rendering.

      Does not include the record counts.
   * @returns 
   */
  async _preparePortalLayoutValues(req: WebRequest): Promise<{}> {
    // get customer sales rep
    let salesUser;// = false
    const partner = await (await (await (await req.getEnv()).user())).partnerId;
    const userId = await partner.userId;
    if (userId.ok && ! await userId._isPublic()) {
      salesUser = userId;
    }
    return {
      'salesUser': salesUser,
      'pageName': 'home',
    }
  }
  /**
   * Values for /my & /my/home routes template rendering.

      Includes the record count for the displayed badges.
      where 'coutners' is the list of the displayed badges
      and so the list to compute.
   * @param counters 
   */
  _prepareHomePortalValues(req: WebRequest, counters: string[]) {
    return {};
  }

  @http.route(['/my/counters'], { type: 'json', auth: "user", website: true })
  async counters(req, res, opts: { counters?: any } = {}) {
    return this._prepareHomePortalValues(req, opts.counters);
  }

  @http.route(['/my', '/my/home'], { type: 'http', auth: "user", website: true })
  async home(req, res, opts = {}) {
    const values = await this._preparePortalLayoutValues(req);
    return req.render(res, "portal.portalMyHome", values);
  }

  @http.route(['/my/account'], { type: 'http', auth: 'user', website: true })
  async account(req: WebRequest, res, post: { redirect?: any }) {
    const env = await req.getEnv();
    let values = await this._preparePortalLayoutValues(req);
    const partner = await (await env.user()).partnerId;
    update(values, {
      'error': {},
      'errorMessage': [],
    })

    const redirect = pop(post, 'redirect');
    if (post && req.httpRequest.method === 'POST') {
      const [error, errorMessage] = await this.detailsFormValidate(req, post);
      update(values, { 'error': error, 'errorMessage': errorMessage });
      update(values, post);
      if (error) {
        values = Object.fromEntries(this.MANDATORY_BILLING_FIELDS.map(key => [key, post[key]]));
        update(values, Object.fromEntries(this.OPTIONAL_BILLING_FIELDS.map(key => [key, post[key]])));
        for (const field of _.intersection(['countryId', 'stateId'], Object.keys(values))) {
          try {
            values[field] = parseInt(values[field]);
          } catch (e) {
            values[field] = false;
          }
        }
        update(values, { 'zip': pop(values, 'zipcode', '') });
        await (await partner.sudo()).write(values);
        if (redirect) {
          return req.redirect(res, redirect);
        }
        return req.redirect(res, '/my/home');
      }
    }

    const countries = await (await env.items('res.country').sudo()).search([]);
    const states = await (await env.items('res.country.state').sudo()).search([]);

    update(values, {
      'partner': partner,
      'countries': countries,
      'states': states,
      'hasCheckVat': bool(env.items('res.partner').checkVat),
      'redirect': redirect,
      'pageName': 'myDetails',
    })

    const response = await req.render(res, "portal.portalMyDetails", values);
    response.setHeader('X-Frame-Options', 'DENY');
    return response;
  }

  @http.route('/my/security', { type: 'http', auth: 'user', website: true, methods: ['GET', 'POST'] })
  async security(req: WebRequest, res, post: {} = {}) {
    const env = await req.getEnv();
    const values = await this._preparePortalLayoutValues(req);
    values['getError'] = getError;
    values['allowApiKeys'] = bool(await (await env.items('ir.config.parameter').sudo()).getParam('portal.allowApiKeys'));

    if (req.httpRequest.method === 'POST') {
      update(values, await this._updatePassword(req,
        post['old'].trim(),
        post['new1'].trim(),
        post['new2'].trim()
      ))
    }

    const response = await req.render(res, 'portal.portalMySecurity', values);
    response.setHeader('X-Frame-Options', 'DENY');
    return response;
  }

  async _updatePassword(req: WebRequest, old: string, new1: string, new2: string) {
    for (const [k, v] of [['old', old], ['new1', new1], ['new2', new2]]) {
      if (v) {
        return { 'errors': { 'password': { k: await this._t(await req.getEnv(), "You cannot leave any password empty.") } } };
      }
    }
    if (new1 !== new2) {
      return { 'errors': { 'password': { 'new2': await this._t(await req.getEnv(), "The new password and its confirmation must be identical.") } } };
    }

    const env = await req.getEnv();
    try {
      await env.items('res.users').changePassword(old, new1);
    } catch (e) {
      if (isInstance(e, UserError)) {
        return { 'errors': { 'password': e.label } };
      }
      if (isInstance(e, AccessDenied)) {
        let msg = e.stack[0];
        if (msg === (new AccessDenied()).stack[0])
          msg = await this._t(await req.getEnv(), 'The old password you provided is incorrect, your password was not changed.')
        return { 'errors': { 'password': { 'old': msg } } }
      }
      throw e;
    }
    // update session token so the user does not get logged out (cache cleared by passwd change)
    const newToken = (await env.user())._computeSessionToken(req.session.sid);
    req.session.sessionToken = newToken;

    return { 'success': { 'password': true } }
  }

  /**
   * Process a file uploaded from the portal chatter and create the
      corresponding `ir.attachment`.

      The attachment will be created "pending" until the associated message
      is actually created, and it will be garbage collected otherwise.

      :param name: name of the file to save.
      :type name: string

      :param file: the file to save
      :type file: theveb.FileStorage

      :param resModel: name of the model of the original document.
          To check access rights only, it will not be saved here.
      :type resModel: string

      :param resId: id of the original document.
          To check access rights only, it will not be saved here.
      :type resId: int

      :param accessToken: accessToken of the original document.
          To check access rights only, it will not be saved here.
      :type accessToken: string

      :return: attachment data {id, name, mimetype, fileSize, accessToken}
      :rtype: dict
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/portal/attachment/add', { type: 'http', auth: 'public', methods: ['POST'], website: true })
  async attachmentAdd(req: WebRequest, res, opts: { label?: string, file?: string, resModel?: string, resId?: string, accessToken?: string } = {}) {
    try {
      await this._documentCheckAccess(req, opts.resModel, parseInt(opts.resId), opts.accessToken);
    } catch (e) {
      if (isInstance(e, AccessError, MissingError)) {
        throw new UserError(await this._t(await req.getEnv(), "The document does not exist or you do not have the rights to access it."));
      } else {
        throw e;
      }
    }

    const env = await req.getEnv();
    let irAttachment = env.items('ir.attachment');
    let accessToken = false;

    // Avoid using sudo or creating accessToken when not necessary: internal
    // users can create attachments, as opposed to public and portal users.
    if (! await (await env.user()).hasGroup('base.groupUser')) {
      irAttachment = await (await irAttachment.sudo()).withContext({ binaryFieldRealUser: await irAttachment.env.user() });
      accessToken = await irAttachment._generateAccessToken();
    }

    // At this point the related message does not exist yet, so we assign
    // those specific resModel and res_is. They will be correctly set
    // when the message is created: see `portal_chatter_post`,
    // or garbage collected otherwise: see  `_garbage_collect_attachments`.
    const attachment = await irAttachment.create({
      'label': opts.label,
      'datas': b64encode(await fs.readFile(opts.file)),
      'resModel': 'mail.compose.message',
      'resId': 0,
      'accessToken': accessToken,
    })
    return req.makeResponse(res,
      stringify((await attachment.read(['id', 'label', 'mimetype', 'fileSize', 'accessToken']))[0]),
      [['Content-Type', 'application/json']]
    );
  }

  /**
   * Remove the given `attachment_id`, only if it is in a "pending" state.
 
      The user must have access right on the attachment or provide a valid
      `accessToken`.
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/portal/attachment/remove', { type: 'json', auth: 'public' })
  async attachmentRemove(req: WebRequest, res, opts: { attachmentId?: any, accessToken?: any } = {}) {
    let attachmentSudo;
    try {
      attachmentSudo = await this._documentCheckAccess(req, 'ir.attachment', parseInt(opts.attachmentId), opts.accessToken);
    } catch (e) {
      if (isInstance(e, AccessError, MissingError)) {
        throw new UserError(await this._t(await req.getEnv(), "The attachment does not exist or you do not have the rights to access it."));
      }
      else {
        throw e;
      }
    }
    if (await attachmentSudo.resModel !== 'mail.compose.message' || await attachmentSudo.resId != 0) {
      throw new UserError(await this._t(await req.getEnv(), "The attachment %s cannot be removed because it is not in a pending state.", await attachmentSudo.label));
    }

    if (bool(await attachmentSudo.env.items('mail.message').search([['attachmentIds', 'in', attachmentSudo.ids]]))) {
      throw new UserError(await this._t(await req.getEnv(), "The attachment %s cannot be removed because it is linked to a message.", await attachmentSudo.label));
    }

    return attachmentSudo.unlink();
  }
  
  async detailsFormValidate(req: WebRequest, data: {}): Promise<any[]> {
    const error = {};
    const errorMessage = [];

    // Validation
    for (const fieldName of this.MANDATORY_BILLING_FIELDS) {
      if (!data[fieldName]) {
        error[fieldName] = 'missing';
      }
    }

    // email validation
    if (data['email'] && !singleEmailRe.test(data['email'])) {
      error["email"] = 'error';
      errorMessage.push(await this._t(await req.getEnv(), 'Invalid Email! Please enter a valid email address.'));
    }
    // vat validation
    const env = await req.getEnv();
    const partner = await (await env.user()).partnerId;
    if (data["vat"] && partner.ok && await partner.vat !== data["vat"]) {
      if (await partner.canEditVat()) {
        if (partner._fields["checkVat"]) {
          if (data["countryId"]) {
            data["vat"] = await env.items("res.partner").fixEuVatNumber(parseInt(data["countryId"]), data["vat"]);
          }
          const partnerDummy = await partner.new({
            'vat': data['vat'],
            'countryId': data['countryId'] ? parseInt(data['countryId']) : false,
          });
          try {
            await partnerDummy.checkVat();
          } catch (e) {
            if (isInstance(e, ValidationError)) {
              error["vat"] = 'error';
            } else {
              throw e;
            }
          }
        }
      }
      else {
        errorMessage.push(await this._t(await req.getEnv(), 'Changing VAT number is not allowed once document(s) have been issued for your account. Please contact us directly for this operation.'));
      }
    }

    // error message for empty required fields
    if (Object.values(error).filter(err => err === 'missing').length) {
      errorMessage.push(await this._t(await req.getEnv(), 'Some required fields are empty.'));
    }

    const unknown = Object.keys(data).filter(k => !this.MANDATORY_BILLING_FIELDS.concat(this.OPTIONAL_BILLING_FIELDS).includes(k));
    if (unknown.length) {
      error['common'] = 'Unknown field';
      errorMessage.push(f("Unknown field '%s'", unknown.join(',')));
    }
    return [error, errorMessage];
  }

  async _documentCheckAccess(req: WebRequest, modelName, documentId, accessToken?: string) {
    const document = (await req.getEnv()).items(modelName).browse([documentId]);
    const documentSudo = await (await document.withUser(global.SUPERUSER_ID)).exists();
    if (!bool(documentSudo)) {
      throw new MissingError(await this._t(await req.getEnv(), "This document does not exist."));
    }
    try {
      // await Promise.all([
        await document.checkAccessRights('read'),
        await document.checkAccessRule('read')
      // ]);
    } catch (e) {
      if (isInstance(e, AccessError)) {
        if (!accessToken || ! await documentSudo.accessToken || !consteq(await documentSudo.accessToken, accessToken)) {
          throw e;
        }
      } else {
        throw e;
      }
    }
    return documentSudo;
  }

  async _getPageViewValues(req: WebRequest, document, accessToken, values, sessionHistory, noBreadcrumbs, opts = {}) {
    if (accessToken) {
      // if noBreadcrumbs = false -> force breadcrumbs even if accessToken to `invite` users to register if they click on it
      values['noBreadcrumbs'] = noBreadcrumbs;
      values['accessToken'] = accessToken;
      values['token'] = accessToken  // for portal chatter
    }
    // Those are used notably whenever the payment form is implied in the portal.
    if (opts['error']) {
      values['error'] = opts['error'];
    }
    if (opts['warning']) {
      values['warning'] = opts['warning'];
    }
    if (opts['success']) {
      values['success'] = opts['success'];
    }
    // Email token for posting messages in portal view with identified author
    if (opts['pid']) {
      values['pid'] = opts['pid'];
    }
    if (opts['hash']) {
      values['hash'] = opts['hash'];
    }

    const history = req.session[sessionHistory] || [];
    update(values, getRecordsPager(history, document));

    return values
  }

  async _showReport(req: WebRequest, res: ServerResponse, model, reportType, reportRef, download: boolean = false) {
    if (!['html', 'pdf', 'text'].includes(reportType)) {
      throw new UserError(await this._t(await req.getEnv(), "Invalid report type: %s", reportType));
    }

    const env = await req.getEnv();
    let reportSudo = await (await env.ref(reportRef)).withUser(global.SUPERUSER_ID);

    if (!isSubclass(reportSudo, env.models['ir.actions.report'])) {
      throw new UserError(await this._t(await req.getEnv(), "%s is not the reference of a report", reportRef));
    }

    if (bool(model['companyId'])) {
      reportSudo = await reportSudo.withCompany(model.companyId);
    }

    const methodName = f('_renderQweb%s', _.upperFirst(reportType));
    const report = (await reportSudo[methodName]([model.id], { data: { 'reportType': reportType } }))[0];
    const reporthttpheaders = [
      ['Content-Type', reportType === 'pdf' ? 'application/pdf' : 'text/html'],
      ['Content-Length', String(len(report))],
    ];
    if (reportType === 'pdf' && download) {
      const filename = f("%s.pdf", (await model._getReportBaseFilename()).replace(/\W+/, '-'));
      reporthttpheaders.push(['Content-Disposition', contentDisposition(filename)]);
    }
    return req.makeResponse(res, report, reporthttpheaders);
  }

}

/**
 * Recursively dereferences `path` (a period-separated sequence of dict
    keys) in `e` (an error dict or value), returns the final resolution IIF it's
    an str, otherwise returns None
 * @param e 
 * @param path 
 * @returns 
 */
function getError(e, path = '') {
  for (const k of (path ? path.split('.') : [])) {
    if (isInstance(e, Dict, Object)) {
      return null;
    }
    e = e[k];
  }
  return typeof (e) === 'string' ? e : null;
}