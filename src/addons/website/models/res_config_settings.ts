import { Fields, api } from "../../../core";
import { UserError } from "../../../core/helper";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool, f, len } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";

@MetaModel.define()
class ResConfigSettings extends TransientModel {
  static _module = module;
  static _parents = 'res.config.settings';

  async _defaultWebsite() {
    return this.env.items('website').search([['companyId', '=', (await this.env.company()).id]], { limit: 1 });
  }

  static websiteId = Fields.Many2one('website', {
    string: "website",
    default: self => self._defaultWebsite(), ondelete: 'CASCADE'
  });
  static websiteName = Fields.Char('Website Name', { related: 'websiteId.label', readonly: false });
  static websiteDomain = Fields.Char('Website Domain', { related: 'websiteId.domain', readonly: false });
  static websiteCountryGroupIds = Fields.Many2many({ related: 'websiteId.countryGroupIds', readonly: false });
  static websiteCompanyId = Fields.Many2one({ related: 'websiteId.companyId', string: 'Website Company', readonly: false });
  static websiteLogo = Fields.Binary({ related: 'websiteId.logo', readonly: false });
  static languageIds = Fields.Many2many({ related: 'websiteId.languageIds', relation: 'res.lang', readonly: false });
  static websiteLanguageCount = Fields.Integer({ string: 'Number of languages', compute: '_computeWebsiteLanguageCount', readonly: true });
  static websiteDefaultLangId = Fields.Many2one({ string: 'Default language', related: 'websiteId.defaultLangId', readonly: false });
  static websiteDefaultLangCode = Fields.Char('Default language code', { related: 'websiteId.defaultLangId.code', readonly: false });
  static specificUserAccount = Fields.Boolean({
    related: 'websiteId.specificUserAccount', readonly: false,
    help: 'Are newly created user accounts website specific'
  });
  static websiteCookiesBar = Fields.Boolean({ related: 'websiteId.cookiesBar', readonly: false });

  static googleAnalyticsKey = Fields.Char('Google Analytics Key', { related: 'websiteId.googleAnalyticsKey', readonly: false });
  static googleManagementClientId = Fields.Char('Google Client ID', { related: 'websiteId.googleManagementClientId', readonly: false });
  static googleManagementClientSecret = Fields.Char('Google Client Secret', { related: 'websiteId.googleManagementClientSecret', readonly: false });
  static googleSearchConsole = Fields.Char('Google Search Console', { related: 'websiteId.googleSearchConsole', readonly: false });

  static cdnActivated = Fields.Boolean({ related: 'websiteId.cdnActivated', readonly: false });
  static cdnUrl = Fields.Char({ related: 'websiteId.cdnUrl', readonly: false });
  static cdnFilters = Fields.Text({ related: 'websiteId.cdnFilters', readonly: false });
  static authSignupUninvited = Fields.Selection({ compute: "_computeAuthSignup", inverse: "_setAuthSignup" });

  static socialTwitter = Fields.Char({ related: 'websiteId.socialTwitter', readonly: false });
  static socialFacebook = Fields.Char({ related: 'websiteId.socialFacebook', readonly: false });
  static socialGithub = Fields.Char({ related: 'websiteId.socialGithub', readonly: false });
  static socialLinkedin = Fields.Char({ related: 'websiteId.socialLinkedin', readonly: false });
  static socialYoutube = Fields.Char({ related: 'websiteId.socialYoutube', readonly: false });
  static socialInstagram = Fields.Char({ related: 'websiteId.socialInstagram', readonly: false });
  static socialTiktok = Fields.Char({ related: 'websiteId.socialTiktok', readonly: false });
  static socialZalo = Fields.Char({ related: 'websiteId.socialZalo', readonly: false });

  @api.depends('websiteId', 'socialTwitter', 'socialFacebook', 'socialGithub', 'socialLinkedin', 'socialYoutube', 'socialInstagram', 'socialTiktok', 'socialZalo')
  async hasSocialNetwork() {
    await this.set('hasSocialNetwork', await this['socialTwitter'] || await this['socialFacebook'] || await this['socialGithub'] || await this['socialLinkedin'] || await this['socialYoutube'] || await this['socialInstagram'] || await this['socialTiktok'] || await this['socialZalo']);
  }

  async inverseHasSocialNetwork() {
    if (! await this['hasSocialNetwork']) {
      await this.set('socialTwitter', '');
      await this.set('socialFacebook', '');
      await this.set('socialGithub', '');
      await this.set('socialLinkedin', '');
      await this.set('socialYoutube', '');
      await this.set('socialInstagram', '');
      await this.set('socialTiktok', '');
      await this.set('socialZalo', '');
    }
  }

  static hasSocialNetwork = Fields.Boolean("Configure Social Network", { compute: 'hasSocialNetwork', inverse: 'inverseHasSocialNetwork' });

  static favicon = Fields.Binary('Favicon', { related: 'websiteId.favicon', readonly: false });
  static socialDefaultImage = Fields.Binary('Default Social Share Image', { related: 'websiteId.socialDefaultImage', readonly: false });

  static googleMapsApiKey = Fields.Char({ related: 'websiteId.googleMapsApiKey', readonly: false });
  static groupMultiWebsite = Fields.Boolean("Multi-website", { impliedGroup: "website.groupMultiWebsite" });

  @api.onchange('websiteId')
  @api.depends('websiteId.authSignupUninvited')
  async _computeAuthSignup() {
    await this.set('authSignupUninvited', await (await this['websiteId']).authSignupUninvited);
  }

