import _ from "lodash";
import { Fields, api } from "../../../core";
import { DefaultDict2 } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { _f, formatDate, sorted, sortedAsync } from "../../../core/tools";
import { enumerate, len, range } from "../../../core/tools/iterable";
import { stringify } from "../../../core/tools/json";

@MetaModel.define()
class ReSequenceWizard extends TransientModel {
    static _module = module;
    static _name = 'account.resequence.wizard';
    static _description = 'Remake the sequence of Journal Entries.';

    static sequenceNumberReset = Fields.Char({ compute: '_computeSequenceNumberReset' });
    static firstDate = Fields.Date({ help: "Date (inclusive) from which the numbers are resequenced." });
    static endDate = Fields.Date({ help: "Date (inclusive) to which the numbers are resequenced. If not set, all Journal Entries up to the end of the period are resequenced." });
    static firstName = Fields.Char({ compute: "_computeFirstName", readonly: false, store: true, required: true, string: "First New Sequence" });
    static ordering = Fields.Selection([['keep', 'Keep current order'], ['date', 'Reorder by accounting date']], { required: true, default: 'keep' });
    static moveIds = Fields.Many2many('account.move');
    static newValues = Fields.Text({ compute: '_computeNewValues' });
    static previewMoves = Fields.Text({ compute: '_computePreviewMoves' });

    @api.model()
    async defaultGet(fieldsList) {
        const values = await _super(ReSequenceWizard, this).defaultGet(fieldsList);
        if (!fieldsList.includes('moveIds')) {
            return values;
        }
        let activeMoveIds = this.env.items('account.move');
        if (this.env.context['activeModel'] === 'account.move' && 'activeIds' in this.env.context) {
            activeMoveIds = this.env.items('account.move').browse(this.env.context['activeIds']);
        }
        if (len(await activeMoveIds.journalId) > 1) {
            throw new UserError(await this._t('You can only resequence items from the same journal'));
        }
        const moveTypes = new Set(await activeMoveIds.mapped('moveType'));
        if (
            await (await activeMoveIds.journalId).refundSequence
            && (moveTypes.has('inRefund') || moveTypes.has('outRefund'))
            && len(moveTypes) > 1
        ) {
            throw new UserError(await this._t('The sequences of this journal are different for Invoices and Refunds but you selected some of both types.'));
        }
        values['moveIds'] = [[6, 0, activeMoveIds.ids]];
        return values;
    }

    @api.depends('firstName')
    async _computeSequenceNumberReset() {
        for (const record of this) {
            await record.set('sequenceNumberReset', await (await record.moveIds)[0]._deduceSequenceNumberReset(await record.firstName));
        }
    }

    @api.depends('moveIds')
    async _computeFirstName() {
        await this.set('firstName', "");
        for (const record of this) {
            const moveIds = await record.moveIds;
            if (moveIds.ok) {
                await record.set('firstName', Math.min(await moveIds._origin.mapped(async (move) => await move.label || "")));
            }
        }
    }

    /**
     * Reduce the computed new_values to a smaller set to display in the preview.
     */
    @api.depends('newValues', 'ordering')
    async _computePreviewMoves() {
        for (const record of this) {
            const newValues = sorted(Object.values(JSON.parse(await record.newValues)), (x) => x['server-date'], true);
            const changeLines = [];
            let inElipsis = 0;
            let previousLine;// = None
            for (const [i, line] of enumerate(newValues)) {
                if (i < 3 || i == len(newValues) - 1 || line['newByName'] !== line['newByDate']
                    || (await this['sequenceNumberReset'] === 'year' && _.difference(line['server-date'].slice(0, 4), previousLine['server-date'].slice(0, 4)).length)
                    || (await this['sequenceNumberReset'] === 'month' && _.difference(line['server-date'].slice(0, 7), previousLine['server-date'].slice(0, 7)).length)) {
                    if (inElipsis) {
                        changeLines.push({ 'id': 'other_' + String(line['id']), 'currentName': await this._t('... (%s other)', inElipsis), 'newByName': '...', 'newByDate': '...', 'date': '...' });
                        inElipsis = 0;
                    }
                    changeLines.push(line);
                }
                else {
                    inElipsis += 1;
                }
                previousLine = line;
            }

            await record.set('previewMoves', stringify({
                'ordering': await record.ordering,
                'changeLines': changeLines,
            }));
        }
    }

