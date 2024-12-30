import { api } from "../../../core";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";
import * as phoneValidation from '../tools';

@MetaModel.define()
class Partner extends Model {
    static _module = module;
    static _name = 'res.partner';
    static _parents = ['res.partner'];

    @api.onchange('phone', 'countryId', 'companyId')
    async _onchangePhoneValidation() {
        if (await this['phone']) {
            await this.set('phone', await this._phoneFormat(await this['phone']));
        }
    }

    @api.onchange('mobile', 'countryId', 'companyId')
    async _onchangeMobileValidation() {
        if (await this['mobile']) {
            await this.set('mobile', await this._phoneFormat(await this['mobile']));
        }
    }

    async _phoneFormat(number, country?: any, company?: any) {
        country = bool(country) ? country : await this['countryId'];
        country = bool(country) ? country : await (await this.env.company()).countryId;
        if (!bool(country)) {
            return number;
        }
        return phoneValidation.phoneFormat(
            number,
            bool(country) ? await country.code : null,
            bool(country) ? await country.phoneCode : null,
            'INTERNATIONAL',
            false
        );
    }

    /**
     * Stand alone version, allowing to use it on partner model without
        having any dependency on sms module.
     * @param numberFname 
     * @param forceFormat 
     * @returns 
     */
    async phoneGetSanitizedNumber(numberFname='mobile', forceFormat='E164') {
        this.ensureOne();
        const countryFname = 'countryId';
        const number = await this[numberFname];
        return (await phoneValidation.phoneSanitizeNumbersWRecord([number], this, countryFname, forceFormat))[number]['sanitized'];
    }

    /**
     * Stand alone version, allowing to use it on partner model without
        having any dependency on sms module.
     * @returns 
     */
    _phoneGetNumberFields() {
        return ['mobile', 'phone'];
    }
}