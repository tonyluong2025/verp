import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { len } from "../../../core/tools/iterable";

@MetaModel.define()
class ResPartnerBank extends Model {
  static _module = module;
  static _parents = "res.partner.bank";

  static journalId = Fields.One2many('account.journal', 'bankAccountId', { domain: [['type', '=', 'bank']], string: 'Account Journal', readonly: true, help: "The accounting journal corresponding to this bank account." });

  @api.constrains('journalId')
  async _checkJournalId() {
    for (const bank of this) {
      if (len(await bank.journalId) > 1) {
        throw new ValidationError(await this._t('A bank account can belong to only one journal.'));
      }
    }
  }
}