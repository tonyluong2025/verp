import fs from "fs/promises";
import { DateTime } from "luxon";
import { Command, _Date, api } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { filePath, formatLang, isInstance } from "../../../core/tools";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountChartTemplate extends Model {
    static _module = module;
    static _parents = "account.chart.template";

    /**
     * Generate the demo data related to accounting.
     */
    @api.model()
    async* _getDemoData() {
        // This is a generator because data created here might be referenced by xmlid to data
        // created later but defined in this same function.
        yield this._getDemoDataMove();
        yield this._getDemoDataStatement();
        yield this._getDemoDataReconcileModel();
        yield this._getDemoDataAttachment();
        yield this._getDemoDataMailMessage();
        yield this._getDemoDataMailActivity()
    }

    @api.model()
    async _getDemoDataMove() {
        const company = await this.env.company();
        const cid = company.id;
        const ref = this.env.ref;
        const partner12Id = (await ref('base.resPartner_12')).id;
        const partner2Id = (await ref('base.resPartner_2')).id;
        const userId = (await ref('base.userDemo')).id;
        const _time = DateTime.now();
        return ['account.move', {
            [`${cid}_demo_invoice_1`]: {
                'moveType': 'outInvoice',
                'partnerId': partner12Id,
                'invoiceUserId': userId,
                'invoicePaymentTermId': (await ref('account.accountPaymentTermEndFollowingMonth')).id,
                'invoiceDate': _time.toFormat('yyyy-MM-01'),
                'invoiceLineIds': [
                    Command.create({ 'productId': (await ref('product.consuDelivery02')).id, 'quantity': 5 }),
                    Command.create({ 'productId': (await ref('product.consuDelivery03')).id, 'quantity': 5 }),
                ],
            },
            [`${cid}_demo_invoice_2`]: {
                'moveType': 'outInvoice',
                'partnerId': partner2Id,
                'invoiceUserId': false,
                'invoiceDate': _time.toFormat('yyyy-MM-08'),
                'invoiceLineIds': [
                    Command.create({ 'productId': (await ref('product.consuDelivery03')).id, 'quantity': 5 }),
                    Command.create({ 'productId': (await ref('product.consuDelivery01')).id, 'quantity': 20 }),
                ],
            },
            [`${cid}_demo_invoice_3`]: {
                'moveType': 'outInvoice',
                'partnerId': partner2Id,
                'invoiceUserId': false,
                'invoiceDate': _time.toFormat('yyyy-MM-08'),
                'invoiceLineIds': [
                    Command.create({ 'productId': (await ref('product.consuDelivery01')).id, 'quantity': 5 }),
                    Command.create({ 'productId': (await ref('product.consuDelivery03')).id, 'quantity': 5 }),
                ],
            },
            [`${cid}_demo_invoice_followup`]: {
                'moveType': 'outInvoice',
                'partnerId': partner2Id,
                'invoiceUserId': userId,
                'invoicePaymentTermId': (await ref('account.accountPaymentTermImmediate')).id,
                'invoiceDate': DateTime.now().minus({ days: 15 }).toFormat('yyyy-MM-dd'),
                'invoiceLineIds': [
                    Command.create({ 'productId': (await ref('product.consuDelivery02')).id, 'quantity': 5 }),
                    Command.create({ 'productId': (await ref('product.consuDelivery03')).id, 'quantity': 5 }),
                ],
            },
            [`${cid}_demo_invoice_5`]: {
                'moveType': 'inInvoice',
                'partnerId': partner12Id,
                'invoiceUserId': userId,
                'invoicePaymentTermId': (await ref('account.accountPaymentTermEndFollowingMonth')).id,
                'invoiceDate': _time.toFormat('yyyy-MM-01'),
                'invoiceLineIds': [
                    Command.create({ 'productId': await ref('product.productDelivery01'), 'priceUnit': 10.0, 'quantity': 1 }),
                    Command.create({ 'productId': await ref('product.productOrder01'), 'priceUnit': 4.0, 'quantity': 5 }),
                ],
            },
            [`${cid}_demo_invoice_extract`]: {
                'moveType': 'inInvoice',
                'invoiceUserId': userId,
            },
            [`${cid}_demo_invoice_equipment_purchase`]: {
                'moveType': 'inInvoice',
                'ref': 'INV/2018/0057',
                'partnerId': partner12Id,
                'invoiceUserId': false,
                'invoiceDate': '2018-09-17',
                'invoiceLineIds': [
                    Command.create({ 'label': 'Redeem Reference Number: PO02529', 'quantity': 1, 'priceUnit': 541.10 }),
                ],
            },
        }]
    }

    @api.model()
    async _getDemoDataStatement() {
        const company = await this.env.company();
        const cid = company.id;
        const ref = this.env.ref;
        const partnerId = (await ref('base.resPartner_12')).id;
        const now = DateTime.now();
        const year = now.toFormat('yyyy');
        return ['account.bank.statement', {
            [`${cid}_demo_bank_statement_1`]: {
                'journalId': (await this.env.items('account.journal').search([
                    ['type', '=', 'bank'],
                    ['companyId', '=', cid],
                ], { limit: 1 })).id,
                'date': year + '-01-01',
                'balanceEndReal': 9944.87,
                'balanceStart': 5103.0,
                'lineIds': [
                    Command.create({
                        'paymentRef': `INV/${year}/00002 and INV/${year}/00003`,
                        'amount': 1275.0,
                        'date': year + '-01-01',
                        'partnerId': partnerId
                    }),
                    Command.create({
                        'paymentRef': 'Bank Fees',
                        'amount': -32.58,
                        'date': year + '-01-01',
                    }),
                    Command.create({
                        'paymentRef': 'Prepayment',
                        'amount': 650,
                        'date': year + '-01-01',
                        'partnerId': partnerId
                    }),
                    Command.create({
                        'paymentRef': `First ${await formatLang(this.env, 2000, { currencyObj: await company.currencyId })} of invoice ${year}/00001`,
                        'amount': 2000,
                        'date': year + '-01-01',
                        'partnerId': partnerId
                    }),
                    Command.create({
                        'paymentRef': 'Last Year Interests',
                        'amount': 102.78,
                        'date': year + '-01-01',
                    }),
                    Command.create({
                        'paymentRef': `INV/${year}/00002`,
                        'amount': 750,
                        'date': year + '-01-01',
                        'partnerId': partnerId
                    }),
                    Command.create({
                        'paymentRef': `R:9772938 10/07 AX 9415116318 T:5 BRT: ${await formatLang(this.env, 96.67, { currencyObj: await company.currencyId })} C/ croip`,
                        'amount': 96.67,
                        'date': year + '-01-01',
                    }),
                ]
            },
        }];
    }

    @api.model()
    async _getDemoDataReconcileModel() {
        const company = await this.env.company();
        const cid = company.id;
        return ['account.reconcile.model', {
            [`${cid}_reconcile_from_label`]: {
                'label': 'Line with Bank Fees',
                'ruleType': 'writeoffSuggestion',
                'matchLabel': 'contains',
                'matchLabelParam': 'BRT',
                'decimalSeparator': ',',
                'lineIds': [
                    Command.create({
                        'label': 'Due amount',
                        'accountId': (await this._getDemoAccount(
                            'income',
                            'account.dataAccountTypeRevenue',
                            company,
                        )).id,
                        'amountType': 'regex',
                        'amountString': /BRT: ([\d,]+)/.source,
                    }),
                    Command.create({
                        'label': 'Bank Fees',
                        'accountId': (await this._getDemoAccount(
                            'costOfGoodsSold',
                            'account.dataAccountTypeDirectCosts',
                            company,
                        )).id,
                        'amountType': 'percentage',
                        'amountString': '100',
                    }),
                ]
            },
        }];
    }

    @api.model()
    async _getDemoDataAttachment() {
        const cid = (await this.env.company()).id;
        const ref = this.env.ref;
        return ['ir.attachment', {
            [`${cid}_ir_attachment_bank_statement_1`]: {
                'type': 'binary',
                'label': 'bank_statement_yourcompany_demo.pdf',
                'resModel': 'account.bank.statement',
                'resId': (await ref(`account.${cid}_demo_bank_statement_1`)).id,
                'raw': await fs.readFile(filePath('account/static/demo/bank_statement_yourcompany_1.pdf'))
            },
            [`${cid}_ir_attachment_in_invoice_1`]: {
                'type': 'binary',
                'label': 'in_invoice_yourcompany_demo.pdf',
                'resModel': 'account.move',
                'resId': (await ref(`account.${cid}_demo_invoice_extract`)).id,
                'raw': await fs.readFile(filePath('account/static/demo/in_invoice_yourcompany_demo_1.pdf'))
            },
            [`${cid}_ir_attachment_in_invoice_2`]: {
                'type': 'binary',
                'label': 'in_invoice_yourcompany_demo.pdf',
                'resModel': 'account.move',
                'resId': (await ref(`account.${cid}_demo_invoice_equipment_purchase`)).id,
                'raw': await fs.readFile(filePath('account/static/demo/in_invoice_yourcompany_demo_2.pdf'))
            },
        }];
    }

    @api.model()
    async _getDemoDataMailMessage() {
        const cid = (await this.env.company()).id;
        const ref = this.env.ref;
        const demoId = (await ref('base.partnerDemo')).id;
        return ['mail.message', {
            [`${cid}_mail_message_bank_statement_1`]: {
                'model': 'account.bank.statement',
                'resId': (await ref(`account.${cid}_demo_bank_statement_1`)).id,
                'body': 'Bank statement attachment',
                'messageType': 'comment',
                'authorId': demoId,
                'attachmentIds': [Command.set([
                    (await ref(`account.${cid}_ir_attachment_bank_statement_1`)).id
                ])]
            },
            [`${cid}_mail_message_in_invoice_1`]: {
                'model': 'account.move',
                'resId': (await ref(`account.${cid}_demo_invoice_extract`)).id,
                'body': 'Vendor Bill attachment',
                'messageType': 'comment',
                'authorId': demoId,
                'attachmentIds': [Command.set([
                    (await ref(`account.${cid}_ir_attachment_in_invoice_1`)).id
                ])]
            },
            [`${cid}_mail_message_in_invoice_2`]: {
                'model': 'account.move',
                'resId': (await ref(`account.${cid}_demo_invoice_equipment_purchase`)).id,
                'body': 'Vendor Bill attachment',
                'messageType': 'comment',
                'authorId': (await ref('base.partnerDemo')).id,
                'attachmentIds': [Command.set([
                    (await ref(`account.${cid}_ir_attachment_in_invoice_2`)).id
                ])]
            },
        }];
    }

    @api.model()
    async _getDemoDataMailActivity() {
        const cid = (await this.env.company()).id;
        const ref = this.env.ref;
        const _today = DateTime.fromJSDate(_Date.today());
        const adminId = (await ref('base.userAdmin')).id;
        return ['mail.activity', {
            [`${cid}_invoice_activity_1`]: {
                'resId': (await ref(`account.${cid}_demo_invoice_3`)).id,
                'resModelId': (await ref('account.model_accountMove')).id,
                'activityTypeId': (await ref('mail.mailActivityDataTodo')).id,
                'dateDeadline': _today.plus({ days: 5 }).toFormat('yyyy-MM-dd HH:mm'),
                'summary': 'Follow-up on payment',
                'createdUid': adminId,
                'userId': adminId,
            },
            [`${cid}_invoice_activity_2`]: {
                'resid': (await ref(`account.${cid}_demo_invoice_2`)).id,
                'resModelId': (await ref('account.model_accountMove')).id,
                'activityTypeId': (await ref('mail.mailActivityDataCall')).id,
                'dateDeadline': _today.toFormat('yyyy-MM-dd HH:mm'),
                'createdUid': adminId,
                'userId': adminId,
            },
            [`${cid}_invoice_activity_3`]: {
                'resId': (await ref(`account.${cid}_demo_invoice_1`)).id,
                'resModelId': (await ref('account.model_accountMove')).id,
                'activityTypeId': (await ref('mail.mailActivityDataTodo')).id,
                'dateDeadline': _today.plus({ days: 5 }).toFormat('yyyy-MM-dd HH:mm'),
                'summary': 'Include upsell',
                'createdUid': adminId,
                'userId': adminId,
            },
            [`${cid}_invoice_activity_4`]: {
                'resId': (await ref(`account.${cid}_demo_invoice_extract`)).id,
                'resModelId': (await ref('account.model_accountMove')).id,
                'activityTypeId': (await ref('mail.mailActivityDataTodo')).id,
                'dateDeadline': _today.plus({ days: 5 }).toFormat('yyyy-MM-dd HH:mm'),
                'summary': 'Update address',
                'createdUid': adminId,
                'userId': adminId,
            },
        }];
    }

    @api.model()
    async _postCreateDemoData(created) {
        const cid = (await this.env.company()).id;
        if (created._name === 'account.move') {
            created = await created.withContext({ checkMoveValidity: false });
            // We need to recompute some onchanges. Invoice lines VS journal items are already
            // synchronized in the create, but the onchange were not applied on the invoice lines.
            for (const move of created) {
                await move._onchangePartnerId();
            }

            const lineIds = await created.lineIds;
            await lineIds._onchangeProductId();
            await lineIds._onchangeAccountId();
            await lineIds._onchangePriceSubtotal();

            await created._recomputeDynamicLines(true, true);

            // the invoice_extract acts like a placeholder for the OCR to be ran and doesn't contain any lines yet
            for (const move of created.sub(await this.env.ref(`account.${cid}_demo_invoice_extract`))) {
                try {
                    await move.actionPost();
                } catch (e) {
                    if (isInstance(e, UserError, ValidationError)) {
                        console.error('Error while posting demo data');
                    }
                    throw e;
                }
            }
        }
        else if (created._name === 'account.bank.statement') {
            await created.buttonPost();
        }
    }

    /**
     * Find the most appropriate account possible for demo data creation.

        :param xmlid (str): the xmlid of the account template in the generic coa
        :param userTypeId (str): the full xmlid of the account type wanted
        :param company (Model<res.company>): the company for which we search the account
        :return (Model<account.account>): the most appropriate record found
     * @param xmlid 
     * @param userTypeId 
     * @param company 
     * @returns 
     */
    @api.model()
    async _getDemoAccount(xmlid, userTypeId, company) {
        let account = await this.env.items('account.account').browse((await (await this.env.items('ir.model.data').sudo()).search([
            ['label', '=', f('%s_%s', company.id, xmlid)],
            ['model', '=', 'account.account'],
            ['module', '=like', 'l10n%']
        ], { limit: 1 })).resId);
        if (account.ok) {
            return account;
        }

        account = await this.env.items('account.account').search([
            ['userTypeId', '=', (await this.env.ref(userTypeId)).id],
            ['companyId', '=', company.id]
        ], { limit: 1 });
        if (account.ok) {
            return account;
        }

        return await this.env.items('account.account').search([['companyId', '=', company.id]], { limit: 1 });
    }
}