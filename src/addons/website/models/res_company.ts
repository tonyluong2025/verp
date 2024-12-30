import { Fields, api } from "../../../core";
import { MetaModel, Model } from "../../../core/models";
import { bool, f } from "../../../core/tools";

@MetaModel.define()
class Company extends Model {
  static _module = module;
  static _parents = "res.company";

  static websiteId = Fields.Many2one('website', { compute: '_computeWebsiteId', store: true });

  async _computeWebsiteId() {
    for (const company of this) {
      await company.set('websiteId', await this.env.items('website').search([['companyId', '=', company.id]], { limit: 1 }));
    }
  }

  @api.model()
  async actionOpenWebsiteThemeSelector() {
    const action = await this.env.items("ir.actions.actions")._forXmlid("website.themeInstallKanbanAction");
    action['target'] = 'new';
    return action;
  }

  async googleMapImg(zoom = 8, width = 298, height = 298) {
    const partner = await (await this.sudo()).partnerId;
    const res = partner.ok && await partner.googleMapImg(zoom, width, height);
    return bool(res) ? res : null;
  }

  async googleMapLink(zoom = 8) {
    const partner = await (await this.sudo()).partnerId;
    const res = partner.ok && await partner.googleMapLink(zoom);
    return bool(res) ? res : null;
  }

  async _getPublicUser() {
    this.ensureOne();
    // We need sudo to be able to see public users from others companies too
    const publicUsers = await (await (await (await this.env.ref('base.groupPublic')).sudo()).withContext({ activeTest: false })).users;
    const publicUsersForWebsite = await publicUsers.filtered(async (user) => (await user.companyId).eq(this));

    if (publicUsersForWebsite.ok) {
      return publicUsersForWebsite[0];
    }
    else {
      return (await (await this.env.ref('base.publicUser')).sudo()).copy({
        'label': f('Public user for %s', await this['label']),
        'login': f('public-user@company-%s.com', this.id),
        'companyId': this.id,
        'companyIds': [[6, 0, [this.id]]],
      });
    }
  }
}