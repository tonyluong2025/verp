import { Fields, _Date } from "../../../core";
import { Dict } from "../../../core/helper";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool, f, len, parseInt, update } from "../../../core/tools";
import { fromFormat, subDate, toFormat } from "../../../core/tools/date_utils";

@MetaModel.define()
class FollowupPrint extends TransientModel {
    static _module = module;
    static _name = 'followup.print';
    static _description = 'Print Follow-up & Send Mail to Customers';

    async _getFollowup() {
        if ((this.env.context['activeModel'] || 'ir.ui.menu') === 'followup.followup') {
            return this.env.context['activeId'] ?? false;
        }
        const companyId = (await (await this.env.user()).companyId).id;
        const followpId = await this.env.items('followup.followup').search(
            [['companyId', '=', companyId]], {limit: 1})
        return bool(followpId) ? followpId : false;
    }

    static date = Fields.Date('Follow-up Sending Date', {required: true,
                       help: "This field allow you to select a forecast date to plan your follow-ups",
                       default: self => toFormat(new Date(), 'yyyy-MM-dd')});
    static followupId = Fields.Many2one('followup.followup', {string: 'Follow-Up',
                                  required: true, readonly: true,
                                  default: self => self._getFollowup()});
    static partnerIds = Fields.Many2many('followup.stat.by.partner',{
        relation: 'partnerStatRel', column1: 'osvMemoryId', column2: 'partnerId', 
        string: 'Partners', required: true});
    static companyId = Fields.Many2one('res.company', {readonly: true,
                                 related: 'followupId.companyId'});
    static emailConf = Fields.Boolean('Send Email Confirmation');
    static emailSubject = Fields.Char('Email Subject', {size: 64,
                                default: self => self._t('Invoices Reminder')});
    static partnerLang = Fields.Boolean(
        'Send Email in Partner Language', {default: true,
        help: 'Do not change message text, if you want to send email in partner language, or configure from company'});
    static emailBody = Fields.Text('Email Body', {default: ''});
    static summary = Fields.Text('Summary', {readonly: true});
    static testPrint = Fields.Boolean(
        'Test Print', {help: 'Check if you want to print follow-ups without changing follow-up level.'});

    async processPartners(partnerIds, data) {
        let partnerObj = this.env.items('res.partner');
        const partnerIdsToPrint = [];
        const manuals = {};
        let nbmanuals = 0;
        let nbmails = 0;
        let nbunknownmails = 0;
        let nbprints = 0;
        let resulttext = " ";
        for (const partner of this.env.items('followup.stat.by.partner').browse(partnerIds)) {
            const [maxFollowup, ppartner] = await partner('maxFollowupId', 'partnerId');
            if (await maxFollowup.manualAction) {
                await partnerObj.doPartnerManualAction([ppartner.id]);
                nbmanuals = nbmanuals + 1;
                const key = await (await ppartner.paymentResponsibleId).label || await this._t("Anybody");
                if (!Object.keys(manuals).includes(key)) {
                    manuals[key] = 1;
                }
                else {
                    manuals[key] = manuals[key] + 1;
                }
            }
            if (await maxFollowup.sendEmail) {
                nbunknownmails += await ppartner.doPartnerMail();
                nbmails += 1;
            }
            if (await maxFollowup.sendLetter) {
                partnerIdsToPrint.push(partner.id);
                nbprints += 1;
                const followupWithoutLit = await ppartner.latestFollowupLevelIdWithoutLit;
                const message = f("%s<I> %s </I>%s", await this._t("Follow-up letter of "),
                    await followupWithoutLit.label, await this._t(" will be sent"));
                await ppartner.messagePost({body: message});
            }
        }
        if (nbunknownmails == 0) {
            resulttext += String(nbmails) + await this._t(" email(s) sent");
        }
        else {
            resulttext += String(nbmails) + await this._t(" email(s) should have been sent, but ") 
                + String(nbunknownmails) + await this._t(" had unknown email address(es)") + "\n <BR/> ";
        }
        resulttext += "<BR/>" + String(nbprints) + await this._t(" letter(s) in report") 
            + " \n <BR/>" + String(nbmanuals) + await this._t(" manual action(s) assigned:");
        let needprinting = false;
        if (nbprints > 0) {
            needprinting = true;
        }
        resulttext += "<p align=\"center\">";
        for (const item of Object.keys(manuals)) {
            resulttext = resulttext + "<li>" + item + ":" + String(manuals[item]) + "\n </li>";
        }
        resulttext += "</p>";
        const result = {};
        const action = await partnerObj.doPartnerPrint(partnerIdsToPrint, data);
        result['needprinting'] = needprinting;
        result['resulttext'] = resulttext;
        result['action'] = action || {}
        return result;
    }

