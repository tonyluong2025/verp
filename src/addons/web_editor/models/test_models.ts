import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class ConverterTest extends Model {
  static _module = module;
  static _name = 'web.editor.converter.test'
  static _description = 'Web Editor Converter Test'

  // disable translation export for those brilliant field labels and values
  static _translate = false

  static char = Fields.Char()
  static integer = Fields.Integer()
  static float = Fields.Float()
  static staticnumeric = Fields.Float({digits: [16, 2]})
  static many2one = Fields.Many2one('web.editor.converter.test.sub')
  static binary = Fields.Binary({attachment: false})
  static date = Fields.Date()
  static datetime = Fields.Datetime()
  static selectionStr = Fields.Selection([
    ['A', "Qu'il n'est pas arrivé à Toronto"],
    ['B', "Qu'il était supposé arriver à Toronto"],
    ['C', "Qu'est-ce qu'il fout ce maudit pancake, tabernacle ?"],
    ['D', "La réponse D"],
  ], {string: "Lorsqu'un pancake prend l'avion à destination de Toronto et qu'il fait une escale technique à St Claude, on dit:"})
  static html = Fields.Html()
  static text = Fields.Text()
}

@MetaModel.define()
class ConverterTestSub extends Model {
  static _module = module;
  static _name = 'web.editor.converter.test.sub';
  static _description = 'Web Editor Converter Subtest';

  static label = Fields.Char();
}