import { Fields, api } from "../../../core";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { isInstance } from "../../../core/tools/func";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class PortalShare extends TransientModel {
  static _module = module;
  static _name = 'portal.share';
  static _description = 'Portal Sharing';

  @api.model()
  async defaultGet(fields) {
    const result = await _super(PortalShare, this).defaultGet(fields);
    result['resModel'] = this._context['activeModel'] ?? false;
    result['resId'] = this._context['activeId'] ?? false;
    if (result['resModel'] && result['resId']) {
      const record = this.env.items(result['resModel']).browse(result['resId']);
      result['shareLink'] = await record.getBaseUrl() + await record._getShareUrl(true);
    }
    return result
  }

  @api.model()
  async _selectionTargetModel() {
    const res = [];
    for (const model of await (await this.env.items('ir.model').sudo()).search([])) {
      res.push(await model('model', 'label'));
    }
    return res;
  }

  static resModel = Fields.Char('Related Document Model', {required: true});
  static resId = Fields.Integer('Related Document ID', {required: true});
  static resourceRef = Fields.Reference('_selectionTargetModel', {string: 'Related Document', compute: '_computeResourceRef'});
  static partnerIds = Fields.Many2many('res.partner', {string: "Recipients", required: true});
  static note = Fields.Text({help: "Add extra content to display in the email"});
  static shareLink = Fields.Char({string: "Link", compute: '_computeShareLink'});
  static accessWarning = Fields.Text("Access warning", {compute: "_computeAccessWarning"});

  @api.depends('resModel', 'resId')
  async _computeResourceRef() {
    for (const wizard of this) {
      const resModel = await wizard.resModel;
      if (resModel && resModel in this.env.models) {
        await wizard.set('resourceRef', f('%s,%s', resModel, await wizard.resId || 0));
      }
      else {
        await wizard.set('resourceRef', null);
      }
    }
  }

  @api.depends('resModel', 'resId')
  async _computeShareLink() {
    for (const rec of this) {
      await rec.set('shareLink', false);
      if (await rec.resModel) {
        const resModel = this.env.items(await rec.resModel);
        if (isInstance(resModel, this.pool.models['portal.mixin']) && await rec.resId) {
          const record = resModel.browse(await rec.resId)
          await rec.set('shareLink', await record.getBaseUrl() + await record._getShareUrl(true));
        }
      }
    }
  }

  @api.depends('resModel', 'resId')
  async _computeAccessWarning() {
    for (const rec of this) {
      await rec.set('accessWarning', false);
      if (await rec.resModel) {
        const resModel = this.env.items(await rec.resModel);
        if (isInstance(resModel, this.pool.models['portal.mixin']) && await rec.resId) {
          const record = resModel.browse(await rec.resId);
          await rec.set('accessWarning', await record.accessWarning);
        }
      }
    }
  }

  @api.model()
  async _getNote() {
    return this.env.ref('mail.mtNote');
  }

  async _sendPublicLink(note, partners?: any) {
    if (partners == null) {
      partners = await this['partnerIds'];
    }
    let self: any = this;
    for (const partner of partners) {
      const shareLink = await (await self.resourceRef).getBaseUrl() + await (await self.resourceRef)._getShareUrl(true, partner.id);
      const savedLang = self.env.lang;
      self = await self.withContext({lang: await partner.lang});
      const template = await self.env.ref('portal.portalShareTemplate', false);
      const resourceRef = await self.resourceRef;
      await resourceRef.messagePostWithView(template,
        {values: {'partner': partner, 'note': await self.note, 'record': resourceRef, 'shareLink': shareLink},
        subject: await this._t("You are invited to access %s", await resourceRef.displayName),
        subtypeId: note.id,
        emailLayoutXmlid: 'mail.mailNotificationLight',
        partnerIds: [[6, 0, partner.ids]]});
      self = await self.withContext({lang: savedLang});
    }
  }

  async _sendSignupLink(note, partners?: any) {
    if (partners == null) {
      partners = await (await this['partnerIds']).filtered(async (partner) => !bool(await partner.userIds));
    }
    let self: any = this;
    for (const partner of partners) {
      //  prepare partner for signup and send singup url with redirect url
      await partner.signupGetAuthParam();
      const shareLink = (await partner._getSignupUrlForAction({action: '/mail/view', resId: await self.resId, model: self.resModel}))[partner.id];
      const savedLang = this.env.lang;
      self = await self.withContext({lang: await partner.lang});
      const template = await self.env.ref('portal.portalShareTemplate', false);
      const resourceRef = await self.resourceRef;
      await resourceRef.messagePostWithView(template,
          {values: {'partner': partner, 'note': await self.note, 'record': resourceRef, 'shareLink': shareLink},
          subject: await this._t("You are invited to access %s", await resourceRef.displayName),
          subtypeId: note.id,
          emailLayoutXmlid: 'mail.mailNotificationLight',
          partnerIds: [[6, 0, partner.ids]]})
      self = await self.withContext({lang: savedLang});
    }
  }

  async actionSendMail() {
    const note = this._getNote();
    const signupEnabled = await (await this.env.items('ir.config.parameter').sudo()).getParam('auth_signup.invitationScope') === 'b2c';

    const resourceRef = await this['resourceRef'];
    let partnerIds;
    if ((resourceRef['accessToken'] ?? false) || !signupEnabled) {
      partnerIds = await this['partnerIds'];
    }
    else {
      partnerIds = await (await this['partnerIds']).filtered((x) => x.userIds);
    }
    // if partner already user or record has access token send common link in batch to all user
    await this._sendPublicLink(note, partnerIds);
    // when partner not user send individual mail with signup token
    await this._sendSignupLink(note, (await this['partnerIds']).sub(partnerIds));

    // subscribe all recipients so that they receive future communication (better than
    // using autofollow as more precise)
    await resourceRef.messageSubscribe((await this['partnerIds']).ids);

    return {'type': 'ir.actions.actwindow.close'};
  }
}