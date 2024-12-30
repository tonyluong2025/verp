import { api } from "../../..";
import { Fields } from "../../../fields";
import { KeyError, UserError, ValueError } from "../../../helper";
import { MetaModel, Model, _super } from "../../../models";
import { expression } from "../../../osv";
import { f, isInstance } from "../../../tools";
import { len } from "../../../tools/iterable";

const FLAG_MAPPING = {
  "GF": "fr",
  "BV": "no",
  "BQ": "nl",
  "GP": "fr",
  "HM": "au",
  "YT": "fr",
  "RE": "fr",
  "MF": "fr",
  "UM": "us",
}

const NO_FLAG_COUNTRIES = [
  "AQ", //Antarctica
  "SJ", //Svalbard + Jan Mayen : separate jurisdictions : no dedicated flag
]

@MetaModel.define()
class Country extends Model {
  static _module = module;
  static _name = 'res.country';
  static _description = 'Country';
  static _order = 'label';

  static label = Fields.Char({ string: 'Country Name', required: true, translate: true, help: 'The full name of the country.' });
  static code = Fields.Char({ string: 'Country Code', size: 2, help: 'The ISO country code in two chars. \nYou can use this field for quick search.' });
  static addressFormat = Fields.Text({
    string: "Layout in Reports", help: `Display format to use for addresses belonging to this country.\n\n
    You can use javascript string pattern with all the fields of the address
    (for example, use '{street}' to display the field 'street') plus"
    \n{stateName}: the name of the state
    \n{stateCode}: the code of the state
    \n{countryName}: the name of the country
    \n{countryCode}: the code of the country`, default: '{street}\n{street2}\n{city} {stateCode} {zip}\n{countryName}'
  });
  static addressViewId = Fields.Many2one('ir.ui.view', { string: "Input View", domain: [['model', '=', 'res.partner'], ['type', '=', 'form']], help: "Use this field if you want to replace the usual way to encode a complete address. Note that the address_format field is used to modify the way to display addresses (in reports for example), while this field is used to modify the input form for addresses." });
  static currencyId = Fields.Many2one('res.currency', { string: 'Currency' });
  static imageUrl = Fields.Char({ compute: "_computeImageUrl", string: "Flag", help: "Url of static flag image" });
  static phoneCode = Fields.Integer({ string: 'Country Calling Code' });
  static countryGroupIds = Fields.Many2many('res.country.group', { relation: 'resCountryresCountryGroupRel', column1: 'resCountryId', column2: 'resCountryGroupId', string: 'Country Groups' });
  static stateIds = Fields.One2many('res.country.state', 'countryId', { string: 'States' });
  static namePosition = Fields.Selection([
    ['before', 'Before Address'],
    ['after', 'After Address'],
  ], { string: "Customer Name Position", default: "before", help: "Determines where the customer/company name should be placed, i.e. after or before the address." });
  static vatLabel = Fields.Char({ string: 'Vat Label', translate: true, help: "Use this field if you want to change vat label." });
  static stateRequired = Fields.Boolean({ default: false });
  static zipRequired = Fields.Boolean({ default: true });

  static _sqlConstraints = [
    ['label_uniq', 'unique (label)',
      'The name of the country must be unique !'],
    ['code_uniq', 'unique (code)',
      'The code of the country must be unique !']
  ];

  async _nameSearch(name = '', args?: any, operator = 'ilike', { limit = 100, nameGetUid = false } = {}) {
    if (args == null) {
      args = [];
    }

    let ids: any = [];
    if (len(name) == 2) {
      ids = await this._search([['code', 'ilike', name]].concat(args), { limit });
    }
    const searchDomain: any[] = [['label', operator, name]];
    if (len(ids)) {
      searchDomain.push(['id', 'not in', ids]);
    }
    ids = ids.concat(await this._search(searchDomain.concat(args), { limit }));

    return ids;
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const vals of valsList) {
      if (vals.get('code'))
        vals['code'] = vals['code'].toUpperCase();
    }
    return _super(Country, this).create(valsList);
  }

  async write(vals) {
    if (vals.get('code'))
      vals['code'] = vals['code'].toUpperCase();
    return _super(Country, this).write(vals);
  }

  async getAddressFields() {
    this.ensureOne();
    return Array.from((await this['addressFormat']).matchAll(/{(.+?)}/gm)).map(match => match[1]);
  }

  @api.depends('code')
  async _computeImageUrl() {
    for (const country of this) {
      if (! await country.code || NO_FLAG_COUNTRIES.includes(country.code)) {
        await country.set('imageUrl', false);
      }
      else {
        const code = FLAG_MAPPING[await country.code] ?? (await country.code).toLowerCase();
        await country.set('imageUrl', f("/base/static/img/country_flags/%s.png", code));
      }
    }
  }

  @api.constrains('addressFormat')
  async _checkAddressFormat() {
    for (const record of this) {
      if (await record.addressFormat) {
        const addressFields = this.env.items('res.partner')._formattingAddressFields().concat(['stateCode', 'state_name', 'countryCode', 'countryName', 'companyName']);
        try {
          f(await record.addressFormat, addressFields);
        } catch (e) {
          if (isInstance(e, ValueError, KeyError)) {
            throw new UserError(await this._t('The layout contains an invalid format key'));
          }
        }
      }
    }
  }

  @api.constrains('code')
  async _checkCountryCode() {
    for (const record of this) {
      if (! await record.code) {
        throw new UserError(await this._t('Country code cannot be empty'));
      }
    }
  }
}

@MetaModel.define()
class CountryGroup extends Model {
  static _module = module;
  static _description = "Country Group";
  static _name = 'res.country.group';

  static label = Fields.Char({ required: true, translate: true });
  static countryIds = Fields.Many2many('res.country', { relation: 'resCountryresCountryGroupRel', column1: 'resCountryGroupId', column2: 'resCountryId', string: 'Countries' });
}

@MetaModel.define()
class CountryState extends Model {
  static _module = module;
  static _description = "Country state";
  static _name = 'res.country.state';
  static _order = 'code';

  static countryId = Fields.Many2one('res.country', { string: 'Country', required: true });
  static label = Fields.Char({ string: 'State Name', required: true, help: 'Administrative divisions of a country. E.g. Fed. State, Departement, Canton' });
  static code = Fields.Char({ string: 'State Code', help: 'The state code.', required: true });

  static _sqlConstraints = [
    ['countryCode_uniq', 'unique("countryId", code)', 'The code of the state must be unique by country !']
  ];

  @api.model()
  async _nameSearch(name?: string, args?: any, operator = 'ilike', { limit = 100, nameGetUid = false } = {}): Promise<any> {
    args = args || []
    if (this.env.context['countryId']) {
      args = expression.AND([args, [['countryId', '=', this.env.context['countryId']]]]);
    }
    let domain, firstDomain;
    if (operator === 'ilike' && !(name || '').trim()) {
      firstDomain = [];
      domain = [];
    }
    else {
      firstDomain = [['code', '=ilike', name]];
      domain = [['label', operator, name]];
    }

    const firstStateIds: any[] = len(firstDomain) ? await this._search(expression.AND([firstDomain, args]), { limit, accessRightsUid: nameGetUid }) as any[] : [];
    const stateIds: any[] = await this._search(expression.AND([domain, args]), { limit, accessRightsUid: nameGetUid }) as any[];
    return Array.from(firstStateIds).concat(stateIds.filter(id => !firstStateIds.includes(id)));
  }

  async nameGet() {
    const result = [];
    for (const record of this) {
      result.push([record.id, `${await record.label} (${await (await record.countryId).code})`]);
    }
    return result;
  }
}