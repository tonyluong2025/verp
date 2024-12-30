import { Fields, _Date } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class HrDepartureWizard extends TransientModel {
    static _module = module;
    static _name = 'hr.departure.wizard';
    static _description = 'Departure Wizard';

    async _getDefaultDepartureDate() {
        let departureDate = false;
        if (this.env.context['activeId']) {
            departureDate = await this.env.items('hr.employee').browse(this.env.context['activeId']).departureDate;
        }
        return departureDate || _Date.today();
    }

    static departureReasonId = Fields.Many2one("hr.departure.reason", { default: self => self.env.items('hr.departure.reason').search([], { limit: 1 }), required: true });
    static departureDescription = Fields.Html({ string: "Additional Information" });
    static departureDate = Fields.Date({ string: "Departure Date", required: true, default: self => self._getDefaultDepartureDate() });
    static employeeId = Fields.Many2one(
        'hr.employee', {
            string: 'Employee', required: true,
        default: self => self.env.context['activeId'] ?? null,
    });
    static archivePrivateAddress = Fields.Boolean('Archive Private Address', { default: true });

    async actionRegisterDeparture() {
        const employee = await this['employeeId'];
        if ((this.env.context['toggleActive'] ?? false) && await employee.active) {
            await (await employee.withContext({ noWizard: true })).toggleActive();
        }
        await employee.update(await this.getDict('departureReasonId', 'departureDescription', 'departureDate'));
        if (await this['archivePrivateAddress']) {
            // ignore contact links to internal users
            let privateAddress = await employee.addressHomeId;
            if (bool(privateAddress) && await privateAddress.active && !bool(await this.env.items('res.users').search([['partnerId', '=', privateAddress.id]]))) {
                await privateAddress.toggleActive();
            }
        }
    }
}
