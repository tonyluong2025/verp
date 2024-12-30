import { v4 as uuid4 } from "uuid";
import { Fields } from "../../../core/fields"
import { MetaModel, AbstractModel, _super } from "../../../core/models"
import { bool } from "../../../core/tools/bool";
import { f } from "../../../core/tools/utils";
import { urlEncode } from "../../../core/service/middleware/utils";
import { Dict } from "../../../core/helper/collections";
import { api } from "../../../core";

@MetaModel.define()
class PortalMixin extends AbstractModel {
  static _module = module;
  static _name = "portal.mixin";
  static _description = 'Portal Mixin';

  static accessUrl = Fields.Char(
      'Portal Access URL', {compute: '_computeAccessUrl',
      help: 'Customer Portal URL'});
  static accessToken = Fields.Char('Security Token', {copy: false});

  // to display the warning from specific model
  static accessWarning = Fields.Text("Access warning", {compute: "_computeAccessWarning"});

  async _computeAccessWarning() {
    for (const record of this) {
      await record.set('accessWarning', '');
    }
  }

  async _computeAccessUrl() {
    for (const record of this) {
      await record.set('accessUrl', '#');
    }
  }

  /**
   * Get the current record access token
   * @returns 
   */
  async _portalEnsureToken() {
    const accessToken = await (this as any).accessToken; 
    if (! accessToken) {
      // we use a `write` to force the cache clearing otherwise `return self.accessToken` will return false
      await (await this.sudo()).write({'accessToken': String(uuid4())});
    }
    return accessToken;
  }

  /**
   * Build the url of the record  that will be sent by mail and adds additional parameters such as accessToken to bypass the recipient's rights, signupPartner to allows the user to create easily an account,hash token to allow the user to be authenticated in the chatter of the record portal view, if applicable
    :param redirect : Send the redirect url instead of the direct portal share url
    :param signupPartner: allows the user to create an account with pre-filled fields.
    :param pid: = partnerId - when given, a hash is generated to allow the user to be authenticated in the portal chatter, if any in the target page, if the user is redirected to the portal instead of the backend.
    :return: the url of the record with access parameters, if any.
   * @param redirect 
   * @param signupPartner 
   * @param pid 
   * @param shareToken 
   * @returns 
   */
  async _getShareUrl(redirect?: any, signupPartner?: any, pid?: any, shareToken: boolean=true) {
    this.ensureOne();
    const params = {
      'model': this._name,
      'resId': this.id,
    }
    if (shareToken && await this['accessToken']) {
      params['accessToken'] = await this._portalEnsureToken();
    }
    if (pid) {
      params['pid'] = pid
      params['hash'] = await (this as any)._signToken(pid);
    }
    const partnerId = await this['partnerId'];
    if (signupPartner && bool('partnerId')) {
      Object.assign(params, (await partnerId.signupGetAuthParam())[partnerId.id]);
    }

    return f('%s?%s', redirect ? '/mail/view' : await (this as any).accessUrl, urlEncode(params));
  }

  async _notifyGetGroups(msgVals?: any) {
    const accessToken = await this._portalEnsureToken();
    const groups = await _super(PortalMixin, this)._notifyGetGroups(msgVals);
    const localMsgVals: Dict<any> = new Dict(msgVals ?? {});

    let newGroup;
    if (accessToken && 'partnerId' in this._fields && bool(await this['partnerId'])) {
      const customer = await this['partnerId'];
      localMsgVals['accessToken'] = await this['accessToken'];
      localMsgVals.updateFrom((await customer.signupGetAuthParam())[customer.id]);
      const accessLink = await (this as any)._notifyGetActionLink('view', localMsgVals);

      newGroup = [
        ['portalCustomer', async (pdata) => await pdata['id'] == customer.id, {
          'hasButtonAccess': false,
          'buttonAccess': {
            'url': accessLink,
          },
          'notificationIsCustomer': true,
        }]
      ];
    }
    else {
      newGroup = [];
    }
    return newGroup.concat(groups);
  }

  /**
   * Instead of the classic form view, redirect to the online document for portal users or if force_website=true in the context.
   * @param accessUid 
   * @returns 
   */
  async getAccessAction(accessUid?: any) {
    this.ensureOne();

    let [user, record] = [await this.env.user(), this];
    if (accessUid) {
      try {
        await record.checkAccessRights('read');
        await record.checkAccessRule("read");
      } catch(e) {
      // except exceptions.AccessError:
        return _super(PortalMixin, this).getAccessAction(accessUid);
      }
      user = (await this.env.items('res.users').sudo()).browse(accessUid);
      record = await this.withUser(user);
    }
    if (await user.share || this.env.context['forceWebsite']) {
      let err;
      try {
        await record.checkAccessRights('read');
        await record.checkAccessRule('read');
      } catch(e) {
        err = true;
      // except exceptions.AccessError:
        if (this.env.context['forceWebsite']) {
          return {
            'type': 'ir.actions.actUrl',
            'url': await record['accessUrl'],
            'target': 'self',
            'resId': record.id,
          }
        }
        else {
          // pass
        }
      }
      if (!err) {
        return {
          'type': 'ir.actions.acturl',
          'url': await record._getShareUrl(),
          'target': 'self',
          'resId': record.id,
        }
      }
    }
    return _super(PortalMixin, this).getAccessAction(accessUid);
  }

  @api.model()
  async actionShare() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("portal.portalShareAction");
    action['context'] = {
      'activeId': this.env.context['activeId'],
      'activeModel': this.env.context['activeModel']
    }
    return action;
  }

  /**
   * Get a portal url for this model, including accessToken.
      The associated route must handle the flags for them to have any effect.
      - suffix: string to append to the url, before the query string
      - reportType: reportType query string, often one of: html, pdf, text
      - download: set the download query string to true
      - query_string: additional query string
      - anchor: string to append after the anchor #
   * @param suffix 
   * @param reportType 
   * @param download 
   * @param searchQuery 
   * @param anchor 
   * @returns 
   */
  async getPortalUrl(opts: {suffix?: any, reportType?: any, download?: any, queryString?: any, anchor?: any}={}) {
    this.ensureOne();
    const url = await this['accessUrl'] + f('%s?accessToken=%s%s%s%s%s',
      opts.suffix ? opts.suffix : '',
      await this._portalEnsureToken(),
      f('&reportType=%s', opts.reportType ? opts.reportType : ''),
      opts.download ? '&download=true' : '',
      opts.queryString ? opts.queryString : '',
      f('#%s', opts.anchor ? opts.anchor : '')
    );
    return url;
  }
}