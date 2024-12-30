import _ from "lodash";
import { format } from 'node:util';
import { Command, Field, _Date, _Datetime, api } from "../../..";
import { ValueError, Warning } from '../../../helper/errors';
import { AbstractModel, MetaModel } from "../../../models";
import { _format, bool, dateSetTz, extend } from '../../../tools';
import { isInstance, partial } from '../../../tools/func';
import { chain, len } from '../../../tools/iterable';
import { stringify } from "../../../tools/json";
import { ModelRecords, _super } from './../../../models';

const REFERENCING_FIELDS = [undefined, null, 'id', '.id'];

function onlyRefFields(record: any) {
  const res = {};
  for (const [k, v] of Object.entries(record))
    if (REFERENCING_FIELDS.includes(k))
      res[k] = v;
  return res;
}

function excludeRefFields(record: any): any {
  const res = {};
  for (const [k, v] of Object.entries(record))
    if (!REFERENCING_FIELDS.includes(k))
      res[k] = v;
  return res;
}

class ImportWarning extends Warning {}

class ConversionNotFound extends ValueError {}

interface formatImportErrorOptions {
  errorParams?: [], 
  moreinfo?: any, 
  fieldType?: any, 
  value?: any, 
  field?: any,
  errorMessage?: any
}

@MetaModel.define()
class IrFieldsConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.fields.converter';
  static _description = 'Fields Converter';

  @api.model()
  _formatImportError(errorType, errorMsg, errorParams?: formatImportErrorOptions, errorArgs?:any): Error {
    // sanitize error params for later formatting by the import system
    const sanitize = (p: any) => typeof p === 'string' ? p.replace('%', '%%') : p;
    if (len(errorParams)) {
      if (typeof errorParams === 'string') {
        const res = sanitize(errorParams);
        return new errorType(format(errorMsg, res));
      }
      else if (Array.isArray(errorParams)) {
        const res = errorParams.map(val => sanitize(val));
        return new errorType(format(errorMsg, ...res));
      }
      else if (typeof errorParams === 'object') {
        let res = {}
        for (const [key, val] of Object.entries<any>(errorParams)) {
          res[key] = sanitize(val);
        }
        return new errorType(_format(errorMsg, res));
      }
    }
    return new errorType(errorMsg);
  }
  
  @api.model()
  toField(model, field, fromtype='string') {
    const typename = fromtype;
    const funcName = `_${typename}To${_.upperFirst(field.type)}`;
    const converter = this[funcName];
    if (!converter)
      return null;
    return partial(converter, this, model, field);
  }

  @api.model()
  forModel(model: ModelRecords, fromtype='string') {
    const self = this as any;
    model = this.env.items(model.cls._name);
    const converters = {}
    for (const [name, field] of Object.entries(model._fields)) {
      converters[name] = this.toField(model, field, fromtype);
    }

    async function fn(record, log) {
      const converted = {}
      const importFileContext = self.env.context['importFile']
      for (const [field, value] of Object.entries<any>(record)) {
        if (REFERENCING_FIELDS.includes(field))
          continue;
        if (!value) {
          converted[field] = false;
          continue;
        }
        try {
          let ws;
          // console.log('>>> fn convert:', field, value);
          [converted[field], ws] = await converters[field](value);
          for (let w of ws) {
            if (typeof w === 'string') {
              w = new ImportWarning(w)
            }
            log(field, w)
          }
        } catch(e) {
          console.log('>>> ERROR fn convert:', field, value);
          throw e;
        }
      }
      return converted;
    }
    return fn;
  }

  @api.model()
  async _stringToBoolean(self, model, field, value) {
    // all translatables used for booleans
    // potentially broken casefolding? What about locales?
    const trues = new Set<any>();
    for (const word of chain(
        ['1', "true", "yes"], // don't use potentially translated values
        await self._getTranslations(['code'], "true"),
        await self._getTranslations(['code'], "yes"),
    )) {
      trues.add(word.toLowerCase());
    }
    if (trues.has(value.toLowerCase())) {
      return [true, []];
    }

    // potentially broken casefolding? What about locales?
    const falses = new Set<any>()
    for (const word of chain(
        ['', "0", "false", "no"],
        await self._getTranslations(['code'], "false"),
        await self._getTranslations(['code'], "no"),
    )) {
      falses.add(word.toLowerCase());
    }
    if (falses.has(value.toLowerCase())) {
      return [false, []];
    }

    if ((self._context['importSkipRecords'] || []).includes(field.name)) {
      return [null, []]
    }

    return [true, [self._formatImportError(
      ValueError,
      await this._t("Unknown value '%s' for boolean field '{field}'"),
      value,
      {'moreinfo': await this._t("Use '1' for yes and '0' for no")})
    ]];
  }

  @api.model()
  async _stringToInteger(self, model, field, value) { 
    value = parseInt(value);
    if (isNaN(value)) {
      throw self._formatImportError(
        ValueError,
        await this._t(`'%s' does not seem to be an integer for field '{field}'`, value),
        {field: field}
      );
    }
    return [value, []];
  }

  @api.model()
  async _stringToFloat(self, model, field, value) { 
    value = parseFloat(value);
    if (isNaN(value)) {
      throw self._formatImportError(
        ValueError,
        await this._t(`'%s' does not seem to be a number for field '{field}'`, value),
        {field: field}
      );
    }
    return [value, []];
  }

  @api.model()
  _stringId(self, model, field, value) {
    return [value, []];
  }

  _stringToReference = this._stringId;
  _stringToChar = this._stringId;
  _stringToText = this._stringId;
  _stringToBinary = this._stringId;
  _stringToHtml = this._stringId;

  @api.model()
  async _stringToDate(self, model, field, value) {
    try {
      const parsedValue = _Date.toDate(value) as Date;
      return [_Date.toString(parsedValue), []];
    } catch(e) {
      throw self._formatImportError(
        ValueError,
        await this._t(`'%s' does not seem to be a valid date for field '{field}'`, value),
        {'field': await this._t("Use the format '%s'", "2012-12-31")}
    )
    }
  }

  @api.model()
  async _inputTz() {
    // if there's a tz in context, try to use that
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (this._context['tz']) {
      try {
        return Intl.DateTimeFormat(locale, {timeZone: this._context['tz']}).resolvedOptions().timeZone;
      } catch(e) {
        if (!isInstance(e, RangeError)) {
          throw e;
        }
      }
    }
    // if the current user has a tz set, try to use that
    const user = await this.env.user();
    if (user.tz) {
      try {
        return Intl.DateTimeFormat(locale, {timeZone: user.tz}).resolvedOptions().timeZone;
      } catch(e) {
        if (!isInstance(e, RangeError)) {
          throw e;
        }
      }
    }
    // fallback if no tz in context or on user: UTC
    return 'UTC';
  }

  @api.model()
  async _stringToDatetime(self, model, field, value) {
    let parsedValue;
    try {
      parsedValue = _Datetime.toDatetime(value);
    } catch(e) {
      throw self._formatImportError(
        ValueError,
        _format(await this._t("'%s' does not seem to be a valid datetime for field '{field}'", value),
        {'field': await this._t("Use the format '%s'", "2012-12-31 23:59:59")})
      );
    }

    const inputTz = await self._inputTz() // Apply input tz to the parsed native datetime
    return [dateSetTz(parsedValue, inputTz), []];
  }
  
  @api.model()
  async _getTranslations(types: string[], src): Promise<any[]> {
    // Cache translations so they don't have to be reloaded from scratch on every row of the file
    const tnxCache = this._cr.cache[this.cls._name] = this._cr.cache[this.cls._name] ?? new Map();
    const strTypes = stringify(types);
    const hasTypes = tnxCache.has(strTypes);
    if (!hasTypes) {
      tnxCache.set(strTypes, {});
    }
    if (src in tnxCache.get(strTypes)) {
      return tnxCache.get(strTypes)[src];
    }

    const translations = this.env.items('ir.translation');
    const tnx = await translations.search([['type', 'in', types], ['src', '=', src]]);
    const result = [];
    for (const t of tnx) {
      const value = await t.value;
      if (value !== false) {
        result.push(value);
      }
    } 
    tnxCache.get(strTypes)[src] = result;
    return result;
  }

  @api.model()
  async _stringToSelection(self, model, field: Field, value) {
    // get untranslated values
    const env = (await self.withContext({lang: null})).env;
    const description = await field.getDescription(env);
    const selection = description['selection'];

    for (const [item, label] of selection) {
      const labels = [label].concat(await self._getTranslations(['selection', 'model', 'code'], label));
      // case insensitive comparaison of string to allow to set the value even if the given 'value' param is not
      // exactly (case sensitive) the same as one of the selection item.
      const val = value.toLowerCase();
      if (val === `${item}`.toLowerCase() || labels.some(label => val === label.toLowerCase())) {
        return [item, []]
      }
    }

    if ((self._context['importSkipRecords'] || []).includes(field.name)) {
      return [null, []];
    }
    else if ((self._context['importSetEmptyFields'] || []).includes(field.name)) {
      return [false, []];
    }
    throw self._formatImportError(
      ValueError,
      _format(await this._t("Value '%s' not found in selection field '%{field}'", value),
      {'field': selection.filter(([item, label]) => label || item).map(([item, label]) => label ?? `${item}`)}
    ))
  }

  /**
   * Checks the record for the subfields allowing referencing (an
      existing record in an other table), errors out if it finds potential
      conflicts (multiple referencing subfields) or non-referencing subfields
      returns the name of the correct subfield.

      @param record
      @returns the record subfield to use for referencing and a list of warnings
   */
  async _referencingSubfield(record) {
    // Can import by nameGet, external id or database id
    const fieldset = Object.keys(record);
    if (_.difference(fieldset, REFERENCING_FIELDS).length) {
      throw new ValueError(await this._t("Can not create Many-To-One records indirectly, import the field separately"))
    }
    if (len(fieldset) > 1) {
      throw new ValueError(await this._t("Ambiguous specification for field '%(field)s', only provide one of name, external id or database id"))
    }
    // only one field left possible, unpack
    const [subfield] = fieldset
    return [subfield, []]
  }

  /**
   * Finds a database id for the reference ``value`` in the referencing
    subfield ``subfield`` of the provided field of the provided model.

    @param model model to which the field belongs
    @param field relational field for which references are provided
    @param subfield a relational subfield allowing building of refs to
                    existing records: ``null`` for a nameGet/nameSearch,
                    ``id`` for an external id and ``.id`` for a database
                    id
    @param value value of the reference to match to an actual record
    @param context VERP request context
    @return a pair of the matched database identifier (if any), the
            translated user-readable name for the field and the list of
            warnings
    @type [ID|null, string, []]
   */
  @api.model()
  async dbIdFor(model, field, subfield, value) {
    // the function 'flush' comes from BaseModel.load(), and forces the
    // creation/update of former records (batch creation)
    const _func = (kw) => null;
    const _flush = this._context['importFlush'] ?? _func;

    let id = null;
    const warnings = [];
    let errorMsg = ''
    const action = {
      'label': 'Possible Values',
      'type': 'ir.actions.actwindow',
      'target': 'new',
      'viewMode': 'tree,form',
      'views': [[false, 'list'], [false, 'form']],
      'context': {'create': false},
      'help': await this._t("See all possible values")
    }
    if (subfield == null) {
      action['resModel'] = field.comodelName;
    }
    else if (['id', '.id'].includes(subfield)) {
      action['resModel'] = 'ir.model.data';
      action['domain'] = [['model', '=', field.comodelName]];
    }

    const RelatedModel = this.env.items(field.comodelName);
    let fieldType;
    if (subfield === '.id') {
      fieldType = await this._t("database id");
      if (typeof value === 'string' && ! (await this._stringToBoolean(this, model, field, value))[0]) {
        return [false, fieldType, warnings];
      }
      let tentativeId = parseInt(value); 
      if (isNaN(tentativeId)) {
        tentativeId = value;
      }
      try {
        if (bool(await RelatedModel.search([['id', '=', tentativeId]]))) {
          id = tentativeId;
        }
      }
      catch(e) {
        console.log(e);
        throw this._formatImportError(
          ValueError,
          await this._t(`Invalid database id '%s' for the field '{field}'`, value),
          {'moreinfo': action}
        )
      }
    }
    else if (subfield === 'id') {
      fieldType = await this._t("external id");
      if (typeof value ==='string' && ! (await this._stringToBoolean(this, model, field, value))[0]) {
        return [false, fieldType, warnings];
      }
      let xmlid;
      if (value.includes('.')) {
        xmlid = value;
      }
      else {
        xmlid = format("%s.%s", this._context['_importCurrentModule'] ??  '', value);
      }
      await _flush({xmlid: xmlid});
      id = await this._xmlidToRecordId(xmlid, RelatedModel);
    }
    else if (subfield == null) {
      fieldType = await this._t("name");
      if (!value) {
        return [false, fieldType, warnings];
      }
      await _flush({model: field.comodelName});
      const ids = await RelatedModel.nameSearch(value, [], '=');
      let _name;
      if (bool(ids)) {
        if (len(ids) > 1) {
          warnings.push(new ImportWarning(
            await this._t("Found multiple matches for value '%s' in field '{field}' (%d matches)", value, len(ids))
          ));
        }
        [id, _name] = ids[0];
      }
      else {
        const nameCreateEnabledFields = this.env.context['nameCreateEnabledFields'] ?? {}
        if (nameCreateEnabledFields[field.name]) {
          try {
            [id, _name] = await RelatedModel.nameCreate({label: value});
          }
          catch(e) {
            errorMsg = await this._t("Cannot create new '%s' records from their name alone. Please create those records manually and try importing again.", RelatedModel.cls._description);
          }
        }
      }
    }
    else {
      throw this._formatImportError(
        Error,
        await this._t("Unknown sub-field '%s'"),
        subfield
      )
    }

    let setEmpty = false;
    let skipRecord = false;
    if (this.env.context['importFile']) {
        const importSetEmptyFields = this.env.context['importSetEmptyFields'] || [];
        const fieldPath = (this.env.context['parentFieldsHierarchy'] || []).concat(field.name).join('/');
        setEmpty = importSetEmptyFields.includes(fieldPath);
        skipRecord = (this.env.context['importSkipRecords'] || []).includes(fieldPath);
    }
    if (id == null && !setEmpty && !skipRecord) {
      let message;
      if (errorMsg) {
        message = await this._t("No matching record found for '{fieldType}' '{value}' in field '{field}' and the following error was encountered when we attempted to create one: {errorMessage}")
      }
      else {
        message = await this._t("No matching record found for '{fieldType}' '{value}' in field '{field}'")
      }

      const errorInfoDict = {'moreinfo': action}
      if (this.env.context['importFile']) {
        // limit to 50 char to avoid too long error messages.
        value = typeof value === 'string' ? value.slice(0, 50) : value;
        Object.assign(errorInfoDict, {'value': value, 'fieldType': fieldType});
        if (errorMsg)
          errorInfoDict['errorMessage'] = errorMsg;
      }
      throw this._formatImportError(
        ValueError,
        message,
        {'fieldType': fieldType, 'value': value, 'errorMessage': errorMsg, 'field': field},
        errorInfoDict
      )
    }
    return [id, fieldType, warnings]
  }

  /**
   * Return the record id corresponding to the given external id,
  provided that the record actually exists; otherwise return ``null``.
    */
  async _xmlidToRecordId(xmlid: string, model) {
    const importCache = this.env.context['importCache'] ?? {};
    let result = importCache.get(xmlid);

    if (!result) {
      const index = xmlid.indexOf('.');
      const [module, label] = [xmlid.slice(0, index), xmlid.slice(index+1, xmlid.length)];
      const query = `
        SELECT d."model" AS "resModel", d."resId"
        FROM "irModelData" d
        JOIN "${model.cls._table}" r ON d."resId" = r.id
        WHERE d."module" = '${module}' AND d."label" = '${label}'
      `;
      const res = await this.env.cr.execute(query);
      result = res[0];
    }
    if (result) {
      const {resModel, resId} = result;
      importCache.set(xmlid, result);
      if (resModel !== model.cls._name) {
        const msg = `Invalid external ID ${xmlid}: expected model ${model.cls._name}, found ${resModel}`;
        throw new ValueError(msg);
      }
      return resId
    }
  }

  @api.model()
  async _stringToMany2one(self, model, field, values) {
    // Should only be one record, unpack
    let [res] = values;
    res = res ?? {};

    const [subfield, w1] = await self._referencingSubfield(res);

    const [id, x, w2] = await self.dbIdFor(model, field, subfield, res[subfield]);
    return [id, w1.concat(w2)];
  }

  @api.model()
  async _stringToMany2oneReference(self, model, field, value) {
    return self._stringToInteger(self, model, field, value);
  }

  @api.model()
  async _stringToMany2many(self, model, field, value) {
    const {record} = value;

    const [subfield, warnings] = self._referencingSubfield(record);

    let ids = [];
    for (const reference of (await record[subfield]).split(',')) {
      const [id, x, ws] = self.dbIdFor(model, field, subfield, reference);
      ids.push(id);
      extend(warnings, ws);
    }

    if (field.name in (self._context['importSetEmptyFields'] || []) && ids.some((id) => id == null)) {
      ids = ids.filter(id => bool(id));
    }
    else if (field.name in (self._context['importSkipRecords'] || []) &&  ids.some((id) => id == null)) {
      return [null, warnings];
    }

    if (self._context['updateMany2many']) {
      return [ids.map(id => Command.link(id)), warnings];
    }
    else {
      return [[Command.set(ids)], warnings];
    }
  }

  @api.model()
  async _stringToOne2many(self, model, field, records) {
    const nameCreateEnabledFields = self._context['nameCreateEnabledFields'] ?? {};
    const prefix = field.name + '/'
    const relativeNameCreateEnabledFields = {};
    for (const [k, v] of Object.entries<any>(nameCreateEnabledFields)) {
      if (k.startsWith(prefix)) {
        relativeNameCreateEnabledFields[k[len(prefix)]] = v;
      }
    }    
    const commands = [];
    const warnings = [];

    if (len(records) == 1 && len(excludeRefFields(records[0])) == 0) {
      // only one row with only ref field, field=ref1,ref2,ref3 as in
      // m2o/m2m
      const record = records[0]
      const [subfield, ws] = self._referencingSubfield(record);
      extend(warnings, ws);
      // transform [{subfield:ref1,ref2,ref3}] into
      // [{subfield:ref1},{subfield:ref2},{subfield:ref3}]
      records = record[subfield].split(',').map(item => {return {[subfield]: item}});
    }
    function log(f, exception) {
      if (! isInstance(exception, Warning)) {
        const currentFieldName = self.env.models[field.comodelName]._fields[f].string;
        const arg0 = _format(exception.args[0], {'field': '{field}/' + currentFieldName});
        exception.args = [arg0, ...exception.args.slice(1)];
        throw exception;
      }
      warnings.push(exception);
    }
    // Complete the field hierarchy path
    // E.g. For "parent/child/subchild", field hierarchy path for "subchild" is ['parent', 'child']
    const parentFieldsHierarchy = (self._context['parentFieldsHierarchy'] || []).concat([field.name]);

    const convert = await (await self.withContext({
      nameCreateEnabledFields: relativeNameCreateEnabledFields,
      parentFieldsHierarchy: parentFieldsHierarchy
    })).forModel(self.env.items(field.comodelNname));

    for (const record of records) {
      let id = null;
      const refs = onlyRefFields(record);
      const writable = await convert(excludeRefFields(record), log);
      if (bool(refs)) {
        const [subfield, w1] = self._referencingSubfield(refs);
        extend(warnings, w1);
        try {
          let x, w2;
          [id, x, w2] = await self.dbIdFor(model, field, subfield, await record[subfield]);
          extend(warnings, w2);
        } catch(e) {
          if (isInstance(e, ValueError)) {
            if (subfield !== 'id') {
              throw e;
            }
            writable.id = record.id;
          }
          else {
            throw e;
          }
        }
      }
      if (id) {
        commands.push(Command.link(id));
        commands.push(Command.update(id, writable));
      }
      else {
        commands.push(Command.create(writable));
      }
    }
    return [commands, warnings];
  }
}

/**
 * Updates the base class to support setting xids directly in create by
providing an "id" key (otherwise stripped by create) during an import
(which should strip 'id' from the input data anyway)
 */
@MetaModel.define()
class O2MIdMapper extends AbstractModel {
  static _module = module;
  static _parents = 'base';
  static _description = 'base O2MIdMapper';

  @api.modelCreateMulti()
  @api.returns('self', (value) => value.id)
  async create(valsList) {
    const recs = await _super(O2MIdMapper, this).create(valsList);
    const importModule = this.env.context['_importCurrentModule'];
    if (!importModule) {
      return recs;
    }
    const noupdate = this.env.context['noupdate'] ?? false;
    const xids = valsList.map(v => v['id']);
    const res = [];
    for (const [rec, xid] of _.zip([...recs], xids)) {
      if (xid && typeof xid === 'string') {
        res.push({
          'xmlid': xid.includes('.') ? xid : `${importModule}.${xid}`,
          'record': rec,
          // note: this is not used when updating o2ms above...
          'noupdate': noupdate,
        })
      }
    }
    await this.env.items('ir.model.data')._updateXmlids(res);
    return recs;
  }
}