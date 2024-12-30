import xpath from 'xpath';
import { _Date, Fields } from '../../../core';
import { ValidationError } from '../../../core/helper';
import { _super, MetaModel, Model } from "../../../core/models";
import { _t, bool, f, formatLang } from '../../../core/tools';
import { serializeXml } from "../../../core/tools/xml";

@MetaModel.define()
class ResPartner extends Model {
    static _module = module;
    static _parents = "res.partner";

    static paymentResponsibleId = Fields.Many2one('res.users', {
        ondelete: 'SET NULL',
        string: 'Follow-up Responsible',
        tracking: true, copy: false,
        help: "Optionally you can assign a user to this field, which will make him responsible for the action."
    });
    static paymentNote = Fields.Text('Customer Payment Promise', { help: "Payment Note", copy: false });
    static paymentNextAction = Fields.Text('Next Action', {
        copy: false, tracking: true,
        help: "This is the next action to be taken.  It will automatically be set when the partner gets a follow-up level that requires a manual action."
    });
    static paymentNextActionDate = Fields.Date('Next Action Date', {
        copy: false,
        help: ["This is when the manual follow-up is needed. The date will be ",
            "set to the current date when the partner gets a follow-up level ",
            "that requires a manual action. Can be practical to set manually ",
            "e.g. to see if he keeps his promises."].join()
    });
    static unreconciledAmlIds = Fields.One2many('account.move.line', 'partnerId',
        {
            domain: [['fullReconcileId', '=', false],
            ['accountId.userTypeId.type', '=', 'receivable']]
        });
    static latestFollowupDate = Fields.Date({
        compute: '_getLatest', string: "Latest Follow-up Date", computeSudo: true,
        help: "Latest date that the follow-up level of the partner was changed"
    });
    static latestFollowupLevelId = Fields.Many2one('followup.line', {
        compute: '_getLatest', computeSudo: true,
        string: "Latest Follow-up Level", help: "The maximum follow-up level"
    });

    static latestFollowupSequence = Fields.Integer('Sequence', { help: "Gives the sequence order when displaying a list of follow-up lines.", default: 0 });

    static latestFollowupLevelIdWithoutLit = Fields.Many2one('followup.line',
        {
            compute: '_getLatest', store: true, computeSudo: true,
            string: "Latest Follow-up Level without litigation",
            help: "The maximum follow-up level without taking into account the account move lines with litigation"
        });
    static paymentAmountDue = Fields.Float({
        compute: '_getAmountsAndDate',
        string: "Amount Due", search: '_paymentDueSearch'
    });
    static paymentAmountOverdue = Fields.Float({
        compute: '_getAmountsAndDate',
        string: "Amount Overdue", search: '_paymentOverdueSearch'
    });
    static paymentEarliestDueDate = Fields.Date({
        compute: '_getAmountsAndDate', string: "Worst Due Date",
        search: '_paymentEarliestDateSearch'
    });

    async fieldsViewGet(viewId?: any, viewType: string = 'form', toolbar: boolean = false, submenu: boolean = false) {
        const res = await _super(ResPartner, this).fieldsViewGet(viewId, viewType, toolbar, submenu);
        if (viewType === 'form' && this.env.context['followupFirst']) {
            const doc = res['dom'];
            const firstNode = xpath.select1('//*[@name="followupTab"]', doc) as any as Element;
            const root = firstNode.parentNode;
            root.insertBefore(firstNode, root.firstChild);
            res['arch'] = serializeXml(doc, "utf-8");
        }
        return res;
    }

    async _getLatest() {
        const company = await (await this.env.user()).companyId;
        for (const partner of this) {
            const amls = await partner.unreconciledAmlIds;
            let latestDate = false;
            let latestLevel = false;
            let latestDays = false;
            let latestLevelWithoutLit = false;
            let latestDaysWithoutLit = false;
            for (const aml of amls) {
                const [amlFollowup, amlCompany, amlFollowupDate] = await aml('followupLineId', 'companyId', 'followupDate');
                if (amlCompany.eq(company) && amlFollowup.ok &&
                    (!latestDays || latestDays < await amlFollowup.delay)) {
                    latestDays = await amlFollowup.delay;
                    latestLevel = amlFollowup.id;
                }
                if (amlCompany.eq(company) && amlFollowupDate && (
                    !latestDate || latestDate < amlFollowupDate)) {
                    latestDate = amlFollowupDate;
                }
                if (amlCompany.eq(company) && ! await aml.blocked &&
                    (amlFollowup.ok && (!latestDaysWithoutLit ||
                        latestDaysWithoutLit < await amlFollowup.delay))) {
                    latestDaysWithoutLit = await amlFollowup.delay;
                    latestLevelWithoutLit = amlFollowup.id;
                }
            }
            await partner.set('latestFollowupDate', latestDate),
            await partner.set('latestFollowupLevelId', latestLevel),
            await partner.set('latestFollowupLevelIdWithoutLit', latestLevelWithoutLit)
        }
    }

