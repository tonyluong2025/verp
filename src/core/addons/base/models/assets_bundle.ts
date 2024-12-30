import fs from 'fs/promises';
import _ from "lodash";
import { DateTime } from "luxon";
import * as libsass from 'node-sass';
import assert from "node:assert";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { format } from "node:util";
import path from "path";
import rtlcss from 'rtlcss';
import { v4 as uuid4 } from 'uuid';
import { release } from "../../..";
import { NotImplementedError, StopIteration, UserError, ValueError } from "../../../helper/errors";
import { getResourcePath } from "../../../modules/modules";
import { b64decode, filePath } from "../../../tools";
import { bool } from "../../../tools/bool";
import { toText } from "../../../tools/compat";
import { findInPath } from "../../../tools/config";
import { isInstance } from "../../../tools/func";
import { chain, len, next, range } from "../../../tools/iterable";
import { isErpModule, transpileJavascript } from "../../../tools/js_transpiler";
import { stringify } from "../../../tools/json";
import * as lazy from '../../../tools/lazy';
import { setOptions, sha512 } from "../../../tools/misc";
import { forceHook } from "../../../tools/profiler";
import { SourceMapGenerator } from "../../../tools/sourcemap_generator";
import { _f } from "../../../tools/utils";
import { dedent } from "./qweb";

export const EXTENSIONS = [".js", ".css", ".scss", ".sass", ".less"];

class CompileError extends ValueError { }

class AssetError extends UserError { }

class AssetNotFound extends AssetError { }

