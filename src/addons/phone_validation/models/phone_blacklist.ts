import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool, isList, quoteList } from "../../../core/tools";
import { phoneSanitizeNumbersWRecord } from "../tools";

/**
 * Blacklist of phone numbers. Used to avoid sending unwanted messages to people.
 */
@MetaModel.define()
class PhoneBlackList extends Model {
    static _module = module;
    static _name = 'phone.blacklist';
    static _parents = ['mail.thread'];
    static _description = 'Phone Blacklist';
    static _recName = 'number';

    static number = Fields.Char({string: 'Phone Number', required: true, index: true, tracking: true, help: 'Number should be E164 formatted'});
    static active = Fields.Boolean({default: true, tracking: true});

    static _sqlConstraints = [
        ['unique_number', 'unique (number)', 'Number already exists']
    ];

    /**
     * To avoid crash during import due to unique email, return the existing records if any
     * @param values 
     * @returns 
     */
    @api.modelCreateMulti()
    async create(values) {
        // First of all, extract values to ensure emails are really unique (and don't modify values in place)
        let toCreate = []
        const done = new Set();
        for (const value of values) {
            const number = value['number'];
            const sanitizedValues = (await phoneSanitizeNumbersWRecord([number], await this.env.user()))[number];
            const sanitized = sanitizedValues['sanitized'];
            if (! sanitized) {
                throw new UserError(sanitizedValues['msg'] + await this._t(" Please correct the number and try again."));
            }
            if (done.has(sanitized)) {
                continue;
            }
            done.add(sanitized);
            toCreate.push(Object.assign({}, value, {number: sanitized}));
        }

        const sql = `SELECT number, id FROM "phoneBlacklist" WHERE number IN (%s)`;
        const numbers = toCreate.map(v => v['number']);
        const res = await this._cr.execute(sql, [quoteList(numbers)]);
        const blEntries = Object.fromEntries(res.map(row => [row['number'], row['id']]));
        toCreate = toCreate.filter(v => !(v['number'] in blEntries));

        const results = await _super(PhoneBlackList, this).create(toCreate);
        return this.env.items('phone.blacklist').browse(Object.values(blEntries)).or(results);
    }

    async write(values) {
        if ('number' in values) {
            const number = values['number'];
            const sanitizedValues = (await phoneSanitizeNumbersWRecord([number], await this.env.user()))[number];
            const sanitized = sanitizedValues['sanitized'];
            if (! sanitized) {
                throw new UserError(sanitizedValues['msg'] + await this._t(" Please correct the number and try again."));
            }
            values['number'] = sanitized;
        }
        return _super(PhoneBlackList, this).write(values);
    }

    /**
     * Override _search in order to grep search on sanitized number field
     * @param args 
     * @param optiosn 
     */
    async _search(args, options: {offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean}={}) {
        let newArgs;
        if (bool(args)) {
            newArgs = []
            for (const arg of args) {
                if (isList(arg) && arg[0] === 'number' && typeof(arg[2]) === 'string') {
                    const number = arg[2];
                    const sanitized = (await phoneSanitizeNumbersWRecord([number], await this.env.user()))[number]['sanitized'];
                    if (sanitized) {
                        newArgs.push([arg[0], arg[1], sanitized]);
                    }
                    else {
                        newArgs.push(arg);
                    }
                }
                else {
                    newArgs.push(arg);
                }
            }
        }
        else {
            newArgs = args;
        }
        return _super(PhoneBlackList, this)._search(newArgs, options);
    }

    async plus(number) {
        const sanitized = (await phoneSanitizeNumbersWRecord([number], await this.env.user()))[number]['sanitized'];
        return this._plus([sanitized]);
    }

    /**
     * Add or re activate a phone blacklist entry.

        :param numbers: list of sanitized numbers
     * @param numbers 
     * @returns 
     */
    async _plus(numbers) {
        let records = await (await this.env.items("phone.blacklist").withContext({activeTest: false})).search([['number', 'in', numbers]]);
        const recordsNumbers = await records.mapped('number');
        const todo = numbers.filter(n => !recordsNumbers.includes(n));
        if (bool(records)) {
            await records.actionUnarchive();
        }
        if (bool(todo)) {
            records = records.add(await this.create(todo.map(n => {return {'number': n}})));
        }
        return records;
    }

    async actionRemoveWithReason(number, reason?: any) {
        const records = await this.remove(number);
        if (reason) {
            for (const record of records) {
                await record.messagePost({body: await this._t("Unblacklisting Reason: %s", reason)});
            }
        }
        return records;
    }

    async remove(number) {
        const sanitized = (await phoneSanitizeNumbersWRecord([number], await this.env.user()))[number]['sanitized'];
        return this._remove([sanitized]);
    }

    /**
     * Add de-activated or de-activate a phone blacklist entry.

        :param numbers: list of sanitized numbers
     * @param numbers 
     * @returns 
     */
    async _remove(numbers) {
        let records = await (await this.env.items("phone.blacklist").withContext({activeTest: false})).search([['number', 'in', numbers]]);
        const recordsNumbers = await records.mapped('number');
        const todo = numbers.filter(n => !recordsNumbers.includes(n));
        if (bool(records)) {
            await records.actionArchive();
        }
        if (bool(todo)) {
            records = records.add(await this.create(todo.map(n => {return {'number': n, 'active': false}})));
        }
        return records;
    }

    async phoneActionBlacklistRemove() {
        return {
            'label': await this._t('Are you sure you want to unblacklist this Phone Number?'),
            'type': 'ir.actions.actwindow',
            'viewMode': 'form',
            'resModel': 'phone.blacklist.remove',
            'target': 'new',
        }
    }

    async actionAdd() {
        await this.plus(await this['number']);
    }
}