import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class AccountFiscalYear extends Model {
    static _module = module;
    static _name = 'account.fiscal.year';
    static _description = 'Fiscal Year';

    static label = Fields.Char({string: 'Name', required: true});
    static dateFrom = Fields.Date({string: 'Start Date', required: true,
        help: 'Start Date, included in the fiscal year.'});
    static dateTo = Fields.Date({string: 'End Date', required: true,
        help: 'Ending Date, included in the fiscal year.'});
    static companyId = Fields.Many2one('res.company', {string: 'Company', required: true,
        default: self => self.env.company()});

    /**
     * Check interleaving between fiscal years.
        There are 3 cases to consider:

        s2   s1   e2   e1
        [----(----]    )

        s1   s2   e1   e2
        (    [----)----]

        s2   s1   e1   e2
        (    [----]    )
     */
    @api.constrains('dateFrom', 'dateTo', 'companyId')
    async _checkDates() {
        for (const fy of this) {
            // Starting date must be prior to the ending date
            const [dateFrom, dateTo] = await fy('dateFrom', 'dateTo');
            if (dateTo < dateFrom) {
                throw new ValidationError(await this._t('The ending date must not be prior to the starting date.'));
            }
            const domain = [
                ['id', '!=', fy.id],
                ['companyId', '=', (await fy['companyId']).id],
                '|', '|',
                '&', ['dateFrom', '<=', dateFrom], ['dateTo', '>=', dateFrom],
                '&', ['dateFrom', '<=', dateTo], ['dateTo', '>=', dateTo],
                '&', ['dateFrom', '<=', dateFrom], ['dateTo', '>=', dateTo],
            ];
            if (await this.searchCount(domain) > 0) {
                throw new ValidationError(await this._t('You can not have an overlap between two fiscal years, please correct the start and/or end dates of your fiscal years.'));
            }
        }
    }
}