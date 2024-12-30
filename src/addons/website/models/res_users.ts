import { Command, Fields, api } from "../../../core";
import { Environment } from "../../../core/api";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, doWith } from "../../../core/tools";

@MetaModel.define()
class ResUsers extends Model {
  static _module = module;
  static _parents = 'res.users';

  static websiteId = Fields.Many2one('website', { related: 'partnerId.websiteId', store: true, relatedSudo: false, readonly: false });

  static _sqlConstraints = [
    // Partial constraint, complemented by a constraint (see below).
    ['loginKey', 'unique (login, "websiteId")', 'You can not have two users with the same login!'],
  ];

  /**
   * Do not allow two users with the same login without website
   */
  @api.constrains('login', 'websiteId')
  async _checkLogin() {
    await this.flush(['login', 'websiteId']);
    const res = await this.env.cr.execute(
      `SELECT login
                 FROM "resUsers"
                WHERE login IN (SELECT login FROM "resUsers" WHERE id IN (%s) AND "websiteId" IS NULL)
                  AND "websiteId" IS NULL
             GROUP BY login
               HAVING COUNT(*) > 1
            `,
      [String(this.ids) || 'NULL']
    );
    if (res.length) {
      throw new ValidationError(await this._t('You can not have two users with the same login!'));
    }
  }

  @api.model()
  async _getLoginDomain(login) {
    const website = await this.env.items('website').getCurrentWebsite();
    return (await _super(ResUsers, this)._getLoginDomain(login)).concat(website.websiteDomain());
  }

  @api.model()
  _getLoginOrder() {
    return 'websiteId, ' + _super(ResUsers, this)._getLoginOrder();
  }

  @api.model()
  async _signupCreateUser(values) {
    const currentWebsite = await this.env.items('website').getCurrentWebsite();
    // Note that for the moment, portal users can connect to all websites of
    // all companies as long as the specificUserAccount setting is not
    // activated.
    const company = await currentWebsite.companyId;
    values['companyId'] = company.id;
    values['companyIds'] = [Command.link(company.id)];
    if (this.env.req && await currentWebsite.specificUserAccount) {
      values['websiteId'] = currentWebsite.id;
    }
    return _super(ResUsers, this)._signupCreateUser(values);
  }

  @api.model()
  async _getSignupInvitationScope() {
    const currentWebsite = await this.env.items('website').getCurrentWebsite();
    return await currentWebsite.authSignupUninvited || _super(ResUsers, this)._getSignupInvitationScope();
  }

  /**
   * Override to link the logged in user's res.partner to website.visitor.
      If both a request-based visitor and a user-based visitor exist we try
      to update them (have same partnerId), and move sub records to the main
      visitor (user one). Purpose is to try to keep a main visitor with as
      much sub-records (tracked pages, leads, ...) as possible.
   * @param req 
   * @param db 
   * @param login 
   * @param password 
   * @param userAgentEnv 
   */
  async authenticate(req, db, login, password, userAgentEnv) {
    const uid = await _super(ResUsers, this).authenticate(req, db, login, password, userAgentEnv);
    if (uid) {
      const cr = (this as any).pool.cursor();
      await doWith(cr, async () => {
        const env = await Environment.new(cr, uid, {}, null, req);
        const visitorSudo = await env.items('website.visitor')._getVisitorFromRequest();
        if (bool(visitorSudo)) {
          const userPartner = await (await env.user()).partnerId;
          const otherUserVisitorSudo = await (await (await env.items('website.visitor').withContext({ activeTest: false })).sudo()).search(
            [['partnerId', '=', userPartner.id], ['id', '!=', visitorSudo.id]],
            { order: 'lastConnectionDatetime DESC' }
          );  // current 13.3 state: 1 result max as unique visitor / partner
          if (otherUserVisitorSudo.ok) {
            const visitorMain = otherUserVisitorSudo[0];
            const otherVisitors = otherUserVisitorSudo.slice(1);  // normally void
            await visitorSudo.add(otherVisitors)._linkToVisitor(visitorMain, true);
            await visitorMain.set('label', await userPartner.label);
            await visitorMain.set('active', true);
            await visitorMain._updateVisitorLastVisit();
          }
          else {
            if (!(await visitorSudo.partnerId).eq(userPartner)) {
              await visitorSudo._linkToPartner(userPartner, { 'partnerId': userPartner.id });
            }
            await visitorSudo._updateVisitorLastVisit();
          }
        }
      });
    }
    return uid;
  }
}