import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { update } from "../../../core/tools";

@MetaModel.define()
class ChangeLockDate extends TransientModel {
    static _module = module;
    static _name = 'change.lock.date';
    static _description = 'Change Lock Date';

    @api.model()
    async defaultGet(vals) {
        const res = await _super(ChangeLockDate, this).defaultGet(vals);
        const companyRec = await (await this.env.user()).companyId;
        update(res, {
            'companyId': companyRec.id,
            'periodLockDate': await companyRec.periodLockDate,
            'fiscalyearLockDate': await companyRec.fiscalyearLockDate,
            'taxLockDate': await companyRec.taxLockDate,
        })
        return res;
    }

    static companyId = Fields.Many2one('res.company', {string: "Company",
                                 required: true, default: async (self)=> (await self.env.user()).companyId});
    static periodLockDate = Fields.Date({string: 'Journal Entries Lock Date',
                                   default: async (self) => (await (await self.env.user()).companyId).periodLockDate,
                                   help: 'Prevent posting of journal entries in this period.'});
    static fiscalyearLockDate = Fields.Date({string: 'Lock Date for All Users',
                                       default: async (self) => (await (await self.env.user()).companyId).fiscalyearLockDate,
                                       help: 'No users, including Advisers, can edit accounts prior to and inclusive of this date. Use it for fiscal year locking.'});
    static taxLockDate = Fields.Date("Tax Lock Date", {help: "No users can edit journal entries related to a tax prior and inclusive of this date."});

    async updateLockDate() {
        this.ensureOne();
        const hasManagerGroup = await (await this.env.user()).hasGroup('account.groupAccountManager');
        if (! (hasManagerGroup || this.env.uid == global.SUPERUSER_ID)) {
            throw new UserError(await this._t("You Are Not Allowed To Perform This Operation"));
        }
        await (await (await this['companyId']).sudo()).write({
            'periodLockDate': await this['periodLockDate'],
            'fiscalyearLockDate': await this['fiscalyearLockDate'],
            'taxLockDate': await this['taxLockDate'],
        })
    }
}