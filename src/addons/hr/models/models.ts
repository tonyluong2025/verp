import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { decodeMessageHeader, emailSplit } from "../../../core/tools";

@MetaModel.define()
class BaseModel extends AbstractModel {
    static _module = module;
    static _parents = 'base';

    async _aliasGetErrorMessage(message, messageDict, alias) {
        if (await alias.aliasContact === 'employees') {
            const emailFrom = await decodeMessageHeader(message, 'From');
            const emailAddress = emailSplit(emailFrom)[0];
            let employee = await this.env.items('hr.employee').search([['workEmail', 'ilike', emailAddress]], { limit: 1 });
            if (!employee.ok) {
                employee = await this.env.items('hr.employee').search([['userId.email', 'ilike', emailAddress]], { limit: 1 });
            }
            if (!employee.ok) {
                return this._t('restricted to employees');
            }
            return false;
        }
        return _super(BaseModel, this)._aliasGetErrorMessage(message, messageDict, alias);
    }
}
