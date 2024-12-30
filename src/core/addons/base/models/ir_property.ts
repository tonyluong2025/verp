import _ from "lodash";
import { api, tools } from "../../..";
import { Fields, _Date, _Datetime } from "../../../fields";
import { Dict } from "../../../helper/collections";
import { UserError, ValueError } from "../../../helper/errors";
import { BaseModel, MetaModel, Model, _super } from "../../../models";
import { TERM_OPERATORS_NEGATION } from "../../../osv/expression";
import { bool } from "../../../tools/bool";
import { isInstance } from "../../../tools/func";
import { len } from "../../../tools/iterable";
import { pop } from "../../../tools/misc";
import { quoteList } from "../../../tools/sql";
import { _f, f } from "../../../tools/utils";

const TYPE2FIELD = {
  'char': 'valueText',
  'float': 'valueFloat',
  'boolean': 'valueInteger',
  'integer': 'valueInteger',
  'text': 'valueText',
  'binary': 'valueBinary',
  'many2one': 'valueReference',
  'date': 'valueDatetime',
  'datetime': 'valueDatetime',
  'selection': 'valueText',
}

const TYPE2CLEAN = {
  'boolean': bool,
  'integer': (val) => val ?? false,
  'float': (val) => val ?? false,
  'char': (val) => val ?? false,
  'text': (val) => val ?? false,
  'selection': (val) => val ?? false,
  'binary': (val) => val ?? false,
  'date': (val: Date) => val ? val.getDate() : false,
  'datetime': (val) => val ?? false,
}

@MetaModel.define()
class IrProperty extends Model {
  static _module = module;
  static _name = 'ir.property';
  static _description = 'Company Property';

  static label = Fields.Char({ index: true });
  static resId = Fields.Char({ string: 'Resource', index: true, help: "If not set, acts as a default value for new resources" });
  static companyId = Fields.Many2one('res.company', { string: 'Company', index: true });
  static fieldsId = Fields.Many2one('ir.model.fields', { string: 'Field', ondelete: 'CASCADE', required: true });
  static valueFloat = Fields.Float();
  static valueInteger = Fields.Integer();
  static valueText = Fields.Text();  // will contain (char, text)
  static valueBinary = Fields.Binary({ attachment: false });
  static valueReference = Fields.Char();
  static valueDatetime = Fields.Datetime();
  static type = Fields.Selection(
    [['char', 'Char'],
    ['float', 'Float'],
    ['boolean', 'Boolean'],
    ['integer', 'Integer'],
    ['text', 'Text'],
    ['binary', 'Binary'],
    ['many2one', 'Many2one'],
    ['date', 'Date'],
    ['datetime', 'DateTime'],
    ['selection', 'Selection']],
    { required: true, default: 'many2one', index: true }
  );

  async init() {
    //Ensure there is at most one active variant for each combination.
    const query = `
      CREATE UNIQUE INDEX IF NOT EXISTS "irProperty_unique_index"
      ON "${this.cls._table}" ("fieldsId", COALESCE("companyId", 0), COALESCE("resId", ''))
    `;
    await this.env.cr.execute(query);
  }

  async _updateValues(values: Dict<any>) {
    if (!('value' in values)) {
      return values;
    }
    let value = pop(values, 'value');

    let prop = null;
    let type = values['type'];
    if (!type) {
      if (this.ok) {
        prop = this[0];
        type = await prop.type;
      }
      else
        type = await this._fields['type'].default(this);
    }

    const field = TYPE2FIELD[type];
    if (!field) {
      throw new UserError(await this._t('Invalid type'));
    }

    if (field === 'valueReference') {
      if (!value) {
        value = false;
      }
      else if (isInstance(value, BaseModel)) {
        value = `${value.cls._name},${value.id}`;
      }
      else if (typeof value === 'number') {
        let fieldId = values['fieldsId'];
        if (!fieldId) {
          if (!bool(prop)) {
            throw new ValueError();
          }
          fieldId = await prop.fieldsId;
        }
        else {
          fieldId = this.env.items('ir.model.fields').browse(fieldId);
        }

        value = `${await (await fieldId.sudo()).relation},${value}`;
      }
    }

    values[field] = value;
    return values;
  }

  async write(values) {
    // if any of the records we're writing on has a resId=false *or*
    // we're writing a resId=false on any record
    let defaultSet = false;
    if (len(this._ids)) {
      const res = await this.env.cr.execute(
        `SELECT EXISTS (SELECT 1 FROM "irProperty" WHERE id in (${this._ids}) AND "resId" IS NULL)`);
      defaultSet = res.length == 1 || res.some(v => v['exists'] === false);
    }
    const r = await _super(IrProperty, this).write(await this._updateValues(values));
    if (defaultSet) {
      // Easy solution, need to flush write when changing a property.
      // Maybe it would be better to be able to compute all impacted cache value and update those instead
      // Then clearCaches must be removed as well.
      await this.flush();
      this.clearCaches();
    }
    return r
  }

