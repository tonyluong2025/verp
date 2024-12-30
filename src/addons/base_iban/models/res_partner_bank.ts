import { api } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { isInstance } from "../../../core/tools/func";
import { len, range } from "../../../core/tools/iterable";

function normalizeIban(iban: string): string {
    return (iban || '').replace(/[\W_]/gm, '');
}

/**
 * return iban in groups of four characters separated by a single space
 * @param iban 
 * @returns 
 */
async function prettyIban(model, iban: string): Promise<string> {
    try {
        await validateIban(model, iban);
        iban = Array.from(range(0, len(iban), 4)).map(i => iban.slice(i, i + 4)).join(' ');
    } catch(e) {
        if (!isInstance(e, ValidationError)) {
            throw e;
        }
    }
    return iban;
}

/**
 * Returns the basic bank account number corresponding to an IBAN.
        Note : the BBAN is not the same as the domestic bank account number !
        The relation between IBAN, BBAN and domestic can be found here : http://www.ecbs.org/iban.htm
 * @param iban 
 * @returns 
 */
function getBbanFromIban(iban: string): string {
    return normalizeIban(iban).slice(4);
}

async function validateIban(model, iban: string): Promise<void> {
    iban = normalizeIban(iban);
    if (! iban) {
        throw new ValidationError(await model._t("There is no IBAN code."));
    }

    const countryCode = iban.slice(0,2).toLowerCase();
    if (!(countryCode in _mapIbanTemplate)) {
        throw new ValidationError(await model._t("The IBAN is invalid, it should begin with the country code"));
    }

    const ibanTemplate = _mapIbanTemplate[countryCode];
    if (len(iban) != len(ibanTemplate.replace(' ', '')) || !iban.match(/^[a-zA-Z0-9]+$/)) {
        throw new ValidationError(await model._t("The IBAN does not seem to be correct. You should have entered something like this %s\nWhere B = National bank code, S = Branch code, C = Account No, k = Check digit", ibanTemplate));
    }

    const checkChars = [iban.slice(4), iban.slice(0,4)];
    const digits = parseInt(checkChars.map(char => String(parseInt(char, 36))).join(''));  // BASE 36: 0..9,A..Z -> 0..35
    if (digits % 97 != 1) {
        throw new ValidationError(await model._t("This IBAN does not pass the validation check, please verify it."));
    }
}

@MetaModel.define()
class ResPartnerBank extends Model {
    static _module = module;
    static _parents = "res.partner.bank";

    @api.model()
    async _getSupportedAccountTypes() {
        const rslt = await _super(ResPartnerBank, this)._getSupportedAccountTypes();
        rslt.push(['iban', await this._t('IBAN')]);
        return rslt;
    }
    
    @api.model()
    async retrieveAccType(accNumber) {
        try {
            await validateIban(this, accNumber);
            return 'iban';
        } catch(e) {
            if (isInstance(e, ValidationError)) {
                return _super(ResPartnerBank, this).retrieveAccType(accNumber);
            }
            throw e;
        }
    }

    async getBban() {
        if (await this['accType'] !== 'iban') {
            throw new UserError(await this._t("Cannot compute the BBAN because the account number is not an IBAN."));
        }
        return getBbanFromIban(await this['accNumber']);
    }

    @api.modelCreateMulti()
    async create(valsList) {
        for (const vals of valsList) {
            if (vals['accNumber']) {
                try {
                    await validateIban(this, vals['accNumber']);
                    vals['accNumber'] = await prettyIban(this, normalizeIban(vals['accNumber']));
                } catch(e) {
                    if (!isInstance(e, ValidationError)) {
                        throw e;
                    }
                }
            }
        }
        return _super(ResPartnerBank, this).create(valsList);
    }

    async write(vals) {
        if (vals['accNumber']) {
            try {
                await validateIban(this, vals['accNumber']);
                vals['accNumber'] = await prettyIban(this, normalizeIban(vals['accNumber']));
            } catch(e) {
                if (!isInstance(e, ValidationError)) {
                    throw e;
                }
            }
        }
        return _super(ResPartnerBank, this).write(vals);
    }

    @api.constrains('accNumber')
    async _checkIban() {
        for (const bank of this) {
            if (await bank.accType === 'iban') {
                await validateIban(this, await bank.accNumber);
            }
        }
    }

    async checkIban(iban='') {
        try {
            await validateIban(this, iban);
            return true;
        } catch(e) {
            if (isInstance(e, ValidationError)) {
                return false;
            }
            throw e;
        }
    }
}

