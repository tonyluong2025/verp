import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class EstatePortfolio extends Model {
  static _module = module;
  static _name = 'estate.portfolio';
  static _description = 'Estate Portfolio';

  static label = Fields.Char({required: true});
  static type = Fields.Char();
  static active = Fields.Boolean('Active', { default: true, help: "If unchecked, it will allow you to hide the portfolio without removing it." });
  static lineIds = Fields.One2many('estate.portfolio.line', 'portfolioId', { string: "Properties"});
}

@MetaModel.define()
class EstatePortfolioLine extends Model {
  static _module = module;
  static _name = 'estate.portfolio.line';
  static _description = 'Portfolio Item';

  static portfolioId = Fields.Many2one('estate.portfolio', {string: 'Portfolio'});
  static propertyId = Fields.Many2one('estate.property', {string: 'Property', ondelete: 'RESTRICT'});
  static note = Fields.Char();
}