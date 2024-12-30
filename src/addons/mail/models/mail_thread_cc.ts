import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { emailNormalize, emailSplitAndFormat, emailSplitTuples, formataddr } from "../../../core/tools/mail";

@MetaModel.define()
class MailCCMixin extends AbstractModel {
  static _module = module;
  static _name = 'mail.thread.cc';
  static _parents = 'mail.thread';
  static _description = 'Email CC management';

  static emailCc = Fields.Char('Email cc', {help: 'List of cc from incoming emails.'});

  /**
   * return a dict of sanitize_email:raw_email from a string of cc
   * @param ccString 
   * @returns 
   */
  async _mailCcSanitizedRawDict(ccString) {
    if (!ccString) {
      return {}
    }
    const result = {}
    for (const [name, email] of emailSplitTuples(ccString)) {
      result[`${emailNormalize(email)}`] = formataddr([name, emailNormalize(email)]);
    }
    return result;
  }

  @api.model()
  async messageNew(msgDict, customValues: {}={}) {
    const ccValues = {
      'emailCc': Object.values(await this._mailCcSanitizedRawDict(msgDict.get('cc'))).join(', ')
    }
    Object.assign(ccValues, customValues);
    return _super(MailCCMixin, this).messageNew(msgDict, ccValues);
  }

  /**
   * Adds cc email to self.emailCc while trying to keep email as raw as possible but unique
   * @param msgDict 
   * @param updateVals 
   * @returns 
   */
  async messageUpdate(msgDict, updateVals: {}={}) {
    const ccValues = {}
    const newCc = await this._mailCcSanitizedRawDict(msgDict.get('cc'))
    if (bool(newCc)) {
      const oldCc = await this._mailCcSanitizedRawDict(await this['emailCc']);
      Object.assign(newCc, oldCc);
      ccValues['emailCc'] = Object.values(newCc).join(', ')
    }
    Object.assign(ccValues, updateVals);
    return _super(MailCCMixin, this).messageUpdate(msgDict, ccValues);
  }

  async _messageGetSuggestedRecipients() {
    const recipients = await _super(MailCCMixin, this)._messageGetSuggestedRecipients();
    for (const record of this) {
      const emailCc = await record.emailCc;
      if (emailCc) {
        for (const email of emailSplitAndFormat(emailCc)) {
          await record._messageAddSuggestedRecipient(recipients, {email: email, reason: await this._t('CC Email')});
        }
      }
    }
    return recipients;
  }
}