    /**
     * Compute the proposed new values.

        Sets a json string on new_values representing a dictionary thats maps account.move
        ids to a disctionay containing the name if we execute the action, and information
        relative to the preview widget.
     * @returns 
     */
    @api.depends('firstName', 'moveIds', 'sequenceNumberReset')
    async _computeNewValues() {
        const sequenceNumberReset = this['sequenceNumberReset'];

        function _getMoveKey(date) {
            if (sequenceNumberReset === 'year') {
                return date.getFullYear();;
            }
            else if (sequenceNumberReset === 'month') {
                return [date.getFullYear(), date.getMonth() + 1].join('/');
            }
            return 'default';
        }

        await this.set('newValues', "{}");
        for (const record of await this.filtered('firstName')) {
            const movesByPeriod = new DefaultDict2(() => record.env.items('account.move'));
            for (const move of (await record.moveIds)._origin) {  // Sort the moves by period depending on the sequence number reset
                movesByPeriod[_getMoveKey(await move.date)] = movesByPeriod[_getMoveKey(await move.date)].add(move);
            }

            const [seqFormat, formatValues] = await (await record.moveIds)[0]._getsequenceFormatParam(await record.firstName);

            const newValues = {};
            for (const [j, periodRecs] of enumerate(movesByPeriod.values())) {
                // compute the new values period by period
                for (const move of periodRecs) {
                    newValues[move.id] = {
                        'id': move.id,
                        'currentName': await move.label,
                        'state': await move.state,
                        'date': await formatDate(this.env, await move.date),
                        'server-date': String(await move.date),
                    }
                }
                const date0: Date = await periodRecs[0].date;
                const newNameList = Array.from(range(len(periodRecs))).map(i => _f(seqFormat, {
                    ...formatValues,
                    'year': date0.getFullYear() % (10 ** formatValues['yearLength']),
                    'month': date0.getMonth() + 1,
                    'seq': i + (j == (len(movesByPeriod) - 1) ? formatValues['seq'] : 1),
                }));

                // For all the moves of this period, assign the name by increasing initial name
                for (const [move, newName] of _.zip(await sortedAsync(periodRecs, async (m) => [await m.sequencePrefix, await m.sequenceNumber].join('-')), newNameList)) {
                    newValues[move.id]['newByName'] = newName;
                }
                // For all the moves of this period, assign the name by increasing date
                for (const [move, newName] of _.zip(await sortedAsync(periodRecs, async (m) => [await m.date, await m.label || "", m.id].join('-')), newNameList)) {
                    newValues[move.id]['newByDate'] = newName;
                }
            }

            await record.set('newValues', stringify(newValues));
        }
    }

    async resequence() {
        const newValues = JSON.parse(await this['newValues']);
        const journalId = (await this['moveIds']).journalId;
        if (journalId.ok && await journalId.restrictModeHashTable) {
            if (await this['ordering'] === 'date') {
                throw new UserError(await this._t('You can not reorder sequence by date when the journal is locked with a hash.'));
            }
        }
        await this.env.items('account.move').browse(Object.keys(newValues).map(k => parseInt(k))).set('label', false);
        for (const moveId of await this['moveIds']) {
            if (moveId.id in newValues) {
                if (await this['ordering'] === 'keep') {
                    await moveId.set('label', newValues[moveId.id]['newByName']);
                }
                else {
                    await moveId.set('label', newValues[moveId.id]['newByDate']);
                }
            }
        }
    }
}