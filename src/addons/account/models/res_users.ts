import { api } from "../../../core";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class Users extends Model {
  static _module = module;
  static _parents = "res.users";

  @api.constrains('groupsId')
  async _checkOneUserType() {
    await _super(Users, this)._checkOneUserType();

    const g1 = await this.env.ref('account.groupShowLineSubtotalsTaxIncluded', false);
    const g2 = await this.env.ref('account.groupShowLineSubtotalsTaxExcluded', false);

    if (!bool(g1) || !bool(g2)) {
      // A user cannot be in a non-existant group
      return;
    }

    for (const user of this) {
      if (await user._hasMultipleGroups([g1.id, g2.id])) {
        throw new ValidationError(await this._t(`A user cannot have both Tax B2B and Tax B2C.\n
                                        You should go in General Settings, and choose to display Product Prices\n
                                        either in 'Tax-Included' or in 'Tax-Excluded' mode\n
                                        (or switch twice the mode if you are already in the desired one).`));
      }
    }
  }
}

@MetaModel.define()
class GroupsView extends Model {
  static _module = module;
  static _parents = 'res.groups';

  @api.model()
  async getApplicationGroups(domain) {
    // Overridden in order to remove 'Show Full Accounting Features' and
    // 'Show Full Accounting Features - Readonly' in the 'res.users' form view to prevent confusion
    const groupAccountUser = await this.env.ref('account.groupAccountUser', false);
    if (bool(groupAccountUser) && await (await groupAccountUser.categoryId).xmlid === 'base.category_hidden') {
      domain = domain.concat([['id', '!=', groupAccountUser.id]]);
    }
    const groupAccountReadonly = await this.env.ref('account.groupAccountReadonly', false);
    if (bool(groupAccountReadonly) && await (await groupAccountReadonly.categoryId).xmlid === 'base.category_hidden') {
      domain = domain.concat([['id', '!=', groupAccountReadonly.id]]);
    }
    return _super(GroupsView, this).getApplicationGroups(domain);
  }
}