import { ServerResponse } from "http";
import { http } from "../../../core"
import { WebRequest } from "../../../core/http";
import { f } from "../../../core/tools/utils";
import { urlEncode } from "../../../core/service/middleware/utils";
import { consteq, pop } from "../../../core/tools/misc";
import { isInstance } from "../../../core/tools/func";
import { AccessError } from "../../../core/helper/errors";
import { Dict } from "../../../core/helper/collections";
import { bool } from "../../../core/tools/bool";

@http.define()
export class MailController extends http.Controller {
  static _module = module;
  _cpPath = '/mail';

  static async _redirectToMessaging(req: WebRequest, res: ServerResponse) {
    const url = f('/web#%s', urlEncode({ 'action': 'mail.actionDiscuss' }));
    return req.redirect(res, url);
  }

  static async _checkToken(req: WebRequest, res: ServerResponse, token) {
    const baseLink = req.uri.pathname;
    const params = Dict.from(req.params);
    params.pop('token', '');
    const env = await req.getEnv();
    const validToken = await env.items('mail.thread')._notifyEncodeLink(baseLink, params);
    return consteq(validToken, String(token));
  }

  static async _checkTokenAndRecordOrRedirect(req: WebRequest, res: ServerResponse, model, resId, token) {
    const comparison = await this._checkToken(req, res, token);
    if (!comparison) {
      console.warn('Invalid token in route %s', req.url);
      return [comparison, null, await this._redirectToMessaging(req, res)];
    }
    let err, record, redirect;
    try {
      record = await (await req.getEnv()).items(model).browse(resId).exists();
    } catch (e) {
      err = e;
      redirect = await this._redirectToMessaging(req, res);
    }
    if (!err) {
      redirect = await this._redirectToRecord(req, res, model, resId);
    }
    return [comparison, record, redirect];
  }

  static async _redirectToRecord(req: WebRequest, res: ServerResponse, model, resId, accessToken?: any, opts: {} = {}) {
    // accessToken and kwargs are used in the portal controller override for the Send by email or Share Link to give access to the record to a recipient that has normally no access.
    const uid = req.session.uid;
    const env = await req.getEnv();
    const user = (await env.items('res.users').sudo()).browse(uid);
    let cids: number[];

    // no model / resId, meaning no possible record -> redirect to login
    if (!model || !resId || !(model in env.models)) {
      return this._redirectToMessaging(req, res);
    }

    // find the access action using sudo to have the details about the access link
    const RecordModel = env.items(model);
    const recordSudo = await (await RecordModel.sudo()).browse(resId).exists();
    if (!bool(recordSudo)) {
      // record does not seem to exist -> redirect to login
      return this._redirectToMessaging(req, res);
    }
    let recordAction;
    // the record has a window redirection: check access rights
    if (uid != null) {
      if (! await (await RecordModel.withUser(uid)).checkAccessRights('read', false)) {
        return this._redirectToMessaging(req, res);
      }
      let error;
      try {
        // We need here to extend the "allowedCompanyIds" to allow a redirection to any record that the user can access, regardless of currently visible records based on the "currently allowed companies".
        let cids = req.cookie['cids'] ?? String((await user.companyId).id);
        cids = cids.split(',').map(cid => parseInt(cid));
        try {
          await (await (await recordSudo.withUser(uid)).withContext({ allowedCompanyIds: cids })).checkAccessRule('read');
        } catch (e) {
          // except AccessError:
          // In case the allowedCompanyIds from the cookies (i.e. the last user configuration  on his browser) is not sufficient to avoid an ir.rule access error, try to following heuristic:
          // - Guess the supposed necessary company to access the record via the method
          //   _get_mail_redirect_suggested_company
          //   - If no company, then redirect to the messaging
          //   - Merge the suggested company with the companies on the cookie
          // - Make a new access test if it succeeds, redirect to the record. Otherwise, 
          //   redirect to the messaging.
          const suggestedCompany = await recordSudo._getMailRedirectSuggestedCompany();
          if (!bool(suggestedCompany)) {
            throw new AccessError('');
          }
          cids = cids.concat([suggestedCompany.id]);
          await (await (await recordSudo.withUser(uid)).withContext({ allowedCompanyIds: cids })).checkAccessRule('read');
        }
      } catch (e) {
        error = true;
        if (isInstance(e, AccessError)) {
          return this._redirectToMessaging(req, res);
        }
        throw e;
      }
      if (error) {
        recordAction = await recordSudo.getAccessAction(uid);
      }
    }
    else {
      recordAction = await recordSudo.getAccessAction();
      if (recordAction['type'] === 'ir.actions.acturl' && recordAction['targetType'] !== 'public') {
        const urlParams = {
          'model': model,
          'id': resId,
          'activeId': resId,
          'action': recordAction['id'],
        }
        const viewId = await recordSudo.getFormviewId();
        if (bool(viewId)) {
          urlParams['viewId'] = viewId;
        }
        const url = f('/web/login?redirect=#%s', urlEncode(urlParams));
        return req.redirect(res, url);
      }
    }
    pop(recordAction, 'targetType', null);
    // the record has an URL redirection: use it directly
    if (recordAction['type'] === 'ir.actions.acturl') {
      return req.redirect(res, recordAction['url']);
    }
    // other choice: actwindow (no support of anything else currently)
    else if (recordAction['type'] !== 'ir.actions.actwindow') {
      return this._redirectToMessaging(req, res);
    }

    const urlParams = {
      'model': model,
      'id': resId,
      'activeId': resId,
      'action': recordAction['id'],
    }
    const viewId = await recordSudo.getFormviewId();
    if (bool(viewId)) {
      urlParams['viewId'] = viewId;
    }
    if (bool(cids)) {
      urlParams['cids'] = cids.map(cid => String(cid)).join(',');
    }
    const url = f('/web?#%s', urlEncode(urlParams));
    return req.redirect(res, url);
  }

  /**
   * Generic access point from notification emails. The heuristic to choose where to redirect the user is the following :

      - find a public URL
      - if none found
      - users with a read access are redirected to the document
      - users without read access are redirected to the Messaging
      - not logged users are redirected to the login page

      models that have an accessToken may apply variations on this.
   * @param req 
   * @param res 
   * @param opts 
   */
  @http.route('/mail/view', { type: 'http', auth: 'public' })
  async mailActionView(req: WebRequest, res: ServerResponse, opts: { resId?: any, accessToken?: any } = {}) {
    // ==============================================================================================
    // This block of code disappeared on saas-11.3 to be reintroduced by TBE.
    // This is needed because after a migration from an older version to saas-11.3, the link
    // received by mail with a messageId no longer work.
    // So this block of code is needed to guarantee the backward compatibility of those links.
    let model, resId;
    if (opts['messageId']) {
      const Message = (await req.getEnv()).items('mail.message');
      let msg;
      try {
        msg = await (await Message.sudo()).browse(parseInt(opts['messageId'])).exists();
      } catch (e) {
        msg = Message;
      }
      if (bool(msg)) {
        [model, resId] = await msg('model', 'resId');
      }
    }
    // ==============================================================================================

    if (resId && typeof (resId) === 'string') {
      try {
        resId = parseInt(resId);
      } catch (e) {
        // except ValueError:
        resId = false;
      }
    }
    return MailController._redirectToRecord(req, res, model, resId, opts.accessToken);
  }
}