import { Fields, _Date, api } from "../../../core";
import { DefaultDict } from "../../../core/helper/collections";
import { ValidationError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel } from "../../../core/models";
import { _f, bool, formatDate, len, pop } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";

function _format(format: string, formatValues: {} = {}) {
  return _f(format, formatValues);
}
/**
 * Mechanism used to have an editable sequence number.

    Be careful of how you use this regarding the prefixes. More info in the docstring of _getLastSequence.
 */
@MetaModel.define()
class SequenceMixin extends AbstractModel {
  static _module = module;
  static _name = 'sequence.mixin';
  static _description = "Automatic sequence";

  static _sequenceField = "label";
  static _sequenceDateField = "date";
  static _sequenceIndex = false;

  get _sequenceField() { return "label" };
  get _sequenceDateField() { return "date" };
  get _sequenceIndex() { return false };

  async _sequenceMonthlyRegex() { return /^(?<prefix1>.*?)(?<year>((?<=\D)|(?<=^))((19|20|21)\d{2}|(\d{2}(?=\D))))(?<prefix2>\D*?)(?<month>(0[1-9]|1[0-2]))(?<prefix3>\D+?)(?<seq>\d*)(?<suffix>\D*?)$/g; }
  async _sequenceYearlyRegex() { return /^(?<prefix1>.*?)(?<year>((?<=\D)|(?<=^))((19|20|21)?\d{2}))(?<prefix2>\D+?)(?<seq>\d*)(?<suffix>\D*?)$/g; }
  async _sequenceFixedRegex() { return /^(?<prefix1>.*?)(?<seq>\d{0,9})(?<suffix>\D*?)$/g; }

  static sequencePrefix = Fields.Char({ compute: '_computeSplitSequence', store: true });
  static sequenceNumber = Fields.Integer({ compute: '_computeSplitSequence', store: true });

  async init() {
    // Add an index to optimise the query searching for the highest sequence number
    if (!this.cls._abstract && this._sequenceIndex) {
      const indexName = this.cls._table + '_sequence_index';
      const res = await this.env.cr.execute(`SELECT indexname FROM pg_indexes WHERE indexname = '%s'`, [indexName,]);
      if (!res.length) {
        await this.env.cr.execute(_f(`
            CREATE INDEX "{indexName}" ON "{table}" ("{sequenceIndex}", "sequencePrefix" desc, "sequenceNumber" desc, "{field}");
            CREATE INDEX "{index2Name}" ON "{table}" ("{sequenceIndex}", id desc, "sequencePrefix");
        `, {
          sequenceIndex: (this._sequenceIndex),
          indexName: indexName,
          index2Name: indexName + "2",
          table: this.cls._table,
          field: this._sequenceField,
        }))
      }
    }
  }

  @api.constrains((model) => [model._sequenceField, model._sequenceDateField])
  async _constrainsDateSequence() {
    // Make it possible to bypass the constraint to allow edition of already messed up documents. /!\ Do not use this to completely disable the constraint as it will make this mixin unreliable.
    const constraintDate = _Date.toDate(await (await this.env.items('ir.config.parameter').sudo()).getParam(
      'sequence.mixin.constraintStartDate',
      '1970-01-01'
    ));
    for (const record of this) {
      const date = _Date.toDate(await record[record._sequenceDateField]) as Date;
      const sequence = await record[record._sequenceField];
      if (bool(sequence) && date && date > constraintDate) {
        const [, formatValues] = await record._getSequenceFormatParam(sequence);
        if (
          formatValues['year'] && formatValues['year'] != (date.getFullYear() % (10 ** String(formatValues['year']).length))
          || formatValues['month'] && formatValues['month'] != (date.getMonth()+1)
        ) {
          throw new ValidationError(_f(await this._t(
            `The {dateField} ({date}) doesn't match the sequence number of the related {model} {sequence})\n"
                        "You will need to clear the {model}'s {sequenceField} to proceed.\n"
                        "In doing so, you might want to resequence your entries in order to maintain a continuous date-based sequence.`), {
            date: await formatDate(this.env, date),
            sequence: sequence,
            dateField: await record._fields[record._sequenceDateField]._descriptionString(record._fields[record._sequenceDateField], this.env),
            sequenceField: await record._fields[record._sequenceField]._descriptionString(record._fields[record._sequenceField], this.env),
            model: await (await this.env.items('ir.model')._get(record._name)).displayName,
          }));
        }
      }
    }
  }

