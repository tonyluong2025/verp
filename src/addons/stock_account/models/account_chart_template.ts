import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class AccountChartTemplate extends Model {
    static _module = module;
    static _parents = "account.chart.template";

    @api.model()
    async generateJournals(accTemplateRef, company, journalsDict?: any) {
        const journalToAdd = [{'label': await this._t('Inventory Valuation'), 'type': 'general', 'code': 'STJ', 'favorite': false, 'sequence': 8}];
        return await _super(AccountChartTemplate, this).generateJournals(accTemplateRef, company, journalToAdd);
    }

    async generateProperties(accTemplateRef, company, propertyList?: any) {
        const res = await _super(AccountChartTemplate, this).generateProperties(accTemplateRef, company);
        const propertyObj = this.env.items('ir.property');  // Property Stock Journal
        const value = await this.env.items('account.journal').search([['companyId', '=', company.id], ['code', '=', 'STJ'], ['type', '=', 'general']], {limit: 1});
        if (bool(value)) {
            await propertyObj._setDefault("propertyStockJournal", "product.category", value, company);
        }

        const todoList = [  // Property Stock Accounts
            'propertyStockAccountInputCategId',
            'propertyStockAccountOutputCategId',
            'propertyStockValuationAccountId',
        ];
        const categValues = Object.fromEntries(await (await this.env.items('product.category').search([])).map(category => [category.id, false]));
        for (const field of todoList) {
            const account = await this[field];
            const value = bool(account) ? accTemplateRef.get(account).id : false;
            await propertyObj._setDefault(field, "product.category", value, company);
            await propertyObj._setMulti(field, "product.category", categValues, true);
        }
        return res;
    }
}