import assert from "assert";
import path from "path";
import { EXTENSIONS } from "../../../core/addons/base";
import { AbstractModel, MetaModel } from "../../../core/models";
import { b64decode, b64encode, bool, f, fileClose, fileOpen, fileRead, rsplit, update } from "../../../core/tools";
import { strip } from "../../../core/tools/utils";

const _matchAssetFileUrlRegex = new RegExp("^/(\\w+)/(.+?)(\\.custom\\.(.+))?\\.(\\w+)$");

@MetaModel.define()
class Assets extends AbstractModel {
  static _module = module;
  static _name = 'webeditor.assets';
  static _description = 'Assets Utils';

  /**
   *  Fetch all the ir.attachment records related to given URLs.

      Params:
          urls (str[]): list of urls

      Returns:
          ir.attachment(): attachment records related to the given URLs.

   * @param urls 
   * @returns 
   */
  async getAllCustomAttachments(urls) {
    return this._getCustomAttachment(urls, 'in');
  }

  /**
   * Fetch the content of an asset (scss / js) file. That content is either
      the one of the related file on the disk or the one of the corresponding
      custom ir.attachment record.

      Params:
          url (str): the URL of the asset (scss / js) file/ir.attachment

          urlInfo (dict, optional):
              the related url info (see getAssetInfo) (allows to optimize
              some code which already have the info and do not want this
              function to re-get it)

          customAttachments (ir.attachment(), optional):
              the related custom ir.attachment records the function might need
              to search into (allows to optimize some code which already have
              that info and do not want this function to re-get it)

      Returns:
          utf-8 encoded content of the asset (scss / js)
   * @param url 
   * @param urlInfo 
   * @param customAttachments 
   */
  async getAssetContent(url: string, urlInfo?: any, customAttachments?: any) {
    if (urlInfo == null) {
      urlInfo = this.getAssetInfo(url);
    }

    if (urlInfo["customized"]) {
      // If the file is already customized, the content is found in the
      // corresponding attachment
      let attachment;
      if (customAttachments == null) {
        attachment = await this._getCustomAttachment(url);
      }
      else {
        attachment = await customAttachments.filtered(async (r) => await r.url === url);
      }
      return attachment.ok && b64decode(await attachment.datas) || false;
    }

    // If the file is not yet customized, the content is found by reading
    // the local file
    const fd = fileOpen(strip(url, '/'), 'r', EXTENSIONS).fd;
    const buf = fileRead(fd);
    fileClose(fd);
    // const buf = await fs.readFile(fd as any);
    return buf;
  }

  /**
   * Return information about an asset (scss / js) file/ir.attachment just by
      looking at its URL.

      Params:
          url (str): the url of the asset (scss / js) file/ir.attachment

      Returns:
          dict:
              module (str): the original asset's related app

              resourcepath (str):
                  the relative path to the original asset from the related app

              customized (bool): whether the asset is a customized one or not

              bundle (str):
                  the name of the bundle the asset customizes (false if this
                  is not a customized asset)
   * @param url 
   * @returns 
   */
  getAssetInfo(url: string) {
    const m = url.match(_matchAssetFileUrlRegex);
    if (!m) {
      return false;
    }
    const group = m;
    return {
      'module': group[1],
      'resourcePath': f("%s.%s", group[2], group[5]),
      'customized': bool(group[3]),
      'bundle': group[4] || false
    }
  }

  /**
   * Return the customized version of an asset URL, that is the URL the asset
      would have if it was customized.

      Params:
          url (str): the original asset's url
          bundleXmlid (str): the name of the bundle the asset would customize

      Returns:
          str: the URL the given asset would have if it was customized in the
               given bundle
   * @param url 
   * @param bundleXmlid 
   * @returns 
   */
  makeCustomAssetFileUrl(url, bundleXmlid) {
    const parts = rsplit(url, ".", 1);
    return f("%s.custom.%s.%s", parts[0], bundleXmlid, parts[1]);
  }