    async doPartnerManualActionDermanord(followupLine) {
        const actionText = await followupLine.manualActionNote || '';

        const actionDate = await this['paymentNextActionDate'] || _Date.today();
        let responsibleId;
        const paymentResponsible = await this['paymentResponsibleId'];
        if (paymentResponsible.ok) {
            responsibleId = paymentResponsible.id;
        }
        else {
            const p = await followupLine.manualActionResponsibleId;
            responsibleId = p.ok && p.id || false;
        }
        await this.write({
            'paymentNextActionDate': actionDate,
            'paymentNextAction': actionText,
            'paymentResponsibleId': responsibleId
        });
    }

    async doPartnerManualAction(partnerIds) {
        for (const partner of this.browse(partnerIds)) {
            const [followupWithoutLit, paymentNextAction, paymentNextActionDate, paymentResponsible] = await partner('latestFollowupLevelIdWithoutLit', 'paymentNextAction', 'paymentNextActionDate', 'paymentResponsibleId');
            let actionText;
            if (paymentNextAction) {
                actionText = (paymentNextAction || '') + "\n" + (await followupWithoutLit.manualActionNote || '');
            }
            else {
                actionText = await followupWithoutLit.manualActionNote || '';
            }

            const actionDate = paymentNextActionDate || _Date.today();

            let responsibleId;
            if (paymentResponsible.ok) {
                responsibleId = paymentResponsible.id;
            }
            else {
                const p = await followupWithoutLit.manualActionResponsibleId;
                responsibleId = p.ok && p.id || false;
            }
            await partner.write({
                'paymentNextActionDate': actionDate,
                'paymentNextAction': actionText,
                'paymentResponsibleId': responsibleId
            });
        }
    }

    async doPartnerPrint(wizardPartnerIds, data) {
        if (!bool(wizardPartnerIds)) {
            return {};
        }
        data['partnerIds'] = wizardPartnerIds;
        const datas = {
            'ids': wizardPartnerIds,
            'model': 'followup.followup',
            'form': data
        }
        return (await this.env.ref('account_followup.actionReportFollowup')).reportAction(this, datas);
    }

    async doPartnerMail() {
        const ctx = Object.assign({}, this.env.context);
        ctx['followup'] = true;
        const template = 'account_followup.emailTemplateAccountFollowupDefault';
        let unknownMails = 0;
        for (const partner of this) {
            let partnersToEmail = [];
            for (const child of await partner.childIds) {
                if (await child.type === 'invoice' && await child.email) {
                    partnersToEmail.push(child);
                }
            }
            if (!partnersToEmail && await partner.email) {
                partnersToEmail = [partner];
            }
            if (partnersToEmail.length) {
                const level = await partner.latestFollowupLevelIdWithoutLit;
                for (const partnerToEmail of partnersToEmail) {
                    if (level.ok && await level.sendEmail) {
                        const emailTemplate = await level.emailTemplateId;
                        if (emailTemplate.ok && bool(emailTemplate.id)) {
                            await (await emailTemplate.withContext(ctx)).sendMail(partnerToEmail.id);
                        }
                    }
                    else {
                        const mailTemplateId = await this.env.ref(template);
                        await (await mailTemplateId.withContext(ctx)).sendMail(partnerToEmail.id);
                    }
                }
                if (!(partnersToEmail.includes(partner))) {
                    await partner.messagePost({
                        body: await _t(
                            'Overdue email sent to %s', (await Promise.all(partnersToEmail.map(async (partner) => f('%s <%s>', await partner.label, await partner.email)))).join(', '))
                    });
                }
            }
            else {
                unknownMails = unknownMails + 1;
                const actionText = _t("Email not sent because of email address of partner not filled in");
                let paymentActionDate;
                const paymentNextActionDate = await partner.paymentNextActionDate;
                const today = _Date.today();
                if (paymentNextActionDate) {
                    paymentActionDate = today > paymentNextActionDate ? paymentNextActionDate : today;
                }
                else {
                    paymentActionDate = today;
                }
                let paymentNextAction = await partner.paymentNextAction;
                if (await partner.paymentNextAction) {
                    paymentNextAction = paymentNextAction + " \n " + actionText;
                }
                else {
                    paymentNextAction = actionText;
                }
                await (await partner.withContext(ctx)).write(
                    {
                        'paymentNextActionDate': paymentActionDate,
                        'paymentNextAction': paymentNextAction
                    });
            }
        }
        return unknownMails;
    }

