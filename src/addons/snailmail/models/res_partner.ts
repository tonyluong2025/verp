import { api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { SNAILMAIL_COUNTRIES } from "../country_utils";

@MetaModel.define()
class ResPartner extends Model {
  static _module = module;
  static _parents = "res.partner";

  async write(vals) {
    const letterAddressVals = {};
    const addressFields = ['street', 'street2', 'city', 'zip', 'stateId', 'countryId'];
    for (const field of addressFields) {
      if (field in vals) {
        letterAddressVals[field] = vals[field];
      }
    }
    if (letterAddressVals) {
      const letters = await this.env.items('snailmail.letter').search([
        ['state', 'not in', ['sent', 'canceled']],
        ['partnerId', 'in', this.ids],
      ]);
      await letters.write(letterAddressVals);
    }
    return _super(ResPartner, this).write(vals);
  }

  async _getCountryName() {
    // when sending a letter, thus rendering the report with the snailmail_layout,
    // we need to override the country name to its english version following the
    // dictionary imported in country_utils.js
    const countryCode = await (await this['countryId']).code;
    if (this.env.context['snailmailLayout'] && countryCode in SNAILMAIL_COUNTRIES) {
      return SNAILMAIL_COUNTRIES[countryCode];
    }

    return _super(ResPartner, this)._getCountryName();
  }

  @api.model()
  async _getAddressFormat() {
    // When sending a letter, the fields 'street' and 'street2' should be on a single line to fit in the address area
    if (this.env.context['snailmailLayout'] && await this['street2']) {
      return "{street}, {street2}\n{city} {stateCode} {zip}\n{countryName}";
    }

    return _super(ResPartner, this)._getAddressFormat();
  }
}