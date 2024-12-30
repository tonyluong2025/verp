import https from 'https';
import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { b64encode, base64ToImage } from "../../../core/tools/image";
import { len } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";
import { pop, update } from "../../../core/tools/misc";
import { URI } from "../../../core/tools/uri";

const PARTNER_AC_TIMEOUT = 5;

@MetaModel.define()
class ResPartner extends Model {
    static _module = module;
    static _name = 'res.partner';
    static _parents = 'res.partner';

    static partnerGid = Fields.Integer('Company database ID');
    static additionalInfo = Fields.Char('Additional info');

    @api.model()
    async _iapReplaceLocationCodes(iapData) {
        const [countryCode, countryName] = [pop(iapData, 'countryCode', false), pop(iapData, 'countryName', false)];
        const [stateCode, stateName] = [pop(iapData, 'stateCode', false), pop(iapData, 'stateName', false)];

        let [country, state] = [null, null];
        if (countryCode) {
            country = await this.env.items('res.country').search([['code', '=ilike', countryCode]]);
        }
        if (! bool(country) && countryName) {
            country = await this.env.items('res.country').search([['label', '=ilike', countryName]]);
        }
        
        if (bool(country)) {
            if (stateCode) {
                state = await this.env.items('res.country.state').search([
                    ['countryId', '=', country.id], ['code', '=ilike', stateCode]
                ], {limit: 1});
            }
            if (! bool(state) && stateName) {
                state = await this.env.items('res.country.state').search([
                    ['countryId', '=', country.id], ['label', '=ilike', stateName]
                ], {limit: 1});
            }
        }
        else {
            console.info('Country code not found: %s', countryCode);
        }

        if (bool(country)) {
            iapData['countryId'] = {'id': country.id, 'displayName': await country.displayName};
        }
        if (bool(state)) {
            iapData['stateId'] = {'id': state.id, 'displayName': await state.displayName}
        }

        return iapData;
    }

    @api.model()
    async _iapReplaceLogo(iapData) {
        if (iapData['logo']) {
            try {
                const uri = new URI(iapData['logo']);
                uri.timeout = PARTNER_AC_TIMEOUT; 
                let request = https.get(uri, (res) => {
                    if (res.statusCode !== 200) {
                        console.error(`Did not get an OK from the server. Code: ${res.statusCode}`);
                        res.resume();
                        return;
                    }

                    let data = '';
                    res.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    res.on('close', () => {
                        iapData['image1920'] = b64encode(data);
                    });
                });
                
            } catch(e) {
                iapData['image1920'] = false;
            }
            finally {
                pop(iapData, 'logo');
            }
            // avoid keeping falsy images (may happen that a blank page is returned that leads to an incorrect image)
            if (iapData['image1920']) {
                try {
                    base64ToImage(iapData['image1920']);
                } catch(e) {
                    pop(iapData, 'image1920');
                }
            }
        }
        return iapData;
    }

    @api.model()
    async _formatDataCompany(iapData) {
        await this._iapReplaceLocationCodes(iapData);

        if (iapData['childIds']) {
            const childIds = [];
            for (const child of iapData['childIds']) {
                childIds.push(await this._iapReplaceLocationCodes(child));
            }
            iapData['childIds'] = childIds;
        }
        if (iapData['additionalInfo']) {
            iapData['additionalInfo'] = stringify(iapData['additionalInfo']);
        }
        return iapData;
    }

    @api.model()
    async autocomplete(query, timeout: number=15) {
        const [suggestions] = await this.env.items('iap.autocomplete.api')._requestPartnerAutocomplete('search', {
            'query': query,
        }, timeout);
        if (bool(suggestions)) {
            const results = [];
            for (const suggestion of suggestions) {
                results.push(await this._formatDataCompany(suggestion));
            }
            return results;
        }
        else {
            return [];
        }
    }

    @api.model()
    async enrichCompany(companyDomain, partnerGid, vat, timeout=15) {
        const [response, error] = await this.env.items('iap.autocomplete.api')._requestPartnerAutocomplete('enrich', {
            'domain': companyDomain,
            'partnerGid': partnerGid,
            'vat': vat,
        }, timeout);
        let result;
        if (response && response.get('companyData')) {
            result = await this._formatDataCompany(response.get('companyData'));
        }
        else {
            result = {}
        }

        if (response && response.get('creditError')) {
            update(result, {
                'error': true,
                'errorMessage': 'Insufficient Credit'
            });
        }
        else if (error) {
            update(result, {
                'error': true,
                'errorMessage': error
            });
        }

        return result;
    }

    @api.model()
    async readByVat(vat, timeout=15) {
        const [viesVatData] = await this.env.items('iap.autocomplete.api')._requestPartnerAutocomplete('searchVat', {
            'vat': vat,
        }, timeout);
        if (bool(viesVatData)) {
            return [await this._formatDataCompany(viesVatData)];
        }
        else {
            return [];
        }
    }

    @api.model()
    async _isCompanyInEurope(countryCode) {
        const country = await this.env.items('res.country').search([['code', '=ilike', countryCode]]);
        if (bool(country)) {
            const countryId = country.id;
            let europe = await this.env.ref('base.europe');
            if (! bool(europe)) {
                europe = await this.env.items("res.country.group").search([['label', '=', 'Europe']], {limit: 1});
            }
            if (! bool(europe) || !(await europe.countryIds).ids.includes(countryId)) {
                return false;
            }
        }
        return true;
    }

    async _isVatSyncable(vat) {
        const vatCountryCode = vat.slice(0, 2);
        const countryId = await this['countryId'];
        const partnerCountryCode = countryId.ok ? await countryId.code : '';
        return await this._isCompanyInEurope(vatCountryCode) && (partnerCountryCode === vatCountryCode || ! partnerCountryCode);
    }

    async _isSynchable() {
        const alreadySynched = await this.env.items('res.partner.autocomplete.sync').search([['partnerId', '=', this.id], ['synched', '=', true]]);
        return await this['isCompany'] && bool(await this['partnerGid']) && ! bool(alreadySynched);
    }

    async _updateAutocompleteData(vat) {
        this.ensureOne();
        if (vat && await this._isSynchable() && await this._isVatSyncable(vat)) {
            await (await this.env.items('res.partner.autocomplete.sync').sudo()).addToQueue(this.id);
        }
    }

    @api.modelCreateMulti()
    async create(valsList) {
        const partners = await _super(ResPartner, this).create(valsList);
        if (len(valsList) == 1) {
            await partners._updateAutocompleteData(valsList[0]['vat'] ?? false);
            if (bool(await partners.additionalInfo)) {
                const templateValues = JSON.parse(await partners.additionalInfo);
                templateValues['flavorText'] = await this._t("Partner created by Verp Partner Autocomplete Service");
                await partners.messagePostWithView(
                    'iap_mail.enrichCompany',
                    {values: templateValues,
                    subtypeId: (await this.env.ref('mail.mtNote')).id,
                });
                await partners.write({'additionalInfo': false});
            }
        }
        return partners;
    }

    async write(values) {
        const res = await _super(ResPartner, this).write(values);
        if (len(this) == 1) {
            await this._updateAutocompleteData(values['vat'] ?? false);
        }
        return res;
    }
}