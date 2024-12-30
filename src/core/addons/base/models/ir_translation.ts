import { ValidationError } from "@sequelize/core";
import _ from "lodash";
import assert from "node:assert";
import { format } from "util";
import { api, tools } from "../../..";
import { setdefault } from "../../../api/func";
import { Field, Fields } from "../../../fields";
import { AccessError, DefaultDict2, Dict, UserError } from "../../../helper";
import { MetaModel, Model, ModelRecords, _super } from "../../../models";
import { getModulePath, getResourcePath } from "../../../modules/modules";
import { Cursor } from "../../../sql_db";
import { _convert$, _f, bool, equal, extend, f, getIsoCodes, groupby, isCallable, isInstance, itemgetter, len, quoteList, sha1 } from "../../../tools";
import { stringify } from "../../../tools/json";
import { transLoad } from "../../../tools/translate";

const TRANSLATION_TYPE = [
  ['model', 'Model Field'],
  ['modelTerms', 'Structured Model Field'],
  ['code', 'Code'],
]

function getCloseMatches(word: string, possibilities, n = 3, cutoff = 0.6) {
  console.warn("Function not implemented.");
  return [word];
}

/**
 * Temporary cursor for optimizing mass insert into model 'ir.translation'.

    Open it (attached to a sql cursor), feed it with translation data and
    finish() it in order to insert multiple translations in a batch.
 */
class IrTranslationImport {
  _table = 'tmpIrTranslationImport';
  _cr: Cursor;
  _modelTable: string;
  _overwrite: boolean;
  _debug: boolean;
  _rows: any[];

  private constructor() { }
  /**
   * Store some values, and also create a temporary SQL table to accept
      the data.

   * @param cr 
   * @param overwrite 
   */
  static async new(cr, overwrite: boolean = false) {
    const self = new IrTranslationImport();
    self._cr = cr;
    self._modelTable = "irTranslation";
    self._overwrite = overwrite;
    self._debug = false;
    self._rows = [];

    // Note that Postgres will NOT inherit the constraints or indexes
    // of irTranslation, so this copy will be much faster.
    const query = ` CREATE TEMP TABLE "${self._table}" (
                        "imdModel" VARCHAR,
                        "imdLabel" VARCHAR,
                        noupdate BOOLEAN
                    ) INHERITS ("${self._modelTable}") `;
    await self._cr.execute(query);
    return self;
  }

  /**
   * Feed a translation, as a dictionary, into the cursor
   * @param transDict 
   * @returns 
   */
  push(transDict) {
    const params = Object.assign({}, transDict, { state: "translated" });

    this._rows.push([params['label'], params['lang'], params['resId'],
    params['src'], params['type'], params['imdModel'],
    params['module'], params['imdLabel'], params['value'],
    params['state'], params['comments']]);
  }

