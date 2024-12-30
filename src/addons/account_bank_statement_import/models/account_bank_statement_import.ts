import _ from "lodash";
import * as fsPro from "fs/promises";
import * as XLSX from 'xlsx';
import { _Date, _Datetime, Fields } from "../../../core";
import { Dict, UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, TransientModel } from "../../../core/models";
import { b64decode, b64encode, bool, extend, isInstance, len, parseFloat, pop, processBufferCsv, processFileCsv, range, today, update } from "../../../core/tools";
import temp from 'temp';
import { encode } from "utf8";
import { sanitizeAccountNumber } from "../../../core/addons/base";

@MetaModel.define()
class AccountBankStatementLine extends Model {
    static _module = module;
    static _parents = "account.bank.statement.line";

    // Ensure transactions can be imported only once (if the import format provides unique transaction ids)
    static uniqueImportId = Fields.Char({string: 'Import ID', readonly: true, copy: false});

    static _sqlConstraints = [
        ['uniqueImportId', 'unique ("uniqueImportId")', 'A bank account transactions can be imported only once !']
    ];
}

@MetaModel.define()
class AccountBankStatementImport extends TransientModel {
    static _module = module;
    static _name = 'account.bank.statement.import';
    static _description = 'Import Bank Statement';

    static attachmentIds = Fields.Many2many('ir.attachment', {string: 'Files', required: true, help: 'Get you bank statements in electronic format from your bank and select them here.'});

    async getPartner(value) {
        const partner = await this.env.items('res.partner').search([['label', '=', value]]);
        return bool(partner) ? partner.id : false;
    }

    async getCurrency(value) {
        const currency = await this.env.items('res.currency').search([['label', '=', value]]);
        return bool(currency) ? currency.id : false;
    }

    async createStatement(values) {
        const statement = await this.env.items('account.bank.statement').create(values);
        return statement;
    }

    async importFile() {
        for (let dataFile of await this['attachmentIds']) {
            const fileName = (await dataFile.label).toLowerCase();
            try {
                if (fileName.trim().endsWith('.csv') || fileName.trim().endsWith('.xlsx')) {
                    let statement: any = false;
                    if (fileName.trim().endsWith('.csv')) {
                        const keys = ['date', 'paymentRef', 'partnerId', 'amount', 'currencyId'];
                        let fileReader, values;
                        try {
                            let csvData = b64decode(await dataFile.datas);
                            // csvData = csvData.toString("utf-8");
                            fileReader = [];
                            values = new Dict();
                            const [fields, data, badLines] = await processBufferCsv(csvData);
                            fileReader.extend(data);
                        } catch(e) {
                            throw new UserError(await this._t("Invalid file!"));
                        }
                        const valsList = [];
                        let date = false;
                        for (const i of range(len(fileReader))) {
                            const field = fileReader[i].map(val => String(val));
                            values = Dict.from(_.zip(keys, field));
                            if (bool(values)) {
                                if (i == 0) {
                                    continue;
                                }
                                else {
                                    if (! date) {
                                        date = field[0];
                                    }
                                    values.update({
                                        'date': field[0],
                                        'paymentRef': field[1],
                                        'ref': field[2],
                                        'partnerId': await this.getPartner(field[3]),
                                        'amount': field[4],
                                        'currencyId': await this.getCurrency(field[5])
                                    })
                                    valsList.push([0, 0, values]);
                                }
                            }
                        }
                        const statementVals = {
                            'label': 'Statement Of ' + today().toDateString(),
                            'journalId': this.env.context['activeId'],
                            'lineIds': valsList
                        }
                        if (len(valsList) != 0) {
                            statement = await this.createStatement(statementVals);
                        }
                    }
                    else if (fileName.trim().endsWith('.xlsx')) {
                        let values: {}, sheet: XLSX.Sheet;
                        try {
                            const fd: temp.OpenFile = await temp.open({ suffix: '.xlsx'});//, delete: false});
                            await fsPro.writeFile(fd.path, b64encode(await dataFile.datas));
                            values = {}
                            const workbook = XLSX.read(fd.path);
                            sheet = workbook.Sheets[workbook.SheetNames[0]];
                        } catch(e) {
                            throw new UserError(await this._t("Invalid file!"));
                        }
                        const valsList = [];
                        let rowNo = 0;
                        for (const row of XLSX.utils.sheet_to_json<any>(sheet, {header: 1})) {
                            const val = {}
                            values = {}
                            if (rowNo == 0) {
                                const fields = row.map(col => encode(col));
                            }
                            else {
                                const line = row.map(col => isInstance(col, Uint8Array) && encode(col) || String(col));
                                update(values, {
                                    'date': line[0],
                                    'paymentRef': line[1],
                                    'ref': line[2],
                                    'partnerId': await this.getPartner(line[3]),
                                    'amount': line[4],
                                    'currencyId': await this.getCurrency(line[5])
                                });
                                valsList.push([0, 0, values]);
                            }
                            rowNo++;
                        }
                        const statementVals = {
                            'label': 'Statement Of ' + _Date.today().toDateString(),
                            'journalId': this.env.context['activeId'],
                            'lineIds': valsList
                        }
                        if (len(valsList) != 0) {
                            statement = await this.createStatement(statementVals);
                        }
                    }
                    if (bool(statement)) {
                        return {
                            'type': 'ir.actions.actwindow',
                            'resModel': 'account.bank.statement',
                            'viewMode': 'form',
                            'resId': statement.id,
                            'views': [[false, 'form']],
                        }
                    }
                }
                else {
                    throw new ValidationError(await this._t("Unsupported File Type"));
                }
            } catch(e) {
                throw new ValidationError(await this._t("Please upload in specified format ! \n \
                                        date, payment reference, reference, partner, amount, currency ! \n \
                                        Date Format: %Y-%m-%d"));
            }
        }
    }