// Map ISO 3166-1 -> IBAN template, as described here :
// http://en.wikipedia.org/wiki/International_Bank_Account_Number//IBAN_formats_by_country
const _mapIbanTemplate = {
    'ad': 'ADkk BBBB SSSS CCCC CCCC CCCC',  // Andorra
    'ae': 'AEkk BBBC CCCC CCCC CCCC CCC',  // United Arab Emirates
    'al': 'ALkk BBBS SSSK CCCC CCCC CCCC CCCC',  // Albania
    'at': 'ATkk BBBB BCCC CCCC CCCC',  // Austria
    'az': 'AZkk BBBB CCCC CCCC CCCC CCCC CCCC',  // Azerbaijan
    'ba': 'BAkk BBBS SSCC CCCC CCKK',  // Bosnia and Herzegovina
    'be': 'BEkk BBBC CCCC CCXX',  // Belgium
    'bg': 'BGkk BBBB SSSS DDCC CCCC CC',  // Bulgaria
    'bh': 'BHkk BBBB CCCC CCCC CCCC CC',  // Bahrain
    'br': 'BRkk BBBB BBBB SSSS SCCC CCCC CCCT N',  // Brazil
    'by': 'BYkk BBBB AAAA CCCC CCCC CCCC CCCC',  // Belarus
    'ch': 'CHkk BBBB BCCC CCCC CCCC C',  // Switzerland
    'cr': 'CRkk BBBC CCCC CCCC CCCC CC',  // Costa Rica
    'cy': 'CYkk BBBS SSSS CCCC CCCC CCCC CCCC',  // Cyprus
    'cz': 'CZkk BBBB SSSS SSCC CCCC CCCC',  // Czech Republic
    'de': 'DEkk BBBB BBBB CCCC CCCC CC',  // Germany
    'dk': 'DKkk BBBB CCCC CCCC CC',  // Denmark
    'do': 'DOkk BBBB CCCC CCCC CCCC CCCC CCCC',  // Dominican Republic
    'ee': 'EEkk BBSS CCCC CCCC CCCK',  // Estonia
    'es': 'ESkk BBBB SSSS KKCC CCCC CCCC',  // Spain
    'fi': 'FIkk BBBB BBCC CCCC CK',  // Finland
    'fo': 'FOkk CCCC CCCC CCCC CC',  // Faroe Islands
    'fr': 'FRkk BBBB BGGG GGCC CCCC CCCC CKK',  // France
    'gb': 'GBkk BBBB SSSS SSCC CCCC CC',  // United Kingdom
    'ge': 'GEkk BBCC CCCC CCCC CCCC CC',  // Georgia
    'gi': 'GIkk BBBB CCCC CCCC CCCC CCC',  // Gibraltar
    'gl': 'GLkk BBBB CCCC CCCC CC',  // Greenland
    'gr': 'GRkk BBBS SSSC CCCC CCCC CCCC CCC',  // Greece
    'gt': 'GTkk BBBB MMTT CCCC CCCC CCCC CCCC',  // Guatemala
    'hr': 'HRkk BBBB BBBC CCCC CCCC C',  // Croatia
    'hu': 'HUkk BBBS SSSC CCCC CCCC CCCC CCCC',  // Hungary
    'ie': 'IEkk BBBB SSSS SSCC CCCC CC',  // Ireland
    'il': 'ILkk BBBS SSCC CCCC CCCC CCC',  // Israel
    'is': 'ISkk BBBB SSCC CCCC XXXX XXXX XX',  // Iceland
    'it': 'ITkk KBBB BBSS SSSC CCCC CCCC CCC',  // Italy
    'jo': 'JOkk BBBB NNNN CCCC CCCC CCCC CCCC CC',  // Jordan
    'kw': 'KWkk BBBB CCCC CCCC CCCC CCCC CCCC CC',  // Kuwait
    'kz': 'KZkk BBBC CCCC CCCC CCCC',  // Kazakhstan
    'lb': 'LBkk BBBB CCCC CCCC CCCC CCCC CCCC',  // Lebanon
    'li': 'LIkk BBBB BCCC CCCC CCCC C',  // Liechtenstein
    'lt': 'LTkk BBBB BCCC CCCC CCCC',  // Lithuania
    'lu': 'LUkk BBBC CCCC CCCC CCCC',  // Luxembourg
    'lv': 'LVkk BBBB CCCC CCCC CCCC C',  // Latvia
    'mc': 'MCkk BBBB BGGG GGCC CCCC CCCC CKK',  // Monaco
    'md': 'MDkk BBCC CCCC CCCC CCCC CCCC',  // Moldova
    'me': 'MEkk BBBC CCCC CCCC CCCC KK',  // Montenegro
    'mk': 'MKkk BBBC CCCC CCCC CKK',  // Macedonia
    'mr': 'MRkk BBBB BSSS SSCC CCCC CCCC CKK',  // Mauritania
    'mt': 'MTkk BBBB SSSS SCCC CCCC CCCC CCCC CCC',  // Malta
    'mu': 'MUkk BBBB BBSS CCCC CCCC CCCC CCCC CC',  // Mauritius
    'nl': 'NLkk BBBB CCCC CCCC CC',  // Netherlands
    'no': 'NOkk BBBB CCCC CCK',  // Norway
    'pk': 'PKkk BBBB CCCC CCCC CCCC CCCC',  // Pakistan
    'pl': 'PLkk BBBS SSSK CCCC CCCC CCCC CCCC',  // Poland
    'ps': 'PSkk BBBB XXXX XXXX XCCC CCCC CCCC C',  // Palestinian
    'pt': 'PTkk BBBB SSSS CCCC CCCC CCCK K',  // Portugal
    'qa': 'QAkk BBBB CCCC CCCC CCCC CCCC CCCC C',  // Qatar
    'ro': 'ROkk BBBB CCCC CCCC CCCC CCCC',  // Romania
    'rs': 'RSkk BBBC CCCC CCCC CCCC KK',  // Serbia
    'sa': 'SAkk BBCC CCCC CCCC CCCC CCCC',  // Saudi Arabia
    'se': 'SEkk BBBB CCCC CCCC CCCC CCCC',  // Sweden
    'si': 'SIkk BBSS SCCC CCCC CKK',  // Slovenia
    'sk': 'SKkk BBBB SSSS SSCC CCCC CCCC',  // Slovakia
    'sm': 'SMkk KBBB BBSS SSSC CCCC CCCC CCC',  // San Marino
    'tn': 'TNkk BBSS SCCC CCCC CCCC CCCC',  // Tunisia
    'tr': 'TRkk BBBB BRCC CCCC CCCC CCCC CC',  // Turkey
    'ua': 'UAkk BBBB BBCC CCCC CCCC CCCC CCCC C',  // Ukraine
    'vg': 'VGkk BBBB CCCC CCCC CCCC CCCC',  // Virgin Islands
    'xk': 'XKkk BBBB CCCC CCCC CCCC',  // Kosovo
}
