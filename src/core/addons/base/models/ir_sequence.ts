import { api } from "../../..";
import { Fields, _Date, _Datetime } from "../../../fields";
import { UserError } from "../../../helper/errors";
import { MetaModel, Model, _super } from "../../../models";
import { Cursor } from "../../../sql_db";
import { _f, addDate, bool, dateSetTz, f, quoteDouble, toFormat } from "../../../tools";

function seqId(id) { return `irSequence_` + `${id}`.padStart(3, '0') };

async function _createSequence(cr: Cursor, seqName, numberIncrement, numberNext) {
    if (numberIncrement == 0) {
        throw new UserError(await this._t('Step must not be zero.'));
    }
    const sql = `CREATE SEQUENCE ${seqName} INCREMENT BY ${numberIncrement} START WITH ${numberNext}`;
    await cr.execute(sql);
}

/**
 * Drop the PostreSQL sequences if they exist.
 * @param cr 
 * @param seqNames 
 */
async function _dropSequences(cr: Cursor, seqNames: string[]) {
    const names = seqNames.map(name => quoteDouble(name)).join(',');
    // RESTRICT is the default; it prevents dropping the sequence if an
    // object depends on it.
    await cr.execute(`DROP SEQUENCE IF EXISTS ${names} RESTRICT`);
}

/**
 * Alter a PostreSQL sequence.
 * @param cr 
 * @param seqName 
 * @param numberIncrement 
 * @param numberNext 
 * @returns 
 */
async function _alterSequence(cr: Cursor, seqName, numberIncrement?: any, numberNext?: any) {
    if (numberIncrement == 0) {
        throw new UserError(await this._t("Step must not be zero."));
    }
    const res = await cr.execute(`SELECT relname FROM pg_class WHERE relkind='S' AND relname='${seqName}'`);
    if (!res.length) {
        // sequence is not created yet, we're inside create() so ignore it, will be set later
        return;
    }
    let statement = `ALTER SEQUENCE "${seqName}"`;
    const params = [];
    if (numberIncrement != null) {
        statement += " INCREMENT BY %s"
        params.push(numberIncrement);
    }
    if (numberNext != null) {
        statement += " RESTART WITH %s";
        params.push(numberNext);
    }
    await cr.execute(statement, params);
}

async function _selectNextval(cr, seqName) {
    const res = await cr.execute(`SELECT nextval('${seqName}')`);
    return parseInt(res[0]['nextval']);
}

async function _updateNogap(self: any, numberIncrement) {
    const numberNext = await self.numberNext;
    await self._cr.execute(`SELECT "numberNext" FROM "${self.cls._table}" WHERE id=${self.id} FOR UPDATE NOWAIT`);
    await self._cr.execute(`UPDATE "${self.cls._table}" SET "numberNext"="numberNext"+${numberIncrement} WHERE id=${self.id}`);
    self.invalidateCache(['numberNext'], [self.id]);
    return numberNext;
}

/**
 * Predict next value for PostgreSQL sequence without consuming it
 * @param self 
 * @param seqId 
 * @returns 
 */
async function _predictNextval(self, id) {
    // Cannot use currval() as it requires prior call to nextval()
    const seqname = seqId(id);
    let query = `SELECT last_value,
                      (SELECT increment_by
                       FROM pg_sequences
                       WHERE sequencename = '${seqname}'),
                      is_called
               FROM {}`;
    let params = [seqname];
    if (self.env.cr._cnx.serverVersion < 100000) {
        query = `SELECT last_value, increment_by, is_called FROM {}`;
        params = [];
    }
    const res = await self.env.cr.execute(query, { params: params });
    const { last_value, increment_by, is_called } = res[0];
    if (is_called) {
        return last_value + increment_by;
    }
    // sequence has just been RESTARTed to return last_value next time
    return last_value;
}

@MetaModel.define()
class IrSequence extends Model {
    static _module = module;
    static _name = 'ir.sequence';
    static _description = 'Sequence';
    static _order = 'label';

