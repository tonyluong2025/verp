import _ from "lodash";
import { DateTime } from "luxon";
import { format } from "util";
import * as api from "../../../api";
import { _Date, _Datetime } from "../../../fields";
import { Dict } from "../../../helper/collections";
import { ValueError } from "../../../helper/errors";
import { AbstractModel, MetaModel, ModelRecords, _super } from "../../../models";
import { formatDate, formatDuration, getLang, getTimezoneInfo, posixToLdml, update } from "../../../tools";
import { bool } from "../../../tools/bool";
import { toText } from "../../../tools/compat";
import { TIMEDELTA_UNITS } from "../../../tools/date_utils";
import { divmod, floatRound } from "../../../tools/float_utils";
import { b64encode, base64ToImage, imageDataUri } from "../../../tools/image";
import { parseLocale } from "../../../tools/locale";
import { safeAttrs } from "../../../tools/mail";
import { _lt } from "../../../tools/translate";
import { _f, f } from "../../../tools/utils";
import * as xml from "../../../tools/xml";
import { E, markup, serializeXml } from "../../../tools/xml";

/**
 * Converts newlines to HTML linebreaks in ``string``. returns
    the unicode result

  @param string
 */
export function nl2br(string) {
  return toText(string).replace('\n', markup('<br>\n'))
}

/*--------------------------------------------------------------------
* QWeb Fields converters
*--------------------------------------------------------------------*/

@MetaModel.define()
class FieldConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field';
  static _description = 'Qweb Field';

  /**
   * Get the available option informations.

      Returns a dict of dict with:
      * key equal to the option key.
      * dict: type, params, name, description, defaultValue
      * type:
          'string'
          'integer'
          'float'
          'model' (e.g. 'res.partner')
          'array'
          'selection' (e.g. [key1, key2...])
   * @returns 
   */
  @api.model()
  async getAvailableOptions() {
    return {};
  }

  /**
   * attributes(record, fieldName, field, options, values)

        Generates the metadata attributes (prefixed by ``data-oe-``) for the
        root node of the field conversion.

        The default attributes are:

        * ``model``, the name of the record's model
        * ``id`` the id of the record to which the field belongs
        * ``type`` the logical field type (widget, may not match the field's
          ``type``, may not be any Field subclass name)
        * ``translate``, a boolean flag (``0`` or ``1``) denoting whether the
          field is translatable
        * ``readonly``, has this attribute if the field is readonly
        * ``expression``, the original expression

        :returns: dict (attribute name, attribute value).
   * @param record 
   * @param fieldName 
   * @param options 
   * @param values 
   * @returns 
   */
  @api.model()
  async attributes(record, fieldName, options, values?: any) {
    const data = {}
    const field = record._fields[fieldName];

    if (!options['inheritBranding'] && !options['translate']) {
      return data;
    }
    data['data-oe-model'] = record._name;
    data['data-oe-id'] = record.id;
    data['data-oe-field'] = field.name;
    data['data-oe-type'] = options['type'];
    data['data-oe-expression'] = options['expression'];
    if (field.readonly) {
      data['data-oe-readonly'] = 1;
    }
    return data;
  }

  /**
   * valueToHtml(value, field, options=None)

        Converts a single value to its HTML version/output
   * @param value 
   * @param options 
   * @returns 
   */
  @api.model()
  async valueToHtml(value, options: {} = {}) {
    return _.escape(toText(value));
  }

  /**
   * recordToHtml(record, fieldName, options)

        Converts the specified field of the ``record`` to HTML

   * @param record 
   * @param fieldName 
   * @param options 
   * @returns 
   */
  @api.model()
  async recordToHtml(record, fieldName, options) {
    if (!bool(record)) {
      return false;
    }
    const value = await record(fieldName);
    return value === false ? false : await record.env.items(this._name).valueToHtml(value, options)
  }

  /**
   * userLang()

        Fetches the res.lang record corresponding to the language code stored
        in the user's context.

    @returns Model[res.lang]
   */
  @api.model()
  async userLang(): Promise<ModelRecords> {
    return getLang(this.env);
  }
}

@MetaModel.define()
class IntegerConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.integer';
  static _description = 'Qweb Field Integer';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    return toText(await (this as any).userLang().format('%d', value, true).replace(/-/, '-\uFEFF')); //'-\N{ZERO WIDTH NO-BREAK SPACE}'))
  }
}

