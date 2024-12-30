import { DateTime } from "luxon";
import { _Date, api } from "../../../core";
import { DefaultDict, ValidationError } from "../../../core/helper";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _f, bool, formatDate } from "../../../core/tools";
import { toFormat } from "../../../core/tools/date_utils";

@MetaModel.define()
class AccountFollowupReport extends AbstractModel {
    static _module = module;
    static _name = 'report.account.followup';
    static _description = 'Report Followup';

    @api.model()
    async _getReportValues(docids, data?: any) {
        const model = this.env.items('followup.sending.results');
        const ids = this.env.context['activeIds'] || false;
        const docs = model.browse(ids);
        return {
            'docs': docs,
            'docIds': docids,
            'docModel': model,
            'now': () => new Date(),
            'idsToObjects': this._idsToObjects.bind(this),
            'getLines': this._linesGet.bind(this), // alternative way
            'getText': this._getText.bind(this),
            'data': data && data['form'] || {}
        }
    }

    async _idsToObjects(ids) {
        const allLines = [];
        for (const line of this.env.items('followup.stat.by.partner').browse(ids)) {
            if (!allLines.includes(line)) {
                allLines.push(line);
            }
        }
        return allLines;
    }

    async _linesGet(statByPartnerLine) {
        return this._linesGetWithPartner(await statByPartnerLine.partnerId,
                                            (await statByPartnerLine.companyId).id);
    }

    async _linesGetWithPartner(partner, companyId) {
        const movelineObj = this.env.items('account.move.line');
        const movelineIds = await movelineObj.search(
            [['partnerId', '=', partner.id],
             ['accountId.userTypeId.type', '=', 'receivable'],
             ['fullReconcileId', '=', false],
             ['companyId', '=', companyId],
             '|', ['dateMaturity', '=', false],
             ['dateMaturity', '<=', _Date.today()]]);
        const linesPerCurrency = new DefaultDict<any, []>();
        let total = 0;
        for (const line of movelineIds) {
            let [currency, company, debit, credit, amountCurrency, move, ref, date, dateMaturity, blocked] = await line('currencyId', 'companyId', 'debit', 'credit', 'amountCurrency', 'moveId', 'ref', 'date', 'dateMaturity', 'blocked');
            const companyCurrencyId = await company.currencyId;
            currency = bool(currency) ? currency : companyCurrencyId;
            let balance = debit - credit;
            if (!currency.eq(companyCurrencyId)) {
                balance = amountCurrency;
            }
            const lineData = {
                'label': await move.label,
                'ref': ref,
                'date': await formatDate(this.env, date),
                'dateMaturity': await formatDate(this.env, dateMaturity),
                'balance': balance,
                'blocked': blocked,
                'currencyId': currency,
            }
            total = total + lineData['balance'];
            if (!linesPerCurrency.has(currency)) {
                linesPerCurrency.set(currency, []);
            }
            linesPerCurrency.get(currency).push(lineData);
        }
        const res = [];
        for (const [currency, lines] of linesPerCurrency) {
          res.push({'total': total, 'line': lines, 'currency': currency});
        }
        return res;
    }

    async _getText(statLine, followupId, context?: any) {
        const fpObj = this.env.items('followup.followup');
        const fpLine = await fpObj.browse(followupId).followupLine;
        if (! bool(fpLine)) {
            throw new ValidationError(
                await this._t("The followup plan defined for the current company does not have any followup action."));
        }
        let defaultText = '';
        const liDelay = [];
        for (const line of fpLine) {
            const [description, delay] = await line('description', 'delay');
            if (! defaultText && description) {
                defaultText = description;
            }
            liDelay.push(delay);
        }
        liDelay.reverse();
        const partnerLineIds = await this.env.items('account.move.line').search(
            [['partnerId', '=', (await statLine.partnerId).id],
             ['fullReconcileId', '=', false],
             ['companyId', '=', (await statLine.companyId).id],
             ['blocked', '=', false],
             ['debit', '!=', false],
             ['accountId.userTypeId.type', '=', 'receivable'],
             ['followupLineId', '!=', false]]);

        let partnerMaxDelay = 0;
        let partnerMaxText = '';
        for (const i of partnerLineIds) {
            const followupLine = i.followupLineId;
            if (await followupLine.delay > partnerMaxDelay && await followupLine.description) {
                partnerMaxDelay = await followupLine.delay;
                partnerMaxText = await followupLine.description;
            }
        }
        let text = partnerMaxDelay && partnerMaxText || defaultText;
        if (text) {
            const [partner, company] = await statLine('partnerId', 'companyId');
            const langObj = this.env.items('res.lang');
            const langIds = await langObj.search(
                [['code', '=', await partner.lang]], {limit: 1});
            const dateFormat = bool(langIds) && await langIds.dateFormat || 'yyyy-MM-dd';
            text = _f(text, {
                'partnerName': await partner.label,
                'date': toFormat(new Date(), dateFormat),
                'companyName': await company.label,
                'userSignature': await (await this.env.user()).signature || '',
            });
        }
        return text;
    }
}