  @api.depends((self) => [self._sequenceField])
  async _computeSplitSequence() {
    for (const record of this) {
      const sequence = String(await record[record._sequenceField] || '');
      const regex = new RegExp((await this._sequenceFixedRegex()).source.replace("?<seq>", "").replace("\?<\w+>", "?:"), 'g');  // make the seq the only matching group
      const matching = sequence.matchAll(regex).next().value;
      await record.set('sequencePrefix', sequence.slice(0, matching && matching[1].length));
      await record.set('sequenceNumber', parseInt(matching && matching[2] || '0'));
    }
  }

  /**
   * Detect if the used sequence resets yearly, montly or never.
 
    :param name: the sequence that is used as a reference to detect the resetting
        periodicity. Typically, it is the last before the one you want to give a
        sequence.
   * @param name 
   * @returns 
   */
  @api.model()
  async _deduceSequenceNumberReset(label) {
    const list: [RegExp, string, string[]][] = [
      [await this._sequenceMonthlyRegex(), 'month', ['seq', 'month', 'year']],
      [await this._sequenceYearlyRegex(), 'year', ['seq', 'year']],
      [await this._sequenceFixedRegex(), 'never', ['seq']],
    ];
    label = label || '';
    for (const [regex, retVal, requirements] of list) {
      const match = String(label).matchAll(regex).next().value;
      const groups = match && match.groups || {};
      if (requirements.every(req => req in groups)) {
        return retVal;
      }
    }
    throw new ValidationError(await this._t(
      `The label "${label}" is wrong or regex should at least contain the seq grouping keys. For instance:
              '^(?<prefix1>.*?)(?<seq>\d*)(?<suffix>\D*?)$`
    ))
  }

  /**
   * Get the sql domain to retreive the previous sequence number.
  
          This function should be overriden by models inheriting from this mixin.
  
          :param relaxed: see _get_last_sequence.
  
          :returns: tuple(where_string, where_params): with
              where_string: the entire SQL WHERE clause as a string.
              where_params: a dictionary containing the parameters to substitute
                  at the execution of the query.
   * @param relaxed 
   * @returns 
   */
  async _getLastSequenceDomain(relaxed: boolean = false): Promise<[string, {}]> {
    this.ensureOne();
    return ["", {}];
  }

  /**
   * Get a default sequence number.
 
      This function should be overriden by models heriting from this mixin
      This number will be incremented so you probably want to start the sequence at 0.
 
      :return: string to use as the default sequence to increment
   * @returns 
   */
  async _getStartingSequence() {
    this.ensureOne();
    return "00000000";
  }

  /**
   * Retrieve the previous sequence.
 
      This is done by taking the number with the greatest alphabetical value within
      the domain of _get_last_sequence_domain. This means that the prefix has a
      huge importance.
      For instance, if you have INV/2019/0001 and INV/2019/0002, when you rename the
      last one to FACT/2019/0001, one might expect the next number to be
      FACT/2019/0002 but it will be INV/2019/0002 (again) because INV > FACT.
      Therefore, changing the prefix might not be convenient during a period, and
      would only work when the numbering makes a new start (domain returns by
      _get_last_sequence_domain is [], i.e: a new year).
 
      :param fieldName: the field that contains the sequence.
      :param relaxed: this should be set to true when a previous request didn't find
          something without. This allows to find a pattern from a previous period, and
          try to adapt it for the new period.
      :param with_prefix: The sequence prefix to restrict the search on, if any.
 
      :return: the string of the previous sequence or None if there wasn't any.
   * @param relaxed 
   * @param withPrefix 
   * @returns 
   */
  async _getLastSequence(relaxed: boolean = false, withPrefix?: any) {
    this.ensureOne();
    if (!(this._sequenceField in this._fields) || !this._fields[this._sequenceField].store) {
      throw new ValidationError(await this._t('%s is not a stored field', this._sequenceField));
    }
    let [whereString, param] = await this._getLastSequenceDomain(relaxed);
    if (bool(this.id) || bool(this.id.origin)) {
      whereString += " AND id != {id} ";
      param['id'] = bool(this.id) ? this.id : this.id.origin;
    }
    if (withPrefix) {
      whereString += ` AND "sequencePrefix" = {withPrefix} `;
      param['withPrefix'] = withPrefix;
    }

    const query = _f(`
        UPDATE "{table}" SET "updatedAt" = "updatedAt" WHERE id = (
            SELECT id FROM "{table}"
            {whereString}
            AND "sequencePrefix" = (SELECT "sequencePrefix" FROM "{table}" {whereString} ORDER BY id DESC LIMIT 1)
            ORDER BY "sequenceNumber" DESC
            LIMIT 1
        )
        RETURNING "{field}";
    `, {
      table: this.cls._table,
      whereString: whereString,
      field: this._sequenceField,
    })

    await this.flush([this._sequenceField, 'sequenceNumber', 'sequencePrefix']);
    const res = await this.env.cr.execute(_f(query, param));
    return res.length ? res[0][this._sequenceField] : null;
  }