    /**
     * Calls a wizard that allows the user to carry on with journal creation
     * @param currency 
     * @param accountNumber 
     * @returns 
     */
    async _journalCreationWizard(currency, accountNumber) {
        return {
            'label': await this._t('Journal Creation'),
            'type': 'ir.actions.actwindow',
            'resModel': 'account.bank.statement.import.journal.creation',
            'viewMode': 'form',
            'target': 'new',
            'context': {
                'statementImportTransientId': this.env.context['activeId'],
                'default_bankAccNumber': accountNumber,
                'default_label': await this._t('Bank') + ' ' + accountNumber,
                'default_currencyId': bool(currency) && currency.id || false,
                'default_type': 'bank',
            }
        }
    }

    async _parseFile(dataFile) {
        throw new UserError(await this._t('Could not make sense of the given file.\nDid you install the module to support this type of file ?'));
    }

    /**
     * Basic and structural verifications
     * @param stmtsVals 
     * @param accountNumber 
     */
    async _checkParsedData(stmtsVals, accountNumber) {
        const extraMsg = await this._t('If it contains transactions for more than one account, it must be imported on each of them.');
        if (len(stmtsVals) == 0) {
            throw new UserError(
                await this._t('This file doesn\'t contain any statement for account %s.', accountNumber,)
                + '\n' + extraMsg
            );
        }

        let noStLine = true;
        for (const vals of stmtsVals) {
            if (vals['transactions'] && len(vals['transactions']) > 0) {
                noStLine = false;
                break;
            }
        }
        if (noStLine) {
            throw new UserError(
                await this._t('This file doesn\'t contain any transaction for account %s.', accountNumber,)
                + '\n' + extraMsg
            );
        }
    }

    async _checkJournalBankAccount(journal, accountNumber) {
        // Needed for CH to accommodate for non-unique account numbers
        let sanitizedAccNumber = await (await journal.bankAccountId).sanitizedAccNumber;
        if (sanitizedAccNumber.includes(" ")) {
            sanitizedAccNumber = sanitizedAccNumber.split(" ")[0];
        }
        return sanitizedAccNumber == accountNumber;
    }

    /**
     * Look for a res.currency and account.journal using values extracted from the
            statement and make sure it's consistent.
     * @param currencyCode 
     * @param accountNumber 
     */
    async _findAdditionalData(currencyCode, accountNumber) {
        const companyCurrency = await (await this.env.company()).currencyId;
        const journalObj = this.env.items('account.journal');
        let currency;
        const sanitizedAccountNumber = sanitizeAccountNumber(accountNumber);

        if (currencyCode) {
            currency = await this.env.items('res.currency').search([['label', '=ilike', currencyCode]], {limit: 1});
            if (!bool(currency)) {
                throw new UserError(await this._t("No currency found matching '%s'.", currencyCode));
            }
            if (currency.eq(companyCurrency)) {
                currency = false;
            }
        }
        let journal = journalObj.browse(this.env.context['journalId'] ?? []);
        if (accountNumber) {
            // No bank account on the journal : create one from the account number of the statement
            if (bool(journal) && ! bool(await journal.bankAccountId)) {
                await journal.setBankAccount(accountNumber);
            }
            // No journal passed to the wizard : try to find one using the account number of the statement
            else if (!bool(journal)) {
                journal = await journalObj.search([['bankAccountId.sanitizedAccNumber', '=', sanitizedAccountNumber]]);
            }
            // Already a bank account on the journal : check it's the same as on the statement
            else {
                if (!await this._checkJournalBankAccount(journal, sanitizedAccountNumber)) {
                    throw new UserError(await this._t('The account of this statement (%s) is not the same as the journal (%s).', accountNumber, await (await journal.bankAccountId).accNumber));
                }
            }
        }
        // If importing into an existing journal, its currency must be the same as the bank statement
        if (bool(journal)) {
            const journalCurrency = await journal.currencyId;
            if (currency == null) {
                currency = journalCurrency;
            }
            if (bool(currency) && currency.ne(journalCurrency)) {
                const statementCurCode = !bool(currency) && await companyCurrency.label || await currency.label;
                const journalCurCode = !bool(journalCurrency) && await companyCurrency.label || await journalCurrency.label;
                throw new UserError(await this._t('The currency of the bank statement (%s) is not the same as the currency of the journal (%s).', statementCurCode, journalCurCode));
            }
        }

        // If we couldn't find / can't create a journal, everything is lost
        if (! bool(journal) && ! bool(accountNumber)) {
            throw new UserError(await this._t('Cannot find in which journal import this statement. Please manually select a journal.'));
        }

        return [currency, journal];
    }

