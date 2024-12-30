import _ from "lodash"
import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { AbstractModel, MetaModel, _super } from "../../../core/models"
import { iter, next } from "../../../core/tools/iterable"
import { bool } from "../../../core/tools/bool"

@MetaModel.define()
class AliasMixin extends AbstractModel {
  static _module = module;
  static _name = 'mail.alias.mixin';
  static _inherits = {'mail.alias': 'aliasId'};
  static _description = 'Email Aliases Mixin';

  ALIAS_WRITEABLE_FIELDS = ['aliasName', 'aliasContact', 'aliasDefaults', 'aliasBouncedContent'];

  static aliasId = Fields.Many2one('mail.alias', {string: 'Alias', ondelete: "RESTRICT", required: true});

  // CRUD

  /**
   * Create a record with each ``vals`` or ``valsList`` and create a corresponding alias. 
   * @param valsList 
   */
  @api.modelCreateMulti()
  async create(valsList) {
    // prepare all alias values
    const aliasValsList = [];
    const recordValsList = [];
    for (const vals of valsList) {
      const newAlias = ! vals['aliasId'];
      if (newAlias) {
        const [aliasVals, recordVals] = this._aliasFilterFields(vals);
        Object.assign(aliasVals, await this._aliasGetCreationValues());
        aliasValsList.push(aliasVals);
        recordValsList.push(recordVals);
      }
    }
    // create all aliases
    let aliasIds: any = [];
    if (aliasValsList.length) {
      aliasIds = iter((await (await this.env.items('mail.alias').sudo()).create(aliasValsList)).ids);
    }
    // update alias values in create vals directly
    const validValsList = [];
    const recordValsIter = iter(recordValsList);
    for (const vals of valsList) {
      const newAlias = ! vals['aliasId'];
      if (newAlias) {
        const recordVals = next(recordValsIter);
        recordVals['aliasId'] = next(aliasIds);
        validValsList.push(recordVals);
      }
      else {
        validValsList.push(vals);
      }
    }
    const records = await _super(AliasMixin, this).create(validValsList);

    for (const record of records) {
      await (await (await record.aliasId).sudo()).write(await record._aliasGetCreationValues());
    }

    return records;
  }

  /**
   * Split writable fields of mail.alias and other fields alias fields will
    write with sudo and the other normally
   * @param vals 
   * @returns 
   */
  async write(vals) {
    const [aliasVals, recordVals] = this._aliasFilterFields(vals, this.ALIAS_WRITEABLE_FIELDS);
    if (bool(recordVals)) {
      await _super(AliasMixin, this).write(recordVals);
    }
    if (aliasVals && (recordVals || this.checkAccessRights('write', false))) {
      await (await (await this.mapped('aliasId')).sudo()).write(aliasVals);
    }

    return true;
  }

  /**
   * Delete the given records, and cascade-delete their corresponding alias.
   * @returns 
   */
  async unlink() {
    const aliases = await this.mapped('aliasId');
    const res = await _super(AliasMixin, this).unlink();
    await (await aliases.sudo()).unlink();
    return res;
  }

  @api.returns(null, (value) => value[0])
  async copyData(defaultValue?: any) {
    const data = (await _super(AliasMixin, this).copyData(defaultValue))[0];
    for (const fieldsNotWritable of _.difference<any>(this.env.models['mail.alias']._fields.keys(), this.ALIAS_WRITEABLE_FIELDS)) {
      if (fieldsNotWritable in data) {
        delete data[fieldsNotWritable]
      }
    }
    return [data]
  }

  /**
   * Create aliases for existing rows.
   * @param name 
   */
  async _initColumn(name) {
    await _super(AliasMixin, this)._initColumn(name);
    if (name === 'aliasId') {
      // as 'mail.alias' records refer to 'ir.model' records, create
      // aliases after the reflection of models
      const self: any = this;
      this.pool.postInit(self._initColumnAliasId, self);
    }
  }

  async _initColumnAliasId() {
    // both self and the alias model must be present in 'ir.model'
    const childCtx = {
      'activeTest': false,       // retrieve all records
      'prefetchFields': false,   // do not prefetch fields on records
    }
    const childModel = await (await this.sudo()).withContext(childCtx);

    for (const record of await childModel.search([['aliasId', '=', false]])) {
      // create the alias, and link it to the current record
      const alias = await (await this.env.items('mail.alias').sudo()).create(await record._aliasGetCreationValues());
      await (await record.withContext({mailNotrack: true})).set('aliasId', alias);
      console.info('Mail alias created for %s %s (id %s)', record._name, await record.displayName, record.id);
    }
  }

  // MIXIN TOOL OVERRIDE METHODS

  /**
   * Return values to create an alias, or to write on the alias after its
        creation.
   */
  async _aliasGetCreationValues() {
    return {
      'aliasParentThreadId': bool(this.id) ? this.id : false,
      'aliasParentModelId': (await this.env.items('ir.model')._get(this._name)).id,
    }
  }

  /**
   * Split the vals dict into two dictionnary of vals, one for alias
    field and the other for other fields
   */
  _aliasFilterFields(values, filters?: string[]) {
    if (! filters) {
      filters = this.env.models['mail.alias']._fields.keys();
    }
    const aliasValues = {};
    const recordValues = {};
    for (const fname of Object.keys(values)) {
      if (filters.includes(fname)) {
        aliasValues[fname] = values[fname];
      }
      else {
        recordValues[fname] = values[fname];
      }
    }
    return [aliasValues, recordValues];
  }
}