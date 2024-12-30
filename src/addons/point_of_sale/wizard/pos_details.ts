import { Fields, _Datetime, api } from "../../../core";
import { MetaModel, TransientModel } from "../../../core/models"
import { dateMin } from "../../../core/tools";

@MetaModel.define()
class PosDetails extends TransientModel {
    static _module = module;
    static _name = 'pos.details.wizard';
    static _description = 'Point of Sale Details Report';

    /**
     * Find the earliest start_date of the latests sessions
     * @returns 
     */
    async _defaultStartDate() {
        // restrict to configs available to the user
        const configIds = (await this.env.items('pos.config').search([])).ids;
        // exclude configs has not been opened for 2 days
        const res = await this.env.cr.execute(`
            SELECT
            max("startAt") as start,
            "configId"
            FROM "posSession"
            WHERE "configId" IN (%s)
            AND "startAt" > (NOW() - INTERVAL '2 DAYS')
            GROUP BY "configId"
        `, [String(configIds) || 'NULL']);
        const latestStartDates = res.map(row => row['start']);
        // earliest of the latest sessions
        return latestStartDates.length && dateMin(latestStartDates) || _Datetime.now();
    }

    static startDate = Fields.Datetime({required: true, default: self => self._defaultStartDate()});
    static endDate = Fields.Datetime({required: true, default: self => _Datetime.now()});
    static posConfigIds = Fields.Many2many('pos.config', {string: 'Pos detail configs',
        default: self => self.env.items('pos.config').search([])});

    @api.onchange('startDate')
    async _onchangeStartDate() {
        const [startDate, endDate] = await this('startDate', 'endDate');
        if (startDate && endDate && endDate < startDate) {
            await this.set('endDate', startDate);
        }
    }

    @api.onchange('endDate')
    async _onchangeEndDate() {
        const [startDate, endDate] = await this('startDate', 'endDate');
        if (startDate && endDate && endDate < startDate) {
            await this.set('startDate', endDate);
        }
    }

    async generateReport() {
        const data = {'dateStart': await this['startDate'], 'dateStop': await this['endDate'], 'configIds': (await this['posConfigIds']).ids}
        return (await this.env.ref('point_of_sale.saleDetailsReport')).reportAction([], data);
    }
}