@MetaModel.define()
class FloatConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.float';
  static _description = 'Qweb Field Float';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(FloatConverter, this).getAvailableOptions();
    Object.assign(options,
      { precision: { type: 'integer', string: await this._t('Rounding precision') } }
    )
    return options;
  }

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    let precision;
    if ('decimalPrecision' in options) {
      precision = await this.env.items('decimal.precision').precisionGet(options['decimalPrecision']);
    }
    else {
      precision = options['precision'];
    }

    let fmt;
    if (precision == null) {
      fmt = value.toFixed(0);
    }
    else {
      value = floatRound(value, { precisionDigits: precision });
      fmt = value.toFixed(precision);
    }

    let formatted: string = await (await (this as any).userLang()).format(fmt, value, true).replace(/-/, '-\uFEFF');

    // %f does not strip trailing zeroes. %g does but its precision causes
    // it to switch to scientific notation starting at a million *and* to
    // strip decimals. So use %f and if no precision was specified manually
    // strip trailing 0.
    if (precision == null) {
      formatted = formatted.replace(/(?:(0|\d+?)0+)$/, '0');
    }

    return toText(formatted);
  }

  @api.model()
  async recordToHtml(record, fieldName, options) {
    if (!('precision' in options) && !('decimalPrecision' in options)) {
      const [x, precision] = await record._fields[fieldName].getDigits(record.env) ?? [null, null];
      options = Object.assign({}, { ...options, precision: precision });
    }
    return _super(FloatConverter, this).recordToHtml(record, fieldName, options);
  }
}

@MetaModel.define()
class DateConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.date';
  static _description = 'Qweb Field Date';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(DateConverter, this).getAvailableOptions();
    Object.assign(options, {
      format: { type: 'string', string: await this._t('Date format') }
    });
    return options;
  }

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    return formatDate(this.env, value, false, options['format']);
  }
}

@MetaModel.define()
class DateTimeConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.datetime';
  static _description = 'Qweb Field Datetime';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(DateTimeConverter, this).getAvailableOptions();
    Object.assign(options, {
      format: { type: 'string', string: await this._t('Pattern to format') },
      timeZone: { type: 'char', string: await this._t('Optional timeZone name') },
      timeOnly: { type: 'boolean', string: await this._t('Display only the time') },
      hideSeconds: { type: 'boolean', string: await this._t('Hide seconds') },
      dateOnly: { type: 'boolean', string: await this._t('Display only the date') },
    })
    return options;
  }

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    if (!bool(value))
      return '';

    const lang = await (this as any).userLang();
    const locale = parseLocale(lang.code)[0];
    let formatFunc = DateTime.fromFormat
    if (typeof (value) === 'string') {
      value = _Datetime.toDatetime(value);
    }

    value = await _Datetime.contextTimestamp(this, value);

    let tzinfo;
    if (options['timeZone']) {
      tzinfo = getTimezoneInfo(options['timeZone']);
    }
    else {
      tzinfo = null;
    }

    let pattern;
    if ('format' in options) {
      pattern = options['format'];
    }
    else {
      let strftimePattern;
      if (options['timeOnly']) {
        strftimePattern = format("%s", await lang.timeFormat);
      }
      else if (options['dateOnly']) {
        strftimePattern = format("%s", await lang.dateFormat);
      }
      else {
        strftimePattern = format("%s %s", await lang.dateFormat, await lang.timeFormat);
      }

      pattern = posixToLdml(strftimePattern, locale);
    }
    if (options['hideSeconds']) {
      pattern = pattern.replace(":ss", "").replace(":s", "");
    }

    if (options['timeOnly']) {
      const formatFunc = DateTime.fromFormat;
      return toText(formatFunc(value, pattern, { zone: tzinfo['timeZOne'], locale: locale }));
    }
    if (options['dateOnly']) {
      const formatFunc = DateTime.fromFormat;
      return toText(formatFunc(value, pattern, { locale: locale }));
    }

    return toText(formatFunc(value, pattern, { zone: tzinfo['timeZone'], locale: locale }));
  }
}

@MetaModel.define()
class TextConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.text';
  static _description = 'Qweb Field Text';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    return value ? nl2br(_.escape(value)) : '';
  }
}

