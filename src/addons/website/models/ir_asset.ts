import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools";

@MetaModel.define()
class IrAsset extends Model {
  static _module = module;
  static _parents = 'ir.asset';

  static key = Fields.Char({ copy: false, help: 'Technical field used to resolve multiple assets in a multi-website environment.' });
  static websiteId = Fields.Many2one('website', { ondelete: 'CASCADE' });

  async _getRelatedAssets(domain) {
    const website = await this.env.items('website').getCurrentWebsite(false);
    if (bool(website)) {
      domain = domain.concat(website.websiteDomain());
    }
    const assets = await _super(IrAsset, this)._getRelatedAssets(domain);
    return assets.filterDuplicate();
  }

  /**
   * Overridden to discard inactive themes.
   * @returns 
   */
  async _getActiveAddonsList() {
    const addonsList = await _super(IrAsset, this)._getActiveAddonsList();
    const website = await this.env.items('website').getCurrentWebsite(false);

    if (!bool(website)) {
      return addonsList;
    }

    const irModule = await this.env.items('ir.module.module').sudo();
    // discard all theme modules except website.themeId
    const themes = (await irModule.search(await irModule.getThemesDomain())).sub(await website.themeId);
    const toRemove = await themes.mapped('label');

    return addonsList.filter(name => !toRemove.includes(name));
  }

  /**
   * Filter current recordset only keeping the most suitable asset per distinct name.
          Every non-accessible asset will be removed from the set:
            * In non website context, every asset with a website will be removed
            * In a website context, every asset from another website
   * @returns 
   */
  async filterDuplicate() {
    const currentWebsite = await this.env.items('website').getCurrentWebsite(false);
    if (!bool(currentWebsite)) {
      return this.filtered(async (asset) => !bool(await asset.websiteId));
    }
    let mostSpecificAssets = this.env.items('ir.asset');
    for (const asset of this) {
      if ((await asset.websiteId).eq(currentWebsite)) {
        // specific asset: add it if it's for the current website and ignore
        // it if it's for another website
        mostSpecificAssets = mostSpecificAssets.add(asset);
      }
      else if (!bool(await asset.websiteId)) {
        // no key: added either way
        if (! await asset.key) {
          mostSpecificAssets = mostSpecificAssets.add(asset);
        }
        // generic asset: add it iff for the current website, there is no
        // specific asset for this asset (based on the same `key` attribute)
        else if (!await this.some(async (asset2) => await asset.key === await asset2.key && (await asset2.websiteId).eq(currentWebsite))) {
          mostSpecificAssets = mostSpecificAssets.add(asset);
        }
      }
    }

    return mostSpecificAssets;
  }

  /**
   * COW for ir.asset. This way editing websites does not impact other
      websites. Also this way newly created websites will only
      contain the default assets.
   * @param vals 
   * @returns 
   */
  async write(vals) {
    const currentWebsiteId = this.env.context['websiteId'];
    if (!bool(currentWebsiteId) || this.env.context['noCow']) {
      return _super(IrAsset, this).write(vals);
    }

    for (const asset of await this.withContext({ activeTest: false })) {
      // No need of COW if the asset is already specific
      if ((await asset.websiteId).ok) {
        await _super(IrAsset, asset).write(vals);
        continue;
      }

      // If already a specific asset for this generic asset, write on it
      let websiteSpecificAsset = await asset.search([
        ['key', '=', asset.key],
        ['websiteId', '=', currentWebsiteId]
      ], { limit: 1 });
      if (bool(websiteSpecificAsset)) {
        await _super(IrAsset, websiteSpecificAsset).write(vals);
        continue;
      }

      const copyVals = { 'websiteId': currentWebsiteId, 'key': await asset.key }
      websiteSpecificAsset = await asset.copy(copyVals);

      await _super(IrAsset, websiteSpecificAsset).write(vals);
    }

    return true;
  }
}