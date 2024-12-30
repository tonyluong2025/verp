import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class ResCompany extends Model {
    static _module = module;
    static _parents = 'res.company';

    static pointOfSaleUpdateStockQuantities = Fields.Selection([
            ['closing', 'At the session closing (recommended)'],
            ['real', 'In real time'],
            ], {default: 'closing', string: "Update quantities in stock",
            help: "At the session closing: A picking is created for the entire session when it's closed\n In real time: Each order sent to the server create its own picking"});

    /**
     * This constrains makes it impossible to change the period lock date if
        some open POS session exists into it. Without that, these POS sessions
        would trigger an error message saying that the period has been locked when
        trying to close them.
     */
    @api.constrains('periodLockDate', 'fiscalyearLockDate')
    async validatePeriodLockDate() {
        const posSessionModel = await this.env.items('pos.session').sudo();
        for (const record of this) {
            const sessionsInPeriod = await posSessionModel.search(
                [
                    "&",
                    "&",
                    ["companyId", "=", record.id],
                    ["state", "!=", "closed"],
                    "|",
                    ["startAt", "<=", await record.periodLockDate],
                    ["startAt", "<=", await record.fiscalyearLockDate],
                ]
            );
            if (bool(sessionsInPeriod)) {
                const sessionsStr = (await sessionsInPeriod.mapped('label')).join(', ');
                throw new ValidationError(await this._t("Please close all the point of sale sessions in this period before closing it. Open sessions are: %s ", sessionsStr));
            }
        }
    }
}