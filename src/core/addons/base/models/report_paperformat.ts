import { Fields } from "../../../fields"
import { MetaModel, Model } from "../../../models"

const PAPER_SIZES = [
    {
        'description': 'A0  5   841 x 1189 mm',
        'key': 'A0',
        'height': 1189.0,
        'width': 841.0,
    }, {
        'key': 'A1',
        'description': 'A1  6   594 x 841 mm',
        'height': 841.0,
        'width': 594.0,
    }, {
        'key': 'A2',
        'description': 'A2  7   420 x 594 mm',
        'height': 594.0,
        'width': 420.0,
    }, {
        'key': 'A3',
        'description': 'A3  8   297 x 420 mm',
        'height': 420.0,
        'width': 297.0,
    }, {
        'key': 'A4',
        'description': 'A4  0   210 x 297 mm, 8.26 x 11.69 inches',
        'height': 297.0,
        'width': 210.0,
    }, {
        'key': 'A5',
        'description': 'A5  9   148 x 210 mm',
        'height': 210.0,
        'width': 148.0,
    }, {
        'key': 'A6',
        'description': 'A6  10  105 x 148 mm',
        'height': 148.0,
        'width': 105.0,
    }, {
        'key': 'A7',
        'description': 'A7  11  74 x 105 mm',
        'height': 105.0,
        'width': 74.0,
    }, {
        'key': 'A8',
        'description': 'A8  12  52 x 74 mm',
        'height': 74.0,
        'width': 52.0,
    }, {
        'key': 'A9',
        'description': 'A9  13  37 x 52 mm',
        'height': 52.0,
        'width': 37.0,
    }, {
        'key': 'B0',
        'description': 'B0  14  1000 x 1414 mm',
        'height': 1414.0,
        'width': 1000.0,
    }, {
        'key': 'B1',
        'description': 'B1  15  707 x 1000 mm',
        'height': 1000.0,
        'width': 707.0,
    }, {
        'key': 'B2',
        'description': 'B2  17  500 x 707 mm',
        'height': 707.0,
        'width': 500.0,
    }, {
        'key': 'B3',
        'description': 'B3  18  353 x 500 mm',
        'height': 500.0,
        'width': 353.0,
    }, {
        'key': 'B4',
        'description': 'B4  19  250 x 353 mm',
        'height': 353.0,
        'width': 250.0,
    }, {
        'key': 'B5',
        'description': 'B5  1   176 x 250 mm, 6.93 x 9.84 inches',
        'height': 250.0,
        'width': 176.0,
    }, {
        'key': 'B6',
        'description': 'B6  20  125 x 176 mm',
        'height': 176.0,
        'width': 125.0,
    }, {
        'key': 'B7',
        'description': 'B7  21  88 x 125 mm',
        'height': 125.0,
        'width': 88.0,
    }, {
        'key': 'B8',
        'description': 'B8  22  62 x 88 mm',
        'height': 88.0,
        'width': 62.0,
    }, {
        'key': 'B9',
        'description': 'B9  23  33 x 62 mm',
        'height': 62.0,
        'width': 33.0,
    }, {
        'key': 'B10',
        'description': 'B10    16  31 x 44 mm',
        'height': 44.0,
        'width': 31.0,
    }, {
        'key': 'C5E',
        'description': 'C5E 24  163 x 229 mm',
        'height': 229.0,
        'width': 163.0,
    }, {
        'key': 'Comm10E',
        'description': 'Comm10E 25  105 x 241 mm, U.S. Common 10 Envelope',
        'height': 241.0,
        'width': 105.0,
    }, {
        'key': 'DLE',
        'description': 'DLE 26 110 x 220 mm',
        'height': 220.0,
        'width': 110.0,
    }, {
        'key': 'Executive',
        'description': 'Executive 4   7.5 x 10 inches, 190.5 x 254 mm',
        'height': 254.0,
        'width': 190.5,
    }, {
        'key': 'Folio',
        'description': 'Folio 27  210 x 330 mm',
        'height': 330.0,
        'width': 210.0,
    }, {
        'key': 'Ledger',
        'description': 'Ledger  28  431.8 x 279.4 mm',
        'height': 279.4,
        'width': 431.8,
    }, {
        'key': 'Legal',
        'description': 'Legal    3   8.5 x 14 inches, 215.9 x 355.6 mm',
        'height': 355.6,
        'width': 215.9,
    }, {
        'key': 'Letter',
        'description': 'Letter 2 8.5 x 11 inches, 215.9 x 279.4 mm',
        'height': 279.4,
        'width': 215.9,
    }, {
        'key': 'Tabloid',
        'description': 'Tabloid 29 279.4 x 431.8 mm',
        'height': 431.8,
        'width': 279.4,
    }, {
        'key': 'custom',
        'description': 'Custom',
    },
]

@MetaModel.define()
class ReportPaperformat extends Model {
    static _module = module;
    static _name = "report.paperformat";
    static _description = "Paper Format Config";

    static label = Fields.Char('Label', { required: true });
    static default = Fields.Boolean('Default paper format ?');
    static format = Fields.Selection(PAPER_SIZES.map((ps) => [ps['key'], ps['description']]), { string: 'Paper size', default: 'A4', help: "Select Proper Paper size" });
    static marginTop = Fields.Float('Top Margin (mm)', { default: 40 });
    static marginBottom = Fields.Float('Bottom Margin (mm)', { default: 20 });
    static marginLeft = Fields.Float('Left Margin (mm)', { default: 7 });
    static marginRight = Fields.Float('Right Margin (mm)', { default: 7 });
    static pageHeight = Fields.Integer('Page height (mm)', { default: false });
    static pageWidth = Fields.Integer('Page width (mm)', { default: false });
    static orientation = Fields.Selection([
        ['Landscape', 'Landscape'],
        ['Portrait', 'Portrait']
    ], { string: 'Orientation', default: 'Landscape' });
    static headerLine = Fields.Boolean('Display a header line', { default: false });
    static headerSpacing = Fields.Integer('Header spacing', { default: 35 });
    static disableShrinking = Fields.Boolean('Disable smart shrinking');
    static dpi = Fields.Integer('Output DPI', { required: true, default: 90 });
    static reportIds = Fields.One2many('ir.actions.report', 'paperformatId', { string: 'Associated reports', help: "Explicitly associated reports" });
    static printPageWidth = Fields.Float('Print page width (mm)', { compute: '_computePrintPageSize' });
    static printPageHeight = Fields.Float('Print page height (mm)', { compute: '_computePrintPageSize' });
}