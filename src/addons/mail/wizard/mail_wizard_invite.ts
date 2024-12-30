import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import * as xml from '../../../core/tools/xml';

/**
 * Wizard to invite partners (or channels) and make them followers. 
 */
@MetaModel.define()
class Invite extends TransientModel {
  static _module = module;
  static _name = 'mail.wizard.invite';
  static _description = 'Invite wizard';

  @api.model()
  async defaultGet(fields) {
    const result = await _super(Invite, this).defaultGet(fields);
    if (!fields.includes('message')) {
      return result;
    }

    const userName = await (await this.env.user()).displayName;
    const model = result.get('resModel');
    const resId = result.get('resId');
    let msgFmt;
    if (model && resId) {
      const document = await (await this.env.items('ir.model')._get(model)).displayName;
      const title = await this.env.items(model).browse(resId).displayName;
      msgFmt = await this._t('{userName} invited you to follow {document} document: {title}')
    }
    else {
      msgFmt = await this._t('{userName} invited you to follow a new document.')
    }
    const text = msgFmt// % local()
    const message = xml.E.div([
      xml.E.withType('P', await this._t('Hello,')),
      xml.E.withType('P', text)
    ])
    result['message'] = xml.serializeXml(message);
    return result;
  }

  static resModel = Fields.Char('Related Document Model', {required: true, index: true, help: 'Model of the followed resource'})
  static resId = Fields.Integer('Related Document ID', {index: true, help: 'Id of the followed resource'})
  static partnerIds = Fields.Many2many('res.partner', {string: 'Recipients', help: "List of partners that will be added as follower of the current document.", domain: [['type', '!=', 'private']]})
  static message = Fields.Html('Message')
  static sendMail = Fields.Boolean('Send Email', {default: true, help: "If checked, the partners will receive an email warning they have been added in the document's followers."})

  async addFollowers() {
    if (! await (await this.env.user()).email) {
      throw new UserError(await this._t("Unable to post message, please configure the sender's email address."));
    }
    const emailFrom = await (await this.env.user()).emailFormatted
    for (const wizard of this) {
      const model = this.env.items(wizard.resModel);
      const document = model.browse(wizard.resId)

      // filter partnerIds to get the new followers, to avoid sending email to already following partners
      const newPartners = (await wizard.partnerIds).sub(await (await document.sudo()).messagePartnerIds);
      await document.messageSubscribe(newPartners.ids);

      const modelName = await (await this.env.items('ir.model')._get(wizard.resModel)).displayName;
      // send an email if option checked and if a message exists (do not send void emails)
      if (await wizard.sendMail && await wizard.message && await wizard.message !== '<br>') { // when deleting the message, cleditor keeps a <br>
        const message = await this.env.items('mail.message').create({
          'subject': await this._t('Invitation to follow {documentModel}: {documentName}', {documentModel: modelName, documentName: await document.displayName}),
          'body': await wizard.message,
          'recordName': await document.displayName,
          'emailFrom': emailFrom,
          'replyTo': emailFrom,
          'model': await wizard.resModel,
          'resId': await wizard.resId,
          'replyToForceNew': true,
          'addSign': true,
        })
        const partnersData = [];
        const recipientData = await this.env.items('mail.followers')._getRecipientData(document, 'comment', false, newPartners.ids);
        for (const [pid, active, pshare, notif, groups] of recipientData) {
          const pdata = {'id': pid, 'share': pshare, 'active': active, 'notif': 'email', 'groups': groups ?? []}
          if (! pshare && notif) {  // has an user and is not shared, is therefore user
            partnersData.push({...pdata, type: 'user'});
          }
          else if (pshare && notif) {  // has an user and is shared, is therefore portal
            partnersData.push({...pdata, type: 'portal'});
          }
          else {  // has no user, is therefore customer
            partnersData.push({...pdata, type: 'customer'});
          }
        }

        // await Promise.all([
          await document._notifyRecordByEmail(message, partnersData, false),
          // in case of failure, the web client must know the message was
          // deleted to discard the related failure notification
          await this.env.items('bus.bus')._sendone(await (await this.env.user()).partnerId, 'mail.message/delete', {'messageIds': message.ids}),
          await message.unlink()
        // ]);
      }
    }
    return {'type': 'ir.actions.actwindow_close'}
  }
}