@MetaModel.define()
class SelectionConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.selection';
  static _description = 'Qweb Field Selection';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(SelectionConverter, this).getAvailableOptions();
    Object.assign(options, {
      selection: { type: 'selection', string: await this._t('Selection'), description: await this._t('By default the widget uses the field information'), required: true }
    });
    return options;
  }

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    if (!bool(value)) {
      return '';
    }
    return _.escape(toText(options['selection'][value]) || '');
  }

  @api.model()
  async recordToHtml(record, fieldName, options: {} = {}) {
    if (!('selection' in options)) {
      options = { ...options, selection: { ...(await record._fields[fieldName].getDescription(this.env)['selection']) } };
    }
    return _super(SelectionConverter, this).recordToHtml(record, fieldName, options);
  }
}

@MetaModel.define()
class ManyToOneConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.many2one';
  static _description = 'Qweb Field Many2one';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    if (!bool(value)) {
      return false;
    }
    value = await (await value.sudo()).displayName;
    if (!bool(value)) {
      return false;
    }
    return nl2br(_.escape(value));
  }
}

@MetaModel.define()
class ManyToManyConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.many2many';
  static _description = 'Qweb Field Many2many';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    if (!bool(value))
      return false;
    const text = (await (await value.sudo()).mapped('displayName')).join(', ');
    return nl2br(_.escape(text));
  }
}

@MetaModel.define()
class HTMLConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.html';
  static _description = 'Qweb Field HTML';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    const irQweb = this.env.items('ir.qweb');
    // wrap value inside a body and parse it as HTML
    const body: any = xml.getrootXml(xml.parseXml(`<body>${value}</body>`));
    // use pos processing for all nodes with attributes
    for (const el of xml.iterchildren(body, xml.isElement)) {
      if (el.attributes.length) {
        let attrib = {};
        for (const attr of Array.from<Attr>(el.attributes)) {
          if (xml.isAttribute(attr)) {
            attrib[attr.name] = attr.value;
          }
        }
        attrib = await irQweb._postProcessingAttr(el.nodeName, attrib, options['templateOptions']);
        for (const attr of xml.getAttributes(el)) {
          el.removeAttribute(attr.name);
        }
        Object.entries<any>(attrib).forEach(([name, value]) => el.setAttribute(name, value));
      }
    }
    return markup(xml.serializeXml(body));
  }
}

@MetaModel.define()
class ImageConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.image';
  static _description = 'Qweb Field Image';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    let image;
    try { 
      image = base64ToImage(value);
    } catch (e) {
      throw new ValueError("Non-image binary fields can not be converted to HTML");
    }
    return markup(`<img src="${imageDataUri(image)}">`);
  }
}

@MetaModel.define()
class ImageUrlConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.imageurl';
  static _description = 'Qweb Field Image Url';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    return markup(format('<img src="%s">', value));
  }
}

