import { Fields } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ValidateAccountMove extends TransientModel {
  static _module = module;
  static _name = "validate.account.move";
  static _description = "Validate Account Move";

  static forcePost = Fields.Boolean({ string: "Force", help: "Entries in the future are set to be auto-posted by default. Check this checkbox to post them now." });

  async validateMove() {
    let domain;
    if (this._context['activeModel'] === 'account.move') {
      domain = [['id', 'in', this._context['activeIds'] ?? []], ['state', '=', 'draft']];
    }
    else if (this._context['activeModel'] === 'account.journal') {
      domain = [['journalId', '=', this._context['activeId']], ['state', '=', 'draft']];
    }
    else {
      throw new UserError(await this._t("Missing 'active_model' in context."));
    }

    const moves = await (await this.env.items('account.move').search(domain)).filtered('lineIds');
    if (!bool(moves)) {
      throw new UserError(await this._t('There are no journal items in the draft state to post.'));
    }
    await moves._post(! await this['forcePost']);
    return { 'type': 'ir.actions.actwindow.close' }
  }
}