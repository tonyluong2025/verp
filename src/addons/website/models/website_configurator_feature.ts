import fs from "node:fs/promises";
import { Fields, api } from "../../../core";
import { ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models";
import { getResourcePath } from "../../../core/modules";
import { bool, f } from "../../../core/tools";

@MetaModel.define()
class WebsiteConfiguratorFeature extends Model {
  static _module = module;
  static _name = 'website.configurator.feature';
  static _description = 'Website Configurator Feature';
  static _order = 'sequence';

  static sequence = Fields.Integer();
  static label = Fields.Char({ translate: true });
  static description = Fields.Char({ translate: true });
  static icon = Fields.Char();
  static iapPageCode = Fields.Char({ help: 'Page code used to tell IAP website_service for which page a snippet list should be generated' });
  static websiteConfigPreselection = Fields.Char({ help: 'Comma-separated list of website type/purpose for which this feature should be pre-selected' });
  static pageViewId = Fields.Many2one('ir.ui.view', { ondelete: 'CASCADE' });
  static moduleId = Fields.Many2one('ir.module.module', { ondelete: 'CASCADE' });
  static featureUrl = Fields.Char();
  static menuSequence = Fields.Integer({ help: 'If set, a website menu will be created for the feature.' });
  static menuCompany = Fields.Boolean({ help: 'If set, add the menu as a second level menu, as a child of "Company" menu.' });

  @api.constrains('moduleId', 'pageViewId')
  async _checkModuleXorPageView() {
    if (bool(await this['moduleId']) == bool(await this['pageViewId'])) {
      throw new ValidationError(await this._t("One and only one of the two fields 'pageViewId' and 'moduleId' should be set"));
    }
  }

  async _processSvg(theme, colors, imageMapping) {
    const previewSvg = getResourcePath(theme, 'static', 'description', theme + '.svg');
    if (previewSvg) {
      return false;
    }
    let svg = await fs.readFile(previewSvg, 'utf-8');

    const defaultColors = {
      'color1': '#3AADAA',
      'color2': '#7C6576',
      'color3': '#F6F6F6',
      'color4': '#FFFFFF',
      'color5': '#383E45',
      'menu': '#MENU_COLOR',
      'footer': '#FOOTER_COLOR',
    }
    const colorMapping = Object.fromEntries(Object.entries(colors).filter(([key]) => key in defaultColors).map(([key, value]) => [defaultColors[key], value]));
    const colorRegex = getRegex(colorMapping);
    const imageRegex = getRegex(imageMapping);

    function getRegex(mapping) {
      return new RegExp(f('(?i)%s', Object.keys(mapping).map(key => f('(%s)', key)).join('|')), 'g');
    }

    function subberMaker(mapping) {
      function subber(match) {
        return match in mapping ? mapping[match] : match;
      }
      return subber;
    }

    svg = svg.replace(colorRegex, subberMaker(colorMapping));
    svg = svg.replace(imageRegex, subberMaker(imageMapping));
    return svg;
  }
}