  /**
   * Get the format and format values for the sequence.
 
    @param previous: the sequence we want to extract the format from
    @return [format, formatValues]:
        format is the format string on which we should call .format()
        format_values is the dict of values to format the `format` string
        ``format.format(...formatValues)`` should be equal to ``previous``
   */
  async _getSequenceFormatParam(previous: string) {
    const sequenceNumberReset = await this._deduceSequenceNumberReset(previous);
    let regex = await this._sequenceFixedRegex();
    if (sequenceNumberReset === 'year') {
      regex = await this._sequenceYearlyRegex();
    }
    else if (sequenceNumberReset === 'month') {
      regex = await this._sequenceMonthlyRegex();
    }
    const match = String(previous || '').matchAll(regex).next().value;
    const formatValues: any = match?.groups ?? {};
    formatValues['seqLength'] = len(formatValues['seq']);
    formatValues['yearLength'] = len(formatValues['year'] || '');
    if (!formatValues['seq'] && 'prefix1' in formatValues && 'suffix' in formatValues) {
      // if we don't have a seq, consider we only have a prefix and not a suffix
      formatValues['prefix1'] = formatValues['suffix'];
      formatValues['suffix'] = '';
    }
    for (const field of ['seq', 'year', 'month']) {
      formatValues[field] = parseInt(formatValues[field] || '0');
    }

    const placeholders = regex.source.matchAll(/(prefix\d|seq|suffix\d?|year|month)/g);

    const format = Array.from(placeholders).map(m =>`{${m[1]}}`).join('');

    return [format, formatValues];
  }

  /**
   * Set the next sequence.
 
      This method ensures that the field is set both in the ORM and in the database.
      This is necessary because we use a database query to get the previous sequence,
      and we need that query to always be executed on the latest data.
 
      :param fieldName: the field that contains the sequence.
   */
  async _setNextSequence() {
    this.ensureOne();
    let lastSequence = await this._getLastSequence();
    const _new = !lastSequence;
    if (_new) {
      lastSequence = await this._getLastSequence(true) ?? await this._getStartingSequence();
    }

    const [format, formatValues] = await this._getSequenceFormatParam(lastSequence);
    if (_new) {
      const date = new Date(await this[this._sequenceDateField]);
      formatValues['seq'] = 0;
      formatValues['year'] = date.getFullYear() % (10 ** formatValues['yearLength']);
      formatValues['month'] = date.getMonth() + 1;
    }

    formatValues['seq'] = String(formatValues['seq'] + 1).padStart(formatValues['seqLength'], '0');
    formatValues['year'] = String(formatValues['year']).padStart(formatValues['yearLength'], '0');
    formatValues['month'] = String(formatValues['month']).padStart(2, '0');

    await this.set(this._sequenceField, _f(format, formatValues));
    await this._computeSplitSequence();
  }

  /**
   * Tells whether or not this element is the last one of the sequence chain.
 
      :return: true if it is the last element of the chain.
   * @returns 
   */
  async _isLastFromSeqChain() {
    const lastSequence = await this._getLastSequence(false, await this['sequencePrefix']);
    if (!lastSequence) {
      return true;
    }
    const [format, formatValues] = await this._getSequenceFormatParam(lastSequence);
    formatValues['seq'] += 1;
    return _format(format, formatValues) === await this['label'];
  }

  /**
   * Tells whether or not these elements are the last ones of the sequence chain.
 
      :return: true if self are the last elements of the chain.
   * @returns 
   */
  async _isEndOfSeqChain() {
    const batched = new DefaultDict(); // () => { return {'lastRec': this.browse(), 'seqList': [] } }
    for (const record of this) {
      const [format, formatValues] = await record._getSequenceFormatParam(await record[record._sequenceField]);
      const seq = pop(formatValues, 'seq');
      const key = `${format}@${stringify(formatValues)}`;
      batched[key] = batched[key] ?? { 'lastRec': this.browse(), 'seqList': [] };
      const batch = batched[key];
      batch['seqList'].push(seq);
      if (batch['lastRec'].sequenceNumber < await record.sequenceNumber) {
        batch['lastRec'] = record;
      }
    }

    for (const values of batched.values()) {
      // The sequences we are deleting are not sequential
      const seqList = values['seqList'];
      if (Math.max(...seqList) - Math.min(...seqList) != len(seqList) - 1) {
        return false;
      }

      // last_rec must have the highest number in the database
      const record = values['lastRec'];
      if (! await record._isLastFromSeqChain()) {
        return false;
      }
    }
    return true;
  }
}