    static label = Fields.Char({ required: true });
    static code = Fields.Char({ string: 'Sequence Code' });
    static implementation = Fields.Selection([['standard', 'Standard'], ['nogap', 'No gap']], { string: 'Implementation', required: true, default: 'standard', help: "While assigning a sequence number to a record, the 'no gap' sequence implementation ensures that each previous sequence number has been assigned already. While this sequence implementation will not skip any sequence number upon assignment, there can still be gaps in the sequence if records are deleted. The 'no gap' implementation is slower than the standard one." });
    static active = Fields.Boolean({ default: true });
    static prefix = Fields.Char({ help: "Prefix value of the record for the sequence", trim: false });
    static suffix = Fields.Char({ help: "Suffix value of the record for the sequence", trim: false });
    static numberNext = Fields.Integer({ string: 'Next Number', required: true, default: 1, help: "Next number of this sequence" });
    static numberNextActual = Fields.Integer({ compute: '_getNumberNextActual', inverse: '_setNumberNextActual', string: 'Actual Next Number', help: "Next number that will be used. This number can be incremented frequently so the displayed value might already be obsolete" });
    static numberIncrement = Fields.Integer({ string: 'Step', required: true, default: 1, help: "The next number of the sequence will be incremented by this number" });
    static padding = Fields.Integer({ string: 'Sequence Size', required: true, default: 0, help: "Verp will automatically adds some '0' on the left of the 'Next Number' to get the required padding size." });
    static companyId = Fields.Many2one('res.company', { string: 'Company', default: async (self) => await self.env.company() });
    static useDaterange = Fields.Boolean({ string: 'Use subsequences per daterange' });
    static daterangeIds = Fields.One2many('ir.sequence.daterange', 'sequenceId', { string: 'Subsequences' });

    /**
     * Create a sequence, in implementation == standard a fast gaps-allowed PostgreSQL sequence is used.
     * @param values 
     * @returns 
     */
    @api.model()
    async create(values) {
        const seq = await _super(IrSequence, this).create(values);
        if ((values['implementation'] ?? 'standard') === 'standard') {
            await _createSequence(this._cr, seqId(seq.id), values['numberIncrement'] ?? 1, values['numberNext'] ?? 1);
        }
        return seq;
    }

    async unlink() {
        await _dropSequences(this._cr, (await this.mapped('id')).map(id => seqId(id)));
        return _super(IrSequence, this).unlink();
    }

    async write(values) {
        const newImplementation = values['implementation'];
        const self: any = this;
        for (const seq of self) {
            // 4 cases: we test the previous impl. against the new one.
            const i = values['numberIncrement'] ?? await seq.numberIncrement;
            const n = values['numberNext'] ?? await seq.numberNext;
            if (await seq.implementation === 'standard') {
                if (['standard', null].includes(newImplementation)) {
                    // Implementation has NOT changed.
                    // Only change sequence if really requested.
                    if (values['numberNext']) {
                        await _alterSequence(self._cr, seqId(seq.id), n);
                    }
                    if (await seq.numberIncrement !== i) {
                        await _alterSequence(self._cr, seqId(seq.id), i);
                        await (await seq.daterangeIds)._alterSequence(i);
                    }
                }
                else {
                    await _dropSequences(self._cr, [seqId(seq.id)]);
                    for (const subSeq of await seq.daterangeIds) {
                        await _dropSequences(self._cr, [seqId(seq.id) + '_' + `${subSeq.id}`.padStart(3, '0')]);
                    }
                }
            }
            else {
                if (!['noGap', null].includes(newImplementation)) {
                    await _createSequence(self._cr, seqId(seq.id), i, n);
                    for (const subSeq of await seq.daterangeIds) {
                        await _createSequence(self._cr, seqId(seq.id) + '_' + `${subSeq.id}`.padStart(3, '0'), i, n);
                    }
                }
            }
        }
        const res = await _super(IrSequence, this).write(values);
        await this.flush(Object.keys(values));
        return res;
    }


    async _nextDo() {
        let numberNext;
        if (await this['implementation'] === 'standard') {
            numberNext = await _selectNextval(this._cr, f('irSequence_%s', String(this.id).padStart(3, '0')));
        }
        else {
            numberNext = await _updateNogap(this, await this['numberIncrement']);
        }
        return this.getNextChar(numberNext);
    }

