import _ from "lodash"
import { api } from "../../../core"
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ResUsers extends Model {
    static _module = module;
    static _parents = 'res.users'

    @api.model()
    async webCreateUsers(emails: string[]) {

        // Reactivate already existing users if needed
        const deactivatedUsers = await (await (this as any).withContext({activeTest: false})).search([['active', '=', false], '|', ['login', 'in', emails], ['email', 'in', emails]]);
        for (const user of deactivatedUsers) {
            await user.set('active', true);
        }

        const newEmails = _.difference(emails, await deactivatedUsers.mapped('email'));

        // Process new email addresses : create new users
        for (const email of newEmails) {
            const defaultValues = {'login': email, 'label': email.split('@')[0], 'email': email, 'active': true}
            const user = await (await (this as any).withContext({signupValid: true})).create(defaultValues);
        }

        return true;
    }
}