  /**
   * Transfer the data from the temp table to ir.translation
   * @returns 
   */
  async finish() {
    const cr = this._cr;

    // Step 0: insert rows in batch
    const query = ` INSERT INTO "${this._table}" (label, lang, "resId", src, type, "imdModel",
                                    module, "imdLabel", value, state, comments)
                    VALUES `;
    const rowValue = '(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)';
    for (const rows of cr.splitForInConditions(this._rows)) {
      let str = _convert$(_.fill(Array(len(rows)), rowValue).join(','));
      await cr.execute(query + str, { bind: rows.flat() });
    }

    console.debug("ir.translation.cursor: We have %s entries to process", len(this._rows));

    // Step 1: resolve ir.model.data references to resIds
    await cr.execute(` UPDATE "${this._table}" AS ti
                          SET "resId" = imd."resId",
                              noupdate = imd.noupdate
                       FROM "irModelData" AS imd
                       WHERE ti."resId" IS NULL
                       AND ti.module IS NOT NULL AND ti."imdLabel" IS NOT NULL
                       AND ti.module = imd.module AND ti."imdLabel" = imd.label
                       AND ti."imdModel" = imd.model; `);

    if (this._debug) {
      const res = await cr.execute(` SELECT module, "imdLabel", "imdModel" FROM "${this._table}"
                           WHERE "resId" IS NULL AND module IS NOT NULL `);
      for (const row of res) {
        console.info("ir.translation.cursor: missing resId for %s.%s <%s> ", row['module'], row['imdLabel'], row['imdModel']);
      }
    }
    // Records w/o resId must _not_ be inserted into our db, because they are
    // referencing non-existent data.
    await cr.execute(`DELETE FROM "${this._table}" WHERE "resId" IS NULL AND module IS NOT NULL`);

    let count = 0;
    // Step 2: insert new or upsert non-noupdate translations
    if (this._overwrite) {
      let res = await cr.execute(` INSERT INTO "%s" (label, lang, "resId", src, type, value, module, state, comments)
                          SELECT label, lang, "resId", src, type, value, module, state, comments
                          FROM "%s"
                          WHERE type = 'code'
                          AND noupdate IS NOT TRUE
                          ON CONFLICT (type, lang, md5(src)) WHERE type = 'code'
                            DO UPDATE SET (label, lang, "resId", src, type, value, module, state, comments) = (EXCLUDED.label, EXCLUDED.lang, EXCLUDED."resId", EXCLUDED.src, EXCLUDED.type, EXCLUDED.value, EXCLUDED.module, EXCLUDED.state, CASE WHEN "%s".comments = 'verp-web' THEN 'verp-web' ELSE EXCLUDED.comments END)
                            WHERE EXCLUDED.value IS NOT NULL AND EXCLUDED.value != ''
                          RETURNING id;
                       `, [this._modelTable, this._table, this._modelTable]);
      count += res.length;
      res = await cr.execute(` INSERT INTO "%s"(label, lang, "resId", src, type, value, module, state, comments)
                           SELECT label, lang, "resId", src, type, value, module, state, comments
                           FROM "%s"
                           WHERE type = 'model'
                           AND noupdate IS NOT TRUE
                           ON CONFLICT (type, lang, label, "resId") WHERE type = 'model'
                            DO UPDATE SET (label, lang, "resId", src, type, value, module, state, comments) = (EXCLUDED.label, EXCLUDED.lang, EXCLUDED."resId", EXCLUDED.src, EXCLUDED.type, EXCLUDED.value, EXCLUDED.module, EXCLUDED.state, EXCLUDED.comments)
                            WHERE EXCLUDED.value IS NOT NULL AND EXCLUDED.value != ''
                          RETURNING id;
                       `, [this._modelTable, this._table]);
      count += res.length;

      res = await cr.execute(` INSERT INTO "%s"(label, lang, "resId", src, type, value, module, state, comments)
                           SELECT label, lang, "resId", src, type, value, module, state, comments
                           FROM "%s"
                           WHERE type = 'modelTerms'
                           AND noupdate IS NOT TRUE
                           ON CONFLICT (type, label, lang, "resId", md5(src))
                            DO UPDATE SET (label, lang, "resId", src, type, value, module, state, comments) = (EXCLUDED.label, EXCLUDED.lang, EXCLUDED."resId", EXCLUDED.src, EXCLUDED.type, EXCLUDED.value, EXCLUDED.module, EXCLUDED.state, EXCLUDED.comments)
                            WHERE EXCLUDED.value IS NOT NULL AND EXCLUDED.value != ''
                          RETURNING id;
                       `, [this._modelTable, this._table]);
      count += res.length;
    }
    let res = await cr.execute(` INSERT INTO "%s"(label, lang, "resId", src, type, value, module, state, comments)
                       SELECT label, lang, "resId", src, type, value, module, state, comments
                       FROM "%s"
                       WHERE %s OR noupdate is true
                       ON CONFLICT DO NOTHING
                       RETURNING id;
                   `, [this._modelTable, this._table, !this._overwrite])
    count += res.length;

    if (this._debug) {
      const res = await cr.execute(`SELECT COUNT(*)::int AS cnt FROM ONLY "%s"`, [this._modelTable]);
      const total = res[0]['cnt'];
      console.debug("ir.translation.cursor: %s entries now in ir.translation, %s common entries with tmp", total, count);
    }
    // Step 3: cleanup
    await cr.execute(`DROP TABLE "%s"`, [this._table]);
    this._rows.length = 0;
    return true;
  }
}

@MetaModel.define()
class IrTranslation extends Model {
  static _module = module;
  static _name = "ir.translation";
  static _description = 'Translation';
  static _logAccess = false;

  static label = Fields.Char({ string: 'Translated field', required: true });
  static resId = Fields.Integer({ string: 'Record ID', index: true });
  static lang = Fields.Selection('_getLanguages', { string: 'Language', validate: false });
  static type = Fields.Selection(TRANSLATION_TYPE, { string: 'Type', index: true });
  static src = Fields.Text({ string: 'Internal Source' });  // stored in database, kept for backward compatibility
  static value = Fields.Text({ string: 'Translation Value' });
  static module = Fields.Char({ index: true, help: "Module this term belongs to" });
  static state = Fields.Selection(
    [['toTranslate', 'To Translate'],
    ['inprogress', 'Translation in Progress'],
    ['translated', 'Translated']], { string: "Status", default: 'toTranslate', help: "Automatically set to let administators find new terms that might need to be translated" }
  );
  // aka gettext extracted-comments - we use them to flag verp-web translation
  // cfr: http://www.gnu.org/savannah-checkouts/gnu/gettext/manual/html_node/PO-Files.html
  static comments = Fields.Text({ string: 'Translation comments', index: true });

  static _sqlConstraints = [
    // ['lang_fkey_res_lang', 'FOREIGN KEY (lang) REFERENCES "resLang" (code)',
    //   'Language code of translation item must be among known languages'],
  ];

  @api.model()
  async _getLanguages() {
    return this.env.items('res.lang').getInstalled();
  }

  async _autoInit() {
    const res = await _super(IrTranslation, this)._autoInit();
    // Add separate md5 index on src (no size limit on values, and good performance).
    await tools.createIndex(this._cr, 'irTranslation_src_md5', this.cls._table, ['md5("src")']);
    // Cover 'modelTerms' type
    await tools.createUniqueIndex(this._cr, 'irTranslation_unique', this.cls._table, ['"type"', '"label"', '"lang"', '"resId"', 'md5("src")'])
    if (! await tools.indexExists(this._cr, 'irTranslation_code_unique')) {
      await this._cr.execute(`CREATE UNIQUE INDEX "irTranslation_code_unique" ON "irTranslation" ("type", "lang", md5("src")) WHERE "type" = 'code'`);
    }
    if (! await tools.indexExists(this._cr, 'irTranslation_model_unique')) {
      await this._cr.execute(`CREATE UNIQUE INDEX "irTranslation_model_unique" ON "irTranslation" ("type", "lang", "label", "resId") WHERE "type" = 'model'`);
    }
    return res;
  }