@MetaModel.define()
class MonetaryConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.monetary';
  static _description = 'Qweb Field';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(MonetaryConverter, this).getAvailableOptions();
    Object.assign(options, {
      fromCurrency: { type: 'model', params: 'res.currency', string: await this._t('Original currency') },
      displayCurrency: { type: 'model', params: 'res.currency', string: await this._t('Display currency'), required: "valueToHtml" },
      date: { type: 'date', string: await this._t('Date'), description: await this._t('Date used for the original currency (only used for t-esc). by default use the current date.') },
      companyId: { type: 'model', params: 'res.company', string: await this._t('Company'), description: await this._t('Company used for the original currency (only used for t-esc). By default use the user company') },
    });
    return options;
  }

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    const displayCurrency = options['displayCurrency'];

    if (typeof (value) !== 'number') {
      console.log("The value send to monetary field is (%s: %s) not a number.", value, typeof value);
      throw new ValueError(await this._t("The value send to monetary field is not a number."));
    }

    // lang.format mandates a sprintf-style format. These formats are non-
    // minimal (they have a default fixed precision instead), and
    // lang.format will not set one by default. currency.round will not
    // provide one either. So we need to generate a precision value
    // (integer > 0) from the currency's rounding (a float generally < 1.0).

    if (options['fromCurrency']) {
      const date = options['date'] || _Date.today();
      const companyId = options['companyId'];
      let company;
      if (bool(companyId)) {
        company = this.env.items('res.company').browse(companyId);
      }
      else {
        company = await this.env.company();
      }
      value = await options['fromCurrency']._convert(value, displayCurrency, company, date);
    }

    const lang = await (this as any).userLang();
    value = await displayCurrency.round(value);
    const fmt = `%${value.toFixed(await displayCurrency.decimalPlaces)}f`;
    let formattedAmount = await lang.format(fmt, value, true, true);
    formattedAmount = formattedAmount.replace(new RegExp(' '), '\u00A0').replace(/-/, '-\uFEFF');

    let pre = '';
    let post = '';
    if (await displayCurrency.position === 'before') {
      pre = _f('{symbol}\u00A0', { symbol: await displayCurrency.symbol || '' });
    }
    else {
      post = _f('\u00A0{symbol}', { symbol: await displayCurrency.symbol || '' });
    }

    if (options['labelPrice'] && formattedAmount.includes(await lang.decimalPoint)) {
      const sep = await lang.decimalPoint;
      let [integerPart, decimalPart] = formattedAmount.split(sep);
      integerPart += sep;
      return xml.markup(f(`${pre}<span class="oe-currency-value">%s</span><span class="oe-currency-value" style="font-size:0.5em">%s</span>${post}`, integerPart, decimalPart));
    }
    return markup(`${pre}<span class="oe-currency-value">${formattedAmount}</span>${post}`);
  }

  @api.model()
  async recordToHtml(record, fieldName, options: {} = {}) {
    //currency should be specified by monetary field
    const field = record._fields[fieldName];

    if (!options['displayCurrency'] && field.type === 'monetary' && await field.getCurrencyField(record)) {
      options['displayCurrency'] = await record(await field.getCurrencyField(record));
    }
    if (!options['displayCurrency']) {
      // search on the model if they are a res.currency field to set as default
      const fields = record._fields.items();
      const currencyFields = fields.filter(([k, v]) => v.type === 'many2one' && v.comodelName === 'res.currency').map(([k, v]) => k)
      if (currencyFields.length) {
        options['displayCurrency'] = await record(currencyFields[0]);
      }
    }
    if (!('date' in options))
      options['date'] = record._context['date'];
    if (!('companyId' in options))
      options['companyId'] = record._context['companyId'];

    return _super(MonetaryConverter, this).recordToHtml(record, fieldName, options);
  }
}

async function getTimedeltaUnits() {
  const res = [];
  for (const unit of TIMEDELTA_UNITS) {
    res.push([unit[0], await _lt(unit[0]), unit[1]]);
  }
  return res;
} 

/**
 * ``floatTime`` converter, to display integral or fractional values as
    human-readable time spans (e.g. 1.5 as "01:30").

    Can be used on any numerical field.
 */
@MetaModel.define()
class FloatTimeConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.floattime';
  static _description = 'Qweb Field Float Time';
  static _parents = 'ir.qweb.field';

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    return formatDuration(value);
  }
}

/**
 * ``duration`` converter, to display integral or fractional values as
    human-readable time spans (e.g. 1.5 as "1 hour 30 minutes").

    Can be used on any numerical field.

    Has an option ``unit`` which can be one of ``second``, ``minute``,
    ``hour``, ``day``, ``week`` or ``year``, used to interpret the numerical
    field value before converting it. By default use ``second``.

    Has an option ``round``. By default use ``second``.

    Has an option ``digital`` to display 01:00 instead of 1 hour

    Sub-second values will be ignored.
 */
@MetaModel.define()
class DurationConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.duration';
  static _description = 'Qweb Field Duration';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(DurationConverter, this).getAvailableOptions();
    const unit = (await getTimedeltaUnits()).map(([value, label]) => [value, String(label)]);
    update(options, {
      digital: { type: "boolean", string: await this._t('Digital formatting') },
      unit: { type: "selection", params: unit, string: await this._t('Date unit'), description: await this._t('Date unit used for comparison and formatting'), defaultValue: 'second', required: true },
      round: { type: "selection", params: unit, string: await this._t('Rounding unit'), description: await this._t("Date unit used for the rounding. The value must be smaller than 'hour' if you use the digital formatting."), defaultValue: 'second' },
      format: {
        type: "selection",
        params: [
          ['long', await this._t('Long')],
          ['short', await this._t('Short')],
          ['narrow', await this._t('Narrow')]],
        string: await this._t('Format'),
        description: await this._t("Formatting: long, short, narrow (not used for digital)"),
        defaultValue: 'long'
      },
      addDirection: {
        type: "boolean",
        string: await this._t("Add direction"),
        description: await this._t("Add directional information (not used for digital)")
      },
    });
    return options;
  }

  @api.model()
  async valueToHtml(value, options) {
    const units = Object.fromEntries(TIMEDELTA_UNITS);

    const locale = parseLocale(await (await (this as any).userLang()).code)[0];
    const factor = units[options['unit'] ?? 'second'];
    let roundTo = units[options['round'] ?? 'second'];

    if (options['digital'] && roundTo > 3600) {
      roundTo = 3600;
    }

    let v, r = Math.round((value * factor) / roundTo) * roundTo;

    const sections = [];
    let sign = '';
    if (value < 0) {
      r = -r;
      sign = '-';
    }

    if (options['digital']) {
      for (const [, secsPerUnit] of TIMEDELTA_UNITS) {
        if (secsPerUnit > 3600) {
          continue;
        }
        [v, r] = divmod(r, secsPerUnit);
        if (!v && (secsPerUnit > factor || secsPerUnit < roundTo)) {
          continue;
        }
        sections.push(Math.round(v).toFixed(0));
      }
      return sign + sections.join(':');
    }

    for (const [, secsPerUnit] of TIMEDELTA_UNITS) {
      [v, r] = divmod(r, secsPerUnit);
      if (!v) {
        continue;
      }
      const section = formatDuration(
        v * secsPerUnit, {
        granularity: roundTo,
        addDirection: options['addDirection'],
        format: options['format'] ?? 'long',
        threshold: 1,
        locale: locale
      });
      if (section) {
        sections.push(section);
      }
    }

    if (sign) {
      sections.unshift(sign);
    }
    return sections.join(' ');
  }
}