  @api.modelCreateMulti()
  async create(valsList: any) {
    valsList = await Promise.all(valsList.map(async (vals) => await this._updateValues(vals)));
    const createdDefault = valsList.some(v => !v['resId']);
    const r = await _super(IrProperty, this).create(valsList);
    if (createdDefault) {
      await this.flush();
      this.clearCaches();
    }
    return r;
  }

  async unlink() {
    let defaultDeleted = false;
    if (len(this._ids)) {
      const res = await this.env.cr.execute(
        `SELECT EXISTS (SELECT 1 FROM "irProperty" WHERE id in (${this._ids}))`,
      )
      defaultDeleted = res.length == 1;
    }
    const r = await _super(IrProperty, this).unlink();
    if (defaultDeleted)
      this.clearCaches();
    return r;
  }

  async getByRecord() {
    this.ensureOne();
    const [type, valueText, valueFloat, valueInteger, valueBinary, valueReference, valueDatetime] = await this('type', 'valueText', 'valueFloat', 'valueInteger', 'valueBinary', 'valueReference', 'valueDatetime');
    if (['char', 'text', 'selection'].includes(type))
      return valueText;
    else if (type === 'float')
      return valueFloat;
    else if (type === 'boolean')
      return bool(valueInteger);
    else if (type === 'integer')
      return valueInteger;
    else if (type === 'binary')
      return valueBinary;
    else if (type === 'many2one') {
      if (!valueReference)
        return false
      const [model, resourceId] = valueReference.split(',');
      return this.env.items(model).browse(parseInt(resourceId)).exists();
    }
    else if (type === 'datetime')
      return valueDatetime;
    else if (type === 'date') {
      if (!valueDatetime)
        return false
      return _Date.toString(_Datetime.toDatetime(valueDatetime) as Date)
    }
    return false
  }

  /**
   * Set the given field's generic value for the given company.

    @param name the field's name
    @param model the field's model name
    @param value the field's value
    @param company the company (record or id)
   */
  @api.model()
  async _setDefault(name, model, value, company?: any) {
    const fieldId = (await this.env.items('ir.model.fields')._get(model, name)).id;
    const companyId = bool(company) ? Number(company.id ?? 0) : false;
    const prop = await (await this.sudo()).search([
      ['fieldsId', '=', fieldId],
      ['companyId', '=', companyId],
      ['resId', '=', false],
    ])
    if (bool(prop)) {
      await prop.write({ 'value': value });
    }
    else {
      await prop.create({
        'fieldsId': fieldId,
        'companyId': companyId,
        'resId': false,
        'label': name,
        'value': value,
        'type': this.env.models[model]._fields[name].type,
      })
    }
  }

  /**
   * Get the given field's generic value for the record.

    @param name the field's name
    @param model the field's model name
    @param resId optional resource, format: "<id>" (int) or
                    "<model>,<id>" (str)
   */
  @api.model()
  async _get(name, model, resId: any = false) {
    if (!resId) {
      const [t, v] = await this._getDefaultProperty(name, model);
      if (!v || t !== 'many2one') {
        return v;
      }
      return this.env.items(v[0]).browse(v[1]);
    }
    const p = await this._getProperty(name, model, resId);
    if (bool(p)) {
      return p.getByRecord();
    }
    return false;
  }

  async _getDomain(propName, model) {
    const fieldId = (await this.env.items('ir.model.fields')._get(model, propName)).id;
    if (!bool(fieldId)) {
      return null;
    }
    const companyId = (await this.env.company()).id;
    return [['fieldsId', '=', fieldId], ['companyId', 'in', [companyId, false]]];
  }

  // only cache Property._get(resId=false) as that's
  // sub-optimally.
  @tools.ormcache('(await self.env.company()).id', 'label', 'model')
  async _getDefaultProperty(label, model) {
    const prop = await this._getProperty(label, model, false);
    if (!prop.ok) {
      return [null, false];
    }
    const v = prop.getByRecord();
    if (prop.type !== 'many2one') {
      return [prop.type, v];
    }
    return ['many2one', v && [v.cls._name, v.id]]
  }

  async _getProperty(name, model, resId) {
    let domain = await this._getDomain(name, model);
    if (domain != null) {
      if (resId && typeof resId === 'number') {
        resId = `${model},${resId}`;
      }
      domain = [['resId', '=', resId]].concat(domain);
      //make the search with companyId asc to make sure that properties specific to a company are given first
      return (await this.sudo()).search(domain, { limit: 1, order: 'companyId' });
    }
    return (await this.sudo()).browse([]);
  }