export class AssetsBundle {
  rxCssImport = /(@import[^;{]+;?)/gm;
  rxPreprocessImports = /(@import\s?['"]([^'"]+)['"](;?))/gm;
  rxCssSplit = /\/\*\! ([a-f0-9-]+) \*\//gm;

  TRACKED_BUNDLES = ['web.assetsCommon', 'web.assetsBackend'];
  name: string;
  env: any;
  javascripts: JavascriptAsset[];
  stylesheets: StylesheetAsset[];
  cssErrors: string[];
  files: string[];
  userDirection: string;

  /**
   * @param name: bundle name
   * @param files: files to be added to the bundle
   * @param css: if css is true, the stylesheets files are added to the bundle
   * @param js: if js is true, the javascript files are added to the bundle
   * @param env 
   */
  protected constructor(name, files, options?: { env?: any, request?: any, css?: boolean, js?: boolean }) {
    options = options ?? {};
    this.name = name;
    this.env = options.env != null ? options.env : options.request?.env;
    this.javascripts = [];
    this.stylesheets = [];
    this.cssErrors = [];
    this.files = files;
  }

  static async new(name, files, options?: { env?: any, request?: any, css?: boolean, js?: boolean }) {
    options = options ?? {};
    const asset = new AssetsBundle(name, files, options);
    await asset.init(files, options.css, options.js);
    return asset;
  }

  async init(files, css: boolean = true, js: boolean = true) {
    const lang = await this.env.items('res.lang')._langGet(
      this.env.context['lang'] || await (await this.env.user()).lang
    );
    this.userDirection = await lang.direction;
    // asset-wide html "media" attribute
    for (const f of files) {
      if (css) {
        if (f['atype'] === 'text/sass') {
          this.stylesheets.push(new SassStylesheetAsset(this, { url: f['url'], filename: f['filename'], inline: f['content'], media: f['media'], direction: this.userDirection }));
        }
        else if (f['atype'] === 'text/scss') {
          this.stylesheets.push(new ScssStylesheetAsset(this, { url: f['url'], filename: f['filename'], inline: f['content'], media: f['media'], direction: this.userDirection }));
        }
        else if (f['atype'] === 'text/less') {
          this.stylesheets.push(new LessStylesheetAsset(this, { url: f['url'], filename: f['filename'], inline: f['content'], media: f['media'], direction: this.userDirection }));
        }
        else if (f['atype'] === 'text/css') {
          this.stylesheets.push(new StylesheetAsset(this, { url: f['url'], filename: f['filename'], inline: f['content'], media: f['media'], direction: this.userDirection }));
        }
      }
      if (js && f['atype'] === 'text/javascript') {
        this.javascripts.push(await JavascriptAsset.new(this, { url: f['url'], filename: f['filename'], inline: f['content'] }));
      }
    }
  }

  /**
   * Returns last modified date of linked files
   * @returns 
   */
  @lazy.define()
  async lastModified() {
    const assets = this.files
      .filter(f => ['text/sass', "text/scss", "text/less", "text/css", "text/javascript"].includes(f['atype']))
      .map(f => new WebAsset(this, { url: f['url'], filename: f['filename'], inline: f['content'] }));
    let result = [];
    for (const asset of assets) {
      result.push(await asset.lastModified());
    }
    return Math.max(...chain(result));
  }

  @lazy.define()
  async getVersion() {
    return (await this.checksum()).slice(0, 7);
  }

  /**
   *  Not really a full checksum.
    We compute a SHA512/256 on the rendered bundle + max linked files last_modified date
   */
  @lazy.define()
  async checksum() {
    const check = `${stringify(this.files)}${await this.lastModified()}`;
    return sha512(check).slice(0, 64);
  }

  /**
   * @param css 
   * @param js 
   * @param debug 
   * @param asyncLoad 
   * @param deferLoad 
   * @param lazyLoad 
   * @returns [[tagName, attributes, content]] if the tag is auto close
   */
  async toNode(options?: { css?: boolean, js?: boolean, debug?: any, asyncLoad?: boolean, deferLoad?: boolean, lazyLoad?: boolean }) {
    options = options ?? {};
    options.css = options.css ?? true;
    options.js = options.js ?? true;
    const response = [];
    const isDebugAssets = options.debug && options.debug.includes('assets');
    if (options.css && this.stylesheets.length) {
      const cssAttachments = await this.css(!isDebugAssets) || [];
      for (const attachment of cssAttachments) {
        let href;
        if (isDebugAssets) {
          href = this.getDebugAssetUrl(this.userDirection == 'rtl' ? 'rtl/' : '', await cssAttachments.label, '');
        }
        else {
          href = await attachment.url;
        }
        const attr = {
          "type": "text/css",
          "rel": "stylesheet",
          "href": href,
          'data-asset-bundle': this.name,
          'data-asset-version': await this.getVersion(),
        }
        response.push(["link", attr, null]);
      }
      if (this.cssErrors.length) {
        const msg = this.cssErrors.join('\n')
        response.push(await (await JavascriptAsset.new(this, { inline: this.dialogMessage(msg) })).toNode());
        response.push(await (new StylesheetAsset(this, { url: "/web/static/lib/bootstrap/css/bootstrap.css" })).toNode())
      }
    }
    if (options.js && this.javascripts.length) {
      const jsAttachment = await this.js(!isDebugAssets);
      const src = isDebugAssets ? this.getDebugAssetUrl('', await jsAttachment.label, '') : await jsAttachment(0).url;
      const attr = {
        "async": options.asyncLoad ? "async" : null,
        "defer": options.deferLoad || options.lazyLoad ? "defer" : null,
        "type": "text/javascript",
        [options.lazyLoad ? "data-src" : "src"]: src,
        'data-asset-bundle': this.name,
        'data-asset-version': await this.getVersion(),
      }
      response.push(["script", attr, undefined]);
    }
    return response;
  }

  /**
   * Returns a JS script which shows a warning to the user on page load.
    TODO: should be refactored to be a base js file whose code is extended
          by related apps (web/website).
   * @param message 
   * @returns 
   */
  dialogMessage(message) {
    return format(`
      (function (message) {
        'use strict';

        if (window.__assetsBundleErrorSeen) {
          return;
        }
        window.__assetsBundleErrorSeen = true;

        if (document.readyState !== 'loading') {
          onDOMContentLoaded();
        } else {
          window.addEventListener('DOMContentLoaded', () => onDOMContentLoaded());
        }

        async function onDOMContentLoaded() {
          var verp = window.top.verp;
          if (!verp || !verp.define) {
            useAlert();
            return;
          }

          // Wait for potential JS loading
          await new Promise(resolve => {
            const noLazyTimeout = setTimeout(() => resolve(), 10); // 10 since need to wait for promise resolutions of verp.define
            verp.define("AssetsBundle.PotentialLazyLoading", function(require) {
              'use strict';

              const lazyloader = require('web.public.lazyloader');

              clearTimeout(noLazyTimeout);
              lazyloader.allScriptsLoaded.then(() => resolve());
            });
          });

          var alertTimeout = setTimeout(useAlert, 10); // 10 since need to wait for promise resolutions of verp.define
          verp.define("AssetsBundle.ErrorMessage", async function(require) {
            'use strict';

            require('web.domReady');
            var core = require('web.core');
            var Dialog = require('web.Dialog');

            var _t = core._t;

            clearTimeout(alertTimeout);
            new Dialog(null, {
              title: _t("Style error"),
              $content: $('<div/>')
                  .append($('<p/>', {text: _t("The style compilation failed, see the error below. Your recent actions may be the cause, please try reverting the changes you made.")}))
                  .append($('<pre/>', {html: message})),
            }).open();
          });
        }

        function useAlert() {
          window.alert(message);
        }
      })("%s");
    `, message.replace('"', '\\"').replace('\n', '&NewLine;'));
  }

  /**
   * Method to compute the attachments' domain to search the already process assets (css).
        This method was created to be overridden.
   * @param assets 
   * @returns 
   */
  async _getAssetsDomainForAlreadyProcessedCss(assets) {
    return [['url', 'in', Object.keys(assets)]];
  }

  async css(isMinified: boolean = false) {
    const extension = isMinified ? 'min.css' : 'css';
    let attachments = await this.getAttachments(extension);
    if (!attachments.ok) {
      // get css content
      let css = await this.preprocessCss();
      if (this.cssErrors.length) {
        return this.getAttachments(extension, true);
      }

      const matches = [];
      css = css.replace(this.rxCssImport, (match) => {
        matches.push(match);
        return match;
      });

      if (isMinified) {
        // move up all @import rules to the top
        matches.push(css);
        css = matches.join('\n');

        await this.saveAttachment(extension, css);
        attachments = await this.getAttachments(extension)
      }
      else {
        return this.cssWithSourcemap(matches.join('\n'))
      }
    }
    return attachments;
  }

  /**
   * Takes care of deleting any outdated ir.attachment records associated to a bundle before
        saving a fresh one.

        When `extension` is js we need to check that we are deleting a different version (and not *any*
        version) because, as one of the creates in `save_attachment` can trigger a rollback, the
        call to `clean_attachments ` is made at the end of the method in order to avoid the rollback
        of an ir.attachment unlink (because we cannot rollback a removal on the filestore), thus we
        must exclude the current bundle.
   * @param extension 
   * @returns 
   */
  async cleanAttachments(extension) {
    const ira = this.env.items('ir.attachment');
    const url = this.getAssetUrl({
      extra: `${['css', 'min.css'].includes(extension) && this.userDirection === 'rtl' ? 'rtl/' : ''}`,
      name: this.name,
      sep: '',
      extension: `.${extension}`
    });

    const domain = [
      ['url', '=like', url],
      '!', ['url', '=like', this.getAssetUrl({ unique: await this.getVersion() })]
    ]
    /**
     * SELECT "irAttachment".id FROM "irAttachment" 
        WHERE (
          (
            "irAttachment"."resField" IS NULL 
            AND ("irAttachment"."url"::text like '/web/assets/%-%/web.assetsCommon.min.css')
          ) AND (
            NOT ("irAttachment"."url"::text like '/web/assets/%-ba19327/%')
          )
        ) 
        ORDER BY "irAttachment"."id" DESC 
     */
    const attachments = await (await ira.sudo()).search(domain);
    // avoid to invalidate cache if it's already empty (mainly useful for test)

    if (attachments.ok) {
      await this._unlinkAttachments(attachments);
      // force bundle invalidation on other workers
      this.env.items('ir.qweb').clearCaches();
    }
    return true;
  }

  /**
   * Return the ir.attachment records for a given bundle. This method takes care of mitigating
        an issue happening when parallel transactions generate the same bundle: while the file is not
        duplicated on the filestore (as it is stored according to its hash), there are multiple
        ir.attachment records referencing the same version of a bundle. As we don't want to source
        multiple time the same bundle in our `to_html` function, we group our ir.attachment records
        by file name and only return the one with the max id for each group.

    * @param extension: file extension (js, min.js, css)
    * @param ignoreVersion: if ignore_version, the url contains a version => web/assets/%-%/name.extension
                                (the second '%' corresponds to the version),
                               else: the url contains a version equal to that of the this.version
                                => web/assets/%-this.version/name.extension.
   */
  async getAttachments(extension: string, ignoreVersion = false) {
    const unique = ignoreVersion ? "%" : await this.getVersion();

    const urlPattern = this.getAssetUrl({
      unique: unique,
      extra: `${['css', 'min.css'].includes(extension) && this.userDirection == 'rtl' ? 'rtl/' : ''}`,
      name: this.name,
      sep: '',
      extension: `.${extension}`
    });
    const res = await this.env.cr.execute(`
      SELECT max(id)
        FROM "irAttachment"
      WHERE "createdUid" = ${global.SUPERUSER_ID}
        AND url like '${urlPattern}'
      GROUP BY label
      ORDER BY label
    `);

    const attachmentIds = res.map(r => r['max']);
    return (await this.env.items('ir.attachment').sudo()).browse(attachmentIds);
  }

  /**
   * Checks if the bundle contains any sass/less content, then compiles it to css.
            If user language direction is Right to Left then consider css files to call run_rtlcss,
            css files are also stored in ir.attachment after processing done by rtlcss.
            Returns the bundle's flat css.
   * @param debug 
   * @param oldAttachments 
   */
  async preprocessCss(debug = false, oldAttachments?: any): Promise<string> {
    if (this.stylesheets.length) {
      let compiled = "";
      for (const atype of [SassStylesheetAsset, ScssStylesheetAsset, LessStylesheetAsset]) {
        const assets = this.stylesheets.filter(asset => isInstance(asset, atype));
        if (assets.length) {
          let source = '';
          for (const asset of assets) {
            source += await asset.getSource() + '\n';
          }
          compiled += await this.compileCss(assets[0].compile.bind(assets[0]), source);
        }
      }

      // We want to run rtlcss on normal css, so merge it in compiled
      if (this.userDirection === 'rtl') {
        const stylesheetAssets = this.stylesheets.filter(asset => !isInstance(asset, SassStylesheetAsset, ScssStylesheetAsset, LessStylesheetAsset));
        for (const asset of stylesheetAssets) {
          compiled += await asset.getSource() + '\n';
        }
        compiled = this.runRtlcss(compiled);
      }
      if (!bool(this.cssErrors) && oldAttachments) {
        await this._unlinkAttachments(oldAttachments);
        oldAttachments = null;
      }
      const fragments = compiled.split(this.rxCssSplit).filter(e => e !== undefined);
      const atRules = fragments.shift();
      if (atRules) {
        this.stylesheets.unshift(new StylesheetAsset(this, { inline: atRules }));
      }
      while (fragments.length) {
        const assetId = fragments.shift();
        const asset = next(this.stylesheets.filter(asset => asset.id === assetId));
        const _content = fragments.shift();
        if (asset && _content) {
          asset._content = _content;
        }
      }
    }
    let result = '';
    for (const asset of this.stylesheets) {
      result += await asset.minify();
    }
    return result;
  }

  /**
   * Unlinks attachments without actually calling unlink, so that the ORM cache is not cleared.

        Specifically, if an attachment is generated while a view is rendered, clearing the ORM cache
        could unload fields loaded with a sudo(), and expected to be readable by the view.
        Such a view would be website.layout when mainObject is an ir.ui.view.
   * @param attachments 
   */
  async _unlinkAttachments(attachments: any) {
    const toDelete = new Set<string>();
    for (const attach of attachments) {
      const storefname = await attach.storefname
      if (storefname) {
        toDelete.add(storefname);
      }
    }
    await this.env.cr.execute(`DELETE FROM "${attachments.cls._table}" WHERE id IN (${attachments.ids})`);
    for (const filePath of toDelete) {
      await attachments._fileDelete(filePath);
    }
  }

  /**
   * Sanitizes @import rules, remove duplicates @import rules, then compile
   * @param compiler 
   * @param source 
   * @returns 
   */
  async compileCss(compiler: Function, source?: string) {
    const imports = [];
    const self: any = this;

    function handleCompileError(e, source) {
      const error = self.getPreprocessorError(e, source);
      console.warn(error);
      self.cssErrors.push(error);
      return '';
    }

    function sanitize(...group: any[]) {
      const reg = /^[.|~|\/]/
      const ref: string = group[2];
      const line = format('@import "%s"%s', ref, group[3]);
      if (!ref.includes('.') && !(imports.includes(line)) && !reg.test(ref)) {
        imports.push(line);
        return line;
      }
      const msg = `Local import '${ref}' is forbidden for security reasons. Please remove all @import {yourFile} imports in your custom files. In Verp you have to import all files in the assets, and not through the @import statement.`;
      console.warn(msg);
      self.cssErrors.push(msg);
      return '';
    }
    source = source.replace(this.rxPreprocessImports, sanitize);

    let compiled = '';
    try {
      compiled = await compiler(source);
    } catch (e) {
      // except CompileError as e:
      return handleCompileError(e, source);
    }
    compiled = compiled.trim();

    // Post process the produced css to add required vendor prefixes here
    compiled = compiled.replace(/(appearance: (\w+);)/, '-webkit-appearance: $2; -moz-appearance: $2; $1');

    compiled = compiled.replace(/(display: ((?:inline-)?)flex((?: ?!important)?);)/, 'display: -webkit-$2box$3; display: -webkit-$2flex$3; $1');
    compiled = compiled.replace(/(justify-content: flex-(\w+)((?: ?!important)?);)/, '-webkit-box-pack: $2$3; $1');
    compiled = compiled.replace(/(flex-flow: (\w+ \w+);)/, '-webkit-flex-flow: $2; $1');
    compiled = compiled.replace(/(flex-direction: (column);)/, '-webkit-box-orient: vertical; -webkit-box-direction: normal; -webkit-flex-direction: $2; $1');
    compiled = compiled.replace(/(flex-wrap: (\w+);)/, '-webkit-flex-wrap: $2; $1');
    compiled = compiled.replace(/(flex: ((\d)+ \d+ (?:\d+|auto));)/, '-webkit-box-flex: $3; -webkit-flex: $2; $1');

    return compiled;
  }

  runRtlcss(source) {
    var result = rtlcss.process(source);
    return result;
  }

  getPreprocessorError(stderr, source?: any) {
    let error = String(stderr).split('Load paths')[0].replace('  Use --trace for backtrace.', '')
    if (error.includes('Cannot load compass')) {
      error += "\nMaybe you should install the compass gem using this extra argument:\n" +
        "    $ sudo gem install compass --pre";
    }
    error += `\nThis error occurred while compiling the bundle '${this.name}' containing:`;
    for (const asset of this.stylesheets) {
      if (isInstance(asset, PreprocessedCSS)) {
        error += `\n    - ${asset.url ? asset.url : '<inline sass>'}`;
      }
    }
    return error;
  }

  getRtlcssError(result: string, source: any) {
    console.warn("Method not implemented.");
  }

  /**
   * Record the given bundle in an ir.attachment and delete
      all other ir.attachments referring to this bundle (with the same name and extension).

    * @param extension: extension of the bundle to be recorded
    * @param content: bundle content to be recorded
    * @return the ir.attachment records for a given bundle.
   */
  async saveAttachment(extension: string, content: any) {
    assert(['js', 'min.js', 'js.map', 'css', 'min.css', 'css.map'].includes(extension))
    const ira = this.env.items('ir.attachment');

    // Set user direction in name to store two bundles
    // 1 for ltr and 1 for rtl, this will help during cleaning of assets bundle
    // and allow to only clear the current direction bundle
    // (this applies to css bundles only)
    const fname = `${this.name}.${extension}`;
    const mimetype = (
      ['css', 'min.css'].includes(extension) ? 'text/css' :
        ['js.map', 'css.map'].includes(extension) ? 'application/json' :
          'application/javascript'
    );
    let values: {} = {
      'label': fname,
      'mimetype': mimetype,
      'resModel': 'ir.ui.view',
      'resId': false,
      'type': 'binary',
      'isPublic': true,
      'raw': Buffer.from(content),
    }
    const attachment = await (await ira.withUser(global.SUPERUSER_ID)).create(values);
    values = {
      id: attachment.id,
      unique: await this.getVersion(),
      extra: `${['css', 'min.css'].includes(extension) && this.userDirection === 'rtl' ? 'rtl/' : ''}`,
      name: fname,
      sep: '',  // included in fname
      extension: ''
    }
    const url = this.getAssetUrl(values);
    values = {
      'url': url,
    }
    await attachment.write(values);
    await attachment.flush();

    const _debug = global.logDebug;
    global.logDebug = true;
    if (global.logDebug || this.env.context['commitAssetsbundle'] == true) {
      await this.env.cr.commit();
      await this.env.cr.reset();
    }
    global.logDebug = _debug;

    await this.cleanAttachments(extension);

    // For end-user assets (common and backend), send a message on the bus
    // to invite the user to refresh their browser
    if (this.env && 'bus.bus' in this.env.models && this.TRACKED_BUNDLES.includes(this.name)) {
      await this.env.items('bus.bus')._sendone('broadcast', 'bundleChanged', {
        'serverVersion': release.version // Needs to be dynamically imported
      })
      console.debug(`Asset changed: ${fname} -- version: ${await this.getVersion()}`);
    }
    return attachment;
  }

  /**
   * Create the ir.attachment representing the not-minified content of the bundleCSS
        and create/modify the ir.attachment representing the linked sourcemap.

   * @param contentImportRules: string containing all the @import rules to put at the beginning of the bundle
   * @return ir.attachment representing the un-minified content of the bundleCSS
   */
  async cssWithSourcemap(contentImportRules: string) {
    const attachments = await this.getAttachments('css.map');
    const sourcemapAttachment = attachments.ok ? attachments : await this.saveAttachment('css.map', '');
    const debugAssetUrl = this.getDebugAssetUrl(this.userDirection === 'rtl' ? 'rtl/' : '', this.name);
    const generator = new SourceMapGenerator(
      Array.from(range(0, debugAssetUrl.split("/").length - 2)).map(i => "..").join("/") + "/"
    );

    // adds the @import rules at the beginning of the bundle
    const contentBundleList = [contentImportRules];
    let contentLineCount = contentImportRules.split("\n").length;
    for (const asset of this.stylesheets) {
      let content: string = await asset.getContent();
      if (content) {
        content = await asset.withHeader(content);
        if (asset.url) {
          generator.addSource(await asset.url, content, contentLineCount);
        }
        // comments all @import rules that have been added at the beginning of the bundle
        content = content.replace(this.rxCssImport, (matchobj) => `/* ${matchobj} */`)
        contentBundleList.push(content);
        contentLineCount += content.split("\n").length;
      }
    }
    const contentBundle = contentBundleList.join('\n') + `\n//*# sourceMappingURL=${await sourcemapAttachment.url} */`
    const cssAttachment = await this.saveAttachment('css', contentBundle);

    generator._file = await cssAttachment.url;
    await sourcemapAttachment.write({ "raw": generator.getContent(), })

    return cssAttachment;
  }

  async js(isMinified: boolean) {
    const extension = isMinified ? 'min.js' : 'js';
    const attachments = await this.getAttachments(extension);

    if (!attachments.ok) {
      if (isMinified) {
        let content = '';
        for (const asset of this.javascripts) {
          content += await asset.minify() + ';\n';
        }
        // content = beautify(content);
        return this.saveAttachment(extension, content);
      }
      else {
        return this.jsWithSourcemap();
      }
    }
    return attachments(0);
  }

  /**
   * Create the ir.attachment representing the not-minified content of the bundleJS
        and create/modify the ir.attachment representing the linked sourcemap.

   * @return ir.attachment representing the un-minified content of the bundleJS
   */
  async jsWithSourcemap() {
    const attachments = await this.getAttachments('js.map');
    const sourcemapAttachment = attachments.ok ? attachments : await this.saveAttachment('js.map', '');
    const r = [];
    const generator = new SourceMapGenerator(
      Array.from(range(0, len(this.getDebugAssetUrl('', this.name).split("/")) - 2)).map(i => "..").join("/") + "/"
    );

    const contentBundleList = [];
    let contentLineCount = 0;
    let lineHeader = 6  // number of lines added by withHeader()
    for (const asset of this.javascripts) {
      const content = await asset.getContent();
      if (asset.isTranspiled) {
        // '+ 3' corresponds to the 3 lines added at the beginning of the file during transpilation.
        generator.addSource(asset.url, asset._content, contentLineCount, lineHeader + 3);
      }
      else {
        generator.addSource(asset.url, content, contentLineCount, lineHeader);
      }

      contentBundleList.push(await asset.withHeader(content, false))
      contentLineCount += content.split("\n").length + lineHeader;
    }

    const contentBundle = contentBundleList.join(';\n') + '\n//# sourceMappingURL=' + await sourcemapAttachment.url;
    const jsAttachment = await this.saveAttachment('js', contentBundle);

    generator._file = await jsAttachment.url;
    await sourcemapAttachment.write({
      "raw": generator.getContent()
    })

    return jsAttachment;
  }

  _getAssetTemplateUrl() {
    return "/web/assets/{id}-{unique}/{extra}{name}{sep}{extension}";
  }

  _getAssetUrlValues(options: any = {}) {  // extra can contain direction or/and website
    return {
      'id': options.id,
      'unique': options.unique,
      'extra': options.extra,
      'name': options.name,
      'sep': options.sep,
      'extension': options.extension,
    }
  }

  /**
   * @param options: {id='%'m unique ='%', extra='', name='%', sep="%", extension='%'}
   * @returns 
   */
  getAssetUrl(options: {} = {}) {
    setOptions(options, {
      'id': '%',
      'unique': '%',
      'extra': '',
      'name': '%',
      'sep': '%',
      'extension': '%',
    });
    return _f(this._getAssetTemplateUrl(), this._getAssetUrlValues(options));
  }

  getDebugAssetUrl(extra = '', name = '%', extension = '%') {
    return `/web/assets/debug/${extra}${name}${extension}`;
  }
}

class WebAsset {
  htmlUrlFormat = '%s';
  _content = null;
  _filename = null;
  _irAttach = null;
  _id = null;