    async _completeStmtsVals(stmtsVals, journal, accountNumber) {
        for (const stVals of stmtsVals) {
            stVals['journalId'] = journal.id;
            if (! stVals['reference']) {
                stVals['reference'] = (await (await this['attachmentIds']).mapped('label')).join(' ');
            }
            if (stVals['number']) {
                //build the full name like BNK/2016/00135 by just giving the number '135'
                stVals['label'] = await (await (await journal.sequenceId).withContext({irSequenceDate: stVals['date']})).getNextChar(stVals['number']);
                delete stVals['number'];
            }
            for (const lineVals of stVals['transactions']) {
                const uniqueImportId = lineVals['uniqueImportId'];
                if (uniqueImportId) {
                    const sanitizedAccountNumber = sanitizeAccountNumber(accountNumber);
                    lineVals['uniqueImportId'] = (sanitizedAccountNumber && sanitizedAccountNumber + '-' || '') + String(journal.id) + '-' + uniqueImportId;
                }

                if (! lineVals['bankAccountId']) {
                    // Find the partner and his bank account or create the bank account. The partner selected during the
                    // reconciliation process will be linked to the bank when the statement is closed.
                    const identifyingString = lineVals['accountNumber'];
                    if (identifyingString) {
                        const partnerBank = await this.env.items('res.partner.bank').search([['accNumber', '=', identifyingString]], {limit: 1});
                        if (bool(partnerBank)) {
                            lineVals['bankAccountId'] = partnerBank.id;
                            lineVals['partnerId'] = (await partnerBank.partnerId).id;
                        }
                    }
                }
            }
        }
        return stmtsVals;
    }

    /**
     * Create new bank statements from imported values, filtering out already imported transactions, and returns data used by the reconciliation widget
     * @param stmtsVals 
     */
    async _createBankStatements(stmtsVals) {
        let bankStatement = this.env.items('account.bank.statement');
        let bankStatementLine = this.env.items('account.bank.statement.line');

        // Filter out already imported transactions and create statements
        const statementLineIds = [],
        ignoredStatementLinesImportIds = [];
        for (const stVals of stmtsVals) {
            const filteredStLines = [];
            for (const lineVals of stVals['transactions']) {
                if (!('uniqueImportId' in lineVals) 
                   || ! lineVals['uniqueImportId']
                   || ! bool(await (await bankStatementLine.sudo()).search([['uniqueImportId', '=', lineVals['uniqueImportId']]], {limit: 1}))) {
                    filteredStLines.push(lineVals);
                }
                else {
                    ignoredStatementLinesImportIds.push(lineVals['uniqueImportId']);
                    if ('balanceStart' in stVals) {
                        stVals['balanceStart'] += parseFloat(lineVals['amount']);
                    }
                }
            }
            if (len(filteredStLines) > 0) {
                // Remove values that won't be used to create records
                pop(stVals, 'transactions', null);
                // Create the statement
                stVals['lineIds'] = filteredStLines.map(line => [0, false, line]);
                extend(statementLineIds, (await (await bankStatement.create(stVals)).lineIds).ids);
            }
        }
        if (len(statementLineIds) == 0) {
            throw new UserError(await this._t('You already have imported that file.'));
        }

        // Prepare import feedback
        let notifications = [];
        const numIgnored = len(ignoredStatementLinesImportIds);
        if (numIgnored > 0) {
            notifications = notifications.concat([{
                'type': 'warning',
                'message': await this._t("%d transactions had already been imported and were ignored.", numIgnored > 1? numIgnored : await this._t("1 transaction had already been imported and was ignored.")),
                'details': {
                    'label': await this._t('Already imported items'),
                    'model': 'account.bank.statement.line',
                    'ids': await bankStatementLine.search([['uniqueImportId', 'in', ignoredStatementLinesImportIds]]).ids
                }
            }]);
        }
        return [statementLineIds, notifications];
    }
}
