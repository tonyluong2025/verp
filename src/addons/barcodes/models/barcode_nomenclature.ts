import _ from "lodash"
import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"
import { len } from "../../../core/tools"

const UPC_EAN_CONVERSIONS = [
  ['none', 'Never'],
  ['ean2upc', 'EAN-13 to UPC-A'],
  ['upc2ean', 'UPC-A to EAN-13'],
  ['always', 'Always'],
]

@MetaModel.define()
class BarcodeNomenclature extends Model {
  static _module = module;
  static _name = 'barcode.nomenclature'
  static _description = 'Barcode Nomenclature'

  static label = Fields.Char({string: 'Barcode Nomenclature', size: 32, required: true, help: 'An internal identification of the barcode nomenclature'});
  static ruleIds = Fields.One2many('barcode.rule', 'barcodeNomenclatureId', { string: 'Rules', help: 'The list of barcode rules'});
  static upcEanConv = Fields.Selection(
    UPC_EAN_CONVERSIONS, {string: 'UPC/EAN Conversion', required: true, default: 'always',
    help: "UPC Codes can be converted to EAN by prefixing them with a zero. This setting determines if a UPC/EAN barcode should be automatically converted in one way or another when trying to match a rule with the other encoding."});

  @api.model()
  async getBarcodeCheckDigit(numericBarcode) {
    // todo master: remove this method
    return this.env.items('ir.actions.report').getBarcodeCheckDigit(numericBarcode);
  }

  @api.model()
  async checkEncoding(barcode, encoding) {
    // todo master: remove this method
    return this.env.items('ir.actions.report').checkBarcodeEncoding(barcode, encoding);
  }

  /**
   * Returns a valid zero padded EAN-13 from an EAN prefix.
    :type ean: str
   * @param ean 
   * @returns 
   */
  @api.model()
  async sanitizeEan(ean: string) {
    ean = ean.slice(0, 13).padStart(13, '0');
    return ean.slice(0, -1) + String(await this.getBarcodeCheckDigit(ean));
  }

  /**
   * Returns a valid zero padded UPC-A from a UPC-A prefix.
      :type upc: str
   * @param upc 
   * @returns 
   */
  @api.model()
  async sanitizeUpc(upc) {
    return (await this.sanitizeEan('0' + upc)).slice(1);
  }

  /**
   * Checks barcode matches the pattern and retrieves the optional numeric value in barcode.

    :param barcode:
    :type barcode: str
    :param pattern:
    :type pattern: str
    :return: an object containing:
        - value: the numerical value encoded in the barcode (0 if no value encoded)
        - baseCode: the barcode in which numerical content is replaced by 0's
        - match: boolean
    :rtype: dict
   * @param barcode 
   * @param pattern 
   * @returns 
   */
  async matchPattern(barcode: string, pattern: string) {
    const match = {
      'value': 0,
      'baseCode': barcode,
      'match': false,
    }

    barcode = barcode.replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}').replace('.', '\\.');
    const numericalContent = pattern.match(/[{][N]*[D]*[}]/);  // look for numerical content in pattern

    if (numericalContent) {  // the pattern encodes a numerical content
      const numStart = numericalContent.index  // start index of numerical content
      const numEnd = numericalContent.length  // end index of numerical content
      const valueString = barcode.slice(numStart, numStart+numEnd - 2)  // numerical content in barcode
      const content = numericalContent.toString();
      const wholePartMatch = content.match(/[{][N]*[D}]/);  // looks for whole part of numerical content
      const decimalPartMatch = content.match(/[{N][D]*[}]/);  // looks for decimal part
      let wholePart = valueString.slice(0, wholePartMatch.index+wholePartMatch.length - 2)  // retrieve whole part of numerical content in barcode
      const decimalPart = "0." + valueString.slice(decimalPartMatch.index, decimalPartMatch.index+decimalPartMatch.length - 1)  // retrieve decimal part
      if (wholePart == '') {
        wholePart = '0';
      }
      match['value'] = parseInt(wholePart) + parseFloat(decimalPart)

      match['baseCode'] = barcode.slice(0,numStart) + _.fill(Array(numEnd - numStart - 2), "0") + barcode.slice(numEnd - 2)  // replace numerical content by 0's in barcode
      match['baseCode'] = match['baseCode'].replace("\\\\", "\\").replace("\\{", "{").replace("\\}", "}").replace("\\.", ".")
      pattern = pattern.slice(0,numStart) + _.fill(Array(numEnd - numStart - 2), "0") + pattern.slice(numEnd)  // replace numerical content by 0's in pattern to match
    }

    match['match'] = new RegExp(pattern).test(match['baseCode'].slice(0,len(pattern)));

    return match;
  }

  /**
   * Attempts to interpret and parse a barcode.

    :param barcode:
    :type barcode: str
    :return: A object containing various information about the barcode, like as:
        - code: the barcode
        - type: the barcode's type
        - value: if the id encodes a numerical value, it will be put there
        - baseCode: the barcode code with all the encoding parts set to
          zero; the one put on the product in the backend
    :rtype: dict
   * @param barcode 
   */
  async parseBarcode(barcode) {
    const parsedResult = {
      'encoding': '',
      'type': 'error',
      'code': barcode,
      'baseCode': barcode,
      'value': 0,
    }

    for (const rule of await this['ruleIds']) {
      const upcEanConv = await this['upcEanConv'];
      const [encoding, pattern, type, alias] = await rule('encoding', 'pattern', 'type', 'alias');

      let curBarcode = barcode;
      if (encoding === 'ean13' && this.checkEncoding(barcode, 'upca') && ['upc2ean', 'always'].includes(upcEanConv)) {
        curBarcode = '0' + curBarcode;
      }
      else if (encoding === 'upca' && this.checkEncoding(barcode, 'ean13') && barcode[0] === '0' && ['ean2upc', 'always'].includes(upcEanConv)) {
        curBarcode = curBarcode.sclie(1);
      }

      if (! this.checkEncoding(barcode, encoding)) {
        continue;
      }

      const match = this.matchPattern(curBarcode, pattern);

      if (match['match']) {
        if (type === 'alias') {
          barcode = alias;
          parsedResult['code'] = barcode
        }
        else {
          parsedResult['encoding'] = encoding
          parsedResult['type'] = type
          parsedResult['value'] = match['value']
          parsedResult['code'] = curBarcode
          if (encoding === "ean13") {
            parsedResult['baseCode'] = this.sanitizeEan(match['baseCode']);
          }
          else if (encoding === "upca") {
            parsedResult['baseCode'] = this.sanitizeUpc(match['baseCode']);
          }
          else {
            parsedResult['baseCode'] = match['baseCode'];
          }
          return parsedResult;
        }
      }
    }
    return parsedResult;
  }
}