import { Dict, NotImplementedError, UserError } from '../../../core/helper';
import { _f, _t, bool } from '../../../core/tools';
// import * as phonenumbers from 'libphonenumber-js';

global._phonenumbersLibWarning = false;

export let phoneParse: (number, countryCode) => Promise<string|boolean>;
export let phoneFormat: (number, countryCode, countryPhoneCode, forceFormat, raiseException) => Promise<string>;

try {
    const phonenumbers = require('libphonenumber-js');

    phoneParse = async function(number, countryCode) {
        let phoneNbr;
        try {
            phoneNbr = phonenumbers.parse(number, countryCode || null);
        } catch(e) {
        // except phonenumbers.phonenumberutil.NumberParseException as e:
            throw new UserError(_f(await _t('Unable to parse {phone}: {error}'), {phone: number, error: e}));
        }
        if (! phonenumbers.isPossibleNumber(phoneNbr)) {
            throw new UserError(await _t('Impossible number %s: probably invalid number of digits.', number));
        }
        if (! phonenumbers.isValidNumber(phoneNbr)) {
            throw new UserError(await _t('Invalid number %s: probably incorrect prefix.', number));
        }

        return phoneNbr;
    }

    /**
     * Format the given phone number according to the localisation and international options.
        @param number: number to convert
        @param countryCode: the ISO country code in two chars
        @param countryPhoneCode: country dial in codes, defined by the ITU-T (Ex: 32 for Belgium)
        @param forceFormat: stringified version of format globals (see
            'E164' = 0
            'INTERNATIONAL' = 1
            'NATIONAL' = 2
            'RFC3966' = 3
        @param raiseException 
        @returns 
     */
    phoneFormat = async function(number, countryCode, countryPhoneCode, forceFormat='INTERNATIONAL', raiseException=true) {
        let phoneNbr, phoneFmt;
        try {
            phoneNbr = await phoneParse(number, countryCode);
        } catch(e) {
            if (raiseException) {
                throw e;
            }
            else {
                return number;
            }
        }
        if (forceFormat === 'E164') {
            phoneFmt = 'E.164';
        }
        else if (forceFormat === 'RFC3966') {
            phoneFmt = 'RFC3966';
        }
        else if (forceFormat === 'INTERNATIONAL' || await phoneNbr.countryCode != countryPhoneCode) {
            phoneFmt = 'INTERNATIONAL';
        }
        else {
            phoneFmt = 'NATIONAL';
        }
        return phonenumbers.format(phoneNbr, phoneFmt);
    }
} catch(e) {
    phoneParse = async function(number, countryCode) {
        return false;
    }

    phoneFormat = async function(number, countryCode, countryPhoneCode, forceFormat='INTERNATIONAL', raiseException=true) {
        if (! global._phonenumbersLibWarning) {
            console.info(
                "The `libphonenumber` javascript lib is not installed, contact numbers will not be \
                verified. Please install the `npm install libphonenumber-js` nodejs module."
            )
            global._phonenumbersLibWarning = true;
        }
        return number;
    }
}

/**
 * Given a list of numbers, return parsezd and sanitized information

    @return dict: {'number': {
        'sanitized': sanitized and formated number or False (if cannot format)
        'code': 'empty' (number was a void string), 'invalid' (error) or False (sanitize ok)
        'msg': error message when 'invalid'
    }}
 * @param numbers 
 * @param countryCode 
 * @param countryPhoneCode 
 * @param forceFormat 
 * @returns 
 */
export async function phoneSanitizeNumbers(numbers, countryCode, countryPhoneCode, forceFormat='E164') {
    if (! Array.isArray(numbers)) {
        throw new NotImplementedError();
    }
    const result = Dict.fromKeys(numbers, false);
    for (const number of numbers) {
        if (!number) {
            result[number] = {'sanitized': false, 'code': 'empty', 'msg': false}
            continue;
        }
        let sanitized, err;
        try {
            const stripped = String(number).trim();
            sanitized = await phoneFormat(stripped, countryCode, countryPhoneCode, forceFormat, true)
        } catch(e) {
            err = e;
            result[number] = {'sanitized': false, 'code': 'invalid', 'msg': e.stack}
        }
        if (!err) {
            result[number] = {'sanitized': sanitized, 'code': false, 'msg': false}
        }
    }
    return result;
}

export async function phoneSanitizeNumbersWRecord(numbers, record, country?: any, recordCountryFname='countryId', forceFormat='E164') {
    if (! Array.isArray(numbers)) {
        throw new NotImplementedError();
    }
    if (! country) {
        if (bool(record) && recordCountryFname && recordCountryFname in record._fields && await record[recordCountryFname]) {
            country = await record[recordCountryFname];
        }
        else if (bool(record)) {
            country = await (await record.env.company()).countryId;
        }
    }
    const countryCode = bool(country) ? await country.code : null;
    const countryPhoneCode = bool(country) ? await country.phoneCode : null;
    return phoneSanitizeNumbers(numbers, countryCode, countryPhoneCode, forceFormat);
}