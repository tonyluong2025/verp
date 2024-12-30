import { MetaModel, Model, _super } from "../../../core/models";
import { extend } from "../../../core/tools/iterable";

/**
 * Update of res.groups class
  - if adding users from a group, check mail.channels linked to this user
    group and subscribe them. This is done by overriding the write method.
 */
@MetaModel.define()
class ResGroups extends Model {
  static _module = module;
  static _name = 'res.groups';
  static _parents = 'res.groups';
  static _description = 'Access Groups';

  async write(vals) {
    const res = await _super(ResGroups, this).write(vals);
    if (vals['users']) {
      // form: {'groupIds': [[3, 10], [3, 3], [4, 10], [4, 3]]} or {'groupIds': [[6, 0, [ids]}
      let userIds = vals['users'].filter(command => command[0] == 4).map(command => command[1]);
      extend(userIds, vals['users'].filter(command => command[0] == 6).map(command => command[2]).flat());
      await (await this.env.items('mail.channel').search([['groupIds', 'in', this._ids]]))._subscribeUsersAutomatically();
    }
    return res;
  }
}