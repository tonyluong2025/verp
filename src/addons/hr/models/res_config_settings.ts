import { Fields, api } from "../../../core";
import { getattr } from "../../../core/api";
import { ValidationError } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
    static _module = module;
    static _parents = 'res.config.settings';

    static resourceCalendarId = Fields.Many2one(
        'resource.calendar', {
        string: 'Company Working Hours',
        related: 'companyId.resourceCalendarId', readonly: false
    });
    static moduleHrPresence = Fields.Boolean({ string: "Advanced Presence Control" });
    static moduleHrSkills = Fields.Boolean({ string: "Skills Management" });
    static hrPresenceControlLogin = Fields.Boolean({ string: "Based on user status in system", configParameter: 'hr.hrPresenceControlLogin' });
    static hrPresenceControlEmail = Fields.Boolean({ string: "Based on number of emails sent", configParameter: 'hr_presence.hrPresenceControlEmail' });
    static hrPresenceControlIp = Fields.Boolean({ string: "Based on IP Address", configParameter: 'hr_presence.hrPresenceControlIp' });
    static moduleHrAttendance = Fields.Boolean({ string: "Based on attendances" });
    static hrPresenceControlEmailAmount = Fields.Integer({ related: "companyId.hrPresenceControlEmailAmount", readonly: false });
    static hrPresenceControlIpList = Fields.Char({ related: "companyId.hrPresenceControlIpList", readonly: false });
    static hrEmployeeSelfEdit = Fields.Boolean({ string: "Employee Editing", configParameter: 'hr.hrEmployeeSelfEdit' });

    @api.constrains('moduleHrPresence', 'hrPresenceControlEmail', 'hrPresenceControlIp')
    async _checkAdvancedPresence() {
        const testMode = this.env.registry.inTestMode() || getattr(this.env, 'testing', false);
        if ((this.env.context['installMode'] ?? false) || testMode) {
            return;
        }

        for (const settings of this) {
            if (await settings.moduleHrPresence && !(await settings.hrPresenceControlEmail || await settings.hrPresenceControlIp)) {
                throw new ValidationError(await this._t('You should select at least one Advanced Presence Control option.'));
            }
        }
    }
}