@MetaModel.define()
class RelativeDatetimeConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.relative';
  static _description = 'Qweb Field Relative';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(RelativeDatetimeConverter, this).getAvailableOptions();
    update(options,
      { now: { type: 'datetime', string: await this._t('Reference date'), description: await this._t('Date to compare with the field value, by default use the current date.') } }
    )
    return options;
  }

  @api.model()
  async valueToHtml(value, options) {
    const locale = parseLocale(await (await (this as any).userLang()).code)[0];

    if (typeof value === 'string') {
      value = _Datetime.toDatetime(value);
    }
    // value should be a naive datetime in UTC. So is fields.Datetime.now()
    const reference = _Datetime.toDatetime(options['now']) as any;

    return toText(formatDuration(value - reference, { addDirection: true, locale: locale }));
  }

  @api.model()
  async recordToHtml(record, fieldName, options) {
    if (!('now' in options)) {
      options = Object.assign(options, { now: record._fields[fieldName].now() });
    }
    return _super(RelativeDatetimeConverter, this).recordToHtml(record, fieldName, options);
  }
}

/**
 * ``barcode`` widget rendering, inserts a data:uri-using image tag in the
    document. May be overridden by e.g. the website module to generate links
    instead.
 */
@MetaModel.define()
class BarcodeConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.barcode';
  static _description = 'Qweb Field Barcode';
  static _parents = 'ir.qweb.field';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(BarcodeConverter, this).getAvailableOptions();
    update(options, {
      symbology: { type: 'string', string: await this._t('Barcode symbology'), description: await this._t('Barcode type, eg: UPCA, EAN13, Code128'), defaultValue: 'Code128' },
      width: { type: 'integer', string: await this._t('Width'), defaultValue: 600 },
      height: { type: 'integer', string: await this._t('Height'), defaultValue: 100 },
      humanreadable: { type: 'integer', string: await this._t('Human Readable'), defaultValue: 0 },
      quiet: { type: 'integer', string: 'Quiet', defaultValue: 1 },
      mask: { type: 'string', string: 'Mask', defaultValue: '' }
    });
    return options;
  }

  @api.model()
  async valueToHtml(value, options: {} = {}) {
    if (!value) {
      return '';
    }
    const barcodeSymbology = options['symbology'] ?? 'Code128';
    const barcode = await this.env.items('ir.actions.report').barcode(
      barcodeSymbology,
      value,
      Object.fromEntries(Object.entries(options).filter(([key, val]) => ['width', 'height', 'humanreadable', 'quiet', 'mask'].includes(key)))
    )

    const imgElement = E.withType('img');
    for (const [k, v] of Object.entries<string>(options)) {
      if (k.startsWith('img_') && safeAttrs.has(k.slice(4))) {
        imgElement.setAttribute(k.slice(4), v);
      }
    }
    if (!imgElement.getAttribute('alt')) {
      imgElement.setAttribute('alt', await this._t('Barcode %s', value));
    }
    imgElement.setAttribute('src', f('data:image/png;base64,%s', b64encode(barcode).toString()));
    return markup(serializeXml(imgElement, 'unicode'));
  }
}