    async getFollowupTableHtml() {
        this.ensureOne()
        const partner = await this['commercialPartnerId'];
        let followupTable = '';
        if ((await partner.unreconciledAmlIds).ok) {
            const company = await (await this.env.user()).companyId;
            const currentDate = _Date.today();
            let report = this.env.items('report.account_followup.reportFollowup');
            const finalRes: any[][] = await report._linesGetWithPartner(partner, company.id);

            for (const currencyDict of finalRes) {
                const currency = (currencyDict['line'] ?? [
                    { 'currencyId': await company.currencyId }])[0]['currencyId'];
                followupTable += `
                <table border="2" width=100%%>
                <tr>
                    <td>` + await this._t("Invoice Date") + `</td>
                    <td>` + await this._t("Description") + `</td>
                    <td>` + await this._t("Reference") + `</td>
                    <td>` + await this._t("Due Date") + `</td>
                    <td>` + await this._t("Amount") + f(` (%s)`, await currency.symbol) + `</td>
                    <td>` + await this._t("Lit.") + `</td>
                </tr>
                `;
                let total = 0;
                for (const aml of currencyDict['line']) {
                    const block = aml['blocked'] && 'X' || ' ';
                    total += aml['balance'];
                    let strbegin = "<td>",
                        strend = "</td>";
                    const date = aml['dateMaturity'] || aml['date'];
                    if (date <= currentDate && aml['balance'] > 0) {
                        strbegin = "<td><b>";
                        strend = "</b></td>";
                    }
                    followupTable += "<tr>" + strbegin + String(aml['date']) +
                        strend + strbegin + aml['label'] +
                        strend + strbegin +
                        (aml['ref'] || '') + strend +
                        strbegin + String(date) + strend +
                        strbegin + String(aml['balance']) +
                        strend + strbegin + block +
                        strend + "</tr>";
                }
                total = currencyDict['line'].reduce((x, y) => x + y['balance'], 0.00);
                total = await formatLang(this.env, total, { currencyObj: currency });
                followupTable += `<tr> </tr>
                                </table>
                                <center>` + await this._t(
                    "Amount due") + f(` : %s </center>`, total);
            }
        }
        return followupTable;
    }

    async write(vals) {
        if (vals["paymentResponsibleId"] ?? false) {
            for (const part of this) {
                if ((await part.paymentResponsibleId).ne(
                    this.env.items('res.users').browse(vals["paymentResponsibleId"]))) {
                    // Find partnerId of user put as responsible
                    const responsiblePartnerId = (await this.env.items("res.users").browse(
                        vals['paymentResponsibleId']).partnerId).id;
                    await part.messagePost({
                        body: await this._t("You became responsible to do the next action \
                               for the payment follow-up of") +
                            " <b><a href='#id=" + String(part.id) +
                            "&viewType=form&model=res.partner'> " + await part.label +
                            " </a></b>",
                        type: 'comment',
                        context: this.env.context,
                        partnerIds: [responsiblePartnerId]
                    });
                }
            }
        }
        return _super(ResPartner, this).write(vals);
    }

    async actionDone() {
        return this.write({
            'paymentNextActionDate': false,
            'paymentNextAction': '',
            'paymentResponsibleId': false
        });
    }

    async doButtonPrint() {
        this.ensureOne();
        const companyId = (await (await this.env.user()).companyId).id;
        if (!bool(await this.env.items('account.move.line').search(
            [['partnerId', '=', this.id],
            ['accountId.userTypeId.type', '=', 'receivable'],
            ['fullReconcileId', '=', false],
            ['companyId', '=', companyId],
                '|', ['dateMaturity', '=', false],
            ['dateMaturity', '<=', _Date.today()]]))) {
            throw new ValidationError(
                await _t("The partner does not have any accounting entries to \
                  print in the overdue report for the current company."));
        }
        await this.messagePost({ body: await this._t('Printed overdue payments report') });

        const wizardPartnerIds = [this.id * 10000 + companyId];
        const followupIds = await this.env.items('followup.followup').search(
            [['companyId', '=', companyId]]);
        if (!followupIds.ok) {
            throw new ValidationError(await this._t('There is no followup plan defined for the current company.'));
        }
        const data = {
            'date': _Date.today(),
            'followupId': followupIds[0].id,
        }
        return this.doPartnerPrint(wizardPartnerIds, data);
    }

