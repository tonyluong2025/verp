import _ from "lodash";
import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class Channel extends Model {
    static _module = module;
    static _parents = 'mail.channel';

    static subscriptionDepartmentIds = Fields.Many2many(
        'hr.department', {
            string: 'HR Departments',
        help: 'Automatically subscribe members of those departments to the channel.'
    });

    /**
     * Auto-subscribe members of a department to a channel
     * @returns 
     */
    async _subscribeUsersAutomaticallyGetMembers() {
        const newMembers = await _super(Channel, this)._subscribeUsersAutomaticallyGetMembers();
        for (const channel of this) {
            newMembers[channel.id] = _.union(
                newMembers[channel.id],
                (await (await (await (await (await channel.subscriptionDepartmentIds).memberIds).userId).partnerId).filtered((p) => p.active)).sub(await channel.channelPartnerIds).ids
            );
        }
        return newMembers;
    }

    async write(vals) {
        const res = await _super(Channel, this).write(vals);
        if (vals['subscriptionDepartmentIds']) {
            await (this as any)._subscribeUsersAutomatically();
        }
        return res;
    }
}