  bundle: AssetsBundle;
  inline: string;
  url: string;
  htmlUrlArgs: any;

  constructor(bundle, options?: { inline?: string, url?: string, filename?: string }) {
    options = options ?? {};
    this._filename = options.filename;
    this.bundle = bundle;
    this.inline = options.inline;
    this.url = options.url;
    this.htmlUrlArgs = options.url;
    if (!options.inline && !options.url) {
      throw new Error(`An asset should either be inlined or url linked, defined in bundle '${bundle.name}'`);
    }
  }

  get htmlUrl() {
    return format(this.htmlUrlFormat, this.htmlUrlArgs);
  }

  async getContent() {
    if (this._content == null) {
      this._content = this.inline || await this._fetchContent();
    }
    return this._content;
  }

  @lazy.define()
  get id() {
    if (this._id == null) {
      this._id = uuid4();
    }
    return this._id;
  }

  @lazy.define()
  get name() {
    const name = this.inline ? '<inline asset>' : this.url;
    return `${name} defined in bundle '${this.bundle.name}'`;
  }

  async stat() {
    if (!(this.inline || this._filename || this._irAttach)) {
      const path = this.url.split('/').filter(segment => !!segment);
      this._filename = getResourcePath(path[0], ...path.slice(1));
      if (this._filename) {
        return;
      }
      try {
        // Test url against ir.attachments
        const attach = await (await this.bundle.env.items('ir.attachment').sudo()).getServeAttachment(this.url);
        this._irAttach = await attach(0);
      } catch (e) {
        throw new AssetNotFound("Could not find %s", this.name);
      }
    }
  }