  async GetDomain(propName, model) {
    const fieldId = (await this.env.items('ir.model.fields')._get(model, propName)).id;
    if (!fieldId) {
      return null;
    }
    const companyId = (await this.env.company()).id;
    return [['fieldsId', '=', fieldId], ['companyId', 'in', [companyId, false]]];
  }

  /**
   * Read the property field `name` for the records of model `model` with the given `ids`, and return a dictionary mapping `ids` to their corresponding value.
   * @param name 
   * @param model 
   * @param ids 
   * @returns 
   */
  @api.model()
  async _getMulti(name, model, ids) {
    if (!bool(ids)) {
      return {}
    }

    const field = this.env.models[model]._fields[name];
    const fieldId = (await this.env.items('ir.model.fields')._get(model, name)).id;
    const companyId = (await this.env.company()).id;

    let query, params, clean;
    let type = 'id';
    if (field.type === 'many2one') {
      const comodel = this.env.items(field.comodelName);
      const modelPos = len(model) + 2;
      const valuePos = len(comodel._name) + 2;
      // retrieve values: both p.resId and p.value_reference are formatted
      // as "<rec._name>,<rec.id>"; the purpose of the LEFT JOIN is to
      // return the value id if it exists, NULL otherwise
      query = _f(`
          SELECT substr(p."resId", $1)::integer, r.id
          FROM "irProperty" p
          LEFT JOIN "{table}" r ON substr(p."valueReference", $2)::integer=r.id
          WHERE p."fieldsId"=$3
              AND (p."companyId"=$4 OR p."companyId" IS NULL)
              AND (p."resId" IN ($5) OR p."resId" IS NULL)
          ORDER BY p."companyId" NULLS FIRST
      `, { table: comodel.cls._table });
      params = [modelPos, valuePos, fieldId, companyId];
      clean = comodel.browse.bind(comodel);
    }
    else if (field.type in TYPE2FIELD) {
      type = TYPE2FIELD[field.type];
      const modelPos = len(model) + 2;
      // retrieve values: p.resId is formatted as "<rec._name>,<rec.id>"
      query = _f(`
        SELECT substr(p."resId", $1)::integer, p."{type}"
        FROM "irProperty" p
        WHERE p."fieldsId"=$2
            AND (p."companyId"=$3 OR p."companyId" IS NULL)
            AND (p."resId" IN ($4) OR p."resId" IS NULL)
        ORDER BY p."companyId" NULLS FIRST
      `, { type: type });
      params = [modelPos, fieldId, companyId];
      clean = TYPE2CLEAN[field.type];
    }
    else {
      return Dict.fromKeys(ids, false);
    }
    // retrieve values
    const cr = this.env.cr;
    let result = {};
    const refs = new Set(ids.map(id => f("%s,%s", model, id)));
    for (const subRefs of cr.splitForInConditions(refs)) {
      const res = await cr.execute(query, {bind: params.concat([quoteList(subRefs)])});
      result = Object.fromEntries(res.map(r => [r['substr'], r[type]]));
    }

    // determine all values and format them
    const defaultValue = result['null'] ?? null;
    return Object.fromEntries(ids.map(id => [id, clean(result[id] ?? defaultValue)]));
  }

  /**
   * Assign the property field `name` for the records of model `model`
        with `values` (dictionary mapping record ids to their value).
        If the value for a given record is the same as the default
        value, the property entry will not be stored, to avoid bloating
        the database.
        If `default_value` is provided, that value will be used instead
        of the computed default value, to determine whether the value
        for a record should be stored or not.
   * @param name 
   * @param model 
   * @param values 
   * @param defaultValue 
   * @returns 
   */
  @api.model()
  async _setMulti(name, model, values, defaultValue: any = null) {
    function clean(value) {
      return isInstance(value, BaseModel) ? value.id : value;
    }

    if (!bool(values)) {
      return;
    }

    if (defaultValue == null) {
      const domain = await this._getDomain(name, model);
      if (domain == null) {
        throw new Error();
      }
      // retrieve the default value for the field
      defaultValue = clean(await this._get(name, model));
    }

    // retrieve the properties corresponding to the given record ids
    const fieldId = (await this.env.items('ir.model.fields')._get(model, name)).id;
    const companyId = (await this.env.company()).id;
    const refs = Object.fromEntries(Object.keys(values).map(id => [f('%s,%s', model, id), id]));
    const props = await (await this.sudo()).search([
      ['fieldsId', '=', fieldId],
      ['companyId', '=', companyId],
      ['resId', 'in', Object.keys(refs)],
    ])

    // modify existing properties
    for (const prop of props) {
      const id = pop(refs, await prop.resId);
      const value = clean(values[id]);
      if (value == defaultValue) {
        // avoid prop.unlink(), as it clears the record cache that can
        // contain the value of other properties to set on record!
        await this._cr.execute(`DELETE FROM "irProperty" WHERE id=%s`, [prop.id]);
      }
      else if (value != clean(await prop.getByRecord())) {
        await prop.write({ 'value': value });
      }
    }
    // create new properties for records that do not have one yet
    const valsList = [];
    for (const [ref, id] of Object.entries(refs)) {
      const value = clean(values[id]);
      if (value != defaultValue) {
        valsList.push({
          'fieldsId': fieldId,
          'companyId': companyId,
          'resId': ref,
          'label': name,
          'value': value,
          'type': this.env.models[model]._fields[name].type,
        })
      }
    }
    await (await this.sudo()).create(valsList);
  }

