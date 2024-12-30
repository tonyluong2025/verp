import { Fields } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"

@MetaModel.define()
class PhoneBlacklistRemove extends TransientModel {
    static _module = module;
    static _name = 'phone.blacklist.remove';
    static _description = 'Remove phone from blacklist';

    static phone = Fields.Char({string: "Phone Number", readonly: true, required: true});
    static reason = Fields.Char({name: "Reason"});

    async actionUnblacklistApply() {
        return this.env.items('phone.blacklist').actionRemoveWithReason(await this['phone'], await this['reason']);
    }
}