  /**
   * Fetch content from file or database
   * @returns string utf-8
   */
  async _fetchContent(): Promise<string> {
    try {
      await this.stat();
      if (this._filename) {
        const buffer = await fs.readFile(filePath(this._filename, EXTENSIONS), 'utf8');
        return buffer;
      }
      else {
        const buffer =  b64decode(await this._irAttach['datas']).toString('utf-8');
        return buffer;
      }
    } catch (e) {
      // if (isInstance(e, IOError)) {
      //   throw new AssetNotFound('File %s does not exist.' % self.name);
      // }
      // if (isInstance(e, UnicodeDecodeError)) {
      //   throw new AssetError('%s is not utf-8 encoded.', this.name);
      // }
      // else {
      throw new AssetError('Could not get content for %s. %s', this.name, e.message);
      // }
    }
  }

  toNode() {
    throw new NotImplementedError();
  }

  async minify() {
    return this.getContent();
  }

  async withHeader(content?: string) {
    if (content == null) {
      content = await this.getContent();
    }
    if (content) {
      content = content.trim();
    }
    return content ? `/* ${this.name} */\n${content}\n\n` : '';
  }

  @lazy.define()
  async lastModified() {
    try {
      await this.stat();
      if (this._filename) {
        const result = (await fs.stat(this._filename)).mtime;
        return result;
      }
      else if (len(this._irAttach)) {
        const result = await this._irAttach['__lastUpdate'];
        return result;
      }
    } catch (e) {
      // pass
    }
    return DateTime.fromObject({ year: 1970, month: 1, day: 1 }).toJSDate();
  }
}

class JavascriptAsset extends WebAsset {
  isTranspiled: any;
  _convertedContent: any;

