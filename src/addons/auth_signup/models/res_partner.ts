import _ from "lodash";
import { format as f } from 'util';
import * as api from "../../../core/api";
import { Fields } from "../../../core/fields";
import { AccessDenied, DefaultDict, Dict, UserError } from "../../../core/helper";
import { MetaModel, Model, ModelRecords } from "../../../core/models";
import { urlEncode, urlJoin } from "../../../core/service/middleware/utils";
import { randomToken } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";

export class SignupError extends UserError {}

@MetaModel.define()
class ResPartner extends Model {
  static _module = module;
  static _parents = 'res.partner';

  static signupToken = Fields.Char({copy: false, groups: "base.groupErpManager"});
  static signupType = Fields.Char({string: 'Signup Token Type', copy: false, groups: "base.groupErpManager"});
  static signupExpiration = Fields.Datetime({copy: false, groups: "base.groupErpManager"});
  static signupValid = Fields.Boolean({compute: '_computeSignupValid', string: 'Signup Token is Valid'});
  static signupUrl = Fields.Char({compute: '_computeSignupUrl', string: 'Signup URL'});

  @api.depends('signupToken', 'signupExpiration')
  async _computeSignupValid() {
    const self = this;
    const dt = Date.now();
    for (const [partner, partnerSudo] of _.zip([...self], [...(await self.sudo())])) {
      await partner.set('signupValid', bool(await partnerSudo.signupToken) && 
        (! await partnerSudo.signupExpiration || dt <= await partnerSudo.signupExpiration));
    }
  }

  async _computeSignupUrl() {
    const self = this;
    const result = await (await self.sudo())._getSignupUrlForAction();
    for (const partner of self) {
      let any;
      for (const u of await partner.userIds as ModelRecords) {
        if (!u.eq(await self.env.user()) && await u.hasGroup('base.groupUser')) {
          await self.env.items('res.users').checkAccessRights('write');
          break;
        } 
      }
      await partner.set('signupUrl', result.get(partner.id, false));
    }
  }

  /**
   * generate a signup url for the given partner ids and action, possibly overriding
          the url state components (menuId, id, viewType)
   * @param url 
   * @param action 
   * @param viewType 
   * @param menuId 
   * @param resId 
   * @param model 
   */
  async _getSignupUrlForAction(url?: string, action?: string, viewType?: string, menuId?: string, resId?: string, model?: string) {
    const res = Dict.fromKeys(this.ids, false);
    for (const partner of this) {
      const baseUrl = await partner.getBaseUrl();
      const sudo = await partner.sudo();
      const userIds = await partner.userIds;
      // when required, make sure the partner has a valid signup token
      if (this.env.context['signupValid'] && !bool(await partner.userIds)) {
        await sudo.signupPrepare();
      }

      let route = 'login';
      // the parameters to encode for the query
      const query = new Dict({db: this.env.cr.dbName});
      const sudoSignupType = await sudo.signupType;
      const signupType = this.env.context['signupForceTypeInUrl'] || sudoSignupType || '';
      if (signupType) {
        route = signupType === 'reset' ? 'resetPassword' : signupType;
      }

      const sudoSignupToken = await sudo.signupToken;
      if (sudoSignupToken && signupType) {
        query['token'] = sudoSignupToken;
      }
      else if (userIds) {
        query['login'] = await userIds(0).login;
      }
      else {
        continue        // no signup token, no user, thus no signup url!
      }

      if (url) {
          query['redirect'] = url;
      }
      else {
        const fragment = new Dict();
        let base = '/web#';
        if (action === '/mail/view')
          base = '/mail/view?';
        else if (action)
          fragment['action'] = action;
        if (viewType)
          fragment['viewType'] = viewType;
        if (menuId)
          fragment['menuId'] = menuId;
        if (model)
          fragment['model'] = model;
        if (resId)
          fragment['resId'] = resId;

        if (fragment.length) {
          query['redirect'] = base + urlEncode(fragment);
        }
      }

      let signupUrl = f("/web/%s?%s", route, urlEncode(query));
      if (! this.env.context['relativeUrl']) {
        signupUrl = urlJoin(baseUrl, signupUrl);
      }
      res[partner.id] = signupUrl;
    }

    return res;
  }

  async actionSignupPrepare() {
    return this.signupPrepare();
  }

  /**
   * Get a signup token related to the partner if signup is enabled.
        If the partner already has a user, get the login parameter.
   * @returns 
   */
  async signupGetAuthParam() {
    if (! await (await this.env.user()).hasGroup('base.groupUser') && ! await this.env.isAdmin()) {
      throw new AccessDenied();
    }

    const res = new DefaultDict<any, any>() //dict)

    const allowSignup = await this.env.items('res.users')._getSignupInvitationScope() === 'b2c';
    for (let partner of this) {
      partner = await partner.sudo();
      const id = partner.id;
      const userIds = await partner.userIds;
      if (allowSignup && ! bool(userIds)) {
        await partner.signupPrepare();
        res[id] = res[id] ?? {};
        res[id]['authSignupToken'] = await partner.signupToken;
      }
      else if (bool(userIds)) {
        res[id] = res[id] ?? {};
        res[id]['authLogin'] = await userIds(0).login;
      }
    }
    return res;
  }

  async signupCancel() {
    return this.write({'signupToken': false, 'signupType': false, 'signupExpiration': false});
  }

  /**
   * generate a new token for the partners with the given validity, if necessary
        :param expiration: the expiration datetime of the token (string, optional)
   * @param signupType 
   * @param expiration 
   * @returns 
   */
  async signupPrepare(signupType="signup", expiration=false) {
    for (const partner of this) {
      if (expiration || ! await partner.signupValid) {
        let token = randomToken();
        while (bool(await this._signupRetrievePartner(token))) {
          token = randomToken();
        }
        await partner.write({'signupToken': token, 'signupType': signupType, 'signupExpiration': expiration});
      }
    }
    return true;
  }

  /**
   * find the partner corresponding to a token, and possibly check its validity
        :param token: the token to resolve
        :param check_validity: if true, also check validity
        :param raiseException: if true, raise exception instead of returning false
        :return: partner (browse record) or false (if raiseException is false)
   * @param token 
   * @param checkValidity 
   * @param raiseException 
   * @returns 
   */
  @api.model()
  async _signupRetrievePartner(token, checkValidity=false, raiseException=false) {
    const partner = await this.search([['signupToken', '=', token]], {limit: 1});
    if (! bool(partner)) {
      if (raiseException) {
        throw new UserError(await this._t("Signup token '%s' is not valid", token));
      }
      return false;
    }
    if (checkValidity && ! await partner.signupValid) {
      if (raiseException) {
        throw new UserError(await this._t("Signup token '%s' is no longer valid", token));
      }
      return false;
    }
    return partner;
  }

  /**
   * retrieve the user info about the token
        :return: a dictionary with the user information:
            - 'db': the name of the database
            - 'token': the token, if token is valid
            - 'label': the name of the partner, if token is valid
            - 'login': the user login, if the user already exists
            - 'email': the partner email, if the user does not exist
   * @param token 
   * @returns 
   */
  @api.model()
  async signupRetrieveInfo(token) {
    const partner = await this._signupRetrievePartner(token, false, true);
    const res = {'db': this.env.cr.dbName};
    if (await partner.signupValid) {
      res['token'] = token;
      res['label'] = await partner.label;
    }
    const userIds = await partner.userIds;
    if (bool(userIds)) {
      res['login'] = await userIds(0).login;
    }
    else {
      res['email'] = await partner.email || ''
      res['login'] = res['email'];
    }
    return res;
  }
}