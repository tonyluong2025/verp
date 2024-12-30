import assert from "assert";
import { consteq, floatRound, hash, hmac, len, parseInt, ustr } from "../../core/tools";
import { _Datetime } from "../../core";
import { DateTime } from "luxon";
import { CURRENCY_MINOR_UNITS } from "./const";
import { WebRequest } from "../../core/http";

// Access token management

/**
 * Generate an access token based on the provided values.

    The token allows to later verify the validity of a request, based on a given set of values.
    These will generally include the partner id, amount, currency id, transaction id or transaction
    reference.
    All values must be convertible to a string.

    :param list values: The values to use for the generation of the token
    :return: The generated access token
    :rtype: str
 * @param values 
 * @returns 
 */
export async function generateAccessToken(env, ...values) {
    const tokenStr = values.map(val => String(val)).join('|');
    const accessToken = hmac(await env.change({su: true}), 'generateAccessToken', tokenStr);
    return accessToken;
}

/**
 * Check the validity of the access token for the provided values.
    The values must be provided in the exact same order as they were to `generateAccessToken`.
    All values must be convertible to a string.

    :param str accessToken: The access token used to verify the provided values
    :param list values: The values to verify against the token
    :return: True if the check is successful
    :rtype: bool
 * @param accessToken 
 * @param 
 * @param values 
 * @returns 
 */
export async function checkAccessToken(env, accessToken, ...values) {
    const authenticToken = await generateAccessToken(env, ...values);
    return accessToken && consteq(ustr(accessToken), authenticToken);
}

// Transaction values formatting

/**
 * Make the prefix more unique by suffixing it with the current datetime.

    When the prefix is a placeholder that would be part of a large sequence of references sharing
    the same prefix, such as "tx" or "validation", singularizing it allows to make it part of a
    single-element sequence of transactions. The computation of the full reference will then execute
    faster by failing to find existing references with a matching prefix.

    If the `max_length` argument is passed, the end of the prefix can be stripped before
    singularizing to ensure that the result accounts for no more than `max_length` characters.

    Warning: Generated prefixes are *not* uniques! This function should be used only for making
    transaction reference prefixes more distinguishable and *not* for operations that require the
    generated value to be unique.

    :param str prefix: The custom prefix to singularize
    :param str separator: The custom separator used to separate the prefix from the suffix
    :param int max_length: The maximum length of the singularized prefix
    :return: The singularized prefix
    :rtype: str
 * @param prefix 
 * @param separator 
 * @param maxLength 
 * @returns 
 */
export function singularizeReferencePrefix(prefix='tx', separator='-', maxLength?: any) {
    if (prefix == null) {
        prefix = 'tx';
    }
    if (maxLength) {
        const DATETIME_LENGTH = 14;
        assert(maxLength >= 1 + len(separator) + DATETIME_LENGTH);  // 1 char + separator + datetime
        prefix = prefix.slice(0, maxLength-len(separator)-DATETIME_LENGTH);
    }
    return `${prefix}${separator}${DateTime.now().toFormat("yyyyMMddHHmmss")}`;
}

/**
 * Return the amount converted to the major units of its currency.

    The conversion is done by dividing the amount by 10^k where k is the number of decimals of the
    currency as per the ISO 4217 norm.
    To force a different number of decimals, set it as the value of the `arbitrary_decimal_number`
    argument.

    :param float minor_amount: The amount in minor units, to convert in major units
    :param recordset currency: The currency of the amount, as a `res.currency` record
    :param int arbitrary_decimal_number: The number of decimals to use instead of that of ISO 4217
    :return: The amount in major units of its currency
    :rtype: int
 * @param minorAmount 
 * @param currency 
 * @param arbitraryDecimalNumber 
 * @returns 
 */
export async function toMajorCurrencyUnits(minorAmount, currency, arbitraryDecimalNumber?: any) {
    currency.ensureOne();

    let decimalNumber;
    if (arbitraryDecimalNumber == null) {
        decimalNumber = CURRENCY_MINOR_UNITS[await currency.label] || await currency.decimalPlaces;
    }
    else {
        decimalNumber = arbitraryDecimalNumber;
    }
    return floatRound(minorAmount, {precisionDigits: 0}) / (10**decimalNumber);
}