  CACHED_MODELS = ['ir.model.fields', 'ir.ui.view'];

  /**
   * Invalidate the ormcache if necessary, depending on ``modelName``. This should be called when modifying translations of type 'model'.
   * @param modelName 
   */
  _modifiedModel(modelName: string) {
    if (this.CACHED_MODELS.includes(modelName)) {
      this.clearCaches();
    }
  }

  /**
   * Invalidate the ormcache if necessary, depending on the translations ``this``.
   */
  async _modified() {
    for (const trans of this) {
      if (await trans.type === 'modelTerms' && bool(await trans.resId)) {
        const [modelName, fieldName] = (await trans.label).split(',');
        if (modelName in this.env.models) {
          const model = this.env.items(modelName);
          if (fieldName in model._fields) {
            const field = model._fields[fieldName];
            const record = model.browse(await trans.resId);
            await record.modified([field.name]);
          }
        }
      }
    }
    for (const trans of this) {
      if (await trans.type !== 'model' ||
        (this.CACHED_MODELS.includes((await trans.label).split(',')[0])) ||
        (await trans.comments && trans.comments.includes('verp-web'))) {  // clear getWebTransHash
        this.clearCaches();
        break;
      }
    }
  }

  /**
   * Return the translations of records.

    @param label a string defined as "<modelName>,<fieldName>"
    @param tt the type of translation (should always be "model")
    @param lang the language code
    @param ids the ids of the given records
   */
  @api.model()
  async _getIds(label: string, tt: string, lang: string, ids: number[]) {
    const translations = Dict.fromKeys(ids, false);
    if (len(ids)) {
      const res = await this._cr.execute(`SELECT "resId", "value" FROM "irTranslation"
                          WHERE "lang"='${lang}' AND "type"='${tt}' AND "label"='${label}' AND "resId" IN (${String(ids) || 'NULL'})`)
      for (const { resId, value } of res) {
        translations[resId] = value;
      }
    }
    return Object.assign({}, translations);
  }

  /**
   * Update the translations of records.

    @param name a string defined as "<modelName>,<fieldName>"
    @param tt the type of translation (should always be "model")
    @param lang the language code
    @param ids the ids of the given records
    @param value the value of the translation
    @param src the source of the translation
   */
  @api.model()
  async _setIds(label: string, tt: string, lang: string, ids: number[], value: string, src?: any) {
    this._modifiedModel(label.split(',')[0])

    // update existing translations
    const res = await this._cr.execute(`UPDATE "irTranslation"
                        SET value=$1, src=$2, state='translated'
                        WHERE lang=$3 AND type=$4 AND label=$5 AND "resId" IN ($6)
                        RETURNING "resId"`, { bind: [value, src, lang, tt, label, String(ids)] })
    const existingIds = res.map(row => row['resId']);

    // create missing translations
    await (await this.sudo()).create(
      _.difference(ids, existingIds).map<any>((resId) => {
        return {
          'lang': lang,
          'type': tt,
          'label': label,
          'resId': resId,
          'value': value,
          'src': src,
          'state': 'translated',
        }
      }));
    return len(ids)
  }


  /**
   * Update the translation source of records.

    @param name a string defined as "<modelName>,<fieldName>"
    @param ids the ids of the given records
    @param src the source of the translation
   */
  async _setSource(label: string, ids: number[], src: any) {
    const res = await this._cr.execute(`UPDATE "irTranslation"
                        SET src=$1
                        WHERE type='model' AND label=$2 AND "resId" IN ($3)
                        RETURNING id`, { bind: [src, label, String(ids)] });
    const existingIds = res.map(row => row['id']);
    // invalidate src for updated translations
    this.invalidateCache(['src'], existingIds);
  }

  @api.model()
  async _getSourceQuery(label, types, lang, source, resId) {
    let query, params;
    if (source) {
      // Note: the extra test on md5(src) is a hint for postgres to use the
      // index irTranslationSrcMd5
      query = `SELECT value FROM "irTranslation"
                     WHERE lang=$1 AND type IN (${quoteList(types)}) AND src=$2 AND md5(src)=md5($3)`;
      source = tools.ustr(source);
      params = [lang || '', source, source];
      if (resId) {
        query += ` AND "resId" IN (${String([resId,])})`;
      }
      if (label) {
        query += " AND label=$4";
        params.push(tools.ustr(label));
      }
    }
    else {
      query = `SELECT value FROM "irTranslation"
                      WHERE lang=$1 AND type IN (${quoteList(types)}) AND label=$2`;
      params = [lang || '', tools.ustr(label)];
    }
    return [query, params];
  }

  @tools.ormcache('label', 'types', 'lang', 'source', 'resId')
  async __getSource(label, types, lang, source, resId) {
    // resId is a tuple or None, otherwise ormcache cannot cache it!
    const [query, params] = await this._getSourceQuery(label, types, lang, source, resId);
    const res = await this._cr.execute(query, { bind: params });
    const trad = res.length && res[0]['value'] || '';
    if (source && !trad) {
      return tools.ustr(source);
    }
    return trad;
  }