  private constructor(bundle, options?: { inline?: any, url?: any, filename?: any }) {
    super(bundle, options);
    // this.isTranspiled = isErpModule(await super.getContent());
    this._convertedContent = null;
  }

  static async new(bundle, options?: { inline?: any, url?: any, filename?: any }) {
    const asset = new JavascriptAsset(bundle, options);
    await asset.init();
    return asset;
  }

  async init(options?: { inline?: string, url?: string, filename?: string }) {
    this.isTranspiled = isErpModule(await super.getContent());
  }

  async getContent() {
    const content = await super.getContent();
    if (this.isTranspiled) {
      if (!this._convertedContent) {
        this._convertedContent = transpileJavascript(this.url, content);
      }
      return this._convertedContent;
    }
    return content ? `/* Build time: ${new Date().toString()} */\n` + content : '';
  }

  async minify() {
    const content = await this.getContent();
    return this.withHeader(content);
  }

  async _fetchContent() {
    try {
      return await super._fetchContent();
    } catch (e) {
      return format(`console.error(%s);`, stringify(toText(e)));
    }
  }

  async toNode() {
    if (this.url) {
      return ["script", {
        "type": "text/javascript",
        "src": this.htmlUrl,
        'data-asset-bundle': this.bundle.name,
        'data-asset-version': await this.bundle.getVersion(),
      }, null];
    }
    else {
      return ["script", {
        "type": "text/javascript",
        "charset": "utf-8",
        'data-asset-bundle': this.bundle.name,
        'data-asset-version': await this.bundle.getVersion(),
      }, await this.withHeader()];
    }
  }

