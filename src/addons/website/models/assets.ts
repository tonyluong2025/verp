import { httpGet } from "../../../core/http";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { urlParse } from "../../../core/service/middleware/utils";
import { bool, encodebytes, f, lstrip, parseInt, pop, replaceAsync } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";

@MetaModel.define()
class Assets extends AbstractModel {
  static _module = module;
  static _parents = 'webeditor.assets';

  /**
   * Makes a scss customization of the given file. That file must
      contain a scss map including a line comment containing the word 'hook',
      to indicate the location where to write the new key,value pairs.

      Params:
          url (str):
              the URL of the scss file to customize (supposed to be a variable
              file which will appear in the assets_common bundle)

          values (dict):
              key,value mapping to integrate in the file's map (containing the
              word hook). If a key is already in the file's map, its value is
              overridden.
   * @param url 
   * @param values 
   * @returns 
   */
  async makeScssCustomization(url, values) {
    const self = this as any;
    let irAttachment = this.env.items('ir.attachment');
    if ('color-palettes-name' in values) {
      await self.resetAsset('/website/static/src/scss/options/colors/user_color_palette.scss', 'web.assetsCommon');
      await self.resetAsset('/website/static/src/scss/options/colors/user_gray_color_palette.scss', 'web.assetsCommon');
      // Do not reset all theme colors for compatibility (not removing alpha -> epsilon colors)
      await self.makeScssCustomization('/website/static/src/scss/options/colors/user_theme_color_palette.scss', {
        'success': 'null',
        'info': 'null',
        'warning': 'null',
        'danger': 'null',
      })
      // Also reset gradients which are in the "website" values palette
      await self.makeScssCustomization('/website/static/src/scss/options/user_values.scss', {
        'menu-gradient': 'null',
        'header-boxed-gradient': 'null',
        'footer-gradient': 'null',
        'copyright-gradient': 'null',
      })
    }
    let deleteAttachmentId = pop(values, 'delete-font-attachment-id', null);
    if (deleteAttachmentId) {
      deleteAttachmentId = parseInt(deleteAttachmentId);
      await (await irAttachment.search([
        '|', ['id', '=', deleteAttachmentId],
        ['originalId', '=', deleteAttachmentId],
        ['label', 'like', '%google-font%']
      ])).unlink();
    }
    let googleLocalFonts = values['google-local-fonts'];
    if (googleLocalFonts && googleLocalFonts != 'null') {
      // "('font_x': 45, 'font_y': '')" -> {'font_x': '45', 'font_y': ''}
      googleLocalFonts = Object.fromEntries(Array.from(googleLocalFonts.matchAll(/'([^']+)': '?(\d*)/g)).map(m => [m[1], m[2]]));
      // Google is serving different font format (woff, woff2, ttf, eot..)
      // based on the user agent. We need to get the woff2 as this is
      // supported by all the browers we support.
      const headersWoff2 = {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.41 Safari/537.36',
      }
      for (const fontName of googleLocalFonts) {
        if (googleLocalFonts[fontName]) {
          googleLocalFonts[fontName] = parseInt(googleLocalFonts[fontName]);
        }
        else {
          let fontFamilyAttachments = irAttachment;
          const url = 'https://fonts.googleapis.com/css?family=${fontName}&display=swap';
          let fontContent: string = await httpGet(url, { timeout: 5, headers: headersWoff2 });

          async function fetchGoogleFont(statement) {
            const [, url, fontFormat] = statement.matchAll(/src: url\(([^\)]+)\) (.+)/g).next().value;
            const content = await httpGet(url, { timeout: 5, headers: headersWoff2 });
            // https://fonts.gstatic.com/s/modak/v18/EJRYQgs1XtIEskMB-hRp7w.woff2
            // -> s-modak-v18-EJRYQgs1XtIEskMB-hRp7w.woff2
            const name = lstrip(urlParse(url).pathname, '/').replace('/', '-');
            const attachment = await irAttachment.create({
              'label': `google-font-${name}`,
              'type': 'binary',
              'datas': encodebytes(content),
              'isPublic': true,
            })
            fontFamilyAttachments = fontFamilyAttachments.add(attachment);
            return f('src: url(/web/content/%s/%s) %s',
              attachment.id,
              name,
              fontFormat,
            );
          }
          fontContent = await replaceAsync(fontContent, /src: url\(.+\)/g, fetchGoogleFont);

          const attachFont = await irAttachment.create({
            'label': `${fontName} (google-font)`,
            'type': 'binary',
            'datas': encodebytes(fontContent),
            'mimetype': 'text/css',
            'isPublic': true,
          })
          googleLocalFonts[fontName] = attachFont.id;
          // That field is meant to keep track of the original
          // image attachment when an image is being modified (by the
          // website builder for instance). It makes sense to use it
          // here to link font family attachment to the main font
          // attachment. It will ease the unlink later.
          await fontFamilyAttachments.set('originalId', attachFont.id);
        }
      }
      // {'font_x': 45, 'font_y': 55} -> "('font_x': 45, 'font_y': 55)"
      values['google-local-fonts'] = stringify(googleLocalFonts).replace('{', '(').replace('}', ')');
    }

    const customUrl = self.makeCustomAssetFileUrl(url, 'web.assetsCommon');
    let updatedFileContent = await self.getAssetContent(customUrl) || await self.getAssetContent(url);
    updatedFileContent = updatedFileContent.toString('utf-8');
    for (let [name, value] of Object.entries<any>(values)) {
      // Protect variable names so they cannot be computed as numbers
      // on SCSS compilation (e.g. var(--700) => var(700)).
      if (typeof value === 'string') {
        value = value.replace(/var\(--([0-9]+)\)/g,
          (...args: string[]) => "var(--#{" + args[1] + "})");
      }
      const pattern = f("'%s': %%s,\n", name);
      const regex = new RegExp(f(pattern, ".+"));
      const replacement = f(pattern, value);
      if (regex.test(updatedFileContent)) {
        updatedFileContent = updatedFileContent.replace(regex, replacement);
      }
      else {
        updatedFileContent = updatedFileContent.replace(/( *)(.*hook.*)/g, f('$1%s$1$2', replacement));
      }
    }

    // Bundle is 'assetsCommon' as this route is only meant to update
    // variables scss files
    await self.saveAsset(url, 'web.assetsCommon', updatedFileContent, 'scss');
  }

  /**
   * See web_editor.Assets._get_custom_attachment
      Extend to only return the attachments related to the current website.
   * @param customUrl 
   * @param op 
   * @returns 
   */
  async _getCustomAttachment(customUrl, op: string = '=') {
    let self: any = this;
    if (await (await self.env.user()).hasGroup('website.groupWebsiteDesigner')) {
      self = await self.sudo();
    }
    const website = await self.env.items('website').getCurrentWebsite();
    const res = await _super(Assets, self)._getCustomAttachment(customUrl, op);
    // FIXME (?) In website, those attachments should always have been
    // created with a websiteId. The "not websiteId" part in the following
    // condition might therefore be useless (especially since the attachments
    // do not seem ordered). It was developed in the spirit of served
    // attachments which follow this rule of "serve what belongs to the
    // current website or all the websites" but it probably does not make
    // sense here. It however allowed to discover a bug where attachments
    // were left without websiteId. This will be kept untouched in stable
    // but will be reviewed and made more robust in master.
    return (await res.withContext({ websiteId: website.id })).filtered(async (x) => !bool(await x.websiteId) || (await x.websiteId).eq(website));
  }

  /**
   * See web_editor.Assets._get_custom_asset
      Extend to only return the views related to the current website.
   * @param customUrl 
   * @returns 
   */
  async _getCustomAsset(customUrl) {
    let self: any = this;
    if (await (await self.env.user()).hasGroup('website.groupWebsiteDesigner')) {
      // TODO: Remove me in master, see commit message, ACL added right to
      //       unlink to designer but not working without -u in stable
      self = await self.sudo();
    }
    const website = await self.env.items('website').getCurrentWebsite();
    const res = await _super(Assets, self)._getCustomAsset(customUrl);
    return (await res.withContext({ websiteId: website.id })).filterDuplicate();
  }

  /**
   * See web_editor.Assets._save_asset_hook
      Extend to add website ID at attachment creation.
   * @returns 
   */
  async _saveAssetHook() {
    const res = await _super(Assets, this)._saveAssetHook();

    const website = await this.env.items('website').getCurrentWebsite();
    if (bool(website)) {
      res['websiteId'] = website.id;
    }
    return res;
  }
}