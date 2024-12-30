import util from 'util';
import { api, tools } from "../../..";
import { Fields } from "../../../fields";
import { Dict } from "../../../helper/collections";
import { KeyError, ValidationError } from "../../../helper/errors";
import { MetaModel, Model, _super } from "../../../models";
import { isInstance } from "../../../tools";
import { stringify } from "../../../tools/json";

const regAscii = /^[\x00-\xFF]*$/gm;
const regAsciiEx = /^[\x00-\x7F]*$/gm;

@MetaModel.define()
class IrDefault extends Model {
  static _module = module;
  static _name = 'ir.default';
  static _description = 'Default Values';
  static _recName = 'fieldId';

  static fieldId = Fields.Many2one('ir.model.fields', { string: "Field", required: true, ondelete: 'CASCADE', index: true });
  static userId = Fields.Many2one('res.users', { string: 'User', ondelete: 'CASCADE', index: true, help: "If set, action binding only applies for this user." });
  static companyId = Fields.Many2one('res.company', { string: 'Company', ondelete: 'CASCADE', index: true, help: "If set, action binding only applies for this company" });
  static condition = Fields.Char('Condition', { help: "If set, applies the default upon condition." });
  static jsonValue = Fields.Char('Default Value (JSON format)', { required: true });

  @api.modelCreateMulti()
  async create(valsList: any): Promise<any> {
    this.clearCaches();
    return _super(IrDefault, this).create(valsList);
  }

  async write(vals) {
    if (!this.nok)
      this.clearCaches()
    return _super(IrDefault, this).write(vals);
  }

  async unlink() {
    if (!this.nok) {
      this.clearCaches();
    }
    return _super(IrDefault, this).unlink();
  }

  /**
   * Return the available default values for the given model (for the
      current user), as a dict mapping field names to values.
   * @param modelName 
   * @param condition 
   */
  @api.model()
  @tools.ormcache('self.env.uid', '(await self.env.company()).id', 'modelName', 'condition')
  async getModelDefaults(modelName, condition = false) {
    const cr = this.env.cr
    let query = `SELECT f.label, d."jsonValue"
                FROM "irDefault" d
                JOIN "irModelFields" f ON d."fieldId"=f.id
                WHERE f.model='${modelName}'
                    AND (d."userId" IS NULL OR d."userId"=${this.env.uid})
                    AND (d."companyId" IS NULL OR d."companyId"=${(await this.env.company()).id || null})
                    AND %s
                ORDER BY d."userId", d."companyId", d."id"
            `;
    // self.env.company is empty when there is no user (controllers with auth=None)
    if (condition) {
      query = util.format(query, `d.condition='${condition}'`);
    } else {
      query = util.format(query, `d.condition IS NULL`);
    }
    const res = await cr.execute(query);
    const result = {}
    for (const row of res) {
      // keep the highest priority default for each field
      if (!(row['label'] in result)) {
        result[row['label']] = JSON.parse(row['jsonValue'].replace(/(^'|'$)/g, ''));
      }
    }
    return result;
  }

  /**
   * Defines a default value for the given field. Any entry for the same scope (field, user, company) will be replaced. The value is encoded in JSON to be stored to the database.
   * @param modelName 
   * @param fieldName 
   * @param value 
   * @param options 
    - userId: may be ``false`` for all users, ``true`` for the
                    current user, or any user id
    - companyId: may be ``false`` for all companies, ``true`` for
                        the current user's company, or any company id
    - condition: optional condition that restricts the
                      applicability of the default value; this is an
                      opaque string, but the client typically uses
                      single-field conditions in the form ``'key=val'``.
   */
  @api.model()
  async setDefault(modelName: string, fieldName: string, value: any, options: any = { userId: false, companyId: false, condition: false }) {
    options = options ?? {};
    const userId = (options.userId == true) ? this.env.uid : options.userId;
    const companyId = (options.companyId == true) ? (await this.env.company()).id : options.companyId;

    // check consistency of modelName, fieldName, and value
    let jsonValue;
    try {
      const model = this.env.items(modelName);
      const field = model._fields[fieldName];
      await field.convertToCache(value, model);
      jsonValue = stringify(value);
    } catch (e) {
      if (isInstance(e, KeyError)) {
        throw new ValidationError(await this._t("Invalid field %s.%s", modelName, fieldName));
      }
      else {
        throw new ValidationError(await this._t("Invalid value for %s.%s: %s", modelName, fieldName, value));
      }
    }
    // update existing default for the same scope, or create one
    const field = await this.env.items('ir.model.fields')._get(modelName, fieldName);
    const defaultValue = await this.search([
      ['fieldId', '=', field.id],
      ['userId', '=', userId],
      ['companyId', '=', companyId],
      ['condition', '=', options.condition]
    ])
    if (defaultValue.ok) {
      await defaultValue.write({ 'jsonValue': jsonValue });
    }
    else {
      await this.create([Dict.from({
        'fieldId': field.id,
        'userId': userId,
        'companyId': companyId,
        'condition': options.condition,
        'jsonValue': jsonValue,
      })]);
    }
    return true;
  }

  /**
   * Return the default value for the given field, user and company, or
    ``None`` if no default is available.

   * @param modelName 
   * @param fieldName 
   * @param options 
    - userId: may be ``false`` for all users, ``true`` for the
                    current user, or any user id
    - companyId: may be ``false`` for all companies, ``true`` for
                        the current user's company, or any company id
    - condition: optional condition that restricts the
                      applicability of the default value; this is an
                      opaque string, but the client typically uses
                      single-field conditions in the form ``'key=val'``.
   */
  @api.model()
  async get(modelName: string, fieldName: string, options: any = { userId: false, companyId: false, condition: false }) {
    const userId = (options.userId == true) ? this.env.uid : options.userId;
    const companyId = (options.companyId == true) ? (await this.env.company()).id : options.companyId;
    const field = await this.env.items('ir.model.fields')._get(modelName, fieldName);
    const defaultValue = await this.search([
      ['fieldId', '=', field.id],
      ['userId', '=', userId],
      ['companyId', '=', companyId],
      ['condition', '=', options.condition],
    ], { limit: 1 });
    return defaultValue.ok ? JSON.parse(await defaultValue.jsonValue) : null;
  }

  /**
   * Discard all the defaults of many2one fields using any of the given records.
   * @param records 
   * @returns 
   */
  @api.model()
  async discardRecords(records) {
    const jsonVals = records.ids.map(id => stringify(id));
    const domain = [['fieldId.ttype', '=', 'many2one'],
    ['fieldId.relation', '=', records.cls._name],
    ['jsonValue', 'in', jsonVals]];
    return (await this.search(domain)).unlink();
  }

  /**
   * Discard all the defaults for any of the given values.
   * @param modelName 
   * @param fieldName 
   * @param values 
   * @returns 
   */
  @api.model()
  async discardValues(modelName, fieldName, values) {
    const field = await this.env.items('ir.model.fields')._get(modelName, fieldName);
    const jsonVals = Object.values(values).map(value => stringify(value));
    const domain = [['fieldId', '=', field.id], ['jsonValue', 'in', jsonVals]];
    return (await this.search(domain)).unlink();
  }
}