  async withHeader(content?: string, minimal = true) {
    if (minimal) {
      return super.withHeader(content);
    }

    /* format the header like
    **************************
    *     Filepath: <asset_url>  *
    *     Bundle: <name>         *
    *     Lines: 42              *
    ***************************/
    const lines = [
      `Filepath: ${this.url}`,
      `Bundle: ${this.bundle.name}`,
      `Lines: ${len(content.split('\n'))}`,
    ]
    const l = Math.max(...lines.map(line => line.length));
    return [
      "",
      "/" + _.fill(Array(l + 5), "*"),
      ...lines.map(line => `*  {line:<${l}}  *`),
      _.fill(Array(l + 5), "*") + "/",
      content,
    ].join('\n');
  }
}

class StylesheetAsset extends WebAsset {
  rxImport = /@import\s+('|")(?!'|"|\/|https?:\/\/)/u;
  rxUrl = /url\s*\(\s*('|"|)(?!'|"|\/|https?:\/\/|data:)/u;
  rxSourceMap = /(\/\*# sourceMappingURL=.*)/u;
  rxCharset = /(@charset "[^"]+";)/u;
  rxIndent = /'^( +|\t+)/m;

  media: any;
  direction: any;

  constructor(bundle, options: {} = {}) {
    const media = options['media']; delete options['media'];
    const direction = options['direction']; delete options['direction'];
    super(bundle, options);
    this.media = media;
    this.direction = direction;

    if (this.direction === 'rtl' && this.url) {
      const index = this.url.lastIndexOf('.');
      this.htmlUrlArgs = [this.url.substring(0, index), this.url.substring(index + 1)];
      this.htmlUrlFormat = `%s/rtl/${this.bundle.name}.%s`;
    }
  }

  async compile(source): Promise<string> {
    throw new NotImplementedError();
  }

  async getContent(): Promise<any> {
    let content = await super.getContent();
    if (this.media) {
      content = `@media ${this.media} { ${content} }`;
    }
    return content;
  }

  async _fetchContent() {
    try {
      let content = await super._fetchContent();
      const webDir = path.dirname(this.url);

      if (this.rxImport) {
        content = content.replace(this.rxImport, `@import $1${webDir}/`);
      }
      if (this.rxUrl) {
        content = content.replace(this.rxUrl, `url($1${webDir}/`);
      }
      if (this.rxCharset) {
        // remove charset declarations, we only support utf-8
        content = content.replace(this.rxCharset, '');
      }

      return content;
    } catch (e) {
      this.bundle.cssErrors.push(String(e));
      return '';
    }
  }

  async getSource() {
    const content = this.inline || await this._fetchContent();
    return format("/*! %s */\n%s", this.id, content);
  }

  async minify() {
    // remove existing sourcemaps, make no sense after re-mini
    let content: string = await this.getContent();
    content = content.replace(this.rxSourceMap, '');
    // comments
    content = content.replace(/\/\*.*?\*\//, '');
    // space
    content = content.replace(/\s+/, ' ');
    content = content.replace(/ *([{}]) */, '$1');
    return this.withHeader(content);
  }

  async toNode() {
    let attr;
    if (this.url) {
      attr = {
        "type": "text/css",
        "rel": "stylesheet",
        "href": this.htmlUrl,
        "media": this.media ? _.escape(toText(this.media)) : null,
        'data-asset-bundle': this.bundle.name,
        'data-asset-version': await this.bundle.getVersion(),
      }
      return ["link", attr, null];
    }
    else {
      attr = {
        "type": "text/css",
        "media": this.media ? _.escape(toText(this.media)) : null,
        'data-asset-bundle': this.bundle.name,
        'data-asset-version': await this.bundle.getVersion(),
      };
      return ["style", attr, await this.withHeader()];
    }
  }
}

class PreprocessedCSS extends StylesheetAsset {
  rxImport = null;
  direction: string;

  constructor(bundle, options: {} = {}) {
    super(bundle, options);
    const index = this.url.lastIndexOf('/');
    this.htmlUrlArgs = [this.url.substring(0, index), this.url.substring(index + 1)];
    this.htmlUrlFormat = `%s/${this.direction == 'rtl' ? 'rtl/' : ''}${this.bundle.name}/%s.css`;
  }

  getCommand(): string[] {
    throw new NotImplementedError();
  }

  async compile(source): Promise<string> {
    async function streamToString(stream) {
      const chunks: any[] = [];
      return new Promise<string>((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
    }

    const command = this.getCommand();
    let compiler;
    try {
      compiler = spawn(
        command.join(' '),
        {
          stdio: ['pipe', 'pipe', 'inherit'],
          shell: true,
        }
      );
    } catch (e) {
      throw new CompileError("Could not execute command %s", command[0]);
    }

    const sortIn = Writable.toWeb(compiler.stdin);

    const sortInWriter = sortIn.getWriter();
    try {
      await sortInWriter.write(source);
    } finally {
      await sortInWriter.close();
    }

    //==== Reading sass.stdout ====
    const result = await streamToString(compiler.stdout);
    return result;
  }
}

class SassStylesheetAsset extends PreprocessedCSS {
  indent = null;
  reindent = '    ';

  async minify() {
    return this.withHeader();
  }

  async getSource() {
    const self = this;
    function fixIndent(m) {
      // Indentation normalization
      const ind = m.index;
      if (self.indent == null) {
        self.indent = ind;
        if (self.indent === self.reindent) {
          // Don't reindent the file if identation is the final one (reindent)
          throw new StopIteration();
        }
      }
      return ind.replace(self.indent, self.reindent);
    }

    let content = dedent(this.inline ?? await this._fetchContent());
    try {
      content = content.replace(this.rxIndent, fixIndent);
    } catch (e) {
      if (!isInstance(e, StopIteration)) {
        throw e;
      }
    }
    return format("/*! %s */\n%s", this.id, content);
  }

  getCommand() {
    let sass;
    try {
      sass = findInPath('sass');
    } catch (e) {
      sass = 'sass';
    }
    return [sass, '--stdin', '-t', 'compressed', '--unix-newlines', '--compass', '-+', 'bootstrap-sass'];
  }
}

class ScssStylesheetAsset extends PreprocessedCSS {
  precision = 8;
  outputStyle = 'expanded';

  get bootstrapPath() {
    return getResourcePath('web', 'static', 'lib', 'bootstrap', 'scss')
  }

  async compile(source) {
    if (libsass == null) {
      return super.compile(source);
    }
    try {
      await forceHook();
      const result = libsass.renderSync({
        data: source,
        includePaths: [
          this.bootstrapPath,
        ],
        outputStyle: this.outputStyle as any,
      });
      const content = result.css.toString();
      return content;
    } catch (e) {
      throw new CompileError(e.toString());
    }
  }

  getCommand() {
    let sassc;
    try {
      sassc = findInPath('sassc');
    } catch (e) {
      sassc = 'sassc';
    }
    return [sassc, '--stdin', '--precision', String(this.precision), '--load-path', this.bootstrapPath, '-t', this.outputStyle];
  }
}

class LessStylesheetAsset extends PreprocessedCSS {
  getCommand() {
    let lessc;
    try {
      if (process.platform === 'win32') {
        lessc = findInPath('lessc.cmd');
      }
      else {
        lessc = findInPath('lessc');
      }
    } catch (e) {
      lessc = 'lessc';
    }
    const lesspath = getResourcePath('web', 'static', 'lib', 'bootstrap', 'less');
    return [lessc, '-', '--no-js', '--no-colo+', `--include-path=${lesspath}`];
  }
}