  /**
   * Return a domain for the records that match the given condition.
   * @param name 
   * @param model 
   * @param operator 
   * @param value 
   * @returns 
   */
  @api.model()
  async searchMulti(name, model, operator, value: any = []) {
    let defaultMatches = false;
    let negate = false;

    // For "is set" and "is not set", same logic for all types
    if (operator === 'in' && value.includes(false)) {
      operator = 'not in';
      negate = true;
    }
    else if (operator === 'not in' && !value.includes(false)) {
      operator = 'in';
      negate = true;
    }
    else if (['!=', 'not like', 'not ilike'].includes(operator) && bool(value)) {
      operator = TERM_OPERATORS_NEGATION[operator];
      negate = true;
    }
    else if (operator === '=' && !bool(value)) {
      operator = '!=';
      negate = true;
    }

    const field = this.env.models[model]._fields[name];

    if (field.type === 'many2one') {
      function makeref(value) {
        return value && `${field.comodelName},${value}`;
      }

      if (['=', '!=', '<=', '<', '>', '>='].includes(operator)) {
        value = makeref(value);
      }
      else if (['in', 'not in'].includes(operator)) {
        value = value.map(v => makeref(v));
      }
      else if (['=like', '=ilike', 'like', 'not like', 'ilike', 'not ilike'].includes(operator)) {
        // most probably inefficient... but correct
        const target = this.env.items(field.comodelName);
        const targetNames = await target.nameSearch(value, operator, { limit: null });
        const targetIds = targetNames.map(n => n[0]);
        operator = 'in';
        value = targetIds.map(v => makeref(v));
      }
    }
    else if (['integer', 'float'].includes(field.type)) {
      // No record is created in ir.property if the field's type is float or integer with a value
      // equal to 0. Then to match with the records that are linked to a property field equal to 0,
      // the negation of the operator must be taken  to compute the goods and the domain returned
      // to match the searched records is just the opposite.
      value = field.type === 'float' ? parseFloat(value) : parseInt(value);
      if (operator === '>=' && value <= 0) {
        operator = '<';
        negate = true;
      }
      else if (operator === '>' && value < 0) {
        operator = '<=';
        negate = true;
      }
      else if (operator === '<=' && value >= 0) {
        operator = '>';
        negate = true;
      }
      else if (operator === '<' && value > 0) {
        operator = '>=';
        negate = true;
      }
    }
    else if (field.type === 'boolean') {
      // the value must be mapped to an integer value
      value = parseInt(value);
    }
    // retrieve the properties that match the condition
    const domain = await this._getDomain(name, model);
    if (domain == null) {
      throw new Error();
    }
    const props = await this.search(domain.concat([[TYPE2FIELD[field.type], operator, value]]));

    // retrieve the records corresponding to the properties that match
    const goodIds = [];
    for (const prop of props) {
      const propResId = await prop.resId;
      if (propResId) {
        const [__, resId] = propResId.split(',')
        goodIds.push(parseInt(resId));
      }
      else {
        defaultMatches = true;
      }
    }
    if (defaultMatches) {
      // exclude all records with a property that does not match
      const props = await this.search(domain.concat([['resId', '!=', false]]));
      const allIds = (await props.mapped('resId')).map(resId => parseInt(resId.split(',')[1]));
      const badIds = _.difference(allIds, goodIds);
      if (negate) {
        return [['id', 'in', badIds]];
      }
      else {
        return [['id', 'not in', badIds]];
      }
    }
    else if (negate) {
      return [['id', 'not in', goodIds]];
    }
    else {
      return [['id', 'in', goodIds]];
    }
  }
}