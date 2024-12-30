import { getHeapCodeStatistics } from "node:v8";
import { Fields, api, tools } from "../../..";
import { UserError, ValidationError } from '../../../helper/errors';
import { MetaModel, Model } from "../../../models";
import { isList, itemgetter, rsplit, sorted } from "../../../tools";
import { _super } from './../../../models';

const DEFAULT_DATE_FORMAT = '%m/%d/%Y'
const DEFAULT_TIME_FORMAT = '%H:%M:%S'

@MetaModel.define()
class Lang extends Model {
  static _module = module;
  static _name = "res.lang";
  static _description = "Languages";
  static _order = "active desc,label";

  _disallowedDatetimePatterns = Array.from(Object.entries(tools.DATETIME_FORMATS_MAP));

  static label = Fields.Char({ required: true });
  static code = Fields.Char({ string: 'Locale Code', required: true, help: 'This field is used to set/get locales for user' });
  static isoCode = Fields.Char({ string: 'ISO code', help: 'This ISO code is the name of po files to use for translations' });
  static urlCode = Fields.Char('URL Code', { required: true, help: 'The Lang Code displayed in the URL' });
  static active = Fields.Boolean();
  static direction = Fields.Selection([['ltr', 'Left-to-Right'], ['rtl', 'Right-to-Left']], { required: true, default: 'ltr' });
  static dateFormat = Fields.Char({ string: 'Date Format', required: true, default: DEFAULT_DATE_FORMAT });
  static timeFormat = Fields.Char({ string: 'Time Format', required: true, default: DEFAULT_TIME_FORMAT });
  static weekStart = Fields.Selection([['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
  ['7', 'Sunday']], { string: 'First Day of Week', required: true, default: '7' });
  static grouping = Fields.Char({
    string: 'Separator Format', required: true, default: '[]', help: `The Separator Format should be like [,n] where 0 < n :starting from Unit digit. 
    -1 will end the separation. e.g. [3,2,-1] will represent 106500 to be 1,06,500;
    [1,2,-1] will represent it to be 106,50,0;[3] will represent it as 106,500. 
    Provided ',' as the thousand separator in each case.`});
  static decimalPoint = Fields.Char({ string: 'Decimal Separator', required: true, default: '.', trim: false });
  static thousandsSep = Fields.Char({ string: 'Thousands Separator', default: ',', trim: false });

  static flagImage = Fields.Image("Image");
  static flagImageUrl = Fields.Char({ compute: '_computeFieldFlagImageUrl' });

  static _sqlConstraints = [
    ['name_uniq', 'unique(label)', 'The name of the language must be unique !'],
    ['code_uniq', 'unique(code)', 'The code of the language must be unique !'],
    ['urlCode_uniq', 'unique("urlCode")', 'The URL code of the language must be unique !'],
  ];

  @api.depends('code', 'flagImage')
  async _computeFieldFlagImageUrl() {
    for (const lang of this) {
      if (await lang.flagImage) {
        await lang.set('flagImageUrl', `/web/image/res.lang/${await lang.id}/flag_image`);
      }
      else {
        await lang.set('flagImageUrl', `/base/static/img/country_flags/${rsplit((await lang.code).toLowerCase(), '_').slice(-1)[0]}.png`);
      }
    }
  }

  @api.constrains('active')
  async _checkActive() {
    // do not check during installation
    if (this.env.registry.ready && ! await this.searchCount([])) {
      throw new ValidationError(await this._t('At least one language must be active.'));
    }
  }

  @api.constrains('timeFormat', 'dateFormat')
  async _checkFormat() {
    for (const lang of this) {
      for (const pattern of lang._disallowedDatetimePatterns) {
        const [timeFormat, dateFormat] = await lang('timeFormat', 'dateFormat');
        if ((timeFormat && timeFormat.includes(pattern)) ||
          (dateFormat && dateFormat.includes(pattern))) {
          throw new ValidationError(await this._t(`Invalid date/time format directive specified. 
                                              Please refer to the list of allowed directives, 
                                              displayed when you edit a language.`));
        }
      }
    }
  }

  @api.constrains('grouping')
  async _checkGrouping() {
    const warning = await this._t(`The Separator Format should be like [,n] where 0 < n :starting from Unit digit. 
                      -1 will end the separation. e.g. [3,2,-1] will represent 106500 to be 1,06,500;
                      [1,2,-1] will represent it to be 106,50,0;[3] will represent it as 106,500. 
                      Provided as the thousand separator in each case.`);
    for (const lang of this) {
      try {
        if (JSON.parse(await lang.grouping).some(x => typeof x !== 'number')) {
          throw new ValidationError(warning);
        }
      } catch (e) {
        throw new ValidationError(warning);
      }
    }
  }

  async _registerHook() {
    // check that there is at least one active language
    if (! await this.searchCount([])) {
      console.error("No language is active.");
    }
  }

  async _langGet(code) {
    return this.browse(await this._langGetId(code))
  }

  @tools.ormcache('await self.code', 'monetary')
  async _dataGet(monetary = false) {
    const [ thousandsSep, decimalPoint, grouping ] = await this(['thousandsSep', 'decimalPoint', 'grouping']);
    return [grouping, thousandsSep || '', decimalPoint];
  }

  async _activateLang(code: string): Promise<any> {
    const lang = await (await this.withContext({ activeTest: false })).search([['code', '=', code]]);
    if (lang.ok && ! await lang.active) {
      lang.active = true;
    }
    return lang;
  }

  async _createLang(lang: string, langName?: string): Promise<any> {
    // create the language with locale information
    let fail = true;
    const isoLang = tools.getIsoCodes(lang);
    // for (const ln of tools.getLocales(lang)) {
    //   try {
    //     locale.setlocale(locale.LC_ALL, str(ln))
    //     fail = false
    //     break
    //   } catch(e) {
    //     // except locale.Error:
    //     //   continue
    //   }
    // }
    // if fail:
    //     lc = locale.getdefaultlocale()[0]
    //     msg = 'Unable to get information for locale %s. Information from the default locale (%s) have been used.'
    //     _logger.warning(msg, lang, lc)

    if (!langName) {
      langName = lang;
    }

    // function fixXa0(s):
    //     """Fix badly-encoded non-breaking space Unicode character from locale.localeconv(),
    //         coercing to utf-8, as some platform seem to output localeconv() in their system
    //         encoding, e.g. Windows-1252"""
    //     if s == '\xa0':
    //         return '\xc2\xa0'
    //     return s

    function fixDatetimeFormat(form: string) {
      // unsupported '%-' patterns, e.g. for cs_CZ
      form = form.replace('%-', '%');
      for (const [pattern, replacement] of Object.entries(tools.DATETIME_FORMATS_MAP)) {
        form = form.replace(pattern, replacement);
      }
      return `${form}`;
    }

    // const conv = locale.localeconv()
    const langInfo = {
      'code': lang,
      'isoCode': isoLang,
      'label': langName,
      'active': true,
      // 'dateFormat' : fixDatetimeFormat(locale.nl_langinfo(locale.D_FMT)),
      // 'timeFormat' : fix_datetime_format(locale.nl_langinfo(locale.T_FMT)),
      // 'decimalPoint' : fix_xa0(str(conv['decimalPoint'])),
      // 'thousandsSep' : fix_xa0(str(conv['thousandsSep'])),
      // 'grouping' : str(conv.get('grouping', [])),
    }
    try {
      return await this.create(langInfo);
    } finally {
      tools.resetlocale();
    }
  }

  /**
   * This method is called from verp/addons/base/data/res_lang_data.xml to load
      some language and set it as the default for every partners. The
      language is set via tools.config by the '_initialize_db' method on the
      'db' object. This is a fragile solution and something else should be
      found.
   * @returns 
   */
  @api.model()
  async installLang() {
    // config.options['loadLanguage'] is a comma-separated list or None
    const langCode = (tools.config.options['loadLanguage'] ?? 'en_US').split(',')[0];
    const lang = await this._activateLang(langCode) || await this._createLang(langCode);
    const IrDefault = this.env.items('ir.default');
    const defaultValue = await IrDefault.get('res.partner', 'lang');
    if (defaultValue == null) {
      await IrDefault.setDefault('res.partner', 'lang', langCode);
      // set language of main company, created directly by db bootstrap SQL
      const partner = await (await this.env.company()).partnerId;
      if (! await partner.lang)
        await partner.write({ 'lang': langCode });
    }
    return true
  }

  @tools.ormcache('code')
  async _langGetId(code) {
    return (await (await this.withContext({ activeTest: true })).search([['code', '=', code]])).id;
  }

  @tools.ormcache('urlCode')
  async _langGetCode(urlCode) {
    return await (await (await this.withContext({ activeTest: true })).search([['urlCode', '=', urlCode]])).code ?? urlCode;
  }

  /**
   * Return the available languages as a list of (code, urlCode, name, active) sorted by name.
   * @returns 
   */
  @api.model()
  @tools.ormcache()
  async getAvailable() {
    const langs = await (await this.withContext({ activeTest: false })).search([]);
    return langs.getSorted();
  }

  async getSorted() {
    const list = sorted(await this.map(lang => lang('code', 'urlCode', 'label', 'active', 'flagImageUrl')), itemgetter([2]));
    const codes = tools.config.get('langCodes');
    if (isList(codes)) {
      for (const code of Array.from(codes).map(code => code[0]).reverse()) {
        const idx = list.findIndex(elem => elem[0] === code);
        if (idx >= 0) {
          list.unshift(list.splice(idx, 1)[0]);
        }
      }
    }
    return list;
  }

  @tools.ormcache('self.id')
  async _getCachedValues() {
    this.ensureOne();
    const [code, urlCode, label] = await this('code', 'urlCode', 'label');
    return {
      'id': this.id,
      'code': code,
      'urlCode': urlCode,
      'label': label,
    }
  }

  async _getCached(field) {
    return (await this._getCachedValues())[field];
  }

  @api.model()
  @tools.ormcache('code')
  async _langCodeToUrlcode(code) {
    for (const [c, urlc] of await this.getAvailable()) {
      if (c === code) {
        return urlc;
      }
    }
    return (await this._langGet(code)).urlCode;
  }

  /**
   * Return the installed languages as a list of (code, name) sorted by name.
   */
  @api.model()
  async getInstalled() {
    const langs = await (await this.withContext({ activeTest: true })).search([]);
    const res = [];
    for (const lang of langs) {
      res.push(await lang('code', 'label'));
    }
    return sorted(res, (item) => item[1]);
  }

  async toggleActive() {
    await _super(Lang, this).toggleActive();
    // Automatically load translation
    const activeLang = await (await this.filtered(lang => lang.active)).map(lang => lang.code);
    if (activeLang.length) {
      const mods = await this.env.items('ir.module.module').search([['state', '=', 'installed']]);
      await mods._updateTranslations(activeLang);
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    this.clearCaches();
    for (const vals of valsList) {
      if (!vals['urlCode']) {
        vals['urlCode'] = vals['isoCode'] ?? vals['code'];
      }
    }
    return _super(Lang, this).create(valsList);
  }

  async write(values: {}): Promise<any> {
    const langCodes = await this.mapped('code');
    if ('code' in values && langCodes.some(code => code !== values['code'])) {
      throw new UserError(await this._t("Language code cannot be modified."));
    }
    if (values['active'] === false) {
      if (await this.env.items('res.users').searchCount([['lang', 'in', langCodes]])) {
        throw new UserError(await this._t("Cannot deactivate a language that is currently used by users."));
      }
      if (await this.env.items('res.partner').searchCount([['lang', 'in', langCodes]])) {
        throw new UserError(await this._t("Cannot deactivate a language that is currently used by contacts."));
      }
      // delete linked ir.default specifying default partner's language
      await this.env.items('ir.default').discardValues('res.partner', 'lang', langCodes);
    }

    const res = await _super(Lang, this).write(values);
    await this.flush();
    this.clearCaches();
    return res;
  }

  async unlink() {
    for (const language of this) {
      await (await this.env.items('ir.translation').search([['lang', '=', language.code]])).unlink();
    }
    this.clearCaches();
    return _super(Lang, this).unlink();
  }

  /**
   * Format() will return the language-specific output for float values
   * %12.2f => 
   * @param percent %12.2f
   * @param value 12.2
   * @param grouping 
   * @param monetary 
   * @returns 
   */
  async format(percent, value, grouping = false, monetary = false) {
    this.ensureOne();

    let formatted = String(value);

    // floats and decimal ints need special action!
    if (grouping) {
      const [langGrouping, thousandsSep, decimalPoint] = await this._dataGet(monetary);
      const evalLangGrouping = eval(langGrouping);

      if ('eEfFgG'.includes(percent[percent.length - 1])) {
        const parts = formatted.split('.');
        parts[0] = intersperse(parts[0], evalLangGrouping, thousandsSep)[0] as string;

        formatted = parts.join(decimalPoint);
      }
      else if ('diu'.includes(percent[percent.length - 1])) {
        formatted = intersperse(formatted, evalLangGrouping, thousandsSep)[0] as string;
      }
    }
    return formatted;
  }
}

/**
 * >>> split("hello world", [])
    ['hello world']
    >>> split("hello world", [1])
    ['h', 'ello world']
    >>> split("hello world", [2])
    ['he', 'llo world']
    >>> split("hello world", [2,3])
    ['he', 'llo', ' world']
    >>> split("hello world", [2,3,0])
    ['he', 'llo', ' wo', 'rld']
    >>> split("hello world", [2,-1,3])
    ['he', 'llo world']
 * @param l 
 * @param counts 
 * @returns 
 */
function split(l: any, counts: number[]=[]) {
  const res = [];
  let savedCount = l.length; // count to use when encoutering a zero
  for (const count of counts) {
    if (!l)
      break;
    if (count == -1)
      break;
    if (count == 0) {
      while (l.length) {
        res.push(l.slice(0, savedCount));
        l = l.slice(savedCount);
      }
      break;
    }
    res.push(l.slice(0, count));
    l = l.slice(count);
    savedCount = count;
  }
  if (l) {
    res.push(l);
  }
  return res;
}

const interspersePat = /([^0-9]*)([^ ]*)(.*)/g;

function intersperse(str: string, counts: number[]=[], separator = '') {
  const match = str.matchAll(interspersePat).next().value || [];
  const [, left, rest, right] = match;
  function reverse(s: string) {
    return s.split("").reverse().join("");
  }
  let splits = split(reverse(rest), counts);
  const res = splits.reverse().map(s => reverse(s)).join(separator);
  return [left + res + right, splits.length > 0 && splits.length - 1 || 0]
}