  /**
   * Return the translation for the given combination of ``name``,
      ``type``, ``language`` and ``source``. All values passed to this method
      should be unicode (not byte strings), especially ``source``.

      @param name identification of the term to translate, such as field name (optional if source is passed)
      @param types single string defining type of term to translate (see ``type`` field on ir.translation), or sequence of allowed types (strings)
      @param lang language code of the desired translation
      @param source optional source term to translate (should be unicode)
      @param resId optional resource id or a list of ids to translate (if used, ``source`` should be set)
      @returns the request translation, or an empty unicode string if no translation was
               found and `source` was not passed
   */
  @api.model()
  async _getSource(label, types, lang, source?: any, resId?: any) {
    if (!lang) {
      return tools.ustr(source || '');
    }
    if (typeof types === 'string') {
      types = [types];
    }
    if (bool(resId)) {
      if (typeof resId === 'number') {
        resId = [resId];
      }
      else {
        resId = Array.from(resId);
      }
    }
    return this.__getSource(label, types, lang, source, resId);
  }

  /**
   * Utility function that makes the query for field terms.
   * @param field 
   * @param records 
   * @returns 
   */
  @api.model()
  async _getTermsQuery(field, records): Promise<any[]> {
    const query = ` SELECT * FROM "irTranslation"
                  WHERE lang=$1 AND type=$2 AND label=$3 AND "resId" IN (${String(records.ids) || 'NULL'}) `;
    const label = f("%s,%s", field.modelName, field.name);
    const params = [records.env.lang, 'modelTerms', label];
    return [query, params];
  }

  /**
   * Return a function mapping a irTranslation row (dict) to a value.
    This method is called before querying the database for translations.
   * @param field 
   * @param records 
   * @returns 
   */
  @api.model()
  async _getTermsMapping(field, records) {
    return (data) => data['value'];
  }

  /**
   * Return the terms and translations of a given `field` on `records`.
 
    @returns `{recordId: {source: value}}`
    */
  @api.model()
  async _getTermsTranslations(field, records) {
    const result = {}
    for (const rid of records.ids) {
      result[rid] = {}
    }
    if (records.ok) {
      const mapTrans = await this._getTermsMapping(field, records);
      const [query, params] = await this._getTermsQuery(field, records);
      const rows = await this._cr.execute(query, { bind: params });
      for (const data of rows) {
        result[data['resId']][data['src']] = mapTrans(data);
      }
    }
    return result
  }

  /**
   * Synchronize the translations to the terms to translate, after the
    English value of a field is modified. The algorithm tries to match
    existing translations to the terms to translate, provided the distance
    between modified strings is not too large. It allows to not retranslate
    data where a typo has been fixed in the English value.
   * @param field 
   * @param records 
   * @returns 
   */
  @api.model()
  async _syncTermsTranslations(field: Field, records: ModelRecords) {
    if (!isCallable(field.translate)) {
      return;
    }

    const Translation = this.env.items('ir.translation');
    const outdated = Translation;
    let discarded = Translation;

    for (const record of records) {
      // get field value and terms to translate
      const value = await record[field.name];
      const terms = new Set(await field.getTransTerms(value));
      const translations = await Translation.search([
        ['type', '=', 'modelTerms'],
        ['label', '=', f("%s,%s", field.modelName, field.name)],
        ['resId', '=', record.id],
      ])

      if (!terms.size) {
        // discard all translations for that field
        discarded.add(translations);
        continue;
      }

      // remap existing translations on terms when possible; each term
      // should be translated at most once per language
      const done = new Set();                // {[src, lang], ...}
      const translationsToMatch = [];

      for (const translation of translations) {
        const [value, src, lang] = await translation('value', 'src', 'lang');
        if (!value) {
          discarded.add(translation);
          // consider it done to avoid being matched against another term
          done.add([src, lang]);
        }
        else if (terms.has(src)) {
          done.add([src, lang]);
        }
        else {
          translationsToMatch.push(translation);
        }
      }

      for (const translation of translationsToMatch) {
        const [lang, state] = await translation('lang', 'state');
        const matches = getCloseMatches(await translation.src, terms, 1, 0.9);
        const src = bool(matches) ? matches[0] : null;
        if (!src) {
          outdated.add(translation);
        }
        else if (Array.from(done).some((val) => val[0] === src && val[1] === lang)) {
          discarded.add(translation);
        }
        else {
          const vals = { 'src': src, 'state': state };
          if (lang === records.env.lang) {
            vals['value'] = src;
          }
          await translation.write(vals);
          done.add([src, lang]);
        }
      }
    }

    // process outdated and discarded translations
    await outdated.write({ 'state': 'toTranslate' });

    if (discarded.ok) {
      // delete in SQL to avoid invalidating the whole cache
      await discarded._modified();
      await discarded.modified(this._fields);
      await this.flush(this._fields.keys(), discarded);
      this.invalidateCache(null, discarded._ids);
      await this.env.cr.execute(`DELETE FROM "irTranslation" WHERE id IN (${discarded._ids})`);
    }
  }