@MetaModel.define()
class ContactConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.contact';
  static _description = 'Qweb Field Contact';
  static _parents = 'ir.qweb.field.many2one';

  @api.model()
  async getAvailableOptions() {
    const options = await _super(ContactConverter, this).getAvailableOptions();
    const contactFields = [
      { 'fieldName': 'label', 'label': await this._t('Name'), 'default': true },
      { 'fieldName': 'address', 'label': await this._t('Address'), 'default': true },
      { 'fieldName': 'phone', 'label': await this._t('Phone'), 'default': true },
      { 'fieldName': 'mobile', 'label': await this._t('Mobile'), 'default': true },
      { 'fieldName': 'email', 'label': await this._t('Email'), 'default': true },
      { 'fieldName': 'vat', 'label': await this._t('VAT') },
    ];
    const separatorParams = new Dict({
      type: 'selection',
      selection: [[" ", await this._t("Space")], [",", await this._t("Comma")], ["-", await this._t("Dash")], ["|", await this._t("Vertical bar")], ["/", await this._t("Slash")]],
      placeholder: await this._t('Linebreak'),
    });
    update(options, {
      fields: new Dict({ type: 'array', params: new Dict({ type: 'selection', params: contactFields }), string: await this._t('Displayed fields'), description: await this._t('List of contact fields to display in the widget'), defaultValue: contactFields.filter(param => param['default']).map(param => param['fieldName']) }),
      separator: new Dict({ type: 'selection', params: separatorParams, string: await this._t('Address separator'), description: await this._t('Separator use to split the address from the displayName.'), defaultValue: false }),
      noMarker: new Dict({ type: 'boolean', string: await this._t('Hide badges'), description: await this._t("Don't display the font awesome marker") }),
      noTagBr: new Dict({ type: 'boolean', string: await this._t('Use comma'), description: await this._t("Use comma instead of the <br> tag to display the address") }),
      phoneIcons: new Dict({ type: 'boolean', string: await this._t('Display phone icons'), description: await this._t("Display the phone icons even if no_marker is true") }),
      countryImage: new Dict({ type: 'boolean', string: await this._t('Display country image'), description: await this._t("Display the country image if the field is present on the record") }),
    })
    return options;
  }

  @api.model()
  async valueToHtml(value, options) {
    if (!value) {
      return '';
    }

    const opf = options['fields'] || ["label", "address", "phone", "mobile", "email"];
    const sep = options['separator'];
    const templateOptions = options['templateOptions'] ?? {};
    let opsep;
    if (sep) {
      opsep = _.escape(sep);
    }
    else if (templateOptions['noTagBr']) {
      // escaped joiners will auto-escape joined params
      opsep = _.escape(', ');
    }
    else {
      opsep = markup('<br/>');
    }
    value = await (await value.sudo()).withContext({ showAddress: true });
    const nameGet = (await value.nameGet())[0][1] as string;
    // Avoid having something like:
    // name_get = 'Foo\n  \n' -> This is a res.partner with a name and no address
    // That would return markup('<br/>') as address. But there is no address set.
    let address;
    if (nameGet.split("\n").slice(1).some(elem => elem.trim())) {
      address = nameGet.split("\n").slice(1).join(opsep).trim();
    }
    else {
      address = '';
    }
    const val = {
      'label': nameGet.split("\n")[0],
      'address': address,
      'phone': await value.phone,
      'mobile': await value.mobile,
      'city': await value.city,
      'countryId': await (await value.countryId).displayName,
      'website': await value.website,
      'email': await value.email,
      'vat': await value.vat,
      'vatLabel': await (await value.countryId).vatLabel || await this._t('VAT'),
      'fields': opf,
      'object': value,
      'options': options
    }
    return this.env.items('ir.qweb')._render('base.contact', val, templateOptions);
  }
}

@MetaModel.define()
class QwebViewConverter extends AbstractModel {
  static _module = module;
  static _name = 'ir.qweb.field.qweb';
  static _description = 'Qweb Field Qweb';
  static _parents = 'ir.qweb.field.many2one';

  @api.model()
  async recordToHtml(record, fieldName, options) {
    const view = await record[fieldName];
    if (!bool(view)) {
      return '';
    }

    if (view._name !== "ir.ui.view") {
      console.warn("%s.%s must be a 'ir.ui.view', got %s.", record, fieldName, view._name);
      return '';
    }
    return view._render(options['values'] ?? {}, 'ir.qweb');
  }
}