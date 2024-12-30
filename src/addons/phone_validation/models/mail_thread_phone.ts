import _ from "lodash";
import { Fields, api } from "../../../core";
import { AccessError, Dict, NotImplementedError, UserError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { expression } from "../../../core/osv";
import { _f, len, quoteDouble } from "../../../core/tools";
import { phoneSanitizeNumbersWRecord } from "../tools";

/**
 * Purpose of this mixin is to offer two services

      * compute a sanitized phone number based on ´´_smsGetNumberFields´´.
        It takes first sanitized value, trying each field returned by the
        method (see ``MailThread._smsGetNumberFields()´´ for more details
        about the usage of this method);
      * compute blacklist state of records. It is based on phone.blacklist
        model and give an easy-to-use field and API to manipulate blacklisted
        records;

    Main API methods

      * ``_phoneSetBlacklisted``: set recordset as blacklisted;
      * ``_phoneResetBlacklisted``: reactivate recordset (even if not blacklisted
        this method can be called safely);
 */
@MetaModel.define()
class PhoneMixin extends AbstractModel {
    static _module = module;
    static _name = 'mail.thread.phone';
    static _description = 'Phone Blacklist Mixin';
    static _parents = ['mail.thread'];

    static phoneSanitized = Fields.Char(
        {string: 'Sanitized Number', compute: "_computePhoneSanitized", computeSudo: true, store: true,
        help: "Field used to store sanitized phone number. Helps speeding up searches and comparisons."});
    static phoneSanitizedBlacklisted = Fields.Boolean(
        {string: 'Phone Blacklisted', compute: "_computeBlacklisted", computeSudo: true, store: false,
        search: "_searchPhoneSanitizedBlacklisted", groups: "base.groupUser",
        help: "If the sanitized phone number is on the blacklist, the contact won't receive mass mailing sms anymore, from any list"});
    static phoneBlacklisted = Fields.Boolean(
        {string: 'Blacklisted Phone is Phone', compute: "_computeBlacklisted", computeSudo: true, store: false, groups: "base.groupUser",
        help: "Indicates if a blacklisted sanitized phone number is a phone number. Helps distinguish which number is blacklisted \
            when there is both a mobile and phone field in a model."});
    static mobileBlacklisted = Fields.Boolean(
        {string: 'Blacklisted Phone Is Mobile', compute: "_computeBlacklisted", computeSudo: true, store: false, groups: "base.groupUser",
        help: "Indicates if a blacklisted sanitized phone number is a mobile number. Helps distinguish which number is blacklisted \
            when there is both a mobile and phone field in a model."});
    static phoneMobileSearch = Fields.Char("Phone/Mobile", {store: false, search: '_searchPhoneMobileSearch'});

    async _searchPhoneMobileSearch(operator, value) {
        value = typeof(value)== 'string' ? value.trim() : value;
        const phoneFields = this._phoneGetNumberFields().filter(fname => fname in this._fields && this._fields[fname].store);
        if (! phoneFields.length) {
            throw new UserError(await this._t('Missing definition of phone Fields.'));
        }

        // search if phone/mobile is set or not
        if ((value == true || !value) && ['=', '!='].includes(operator)) {
            if (value) {
                // inverse the operator
                operator = operator === '!=' ? '=' : '!=';
            }
            const op = operator === '=' ? expression.AND : expression.OR;
            return op(phoneFields.map(phoneField => [[phoneField, operator, false]]));
        }

        if (len(value) < 3) {
            throw new UserError(await this._t('Please enter at least 3 characters when searching a Phone/Mobile number.'));
        }

        const pattern = new RegExp('[\s\\./\(\)\-]');
        const sqlOperator = {'=like': 'LIKE', '=ilike': 'ILIKE'}[operator] ?? operator;

        let res;
        if (value.startsWith('+') || value.startsWith('00')) {
            let whereStr;
            if (expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
                // searching on +32485112233 should also finds 0032485112233 (and vice versa)
                // we therefore remove it from input value and search for both of them in db
                whereStr = phoneFields.map(phoneField => _f(`model.{phoneField} IS NULL OR (
                        REGEXP_REPLACE(model.{phoneField}, '%s', '', 'g') {sqlOperator} '%s' OR
                        REGEXP_REPLACE(model.{phoneField}, '%s', '', 'g') {sqlOperator} '%s'
                )`, {phoneField: quoteDouble(phoneField), sqlOperator: sqlOperator})).join(' AND ');
            }
            else {
                // searching on +32485112233 should also finds 0032485112233 (and vice versa)
                // we therefore remove it from input value and search for both of them in db
                whereStr = phoneFields.map(phoneField => _f(`model.{phoneField} IS NOT NULL AND (
                            REGEXP_REPLACE(model.{phoneField}, '%s', '', 'g') {sqlOperator} '%s' OR
                            REGEXP_REPLACE(model.{phoneField}, '%s', '', 'g') {sqlOperator} '%s'
                    )`, {phoneField: quoteDouble(phoneField), sqlOperator: sqlOperator})).join(' OR ');
            }
            const query = `SELECT model.id FROM "${this.cls._table}" model WHERE ${whereStr};`;

            let term = value.slice(value.startsWith('+') ? 1 : 2).replace(pattern, '');
            if (!['=', '!='].includes(operator)) {  // for like operators
                term = `${term}%`;
            }
            res = await this._cr.execute(
                query, _.fill(Array(len(phoneFields)), [pattern, '00' + term, pattern, '+' + term]).flat()
            )
        }
        else {
            let whereStr;
            if (expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
                whereStr = phoneFields.map(phoneField => _f(`(model.{phoneField} IS NULL OR REGEXP_REPLACE(model.{phoneField}, '%s', '', 'g') {sqlOperator} '%s')`, {phoneField: quoteDouble(phoneField), sqlOperator: sqlOperator})).join(' AND ');
            }
            else {
                whereStr = phoneFields.map(phoneField => _f(`(model.{phoneField} IS NOT NULL AND REGEXP_REPLACE(model.{phoneField}, '%s', '', 'g') {sqlOperator} '%s')`, {phoneField: quoteDouble(phoneField), sqlOperator: sqlOperator})).join();
            }
            const query = `SELECT model.id FROM ${this.cls._table} model WHERE ${whereStr};`;
            let term = value.replace(pattern, '');
            if (!['=', '!='].includes(operator)) { // for like operators
                term = `%${term}%`;
            }
            res = await this._cr.execute(
                query, _.fill(Array(len(phoneFields)), [pattern, term]).flat()
            );
        }
        if (!len(res)) {
            return [[0, '=', 1]];
        }
        return [['id', 'in', res.map(r => r['id'])]];
    }
    
    @api.depends((self) => self._phoneGetSanitizeTriggers())
    async _computePhoneSanitized() {
        await this._assertPhoneField();
        const numberFields = this._phoneGetNumberFields();
        for (const record of this) {
            let sanitized;
            for (const fname of numberFields) {
                sanitized = await record.phoneGetSanitizedNumber(fname);
                if (sanitized) {
                    break;
                }
            }
            await record.set('phoneSanitized', sanitized);
        }
    }

    @api.depends('phoneSanitized')
    async _computeBlacklisted() {
        // TODO : Should remove the sudo as computeSudo defined on methods.
        // But if user doesn't have access to mail.blacklist, doen't work without sudo().
        const blacklist = new Set(await (await (await this.env.items('phone.blacklist').sudo()).search([
            ['number', 'in', await this.mapped('phoneSanitized')]])).mapped('number'));
        const numberFields = this._phoneGetNumberFields();
        for (const record of this) {
            await record.set('phoneSanitizedBlacklisted', blacklist.has(await record.phoneSanitized));
            let mobileBlacklisted = false;
            let phoneBlacklisted = false;
            // This is a bit of a hack. Assume that any "mobile" numbers will have the word 'mobile'
            // in them due to varying field names and assume all others are just "phone" numbers.
            // Note that the limitation of only having 1 phoneSanitized value means that a phone/mobile number
            // may not be calculated as blacklisted even though it is if both field values exist in a model.
            for (const numberField of numberFields) {
                if (numberField.includes('mobile')) {
                    mobileBlacklisted = (await record.phoneSanitizedBlacklisted) && await record.phoneGetSanitizedNumber(numberField) == await record.phoneSanitized;
                }
                else {
                    phoneBlacklisted = await record.phoneSanitizedBlacklisted && await record.phoneGetSanitizedNumber(numberField) == await record.phoneSanitized;
                }
            }
            await record.set('mobileBlacklisted', mobileBlacklisted);
            await record.set('phoneBlacklisted', phoneBlacklisted);
        }
    }

    @api.model()
    async _searchPhoneSanitizedBlacklisted(operator, value) {
        // Assumes operator is '=' or '!=' and value is True or False
        await this._assertPhoneField();
        if (operator !== '=') {
            if (operator === '!=' && typeof(value) === 'boolean') {
                value = !value;
            }
            else {
                throw new NotImplementedError();
            }
        }
        let query;
        if (value) {
            query = `
                SELECT m.id
                    FROM "phoneBlacklist" bl
                    JOIN "%s" m
                    ON m."phoneSanitized" = bl.number AND bl.active
            `;
        }
        else {
            query = `
                SELECT m.id
                    FROM "%s" m
                    LEFT JOIN "phoneBlacklist" bl
                    ON m."phoneSanitized" = bl.number AND bl.active
                    WHERE bl.id IS NULL
            `;
        }
        const res = await this._cr.execute(query, [this.cls._table]);
        if (! res.length) {
            return [[0, '=', 1]];
        }
        return [['id', 'in', res.map(r => r['id'])]];
    }

    async _assertPhoneField() {
        if (!this._phoneGetNumberFields) {
            throw new UserError(await this._t('Invalid primary phone field on model %s', this._name));
        }
        if (!this._phoneGetNumberFields().some(fname => fname in this._fields && this._fields[fname].type === 'char')) {
            throw new UserError(await this._t('Invalid primary phone field on model %s', this._name));
        }
    }

    /**
     * Tool method to get all triggers for sanitize
     * @returns 
     */
    _phoneGetSanitizeTriggers() {
        const res = this._phoneGetCountryField() ? [this._phoneGetCountryField()] : [];
        return res.concat(this._phoneGetNumberFields());
    }

    /**
     * This method returns the fields to use to find the number to use to
        send an SMS on a record.
     * @returns 
     */
    _phoneGetNumberFields() {
        return [];
    }

    _phoneGetCountryField() {
        if ('countryId' in this._fields) {
            return 'countryId';
        }
        return false;
    }

    async phoneGetSanitizedNumbers(numberFname='mobile', forceFormat='E164') {
        const res = Dict.fromKeys(this.ids, false);
        const countryFname = this._phoneGetCountryField();
        for (const record of this) {
            const number = await record[numberFname];
            res[record.id] = (await phoneSanitizeNumbersWRecord([number], record, countryFname, forceFormat))[number]['sanitized'];
        }
        return res;
    }

    async phoneGetSanitizedNumber(numberFname='mobile', forceFormat='E164') {
        this.ensureOne();
        const countryFname = this._phoneGetCountryField();
        const number = await this[numberFname];
        return (await phoneSanitizeNumbersWRecord([number], this, countryFname, forceFormat))[number]['sanitized'];
    }

    async _phoneSetBlacklisted() {
        return (await this.env.items('phone.blacklist').sudo())._plus(await this.map(r => r.phoneSanitized));
    }

    async _phoneResetBlacklisted() {
        return (await this.env.items('phone.blacklist').sudo())._remove(await this.map(r => r.phoneSanitized));
    }

    async phoneActionBlacklistRemove() {
        // wizard access rights currently not working as expected and allows users without access to
        // open this wizard, therefore we check to make sure they have access before the wizard opens.
        const canAccess = await this.env.items('phone.blacklist').checkAccessRights('write', false);
        if (canAccess) {
            return {
                'label': 'Are you sure you want to unblacklist this Phone Number?',
                'type': 'ir.actions.actwindow',
                'viewMode': 'form',
                'resModel': 'phone.blacklist.remove',
                'target': 'new',
            }
        }
        else {
            throw new AccessError("You do not have the access right to unblacklist phone numbers. Please contact your administrator.");
        }
    }
}