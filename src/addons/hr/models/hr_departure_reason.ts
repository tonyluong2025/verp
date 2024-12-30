import _ from "lodash";
import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class DepartureReason extends Model {
    static _module = module;
    static _name = "hr.departure.reason";
    static _description = "Departure Reason";
    static _order = "sequence";

    static sequence = Fields.Integer("Sequence", { default: 10 });
    static label = Fields.Char({ string: "Reason", required: true, translate: true });

    async _getDefaultDepartureReasons() {
        return {
            'fired': await this.env.ref('hr.departureFired', false),
            'resigned': await this.env.ref('hr.departureResigned', false),
            'retired': await this.env.ref('hr.departureRetired', false),
        }
    }

    @api.ondelete(false)
    async _unlinkExceptDefaultDepartureReasons() {
        const ids = Object.values(await this._getDefaultDepartureReasons()).map(a => a.id);
        if (_.intersection(this.ids, ids).length) {
            throw new UserError(await this._t('Default departure reasons cannot be deleted.'));
        }
    }
}