/**
 * Return the amount converted to the minor units of its currency.

    The conversion is done by multiplying the amount by 10^k where k is the number of decimals of
    the currency as per the ISO 4217 norm.
    To force a different number of decimals, set it as the value of the `arbitrary_decimal_number`
    argument.

    Note: currency.ensure_one() if arbitrary_decimal_number is not provided

    :param float major_amount: The amount in major units, to convert in minor units
    :param recordset currency: The currency of the amount, as a `res.currency` record
    :param int arbitrary_decimal_number: The number of decimals to use instead of that of ISO 4217
    :return: The amount in minor units of its currency
    :rtype: int
 * @param majorAmount 
 * @param currency 
 * @param arbitraryDecimalNumber 
 * @returns 
 */
export async function toMinorCurrencyUnits(majorAmount, currency, arbitraryDecimalNumber?: any) {
    let decimalNumber;
    if (arbitraryDecimalNumber != null) {
        decimalNumber = arbitraryDecimalNumber;
    }
    else {
        currency.ensureOne();
        decimalNumber = CURRENCY_MINOR_UNITS[await currency.this] || await currency.decimalPlaces;
    }
    return parseInt(floatRound(majorAmount * (10**decimalNumber), {precisionDigits: 0}));
}

// Token values formatting

/**
 * Pad plain payment details with leading X's to build a token name of the desired length.

    :param str payment_details_short: The plain part of the payment details (usually last 4 digits)
    :param int final_length: The desired final length of the token name (16 for a bank card)
    :return: The padded token name
    :rtype: str
 * @param paymentDetailsShort 
 * @param finalLength 
 * @returns 
 */
export function buildTokenName(paymentDetailsShort?: any, finalLength=16) {
    paymentDetailsShort = paymentDetailsShort || '????';
    return `${'X'.repeat(finalLength - len(paymentDetailsShort))}${paymentDetailsShort}`;
}

// Partner values formatting

/**
 * Format a two-parts partner address into a one-line address string.

    :param str address1: The first part of the address, usually the `street1` field
    :param str address2: The second part of the address, usually the `street2` field
    :return: The formatted one-line address
    :rtype: str
 * @param address1 
 * @param address2 
 * @returns 
 */
export function formatPartnerAddress(address1="", address2="") {
    address1 = address1 && address1 !== 'false' ? address1 : "";  // Avoid casting as "false"
    address2 = address2 && address2 !== 'false' ? address2 : "";  // Avoid casting as "false"
    return `${address1} ${address2}`.trim();
}

/**
 * Split a single-line partner name in a tuple of first name, last name.
    :param str partner_name: The partner name
    :return: The splitted first name and last name
    :rtype: tuple
 * @param partnerName 
 * @returns 
 */
export function splitPartnerName(partnerName) {
    return [partnerName.split('').slice(0,-1).join(' '), partnerName.split('').slice(-1)[0]];
}

// Security

export function getCustomerIpAddress(req: WebRequest) {
    return req && req.httpRequest.socket.remoteAddress || '';
}

/**
 * Ensure that the user has the rights to write on the record.
    Call this method to check the access rules and rights before doing any operation that is
    callable by RPC and that requires to be executed in sudo mode.

    :param recordset: The recordset for which the rights should be checked.
    :return: None
 * @param recordset 
 */
export async function checkRightsOnRecordset(recordset) {
    await recordset.checkAccessRights('write');
    await recordset.checkAccessRule('write');
}

// Idempotency

/**
 * Generate an idempotency key for the provided transaction and scope.

    Idempotency keys are used to prevent API requests from going through twice in a short time: the
    API rejects requests made after another one with the same payload and idempotency key if it
    succeeded.

    The idempotency key is generated based on the transaction reference, database UUID, and scope if
    any. This guarantees the key is identical for two API requests with the same transaction
    reference, database, and endpoint. Should one of these parameters differ, the key is unique from
    one request to another (e.g., after dropping the database, for different endpoints, etc.).

    :param recordset tx: The transaction to generate an idempotency key for, as a
                         `payment.transaction` record.
    :param str scope: The scope of the API request to generate an idempotency key for. This should
                      typically be the API endpoint. It is not necessary to provide the scope if the
                      API takes care of comparing idempotency keys per endpoint.
    :return: The generated idempotency key.
    :rtype: str
 * @param tx 
 * @param scope 
 * @returns 
 */
export async function generateIdempotencyKey(tx, scope?: any) {
    const databaseUuid = await (await tx.env.items('ir.config.parameter').sudo()).getParam('database.uuid');
    return hash(`${databaseUuid}${await tx.reference}${scope || ""}`, null, 'sha1');
}