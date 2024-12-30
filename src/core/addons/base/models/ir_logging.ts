import { Fields } from "../../../fields";
import { MetaModel, Model, _super } from "../../../models";
import { len } from "../../../tools/iterable";

/**
 * Represents an SMTP server, able to send outgoing emails, with SSL and TLS capabilities.
 */
@MetaModel.define()
class IrLogging extends Model {
  static _module = module;
  static _name = "ir.logging";
  static _description = 'Logging';
  static _order = 'id desc';

  static createdUid = Fields.Integer({string: 'Created by', readonly: true});
  static createdAt = Fields.Datetime({string: 'Created on', readonly: true});
  static updatedUid = Fields.Integer({string: 'Last Updated by', readonly: true});
  static updatedAt = Fields.Datetime({string: 'Last Updated on', readonly: true});

  static label = Fields.Char({required: true});
  static type = Fields.Selection([['client', 'Client'], ['server', 'Server']], {required: true, index: true});
  static dbName = Fields.Char({string: 'Database Name', index: true});
  static level = Fields.Char({index: true});
  static message = Fields.Text({required: true});
  static path = Fields.Char({required: true});
  static func = Fields.Char({string: 'Function', required: true});
  static line = Fields.Char({required: true});

  async init() {
    await _super(IrLogging, this).init();
    const res = await this._cr.execute("select 1 from information_schema.constraint_column_usage where table_name = 'irLogging' and constraint_name = 'irLogging_updatedUid_fkey'")
    if (len(res)) {
      // DROP CONSTRAINT unconditionally takes an ACCESS EXCLUSIVE lock
      // on the table, even "IF EXISTS" is set and not matching; disabling the relevant trigger instead acquires SHARE ROW EXCLUSIVE, which still conflicts with the ROW EXCLUSIVE needed for an insert
      await this._cr.execute(`ALTER TABLE "irLogging" DROP CONSTRAINT "irLogging_updatedUid_fkey"`);
    }
  }
}