  async _setAuthSignup() {
    for (const config of this) {
      await (await config.websiteId).set('authSignupUninvited', await config.authSignupUninvited);
    }
  }

  @api.depends('websiteId')
  async hasGoogleAnalytics() {
    await this.set('hasGoogleAnalytics', bool(await this['googleAnalyticsKey']));
  }

  @api.depends('websiteId')
  async hasGoogleAnalyticsDashboard() {
    await this.set('hasGoogleAnalyticsDashboard', bool(await this['googleManagementClientId']));
  }

  @api.depends('websiteId')
  async hasGoogleMaps() {
    await this.set('hasGoogleMaps', bool(await this['googleMapsApiKey']));
  }

  @api.depends('websiteId')
  async hasDefaultShareImage() {
    await this.set('hasDefaultShareImage', bool(await this['socialDefaultImage']));
  }

  @api.depends('websiteId')
  async hasGoogleSearchConsole() {
    await this.set('hasGoogleSearchConsole', bool(await this['googleSearchConsole']));
  }

  async inverseHasGoogleAnalytics() {
    if (! await this['hasGoogleAnalytics']) {
      await this.set('hasGoogleAnalyticsDashboard', false);
      await this.set('googleAnalyticsKey', false);
    }
  }

  async inverseHasGoogleMaps() {
    if (! await this['hasGoogleMaps']) {
      await this.set('googleMapsApiKey', false);
    }
  }

  async inverseHasGoogleAnalyticsDashboard() {
    if (! await this['hasGoogleAnalyticsDashboard']) {
      await this.set('googleManagementClientId', false);
      await this.set('googleManagementClientSecret', false);
    }
  }

  async inverseHasGoogleSearchConsole() {
    if (! await this['hasGoogleSearchConsole']) {
      await this.set('googleSearchConsole', false);
    }
  }

  async inverseHasDefaultShareImage() {
    if (! await this['hasDefaultShareImage']) {
      await this.set('socialDefaultImage', false);
    }
  }

  static hasGoogleAnalytics = Fields.Boolean("Google Analytics", { compute: 'hasGoogleAnalytics', inverse: 'inverseHasGoogleAnalytics' });
  static hasGoogleAnalyticsDashboard = Fields.Boolean("Google Analytics Dashboard", { compute: 'hasGoogleAnalyticsDashboard', inverse: 'inverseHasGoogleAnalyticsDashboard' });
  static hasGoogleMaps = Fields.Boolean("Google Maps", { compute: 'hasGoogleMaps', inverse: 'inverseHasGoogleMaps' });
  static hasGoogleSearchConsole = Fields.Boolean("Console Google Search", { compute: 'hasGoogleSearchConsole', inverse: 'inverseHasGoogleSearchConsole' });
  static hasDefaultShareImage = Fields.Boolean("Use a image by default for sharing", { compute: 'hasDefaultShareImage', inverse: 'inverseHasDefaultShareImage' });

  @api.onchange('languageIds')
  async _onchangeLanguageIds() {
    // If current default language is removed from language_ids
    // update the website_default_lang_id
    const languageIds = (await this['languageIds'])._origin;
    if (!bool(languageIds)) {
      await this.set('websiteDefaultLangId', false);
    }
    else if (!languageIds.includes(await this['websiteDefaultLangId'])) {
      await this.set('websiteDefaultLangId', languageIds[0]);
    }
  }

  @api.depends('languageIds')
  async _computeWebsiteLanguageCount() {
    for (const config of this) {
      await config.set('websiteLanguageCount', len(await config.languageIds));
    }
  }

  async setValues() {
    await _super(ResConfigSettings, this).setValues();
  }

  async openTemplateUser() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("base.actionResUsers");
    action['resId'] = literalEval(await (await this.env.items('ir.config.parameter').sudo()).getParam('base.templatePortalUserId', 'false'));
    action['views'] = [[(await this.env.ref('base.viewUsersForm')).id, 'form']];
    return action;
  }

  async websiteGoTo() {
    await (await this['websiteId'])._force();
    return {
      'type': 'ir.actions.acturl',
      'url': '/',
      'target': 'self',
    }
  }

  async actionWebsiteCreateNew() {
    return {
      'viewMode': 'form',
      'viewId': (await this.env.ref('website.viewWebsiteFormViewThemesModal')).id,
      'resModel': 'website',
      'type': 'ir.actions.actwindow',
      'target': 'new',
      'resId': false,
    }
  }

  async actionOpenRobots() {
    await (await this['websiteId'])._force();
    return {
      'label': await this._t("Robots.txt"),
      'viewMode': 'form',
      'resModel': 'website.robots',
      'type': 'ir.actions.actwindow',
      "views": [[false, "form"]],
      'target': 'new',
    }
  }

  async actionPingSitemap() {
    if (!bool(await (await this['websiteId'])._getHttpDomain())) {
      throw new UserError(await this._t("You haven't defined your domain"));
    }

    return {
      'type': 'ir.actions.acturl',
      'url': f('http://www.google.com/ping?sitemap=%s/sitemap.xml', await (await this['websiteId'])._getHttpDomain()),
      'target': 'new',
    }
  }

  async installThemeOnCurrentWebsite() {
    await (await this['websiteId'])._force();
    const action = await this.env.items("ir.actions.actions")._forXmlid("website.themeInstallKanbanAction");
    action['target'] = 'main';
    return action;
  }
}