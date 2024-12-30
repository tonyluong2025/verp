import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ResCountry extends Model {
    static _module = module;
    static _parents = 'res.country';

    async getWebsiteSaleCountries(mode='billing') {
        return (await this.sudo()).search([]);
    }

    async getWebsiteSaleStates(mode='billing') {
        return (await this.sudo()).stateIds;
    }
}