    async _getPrefixSuffix(date?: any, daterange?: any) {
        function interpolate(s, d) {
            return s ? _f(s, d) : '';
        }
        function interpolationDict() {
            const now = dateSetTz(new Date(), self._context['tz'] || 'UTC');
            let rangeDate = now,
                effectiveDate = now;
            if (date || self._context['irSequenceDate']) {
                effectiveDate = _Datetime.toDatetime(date || self._context['irSequenceDate']) as Date;
            }
            if (daterange || self._context['irSequenceDaterange']) {
                rangeDate = _Datetime.toDatetime(daterange || self._context['irSequenceDaterange']) as Date;
            }

            const sequences = {
                'year': 'yyyy', 'month': 'MM', 'day': 'dd', 'y': 'yy', 'doy': 'o', 'woy': 'W',
                'weekday': 'c', 'h24': 'HH', 'h12': 'hh', 'min': 'mm', 'sec': 'ss'
            };
            const res = {};
            for (const [key, format] of Object.entries(sequences)) {
                res[key] = toFormat(effectiveDate, format);
                res['range' + key] = toFormat(rangeDate, format);
                res['current' + key] = toFormat(now, format);
            }
            return res;
        }
        this.ensureOne();
        const self = this;
        const d = interpolationDict();
        let interpolatedPrefix, interpolatedSuffix;
        try {
            interpolatedPrefix = interpolate(await this['prefix'], d);
            interpolatedSuffix = interpolate(await this['suffix'], d);
        } catch (e) {
            throw new UserError(await this._t("Invalid prefix or suffix for sequence '%s'", await this['label']));
        }
        return [interpolatedPrefix, interpolatedSuffix];
    }

    async getNextChar(numberNext) {
        const [interpolatedPrefix, interpolatedSuffix] = await this._getPrefixSuffix();
        return interpolatedPrefix + String(numberNext).padStart(await this['padding'], '0') + interpolatedSuffix;
    }

    async _createDaterangeSeq(date) {
        const year = toFormat(date, 'yyyy');
        let dateFrom: any = _f('{year}-01-01', { year }),
            dateTo: any = _f('{year}-12-31', { year }),
            daterange = await this.env.items('ir.sequence.daterange').search([['sequenceId', '=', this.id], ['dateFrom', '>=', date], ['dateFrom', '<=', dateTo]], { order: 'dateFrom desc', limit: 1 });
        if (bool(daterange)) {
            dateTo = addDate(await daterange.dateFrom, { days: -1 });
        }
        daterange = await this.env.items('ir.sequence.daterange').search([['sequenceId', '=', this.id], ['dateTo', '>=', dateFrom], ['dateTo', '<=', date]], { order: 'dateTo desc', limit: 1 });
        if (bool(daterange)) {
            dateFrom = addDate(await daterange.dateTo, { days: 1 });
        }
        const seqDaterange = await (await this.env.items('ir.sequence.daterange').sudo()).create({
            'dateFrom': dateFrom,
            'dateTo': dateTo,
            'sequenceId': this.id,
        });
        return seqDaterange;
    }

    /**
     * Returns the next number in the preferred sequence in all the ones given in self.
     * @param sequenceDate 
     * @returns 
     */
    async _next(sequenceDate?: any) {
        if (! await this['useDaterange']) {
            return this._nextDo();
        }
        // date mode
        const dt = sequenceDate || (this._context['irSequenceDate'] ?? _Date.today());
        let seqDate = await this.env.items('ir.sequence.daterange').search([['sequenceId', '=', this.id], ['dateFrom', '<=', dt], ['dateTo', '>=', dt]], { limit: 1 });
        if (!seqDate.ok) {
            seqDate = await this._createDaterangeSeq(dt);
        }
        return (await seqDate.withContext({ irSequenceDaterange: await seqDate.dateFrom }))._next();
    }

    /**
     * Draw an interpolated string using the specified sequence.
     * @param sequenceDate 
     * @returns 
     */
    async nextById(sequenceDate?: any) {
        await this.checkAccessRights('read');
        return this._next(sequenceDate);
    }

    /**
     * Draw an interpolated string using a sequence with the requested code.
            If several sequences with the correct code are available to the user
            (multi-company cases), the one from the user's current company will
            be used.
     * @param sequenceCode 
     * @param sequenceDate 
     * @returns 
     */
    @api.model()
    async nextByCode(sequenceCode, sequenceDate?: any) {
        await this.checkAccessRights('read');
        const companyId = (await this.env.company()).id;
        const seqIds = await this.search([['code', '=', sequenceCode], ['companyId', 'in', [companyId, false]]], { order: 'companyId' });
        if (!seqIds.ok) {
            console.debug("No ir.sequence has been found for code '%s'. Please make sure a sequence is set for current company.", sequenceCode);
            return false;
        }
        const seqId = seqIds[0];
        return seqId._next(sequenceDate);
    }

