import { v1 as uuidv1, v4 as uuidv4 } from 'uuid';
import { api, tools } from '../../..';
import { Fields, _Datetime } from "../../../fields";
import { MetaModel, Model, _super } from "../../../models";
import { config } from "../../../tools/config";

const _defaultParameters = {
  "database.secret": () => uuidv4(),
  "database.uuid": () => uuidv1(),
  "database.createdAt": _Datetime.now,
  "web.base.url": () => `http://localhost:${config.get('httpPort')}`,
  "base.loginCooldownAfter": () => 10,
  "base.loginCooldownDuration": () => 60,
}

@MetaModel.define()
class IrConfigParameter extends Model {
  static _module = module;
  static _name = 'ir.config.parameter';
  static _table = 'irConfigParameter';
  static _description = 'System Parameter';
  static _recName = 'key';
  static _order = 'key';

  static key = Fields.Char({required: true, index: true})
  static value = Fields.Text({required: true})

  static _sqlConstraints = [
    ['key_uniq', 'unique (key)', 'Key must be unique.']
  ]

  async init(force=false) {
    const self = await this.withContext({prefetchFields: false});
    for (const [key, func] of Object.entries(_defaultParameters)) {
      const params = await (await self.sudo()).search([['key', '=', key]]);
      if (force || !(params.ok)) {
        await params.setParam(key, func());
      }
    }
  }

  /**
   * Retrieve the value for a given key.

   * @param key The key of the parameter value to retrieve.
   * @param defaultValue default value if parameter is missing.
   * @returns The value of the parameter, or ``default`` if it does not exist.
   */
  @api.model()
  async getParam(key, defaultValue=false) {
    await this.checkAccessRights('read');
    return (await this._getParam(key)) ?? defaultValue;
  }

  @api.model()
  @tools.ormcache('key')
  async _getParam(key) {
    // we bypass the ORM because get_param() is used in some field's depends,
    // and must therefore work even when the ORM is not ready to work
    await this.flush(['key', 'value']);
    const result = await this.env.cr.execute(`SELECT "value" FROM "irConfigParameter" WHERE "key"='${key}'`)
    return result[0] && result[0]['value']; 
  }

  /**
   * Sets the value of a parameter.

   * @param key The key of the parameter value to set.
   * @param value The value to set.
   * @returns the previous value of the parameter or false if it did
              not exist.
   */
  @api.model()
  async setParam(key, value) {
    const param = await this.search([['key', '=', key]]) as any;
    if (param.ok) {
      const old = await param.value
      if (value !== false && value !== null) {
        if (old !== `${value}`)
          await param.write({'value': value})
      } else {
        await param.unlink();
      }
      return old;
    } else {
      if (value !== false && value !== null) {
        await this.create({'key': key, 'value': value});
      }
      return false;
    }
  }

  @api.modelCreateMulti()
  async create(valsList: {}) {
    this.clearCaches();
    return _super(IrConfigParameter, this).create(valsList);
  }

  async write(vals) {
    this.clearCaches();
    return _super(IrConfigParameter, this).write(vals);
  }

  async unlink() {
    this.clearCaches();
    return _super(IrConfigParameter, this).unlink();
  }
}