  /**
   * Delete the potential customizations made to a given (original) asset.

      Params:
          url (str): the URL of the original asset (scss / js) file

          bundle (str):
              the name of the bundle in which the customizations to delete
              were made
   * @param url 
   * @param bundle 
   */
  async resetAsset(url, bundle) {
    const customUrl = this.makeCustomAssetFileUrl(url, bundle);

    // Simply delete the attachement which contains the modified scss/js file
    // and the xpath view which links it
    await (await this._getCustomAttachment(customUrl)).unlink();
    await (await this._getCustomAsset(customUrl)).unlink();
  }

  /**
   * Customize the content of a given asset (scss / js).

      Params:
          url (src):
              the URL of the original asset to customize (whether or not the
              asset was already customized)

          bundle (src):
              the name of the bundle in which the customizations will take
              effect

          content (src): the new content of the asset (scss / js)

          fileType (src):
              either 'scss' or 'js' according to the file being customized
   * @param url 
   * @param bundle 
   * @param content 
   * @param fileType 
   */
  async saveAsset(url, bundle, content, fileType) {
    const customUrl = this.makeCustomAssetFileUrl(url, bundle);
    const datas = b64encode(Buffer.from(content || "\n"));

    // Check if the file to save had already been modified
    const customAttachment = await this._getCustomAttachment(customUrl);
    if (bool(customAttachment)) {
      // If it was already modified, simply override the corresponding
      // attachment content
      await customAttachment.write({ "datas": datas });
    }
    else {
      // If not, create a new attachment to copy the original scss/js file
      // content, with its modifications
      const newAttach = {
        'label': url.split('/').slice(-1)[0],
        'type': "binary",
        'mimetype': (fileType === 'js' && 'text/javascript' || 'text/scss'),
        'datas': datas,
        'url': customUrl,
      }
      update(newAttach, await this._saveAssetHook());
      this.env.items("ir.attachment").create(newAttach);

      // Create an asset with the new attachment
      const irAsset = this.env.items('ir.asset');
      const newAsset = {
        'path': customUrl,
        'target': url,
        'directive': 'replace',
        ...await this._saveAssetHook(),
      }
      const targetAsset = await this._getCustomAsset(url);
      if (bool(targetAsset)) {
        newAsset['label'] = await targetAsset.label + ' override';
        newAsset['bundle'] = await targetAsset.bundle
        newAsset['sequence'] = await targetAsset.sequence
      }
      else {
        const pathParts = path.parse(customUrl);
        newAsset['label'] = f('%s: replace %s', bundle, pathParts.base);
        newAsset['bundle'] = await irAsset._getRelatedBundle(url, bundle);
      }
      await irAsset.create(newAsset);
    }

    this.env.items("ir.qweb").clearCaches();
  }

  /**
   * Fetch the ir.attachment record related to the given customized asset.

      Params:
          customUrl (str): the URL of the customized asset
          op (str, default: '='): the operator to use to search the records

      Returns:
          ir.attachment()
   * @param customUrl 
   * @param op 
   * @returns 
   */
  async _getCustomAttachment(customUrl, op: string = '=') {
    assert(['in', '='].includes(op), 'Invalid operator');
    return this.env.items("ir.attachment").search([["url", op, customUrl]]);
  }

  /**
   *         Fetch the ir.asset record related to the given customized asset (the
      inheriting view which replace the original asset by the customized one).

      Params:
          customUrl (str): the URL of the customized asset

      Returns:
          ir.asset()

   * @param customUrl 
   * @returns 
   */
  async _getCustomAsset(customUrl) {
    const url = customUrl.startsWith('/') || customUrl.startsWith('\\') ? customUrl.slice(1) : customUrl;
    return this.env.items('ir.asset').search([['path', 'like', url]]);
  }

  /**
   *         Returns the additional values to use to write the DB on customized
      attachment and asset creation.

      Returns:
          dict

   * @returns 
   */
  async _saveAssetHook() {
    return {};
  }
}