  /**
   *  Return the translation of fields strings in the context's language.
    Note that the result contains the available translations only.

    @param modelName the name of a model
    @return the model's fields' strings as a dictionary `{fieldName: fieldString}`
   */
  @api.model()
  @tools.ormcacheContext('modelName', ['lang'])
  async getFieldString(modelName: string) {
    const fields = await (await this.env.items('ir.model.fields').sudo()).search([['model', '=', modelName]]);
    const res = {};
    for (const field of fields) {
      const [label, fieldDescription] = await field('label', 'fieldDescription');
      res[label] = fieldDescription;
    }
    return res;
  }

  /**
   * Return the translation of fields help in the context's language.
      Note that the result contains the available translations only.

      @param modelName the name of a model
      @return the model's fields' help as a dictionary `{fieldName: fieldHelp}`
   */
  @api.model()
  @tools.ormcacheContext('modelName', ['lang'])
  async getFieldHelp(modelName) {
    const fields = await (await this.env.items('ir.model.fields').sudo()).search([['model', '=', modelName]]);
    const res = {};
    for (const field of fields) {
      const [label, help] = await field('label', 'help');
      res[label] = help;
    }
    return res;
  }

  /**
   * Return the translation of a field's selection in the context's language.
      Note that the result contains the available translations only.

      @param modelName the name of the field's model
      @param fieldName the name of the field
      @returns the fields' selection as a list
   */
  @api.model()
  @tools.ormcacheContext('modelName', 'fieldName', ['lang'])
  async getFieldSelection(modelName: string, fieldName: string) {
    const field = await this.env.items('ir.model.fields')._get(modelName, fieldName);
    const selectionIds = await field.selectionIds;
    const res = await selectionIds.mapped(async (sel) => [await sel.value, await sel.label]);
    return res;
  }

  /**
   * Check access rights of operation ``mode`` on ``this`` for the
    current user. Raise an AccessError in case conditions are not met.
   * @param mode 
   * @returns 
   */
  async check(mode) {
    if (await this.env.isSuperuser()) {
      return;
    }

    // collect translated field records (model_ids) and other translations
    const transIds = [];
    const modelIds = new DefaultDict2(() => new Set());
    const modelFields = new DefaultDict2(() => new Set());
    for (const trans of this) {
      if (['model', 'modelTerms'].includes(await trans.type)) {
        const [mname, fname] = (await trans.label).split(',')
        modelIds[mname].add(trans.resId);
        modelFields[mname].add(fname);
      }
      else {
        transIds.push(trans.id);
      }
    }

    // check for regular access rights on other translations
    if (transIds.length) {
      const records = this.browse(transIds);
      await records.checkAccessRights(mode);
      await records.checkAccessRule(mode);
    }
    // check for read/write access on translated field records
    const fmode = mode == 'read' ? 'read' : 'write';
    for (const [mname, ids] of modelIds) {
      const records = await this.env.items(mname).browse(ids).exists();
      await records.checkAccessRights(fmode);
      await records.checkFieldAccessRights(fmode, modelFields[mname]);
      if (mode === 'create' && !equal(new Set(records._ids), ids)) {
        throw new ValidationError(await this._t("Creating translation on non existing records"));
      }
      if (!bool(records)) {
        continue;
      }
      await records.checkAccessRule(fmode);
    }
  }


