import { api } from "../../..";
import { Fields } from "../../../fields";
import { MetaModel, Model, _super } from "../../../models";
import { NEGATIVE_TERM_OPERATORS } from "../../../osv/expression";
import { isIterable, len } from "../../../tools/iterable";

export function sanitizeAccountNumber(accNumber: string) {
  if (accNumber) {
    accNumber.replace(/\W+/g, '').toUpperCase();
  }
  return false;
}

@MetaModel.define()
class Bank extends Model {
  static _module = module;
  static _description = 'Bank';
  static _name = 'res.bank';
  static _order = 'label';

  static label = Fields.Char({required: true});
  static street = Fields.Char();
  static street2 = Fields.Char();
  static zip = Fields.Char();
  static city = Fields.Char();
  static state = Fields.Many2one('res.country.state', {string: 'Fed. State', domain: "[['countryId', '=?', country]]"});
  static country = Fields.Many2one('res.country');
  static email = Fields.Char();
  static phone = Fields.Char();
  static active = Fields.Boolean({default: true});
  static bic = Fields.Char('Bank Identifier Code', {index: true, help: "Sometimes called BIC or Swift."});

  async nameGet() {
    const result = [];
    for (const bank of this) {
      const [id, label, bic] = await bank('id', 'label', 'bic');

      const name = label + ((bic && (' - ' + bic)) || '')
      result.push([id, name])
    }
    return result;
  }

  @api.model()
  async _nameSearch(name='', args?: any, operator='ilike', {limit=100, nameGetUid=false}={}): Promise<any> {
    args = args || [];
    let domain = [];
    if (name) {
      domain = ['|', ['bic', '=ilike', name + '%'], ['label', operator, name]];
      if (NEGATIVE_TERM_OPERATORS.includes(operator)) {
        domain = ['&'].concat(domain);
      }
    }
    return this._search(domain.concat(args), {limit, accessRightsUid: nameGetUid});
  }
}


@MetaModel.define()
class ResPartnerBank extends Model {
  static _module = module;
  static _name = 'res.partner.bank';
  static _recName = 'accNumber';
  static _description = 'Bank Accounts';
  static _order = 'sequence, id';

  @api.model()
  async getSupportedAccountTypes() {
    return this._getSupportedAccountTypes();
  }

  @api.model()
  async _getSupportedAccountTypes() {
    return [['bank', await this._t('Normal')]];
  }

  static active = Fields.Boolean({default: true});
  static accType = Fields.Selection(async (x) => x.env.items('res.partner.bank').getSupportedAccountTypes(), {compute: '_computeAccType', string: 'Type', help: 'Bank account type: Normal or IBAN. Inferred from the bank account number.'});
  static accNumber = Fields.Char('Account Number', {required: true});
  static sanitizedAccNumber = Fields.Char({compute: '_computeSanitizedAccNumber', string: 'Sanitized Account Number', readonly: true, store: true});
  static accHolderName = Fields.Char({string: 'Account Holder Name', help: "Account holder name, in case it is different than the name of the Account Holder"});
  static partnerId = Fields.Many2one('res.partner', {string: 'Account Holder', ondelete: 'CASCADE', index: true, domain: ['|', ['isCompany', '=', true], ['parentId', '=', false]], required: true});
  static bankId = Fields.Many2one('res.bank', {string: 'Bank'});
  static bankName = Fields.Char({related: 'bankId.label', readonly: false});
  static bankBic = Fields.Char({related: 'bankId.bic', readonly: false});
  static sequence = Fields.Integer({default: 10});
  static currencyId = Fields.Many2one('res.currency', {string: 'Currency'});
  static companyId = Fields.Many2one('res.company', {string: 'Company', default: async (self) => await self.env.company(), ondelete: 'CASCADE', readonly: true});

  static _sqlConstraints = [
    ['uniqueNumber', 'unique("sanitizedAccNumber", "companyId")', 'Account Number must be unique'],
  ];

  @api.depends('accNumber')
  async _computeSanitizedAccNumber() {
    for (const bank of this as any) {
      await bank.set('sanitizedAccNumber', sanitizeAccountNumber(await bank.accNumber));
    }
  }

  @api.depends('accNumber')
  async _computeAccType() {
    for (const bank of this as any) {
      await bank.set('accType', await this.retrieveAccType(await bank.accNumber));
    }
  }

  /**
   * To be overridden by subclasses in order to support other account_types.
   */
  @api.model()
  async retrieveAccType(accNumber) {
    return 'bank';
  }
  
  async nameGet() {
    const self: any = this; 
    const res = [];
    for (const acc of self) {
      const [bankId, accNumber] = await acc('bankId', 'accNumber');
      if (await acc.bankId) {
        res.push([acc.id, `${accNumber} - ${await bankId.label}`]);
      }
    }
    return res;
  }

  @api.model()
  async _search(args: any, options?: { offset?: number; limit?: number; order?: string; count?: boolean; accessRightsUid?: boolean; }) {
    let pos = 0;
    while (pos < len(args)) {
      if (args[pos][0] === 'accNumber') {
        const op = args[pos][1];
        let value = args[pos][2];
        if (! (typeof value === 'string') && isIterable(value))
          value = value.map(i => sanitizeAccountNumber(i));
        else
          value = sanitizeAccountNumber(value);
        if (op.includes('like'))
          value = '%' + value + '%'
        args[pos] = ['sanitizedAccNumber', op, value];
      }
      pos += 1;
    }
    return _super(ResPartnerBank, this)._search(args, options);
  }
}