    async doUpdateFollowupLevel(toUpdate, partnerList, date) {
        for (const id of Object.keys(toUpdate)) {
            if (partnerList.includes(toUpdate[id]['partnerId'])) {
                await this.env.items('account.move.line').browse([parseInt(id)]).write(
                    {'followupLineId': toUpdate[id]['level'],
                     'followupDate': date})
            }
        }
    }

    async clearManualActions(partnerList) {
        const partnerListIds = await this.env.items('followup.stat.by.partner').browse(partnerList)
            .map(async (partner) => (await partner.partnerId).id);
        const ids = await this.env.items('res.partner').search(
            ['&', ['id', 'not in', partnerListIds], '|',
             ['paymentResponsibleId', '!=', false],
             ['paymentNextActionDate', '!=', false]]);

        const partnersToClear = [];
        for (const part of ids) {
            if (! bool(await part.unreconciledAmlIds)) {
                partnersToClear.push(part.id);
                await part.actionDone();
            }
        }
        return len(partnersToClear);
    }

    async doProcess() {
        const context = new Dict<any>(this.env.context || {});

        const tmp = await this._getPartnersFollowp();
        const partnerList = tmp['partnerIds'];
        const toUpdate = tmp['toUpdate'];
        let date = await this['date'];
        const data = await this.readOne();
        data['followupId'] = data['followupId'][0];

        await this.doUpdateFollowupLevel(toUpdate, partnerList, date);
        const restotContext = Dict.from(context);
        const restot = await (await this.withContext(restotContext)).processPartners(
            partnerList, data);
        update(context, restotContext);
        const nbactionscleared = await this.clearManualActions(partnerList);
        if (nbactionscleared > 0) {
            restot['resulttext'] = restot['resulttext'] + "<li>" + f(await this._t(
                "%s partners have no credits and as such the action is cleared"), String(nbactionscleared)) + "</li>";
        }
        const resourceId = await this.env.ref('account_followup.viewAccountFollowupSendingResults');
        update(context, {'description': restot['resulttext'],
                        'needprinting': restot['needprinting'],
                        'reportData': restot['action']});
        return {
            'label': await this._t('Send Letters and Emails: Actions Summary'),
            'viewType': 'form',
            'context': context,
            'viewMode': 'tree,form',
            'resModel': 'followup.sending.results',
            'views': [[resourceId.id, 'form']],
            'type': 'ir.actions.actwindow',
            'target': 'new',
        }
    }

    async _getMsg() {
        return (await (await this.env.user()).companyId).followUpMsg;
    }

    async _getPartnersFollowp() {
        let data: any = this;
        const companyId = (await data.companyId).id;
        const context = this.env.context;
        const moveLines = await this._cr.execute(
            `SELECT
                    l."partnerId",
                    l."followupLineId",
                    l."dateMaturity",
                    l.date, 
                    l.id
                FROM "accountMoveLine" AS l
                LEFT JOIN "accountAccount" AS a
                ON (l."accountId"=a.id)
                WHERE (l."fullReconcileId" IS NULL)
                AND a."userTypeId" IN (SELECT id FROM "accountAccountType"
                    WHERE type = 'receivable')
                AND (l."partnerId" is NOT NULL)
                AND (l.debit > 0)
                AND (l."companyId" = %s)
                AND (l.blocked = false)
                ORDER BY l.date`, [companyId]);
        let old;
        const fups = {};
        const fupId = 'followupId' in context && context['followupId'] || (await data.followupId).id;
        let date = 'date' in context && context['date'] || await data.date;
        date = _Date.toString(date);
        const currentDate = new Date(toFormat(date, 'yyyy-MM-dd'));
        const res = await this._cr.execute(
            `SELECT *
            FROM "followupLine"
            WHERE "followupId"=%s
            ORDER BY delay`, [fupId]);

        for (const row of res) {
            fups[old] = [subDate(currentDate, {days: row['delay']}), row['id']];
            old = row['id'];
        }
        const partnerList = [];
        const toUpdate = {};

        for (let {partnerId, followupLineId, dateMaturity, date, id} of moveLines) {
            if (! partnerId) {
                continue;
            }
            if (!(followupLineId in fups)) {
                continue;
            }
            const statLineId = partnerId * 10000 + companyId;
            if (dateMaturity) {
                dateMaturity = _Date.toString(dateMaturity);
                if (dateMaturity <= fromFormat(fups[followupLineId][0], 'yyyy-MM-dd')) {
                    if (!partnerList.includes(statLineId)) {
                        partnerList.push(statLineId);
                    }
                    toUpdate[id] = {'level': fups[followupLineId][1],
                                    'partnerId': statLineId}
                }
            }
            else if (date && date <= fromFormat(fups[followupLineId][0], 'yyyy-MM-dd')) {
                if (!partnerList.includes(statLineId)) {
                    partnerList.push(statLineId);
                }
                toUpdate[id] = {'level': fups[followupLineId][1],
                                'partnerId': statLineId}
            }
        }
        return {'partnerIds': partnerList, 'toUpdate': toUpdate};
    }
}