  @api.constrains('type', 'label', 'value')
  async _checkValue() {
    for (const trans of await this.withContext({ lang: null })) {
      if (await trans.type === 'model' && await trans.value) {
        const [mname, fname] = (await trans.label).split(',');
        const record = trans.env.items(mname).browse(await trans.resId);
        const field = record._fields[fname];
        if (isCallable(await field.translate)) {
          const src = await trans.src;
          const val = (await trans.value).trim();
          // check whether applying (src -> val) then (val -> src)
          // gives the original value back
          const value0 = await field.translate(async (term) => [null, await record[fname]]);
          const value1 = await field.translate(Dict.from({ [src]: val }).get, value0);
          // don't check the reverse if no translation happened
          if (value0 == value1) {
            continue;
          }
          const value2 = await field.translate(Dict.from({ [val]: src }).get, value1);
          if (value2 != value0) {
            throw new ValidationError(await this._t("Translation is not valid:\n%s", val));
          }
        }
      }
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const records = await (await _super(IrTranslation, await this.sudo()).create(valsList)).withEnv(this.env);
    await records.check('create');
    await records._modified();
    await this.flush();
    return records;
  }

  async write(vals) {
    if (vals['value']) {
      setdefault(vals, 'state', 'translated');
    }
    else if (vals['src'] || !(vals['value'] ?? true)) {
      setdefault(vals, 'state', 'toTranslate');
    }
    await this.check('write');
    const result = await _super(IrTranslation, await this.sudo()).write(vals);
    await this.check('write');
    await this._modified();
    // when calling `flush` with a field list, if there is no value for one of these fields,
    // the flush to database is not done.
    // this causes issues when changing the src/value of a translation, as when we read, we ask the flush,
    // but its not really the field which is in the towrite values, but its translation
    await this.flush();
    return result;
  }

  async unlink() {
    await this.check('unlink');
    await this._modified();
    return _super(IrTranslation, await this.sudo()).unlink();
  }

  @api.model()
  async _search(args, options: { offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean } = {}) {
    // When assigning a translation to a field
    // e.g. email.withContext({lang: 'fr_FR'}).label = "bonjour"
    // and then search on translations for this translation, must flush as the translation has not yet been written in database
    let someField = false;
    for (const [model, ids] of this.env.all.towrite) {
      for (const [recordId, fields] of ids) {
        if (fields.keys().some(field => this.env.models[model]._fields[field].translate)) {
          await this.flush();
          someField = true;
          break;
        }
      }
      if (someField) {
        break;
      }
    }
    return _super(IrTranslation, this)._search(args, options);
  }

  /**
   * Insert missing translations for `field` on `records`.
   * @param field 
   * @param records 
   */
  @api.model()
  async insertMissing(field, records) {
    records = await records.withContext({ lang: null });
    const externalIds = await records.getExternalId();  // if no xmlid, empty string
    if (isCallable(field.translate)) {
      // insert missing translations for each term in src
      const query = ` INSERT INTO "irTranslation" (lang, type, label, "resId", src, value, module, state)
                      SELECT l.code, 'modelTerms', '{label}', {resId}, '{src}', '', '{module}', 'toTranslate'
                      FROM "resLang" l
                      WHERE l.active AND NOT EXISTS (
                          SELECT 1 FROM "irTranslation"
                          WHERE lang=l.code AND type='model' AND label='{label}' AND "resId"={resId} AND src='{src}'
                      )
                      ON CONFLICT DO NOTHING;
                  `;
      for (const record of records) {
        const modul = externalIds[record.id].split('.')[0];
        const src = await record[field.name] || null;
        for (const term of new Set(await field.getTransTerms(src))) {
          this._cr.execute(_f(query, {
            'label': f("%s,%s", field.modelName, field.name),
            'resId': record.id,
            'src': term,
            'module': modul
          }));
        }
      }
    }
    else {
      // insert missing translations for src
      const query = ` INSERT INTO "irTranslation" (lang, type, label, "resId", src, value, module, state)
                      SELECT l.code, 'model', '{label}', {redId}, '{src}', '', '{module}', 'toTranslate'
                      FROM "resLang" l
                      WHERE l.active AND NOT EXISTS (
                          SELECT 1 FROM "irTranslation"
                          WHERE lang=l.code AND type='model' AND label='{label}' AND resId={redId}
                      );

                      DELETE FROM "irTranslation" dup
                      WHERE type='model' AND label='{label}' AND resId={redId}
                          AND dup.id NOT IN (SELECT MAX(t.id)
                                     FROM "irTranslation" t
                                     WHERE t.lang=dup.lang AND type='model' AND label='{label}' AND resId={redId}
                          );

                      UPDATE "irTranslation" SET src='{src}'
                      WHERE type='model' AND label='{label}' AND resId={redId};
                  `;
      for (const record of records) {
        const modul = externalIds[record.id].split('.')[0];
        await this._cr.execute(_f(query, {
          'label': f("%s,%s", field.modelName, field.name),
          'resId': record.id,
          'src': await record[field.name] || null,
          'module': modul
        }));
      }
    }
    this._modifiedModel(field.modelName);
  }

  /**
   * Insert or update translations of type 'model' or 'modelTerms'.

        This method is used for creations of translations where the given
        ``valsList`` is trusted to be the right values and potential
        conflicts should be updated to the new given value.
        Mandatory values: name, lang, resId, src, type
        The other keys are ignored during update if not present
   * @param valsList 
   */
  @api.model()
  async _upsertTranslations(valsList: Dict<any>[]) {
    const rowsByType = new Dict();
    for (const vals of valsList) {
      rowsByType[vals['type']] = rowsByType[vals['type']] || [];
      rowsByType[vals['type']].push([
        vals['label'], vals['lang'], vals['resId'], vals['src'] || '', vals['type'],
        vals.get('module'), vals['value'] || '', vals.get('state'), vals.get('comments'),
      ]);
    }

    if (rowsByType['model']) {
      const query = format(`
        INSERT INTO "irTranslation" ("label", "lang", "resId", "src", "type", "module", "value", "state", "comments")
        VALUES (%s)
        ON CONFLICT ("type", "lang", "label", "resId") WHERE "type"='model'
        DO UPDATE SET ("label", "lang", "resId", "src", "type", "value", "module", "state", "comments") =
          (EXCLUDED."label", EXCLUDED."lang", EXCLUDED."resId", EXCLUDED."src", EXCLUDED."type",
            EXCLUDED."value",
            COALESCE(EXCLUDED."module", "irTranslation"."module"),
            COALESCE(EXCLUDED."state", "irTranslation"."state"),
            COALESCE(EXCLUDED."comments", "irTranslation"."comments"))
        WHERE EXCLUDED."value" IS NOT NULL AND EXCLUDED."value" != '';
      `, _.fill(Array(len(rowsByType['model'])), '%s').join(', '));
      await this.env.cr.execute(query, { params: rowsByType['model'] });
    }

    if (rowsByType['modelTerms']) {
      const query = format(`
          INSERT INTO "irTranslation" (label, lang, "resId", src, type,
                                      module, value, state, comments)
          VALUES (%s)
          ON CONFLICT (type, label, lang, "resId", md5(src))
          DO UPDATE SET (label, lang, "resId", src, type, value, module, state, comments) =
              (EXCLUDED.label, EXCLUDED.lang, EXCLUDED."resId", EXCLUDED.src, EXCLUDED.type,
                EXCLUDED.value, EXCLUDED.module, EXCLUDED.state, EXCLUDED.comments)
          WHERE EXCLUDED.value IS NOT NULL AND EXCLUDED.value != '';
      `, _.fill(Array(len(rowsByType['modelTerms'])), '%s').join(', '));
      await this.env.cr.execute(query, { params: rowsByType['modelTerms'] });
    }
  }

  /**
   * Update translations of type 'model' or 'modelTerms'.
      This method is used for update of translations where the given
      ``valsList`` is trusted to be the right values
      No new translation will be created
   * @param valsList 
   */
  async _updateTranslations(valsList) {
    const groupedRows = new Map();
    for (const vals of valsList) {
      const key = [vals['lang'], vals['type'], vals['label']];
      if (groupedRows.get(key) === undefined)
        groupedRows.set(key, [vals['value'], vals['src'], vals['state'], []]);
      groupedRows.get(key)[3].push(vals['resId']);
    }
    for (const [where, values] of groupedRows) {
      try {
        await this._cr.execute(
          ` UPDATE "irTranslation"
              SET "value"=$1,
                  "src"=$2,
                  "state"=$3
              WHERE "lang"=$4 AND "type"=$5 AND label=$6 AND "resId" in ($7)
          `,
          { bind: [values[0], values[1], values[2], where[0], where[1], where[2], values[3].join(',')] }
        );
      } catch (e) {
        console.error(e);
        throw e;
      }
    }
  }

  /**
   * Open a view for translating the field(s) of the record (model, id).
   * @param model 
   * @param id 
   * @param field 
   * @returns 
   */
  @api.model()
  async translateFields(model, id, field?: any) {
    const mainLang = 'en_US';
    if (! await this.env.items('res.lang').searchCount([['code', '!=', mainLang]])) {
      throw new UserError(await this._t("Translation features are unavailable until you install an extra translation."));
    }
    // determine domain for selecting translations
    const record = (await this.env.items(model).withContext({ lang: mainLang })).browse(id);
    let domain: any[] = ['&', ['resId', '=', id], ['label', '=like', model + ',%']];

    function makeDomain(fld, rec) {
      const label = f("%s,%s", fld.modelName, fld.name);
      return ['&', ['resId', '=', rec.id], ['label', '=', label]];
    }

    // insert missing translations, and extend domain for related fields
    for (let [name, fld] of record._fields) {
      if (!fld.translate) {
        continue;
      }

      let rec = record;
      if (fld.related) {
        try {
          // traverse related fields up to their data source
          while (fld.related) {
            [rec, fld] = await fld.traverseRelated(rec);
          }
          if (bool(rec)) {
            domain = extend(['|'], domain.concat(makeDomain(fld, rec)));
          }
        } catch (e) {
          if (isInstance(e, AccessError)) {
            continue;
          }
          throw e;
        }
      }
      assert(fld.translate && rec._name === fld.modelName);
      await this.insertMissing(fld, rec);
    }
    const action = {
      'label': await this._t('Translate'),
      'resModel': 'ir.translation',
      'type': 'ir.actions.actwindow',
      'viewMode': 'tree',
      'viewId': (await this.env.ref('base.viewTranslationDialogTree')).id,
      'target': 'current',
      'flags': { 'searchView': true, 'actionButtons': true },
      'domain': domain,
      'context': {},
    }
    if (field) {
      let fld = record._fields[field];
      if (!fld.related) {
        action['context'] = {
          'searchDefault_label': f("%s,%s", fld.modelName, fld.name),
        }
      }
      else {
        let rec = record;
        try {
          while (fld.related) {
            [rec, fld] = await fld.traverseRelated(rec);
          }
          if (bool(rec)) {
            action['context'] = { 'searchDefault_label': f("%s,%s", fld.modelName, fld.name), };
          }
        } catch (e) {
          if (!isInstance(e, AccessError)) {
            throw e;
          }
        }
      }
      action['target'] = 'new';
      action['context']['translationType'] = ['text', 'html'].includes(fld.type) ? 'text' : 'char';
      action['context']['translationShowSrc'] = false;
      if (isCallable(fld.translate)) {
        action['viewId'] = (await this.env.ref('base.viewTranslationLangSrcValueTree')).id;
        action['context']['translationShowSrc'] = true;
      }
      else {
        action['viewId'] = (await this.env.ref('base.viewTranslationLangValueTree')).id;
      }
    }
    return action;
  }

  /**
   * Return a cursor-like object for fast inserting translations
   */
  async _getImportCursor(overwrite) {
    return IrTranslationImport.new(this._cr, overwrite);
  }

  /**
   * Load PO files of the given modules for the given languages.
   * @param modules 
   * @param langs 
   * @param overwrite 
   */
  async _loadModuleTerms(modules: string[], langs: string[] = [], overwrite = false) {
    // load i18n files
    for (const moduleName of modules) {
      const modpath = getModulePath(moduleName);
      if (!modpath) {
        continue;
      }
      for (const lang of langs) {
        const langCode = getIsoCodes(lang);
        let langOverwrite = overwrite;
        let baseLangCode = null;
        if (langCode.includes('_')) {
          baseLangCode = langCode.split('_')[0];
        }
        // Step 1: for sub-languages, load base language first (e.g. es_CL.po is loaded over es.po)
        if (baseLangCode) {
          const baseTransFile = getResourcePath(moduleName, 'i18n', baseLangCode + '.po');
          if (baseTransFile) {
            console.info('%s: loading base translation file %s for language %s', moduleName, baseLangCode, lang);
            await transLoad(this._cr, baseTransFile, lang, { verbose: false, overwrite: langOverwrite });
            langOverwrite = true  // make sure the requested translation will override the base terms later
          }

          // i18n_extra folder is for additional translations handle manually (eg: for l10n_be)
          const baseTransExtraFile = getResourcePath(moduleName, 'i18n_extra', baseLangCode + '.po');
          if (baseTransExtraFile) {
            console.info('%s: loading extra base translation file %s for language %s', moduleName, baseLangCode, lang);
            await transLoad(this._cr, baseTransExtraFile, lang, { verbose: false, overwrite: langOverwrite });
            langOverwrite = true  // make sure the requested translation will override the base terms later
          }
        }
        // Step 2: then load the main translation file, possibly overriding the terms coming from the base language
        const transFile = getResourcePath(moduleName, 'i18n', langCode + '.po');
        if (transFile) {
          console.info('%s: loading translation file (%s) for language %s', moduleName, langCode, lang);
          await transLoad(this._cr, transFile, lang, { verbose: false, overwrite: langOverwrite });
        }
        else if (langCode !== 'en_US') {
          console.info('%s: no translation for language %s', moduleName, langCode);
        }

        const transExtraFile = getResourcePath(moduleName, 'i18n_extra', langCode + '.po');
        if (transExtraFile) {
          console.info('%s: loading extra translation file (%s) for language %s', moduleName, langCode, lang);
          await transLoad(this._cr, transExtraFile, lang, { verbose: false, overwrite: langOverwrite });
        }
      }
    }
    return true;
  }

  /**
   * Find the translations for the fields of `modelName`

      Find the technical translations for the fields of the model, including
      string, tooltip and available selections.
      
      @param modelName
      @returns action definition to open the list of available translations
   */
  @api.model()
  async getTechnicalTranslations(modelName) {
    const fields = await this.env.items('ir.model.fields').search([['model', '=', modelName]]);
    const selectionIds = (await (await fields.filter(async field => await field.ttype == 'selection')).map(async field => (await field.selectionIds).ids)).flat();
    const view = await this.env.ref("base.viewTranslationTree", false) || this.env.items('ir.ui.view');
    return {
      'label': await this._t("Technical Translations"),
      'viewMode': 'tree',
      'views': [[view.id, "list"]],
      'resModel': 'ir.translation',
      'type': 'ir.actions.actwindow',
      'domain': [
        '&',
        ['type', '=', 'model'],
        '|',
        '&', ['resId', 'in', fields.ids],
        ['label', 'like', 'ir.model.fields,'],
        '&', ['resId', 'in', selectionIds],
        ['label', 'like', 'ir.model.fields.selection,']
      ],
    }
  }

  @api.model()
  async getTranslationsForWebclient(mods, lang) {
    if (!len(mods)) {
      mods = await (await this.env.items('ir.module.module').sudo())
        .searchRead([['state', '=', 'installed']], ['label']);
      mods = mods.map(x => x['label']);
    }
    if (!lang) {
      lang = this._context["lang"];
    }
    const langs = await this.env.items('res.lang')._langGet(lang);
    let langParams;
    if (langs.ok) {
      langParams = await langs.getDict(["label", "direction", "dateFormat", "timeFormat", "grouping", "decimalPoint", "thousandsSep", "weekStart"]);
      langParams['weekStart'] = parseInt(langParams['weekStart']);
      langParams['code'] = lang;
    }
    // Regional languages (ll_CC) must inherit/override their parent lang (ll), but this is
    // done server-side when the language is loaded, so we only need to load the user's lang.
    const translationsPerModule = {};
    const messages = await (await this.env.items('ir.translation').sudo()).searchRead(
      [['module', 'in', mods], ['lang', '=', lang],
      ['comments', 'like', 'verp-web'], ['value', '!=', false],
      ['value', '!=', '']],
      ['module', 'src', 'value', 'lang'], {
        order: 'module'
    });
    for (const [mod, msgGroup] of groupby(messages, itemgetter(['module']))) {
      setdefault(translationsPerModule, mod, { 'messages': [] });
      extend(translationsPerModule[mod]['messages'], msgGroup.map(m => { return { 'id': m['src'], 'string': m['value'] } }));
    }
    return [translationsPerModule, langParams];
  }

  @api.model()
  @tools.ormcache('Array.from(mods)', 'lang')
  async getWebTranslationsHash(mods, lang) {
    const [translations, langParams] = await this.getTranslationsForWebclient(mods, lang);
    const translationCache = {
      'langParameters': langParams,
      'modules': translations,
      'lang': lang,
      'multiLang': len((await this.env.items('res.lang').sudo()).getInstalled()) > 1,
    }
    return sha1(stringify(translationCache));
  }
}