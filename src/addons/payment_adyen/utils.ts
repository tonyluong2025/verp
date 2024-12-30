import { UserError } from "../../core/helper";
import { _t, rpartition, split } from "../../core/tools";
import { splitPartnerName } from "../payment/utils"

/**
 * Format the partner name to comply with the payload structure of the API request.

    :param str partner_name: The name of the partner making the payment.
    :return: The formatted partner name.
    :rtype: dict
 * @param partnerName 
 * @returns 
 */
export function formatPartnerName(partnerName) {
    const [firstName, lastName] = splitPartnerName(partnerName);
    return {
        'firstName': firstName,
        'lastName': lastName,
    }
}

/**
 * Include the billing and delivery addresses of the related sales order to the payload of the
    API request.

    If no related sales order exists, the addresses are not included.

    Note: `this.ensureOne()`

    :param payment.transaction txSudo: The sudoed transaction of the payment.
    :return: The subset of the API payload that includes the billing and delivery addresses.
    :rtype: dict
 * @param txSudo 
 * @returns 
 */
export async function includePartnerAddresses(txSudo) {
    txSudo.ensureOne();

    if ('saleOrderIds' in txSudo._fields) {  // The module `sale` is installed.
        const order = (await txSudo.saleOrderIds).slice(0, 1);
        if (order.ok) {
            return {
                'billingAddress': await formatPartnerAddress(await order.partnerInvoiceId),
                'deliveryAddress': await formatPartnerAddress(await order.partnerShippingId),
            }
        }
    }
    return {}
}

/**
 * Format the partner address to comply with the payload structure of the API request.

    :param res.partner partner: The partner making the payment.
    :return: The formatted partner address.
    :rtype: dict
 * @param partner 
 * @returns 
 */
export async function formatPartnerAddress(partner) {
    const STREET_FORMAT = '{streetNumber}/{streetNumber2} {streetName}';
    const streetData = splitStreetWithParams(await partner.street, STREET_FORMAT);
    return {
        'city': await partner.city,
        'country': await (await partner.countryId).code || 'ZZ',  // 'ZZ' if the country is not known.
        'stateOrProvince': await (await partner.stateId).code,
        'postalCode': await partner.zip,
        // Fill in the address fields if the format is supported, or fallback to the raw address.
        'street': streetData['streetName'] ?? await partner.street,
        'houseNumberOrName': streetData['streetNumber'],
    }
}

// The method is copy-pasted from `baseAddressExtended` with small modifications.
export async function splitStreetWithParams(streetRaw: string, streetFormat: string) {
    const streetFields = ['streetName', 'streetNumber', 'streetNumber2'];
    const vals = {};
    let previousPos = 0;
    let fieldName, previousGreedy;
    // iter on fields in streetFormat, detected as '{<fieldName>}'
    for (const reMatch of streetFormat.matchAll(/{\w+}/g, )) {
        const fieldPos = reMatch.index;
        if (!fieldName) {
            //first iteration: remove the heading chars
            streetRaw = streetRaw.slice(fieldPos);
        }
        // get the substring between 2 fields, to be used as separator
        const separator = streetFormat.slice(previousPos, fieldPos);
        let fieldValue;
        if (separator && fieldName) {
            // maxsplit set to 1 to unpack only the first element and let the rest untouched
            const tmp = split(streetRaw, separator, 1);
            if (previousGreedy in vals) {
                // attach part before space to preceding greedy field
                const [appendPrevious, sep, tmp0] = rpartition(tmp[0], ' ');
                tmp[0] = tmp0;
                streetRaw = tmp.join(separator);
                vals[previousGreedy] += sep + appendPrevious;
            }
            if (tmp.length == 2) {
                [fieldValue, streetRaw] = tmp;
                vals[fieldName] = fieldValue;
            }
        }
        if (fieldValue || !fieldName) {
            previousGreedy = null;
            if (fieldName === 'streetName' && separator === ' ') {
                previousGreedy = fieldName;
            }
            // select next field to find (first pass OR field found)
            // [1, -1] is used to remove the extra chars '{' and '}'
            fieldName = reMatch[0].slice(1, -1);
        }
        else {
            // value not found: keep looking for the same field
            // pass
        }
        if (!streetFields.includes(fieldName)) {
            throw new UserError(await _t("Unrecognized field %s in street format.", fieldName));
        }
        previousPos = reMatch.index + reMatch[0].length;
    }
    // last field value is what remains in streetRaw minus trailing chars in streetFormat
    const trailingChars = streetFormat.slice(previousPos);
    if (trailingChars && streetRaw.endsWith(trailingChars)) {
        vals[fieldName] = streetRaw.slice(0, -trailingChars.length);
    }
    else {
        vals[fieldName] = streetRaw;
    }
    return vals;
}