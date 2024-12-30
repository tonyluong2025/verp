import { Fields } from "../../../fields"
import { MetaModel, Model } from "../../../models"

@MetaModel.define()
class ReportLayout extends Model {
    static _module = module;
    static _name = "report.layout";
    static _description = 'Report Layout';
    static _order = 'sequence';

    static viewId = Fields.Many2one('ir.ui.view', {string: 'Document Template', required: true});
    static image = Fields.Char({string: "Preview image src"});
    static pdf = Fields.Char({string: "Preview pdf src"});

    static sequence = Fields.Integer({default: 50});
    static label = Fields.Char();
}