    /**
     * Draw an interpolated string using the specified sequence.

        The sequence to use is specified by the ``sequenceCodeOrId``
        argument, which can be a code or an id (as controlled by the
        ``codeOrId`` argument. This method is deprecated.
     * @param sequenceCodeOrId 
     * @param codeOrId 
     * @returns 
     */
    @api.model()
    async getId(sequenceCodeOrId, codeOrId = 'id') {
        if (codeOrId === 'id') {
            return this.browse(sequenceCodeOrId).nextById();
        }
        else {
            return this.nextByCode(sequenceCodeOrId);
        }
    }

    /**
     * Draw an interpolated string using the specified sequence.
     * @param code 
     * @returns 
     */
    @api.model()
    async get(code) {
        return this.getId(code, 'code');
    }
}

@MetaModel.define()
class IrSequenceDaterange extends Model {
    static _module = module;
    static _name = 'ir.sequence.daterange';
    static _description = 'Sequence Date Range';
    static _recName = "sequenceId";

    static dateFrom = Fields.Date({ string: 'From', required: true });
    static dateTo = Fields.Date({ string: 'To', required: true });
    static sequenceId = Fields.Many2one("ir.sequence", { string: 'Main Sequence', required: true, ondelete: 'CASCADE' });
    static numberNext = Fields.Integer({ string: 'Next Number', required: true, default: 1, help: "Next number of this sequence" });
    static numberNextActual = Fields.Integer({ compute: '_getNumberNextActual', inverse: '_setNumberNextActual', string: 'Actual Next Number', help: "Next number that will be used. This number can be incremented frequently so the displayed value might already be obsolete" });

    /**
     * Return number from irSequence row when noGap implementation, and number from postgres sequence when standard implementation.
     */
    async _getNumberNextActual() {
        const self: any = this;
        for (const seq of self) {
            const sequenceId = seq.sequenceId;
            if (await sequenceId.implementation != 'standard') {
                seq.numberNextActual = await seq.numberNext;
            }
            else {
                const id = `${sequenceId.id}`.padStart(3, '0') + '_' + `${seq.id}`.padStart(3, '0');
                seq.numberNextActual = await _predictNextval(self, id);
            }
        }
    }

    async _setNumberNextActual() {
        const self: any = this;
        for (const seq of self) {
            await seq.write({ 'numberNext': await seq.numberNextActual ?? 1 });
        }
    }

    @api.model()
    async defaultGet(fields) {
        const result = await _super(IrSequenceDaterange, this).defaultGet(fields);
        result['numberNextActual'] = 1;
        return result;
    }

    async _next() {
        const sequence = await this['sequenceId'];
        let numberNext;
        if (await sequence.implementation === 'standard') {
            numberNext = await _selectNextval(this._cr, f('irSequence_%s_%s', String(sequence.id).padStart(3, '0'), String(this.id).padStart(3, '0')));
        }
        else {
            numberNext = await _updateNogap(self, await sequence.numberIncrement);
        }
        return sequence.getNextChar(numberNext);
    }

    async _alterSequence(numberIncrement?: any, numberNext?: any) {
        for (const seq of this) {
            await _alterSequence(this._cr, f("irSequence_%s_%s", String((await seq.sequenceId).id).padStart(3, '0'), String(seq.id).padStart(3, '0')), numberIncrement, numberNext);
        }
    }

    /**
     * Create a sequence, in implementation == standard a fast gaps-allowed PostgreSQL sequence is used.
     * @param values 
     * @returns 
     */
    @api.model()
    async create(values) {
        const seq = await _super(IrSequenceDaterange, this).create(values);
        const mainSeq = await seq.sequenceId;
        if (await mainSeq.implementation === 'standard') {
            await _createSequence(this._cr, f("irSequence_%03d_%03d", String(mainSeq.id).padStart(3, '0'), String(seq.id).padStart(3, '0')), await mainSeq.numberIncrement, values['numberNextActual'] ?? 1);
        }
        return seq;
    }

    async unlink() {
        const self: any = this;
        const seqs = [];
        for (const x of self) {
            const sequenceId = await x.sequenceId;
            seqs.push(seqId(sequenceId.id) + '_' + `${x.id}`.padStart(3, '0'));
        }
        await _dropSequences(this._cr, seqs);
        return _super(IrSequenceDaterange, this).unlink();
    }

    async write(values) {
        if (values['numberNext']) {
            const seqToAlter: any = await this.filtered(async (seq) => (await (await seq.sequenceId).implementation) === 'standard');
            await seqToAlter._alterSequence(values['numberNext']);
        }
        const res = await _super(IrSequenceDaterange, this).write(values);
        await this.flush(values.keys());
        return res;
    }
}