    async _getAmountsAndDate() {
        const company = await (await this.env.user()).companyId;
        const currentDate = _Date.today();
        for (const partner of this) {
            let worstDueDate = false;
            let amountDue = 0.0, amountOverdue = 0.0;
            for (const aml of await partner.unreconciledAmlIds) {
                if ((await aml.companyId).eq(company)) {
                    const dateMaturity = await aml.dateMaturity || await aml.date;
                    if (!worstDueDate || dateMaturity < worstDueDate) {
                        worstDueDate = dateMaturity;
                    }
                    amountDue += await aml.result;
                    if (dateMaturity <= currentDate) {
                        amountOverdue += await aml.result;
                    }
                }
            }
            await partner.set('paymentAmountDue', amountDue);
            await partner.set('paymentAmountOverdue', amountOverdue);
            await partner.set('paymentEarliestDueDate', worstDueDate);
        }
    }

    async _getFollowupOverdueQuery(args: any[], overdueOnly = false) {
        const companyId = (await (await this.env.user()).companyId).id;
        let havingWhereClause = (args.map(x => f('(SUM(bal2) %s %s)', x[1]))).join(' AND ');
        const havingValues = args.map(x => x[2]);
        havingWhereClause = f(havingWhereClause, havingValues[0]);
        const overdueOnlyStr = overdueOnly && 'AND "dateMaturity" <= NOW()' || '';
        return f(`SELECT pid AS "partnerId", SUM(bal2) FROM
                                    (SELECT CASE WHEN bal IS NOT NULL THEN bal
                                    ELSE 0.0 END AS bal2, p.id as pid FROM
                                    (SELECT (debit-credit) AS bal, "partnerId"
                                    FROM "accountMoveLine" l
                                    WHERE "accountId" IN
                                            (SELECT id FROM "accountAccount"
                                            WHERE "userTypeId" IN (SELECT id
                                            FROM "accountAccountType"
                                            WHERE type='receivable'
                                            ))
                                    %s AND "fullReconcileId" IS NULL
                                    AND "companyId" = %s) AS l
                                    RIGHT JOIN "resPartner" p
                                    ON p.id = "partnerId" ) AS pl
                                    GROUP BY pid HAVING %s`,
            overdueOnlyStr, companyId, havingWhereClause);
    }

    async _paymentOverdueSearch(operator, operand) {
        const args = [['paymentAmountOverdue', operator, operand]];
        const query = await this._getFollowupOverdueQuery(args, true);
        const res = await this._cr.execute(query);
        if (!res.length) {
            return [['id', '=', '0']];
        }
        return [['id', 'in', res.map(x => x['partnerId'])]];
    }

    async _paymentEarliestDateSearch(operator, operand) {
        const args = [['paymentEarliestDueDate', operator, operand]];
        const companyId = (await (await this.env.user()).companyId).id;
        let havingWhereClause = args.map(x => f(`(MIN(l."dateMaturity") %s '%s')`, x[1])).join(' AND ');
        const havingValues = args.map(x => x[2]);
        havingWhereClause = f(havingWhereClause, havingValues[0]);
        let query = 'SELECT "partnerId" FROM accountMoveLine l ' +
            'WHERE accountId IN ' +
            '(SELECT id FROM "accountAccount" ' +
            'WHERE "userTypeId" IN ' +
            '(SELECT id FROM "accountAccountType" ' +
            'WHERE type=\'receivable\')) AND l."companyId" = %s ' +
            'AND l."fullReconcileId" IS NULL ' +
            'AND "partnerId" IS NOT NULL GROUP BY "partnerId" ';
        query = f(query, companyId);
        if (havingWhereClause) {
            query += f(' HAVING %s ', havingWhereClause);
        }
        const res = await this._cr.execute(query);
        if (!res.length) {
            return [['id', '=', '0']];
        }
        return [['id', 'in', res.map(x => x['partnerId'])]];
    }

    async _paymentDueSearch(operator, operand) {
        const args = [['paymentAmountDue', operator, operand]];
        const query = await this._getFollowupOverdueQuery(args, false);
        const res = await this._cr.execute(query);
        if (!res.length) {
            return [['id', '=', '0']];
        }
        return [['id', 'in', res.map(x => x['partnerId'])]];
    }

    async _getPartners() {
        const partnerIds = new Set();
        for (const aml of this) {
            const partner = await aml.partnerId;
            if (bool(partner)) {
                partnerIds.add(partner.id);
            }
        }
        return Array.from(partnerIds);
    }
}