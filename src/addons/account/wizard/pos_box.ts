import { Fields } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
export class CashBox extends TransientModel {
  static _module = module;
  static _register = false;

  static label = Fields.Char({ string: 'Reason', required: true });
  // Attention, we don't set a domain, because there is a journalType key
  // in the context of the action
  static amount = Fields.Float({ string: 'Amount', digits: 0, required: true });

  async run() {
    const context = Object.assign({}, this._context);
    const activeModel = context['activeModel'] ?? false;
    const activeIds = context['activeIds'] ?? [];

    const records = this.env.items(activeModel).browse(activeIds);

    return this._run(records);
  }

  async _run(records) {
    for (const box of this) {
      for (const record of records) {
        if (!bool(await record.journalId)) {
          throw new UserError(await this._t("Please check that the field 'Journal' is set on the Bank Statement"));
        }
        if (!bool(await (await (await record.journalId).companyId).transferAccountId)) {
          throw new UserError(await this._t("Please check that the field 'Transfer Account' is set on the company."));
        }
        await box._createBankStatementLine(record);
      }
    }
    return {};
  }

  async _createBankStatementLine(record) {
    for (const box of this) {
      if (await record.state === 'confirm') {
        throw new UserError(await this._t("You cannot put/take money in/out for a bank statement which is closed."));
      }
      const values = await box._calculateValuesForStatementLine(record);
      await (await this.env.items('account.bank.statement.line').sudo()).create(values);
    }
  }
}

@MetaModel.define()
class CashBoxOut extends CashBox {
  static _module = module;
  static _name = 'cash.box.out';
  static _description = 'Cash Box Out';
  static _register = true;

  async _calculateValuesForStatementLine(record) {
    if (!bool(await (await (await record.journalId).companyId).transferAccountId)) {
      throw new UserError(await this._t("You have to define an 'Internal Transfer Account' in your cash register's journal."));
    }
    const amount = await this['amount'] || 0.0;
    return {
      'date': await record.date,
      'statementId': record.id,
      'journalId': (await record.journalId).id,
      'amount': amount,
      'paymentRef': await this['label'],
    }
  }
}