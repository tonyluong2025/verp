import { Fields } from "../../../core";
import { NotImplementedError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { hash, repr } from "../../../core/tools";
import { _f } from "../../../core/tools/utils";

@MetaModel.define()
class MailThread extends AbstractModel {
  static _module = module;
  static _parents = 'mail.thread';

  _mailPostTokenField = 'accessToken' // token field for external posts, to be overridden

  static websiteMessageIds = Fields.One2many('mail.message', 'resId', {
    string: 'Website Messages',
    domain: (self) => [['model', '=', self._name], '|', ['messageType', '=', 'comment'], ['messageType', '=', 'email']], autojoin: true, help: "Website communication history"
  })

  /**
   * Generate a secure hash for this record with the email of the recipient with whom the record have been shared.

    This is used to determine who is opening the link to be able for the recipient to post messages on the document's portal view.

    :param str email:
        Email of the recipient that opened the link.
   * @param pid 
   * @returns 
   */
  async _signToken(pid) {
    this.ensureOne();
    // check token field exists
    if (!(this._mailPostTokenField in this._fields)) {
      throw new NotImplementedError(_f(await this._t(
        "Model {modelName} does not support token signature, as it does not have {fieldName} field."),
        {
          modelName: this._name,
          fieldName: this._mailPostTokenField
        }
      ))
    }
    // sign token
    const secret = await (await this.env.items("ir.config.parameter").sudo()).getParam("database.secret");
    const token = [this.env.cr.dbName, await this[this._mailPostTokenField], pid];
    return hash(Buffer.from(secret, 'ascii'), repr(token), 'sha256');
  }
}