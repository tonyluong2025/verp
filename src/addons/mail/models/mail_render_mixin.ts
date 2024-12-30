import { api, tools } from "../../../core";
import { QWebCodeFound } from "../../../core/addons/base/models/qweb";
import { getattr, setattr, setdefault } from "../../../core/api/func";
import { Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { AccessError, UserError, ValueError } from "../../../core/helper/errors";
import { _super, AbstractModel, MetaModel } from "../../../core/models";
import { urlJoin } from "../../../core/service/middleware/utils";
import { bool, formatDuration, isHtmlEmpty, isInstance, isList, len, prependHtmlContent, setOptions, update } from "../../../core/tools";
import { fragmentFromString } from "../../../core/tools/html";
import { formatAmount, formatDate } from "../../../core/tools/models";
import { convertInlineTemplateToQweb, parseInlineTemplate, renderInlineTemplate, templateEnvGlobals } from "../../../core/tools/rendering_tools";
import { checkValues } from "../../../core/tools/save_eval";
import { _f, f, ustr } from "../../../core/tools/utils";
import { markup, Markup } from "../../../core/tools/xml";

async function formatDatetime(env, dt, tz?: any, dtFormat: string = 'medium', langCode?: any) {
  try {
    const result = await tools.formatDatetime(env, dt, tz, dtFormat, langCode);
    return result;
  } catch (e) {
    // except babel.core.UnknownLocaleError:
    return dt;
  }
}

async function formatTime(env, time, tz?: any, timeFormat: string = 'medium', langCode?: any) {
  try {
    const result = await tools.formatTime(env, time, tz, timeFormat, langCode);
    return result;
  } catch (e) {
    // except babel.core.UnknownLocaleError:
    return time;
  }
}

@MetaModel.define()
class MailRenderMixin extends AbstractModel {
  static _module = module;
  static _name = 'mail.render.mixin';
  static _description = 'Mail Render Mixin';

  // If true, we trust the value on the model for rendering
  // If false, we need the group "Template Editor" to render the model fields
  static _unrestrictedRendering = false;

  // language for rendering
  static lang = Fields.Char(
    'Language',
    { help: "Optional translation language (ISO code) to select when sending out an email. If not set, the english version will be used. This should usually be a placeholder expression that provides the appropriate language, e.g. {{ object.partnerId.lang }}." }
  );
  // rendering context
  static renderModel = Fields.Char("Rendering Model", { compute: '_computeRenderModel', store: false });
  // expression builder
  static modelObjectField = Fields.Many2one(
    'ir.model.fields', {
    string: "Field", store: false,
    help: "Select target field from the related document model.\nIf it is a relationship field you will be able to select a target field at the destination of the relationship."
  });
  static subObject = Fields.Many2one(
    'ir.model', {
    string: 'Sub-model', readonly: true, store: false,
    help: "When a relationship field is selected as first field, this field shows the document model the relationship goes to."
  });
  static subModelObjectField = Fields.Many2one(
    'ir.model.fields', {
    string: 'Sub-field', store: false,
    help: "When a relationship field is selected as first field, this field lets you select the target field within the destination document model (sub-model)."
  });
  static nullValue = Fields.Char('Default Value', { store: false, help: "Optional value to use if the target field is empty" });
  static copyvalue = Fields.Char(
    'Placeholder Expression', {
    store: false,
    help: "Final placeholder expression, to be copy-pasted in the desired template field."
  });


  /**
   * Give the target model for rendering. Void by default as models
    inheriting from ``mail.render.mixin`` should define how to find this model. 
   */
  async _computeRenderModel() {
    await this.set('renderModel', false);
  }

  /**
   * Generate the dynamic placeholder
   * @param self 
   */
  @api.onchange('modelObjectField', 'subModelObjectField', 'nullValue')
  async _onchangeDynamicPlaceholder() {
    const self: any = this;
    const modelObjectField = await self.modelObjectField;
    const fieldName = await modelObjectField.label;
    if (modelObjectField) {
      if (['many2one', 'one2many', 'many2many'].includes(await modelObjectField.ttype)) {
        const model = await this.env.items('ir.model')._get(await modelObjectField.relation);
        if (model) {
          await self.update({
            'subObject': model.id,
            'copyvalue': this._buildExpression(fieldName, (await self.subModelObjectField).label, await self.nullValue ?? false)
          });
        }
      }
      else {
        await this.update({
          'subObject': false,
          'subModelObjectField': false,
          'copyvalue': this._buildExpression(fieldName, false, await self.nullValue ?? false)
        });
      }
    }
    else {
      await this.update({
        'subObject': false,
        'copyvalue': false,
        'subModelObjectField': false,
        'nullValue': false
      });
    }
  }

  /**
   * Returns a placeholder expression for use in a template field,
    based on the values provided in the placeholder assistant.

    :param fieldName: main field name
    :param sub_field_name: sub field name (M2O)
    :param null_value: default value if the target value is empty
    :return: final placeholder expression
   * @param fieldName 
   * @param subFieldName 
   * @param nullValue 
   * @returns 
   */
  @api.model()
  _buildExpression(fieldName, subFieldName, nullValue) {
    let expression = '';
    if (fieldName) {
      expression = "{{ object." + fieldName;
      if (subFieldName) {
        expression += "." + subFieldName;
      }
      if (nullValue) {
        expression += f(" ?? `%s`", nullValue);
      }
      expression += " }}";
    }
    return expression;
  }

  // ------------------------------------------------------------
  // ORM
  // ------------------------------------------------------------

  _validFieldParameter(field, name) {
    // allow specifying rendering options directly from field when using the render mixin
    return ['renderEngine', 'renderOptions'].includes(name) || _super(MailRenderMixin, this)._validFieldParameter(field, name);
  }

  @api.modelCreateMulti()
  async create(valuesList) {
    const record = await _super(MailRenderMixin, this).create(valuesList);
    if ((this as any)._unrestrictedRendering) {
      // If the rendering is unrestricted (e.g. mail.template),
      // check the user is part of the mail editor group to create a new template if the template is dynamic
      await record._checkAccessRightDynamicTemplate();
    }
    return record;
  }

  async write(vals) {
    await _super(MailRenderMixin, this).write(vals);
    if ((this as any)._unrestrictedRendering) {
      // If the rendering is unrestricted (e.g. mail.template),
      // check the user is part of the mail editor group to modify a template if the template is dynamic
      await (this as any)._checkAccessRightDynamicTemplate();
    }
    return true;
  }

  // ------------------------------------------------------------
  // TOOLS
  // ------------------------------------------------------------

  /**
   * Replace local links by absolute links. It is required in various
    cases, for example when sending emails on chatter or sending mass
    mailings. It replaces

      * href of links (mailto will not match the regex)
      * src of images (base64 hardcoded data will not match the regex)
      * styling using url like background-image: url

    It is done using regex because it is shorten than using an html parser
    to create a potentially complex soupe and hope to have a result that
    has not been harmed.
   * @param html 
   * @param baseUrl 
   * @returns 
   */
  async _replaceLocalLinks(html, baseUrl?: any) {
    if (!html) {
      return html;
    }

    let wrapper = isInstance(html, Markup) ? markup : String;
    html = ustr(html);
    // if (isInstance(html, Markup)) {
    //   wrapper = Markup;
    // }

    const selfUrl = await (await this.env.items("ir.config.parameter").sudo()).getParam("web.base.url");
    function _subRelative2absolute(match) {
      // compute here to do it only if really necessary + cache will ensure it is done only once
      // if not base_url
      if (!_subRelative2absolute.baseUrl) {
        setattr(_subRelative2absolute, 'baseUrl', selfUrl);
      }
      return match[1] + urlJoin(_subRelative2absolute['baseUrl'], match[2]);
    }

    _subRelative2absolute.baseUrl = baseUrl;
    html = html.replace(/(<img(?=\s)[^>]*\ssrc=")(\/[^/][^"]+)/gm, _subRelative2absolute);
    html = html.replace(/(<a(?=\s)[^>]*\shref=")(\/[^/][^"]+)/gm, _subRelative2absolute);
    html = html.replace(/(<[^>]+\bstyle="[^"]+\burl(\(?:&\#34;|'|&quot;)?)(\/(?:[^'")]|(?!&\#34;))+)/gm, _subRelative2absolute);
    //   re.compile(
    //     r"""( # Group 1: element up to url in style
    //         <[^>]+\bstyle=" # Element with a style attribute
    //         [^"]+\burl\( # Style attribute contains "url(" style
    //         (?:&\#34;|'|&quot;)?) # url style may start with (escaped) quote: capture it
    //     ( # Group 2: url itself
    //         /(?:[^'")]|(?!&\#34;))+ # stop at the first closing quote
    // )""", re.VERBOSE), _sub_relative2absolute, html)

    return wrapper(html);
  }

  @api.model()
  async _renderEncapsulate(layoutXmlid, html, addContext?: any, contextRecord?: any) {
    let template, err;
    try {
      template = this.env.ref(layoutXmlid, true);
    } catch (e) {
      err = e;
      if (isInstance(e, ValueError)) {
        console.warn('QWeb template %s not found when rendering encapsulation template.', layoutXmlid);
      } else {
        throw e;
      }
    }
    if (!err) {
      const recordName = bool(contextRecord) ? await contextRecord.displayName : '';
      const modelDescription = bool(contextRecord) ? await (await this.env.items('ir.model')._get(contextRecord._name)).displayName : false;
      const templateCtx = {
        'body': html,
        'recordName': recordName,
        'modelDescription': modelDescription,
        'company': (bool(contextRecord) && 'companyId' in contextRecord._fields) ? await contextRecord['companyId'] : await this.env.company(),
        'record': contextRecord,
      }
      if (bool(addContext)) {
        update(templateCtx, addContext);
      }

      html = await template._render(templateCtx, 'ir.qweb', true);
      html = this.env.items('mail.render.mixin')._replaceLocalLinks(html);
    }
    return html;
  }

  /**
   * Prepare the email body before sending. Add the text preview at the
      beginning of the mail. The preview text is displayed bellow the mail
      subject of most mail client (gmail, outlook...).

      :param html: html content for which we want to prepend a preview
      :param preview: the preview to add before the html content
      :return: html with preprended preview
   * @param html 
   * @param preview 
   * @returns 
   */
  @api.model()
  async _prependPreview(html, preview) {
    if (preview) {
      preview = preview.trim();
    }

    const previewMarkup = convertInlineTemplateToQweb(preview);

    if (preview) {
      const htmlPreview = markup(`
                <div style="display:none;font-size:1px;height:0px;width:0px;opacity:0;">
                    ${previewMarkup}
                </div>
            `);
      return prependHtmlContent(html, htmlPreview);
    }
    return html;
  }

  // ------------------------------------------------------------
  // SECURITY
  // ------------------------------------------------------------

  async _isDynamic() {
    for (const template of await this.sudo()) {
      for (const [fname, field] of template._fields) {
        const engine = getattr(field, 'renderEngine', 'inlineTemplate');
        if (['qweb', 'qwebView'].includes(engine)) {
          if (await this._isDynamicTemplateQweb(await template[fname])) {
            return true;
          }
        }
        else {
          if (await this._isDynamicTemplateInlineTemplate(await template[fname])) {
            return true;
          }
        }
      }
    }
    return false;
  }

  @api.model()
  async _isDynamicTemplateQweb(templateSrc) {
    if (templateSrc) {
      try {
        const node = fragmentFromString(templateSrc, { createParent: 'div' });
        await this.env.items("ir.qweb")._compile(node, { 'raiseOnCode': true });
      } catch (e) {
        return true;
      }
    }
    return false;
  }

  @api.model()
  async _isDynamicTemplateInlineTemplate(templateTxt) {
    if (templateTxt) {
      const templateInstructions = parseInlineTemplate(String(templateTxt));
      if (len(templateInstructions) > 1 || templateInstructions[0][1]) {
        return true;
      }
    }
    return false;
  }

  async _checkAccessRightDynamicTemplate() {
    if (!this.env.su && ! await (await this.env.user()).hasGroup('mail.groupMailTemplateEditor') && await this._isDynamic()) {
      const group = await this.env.ref('mail.groupMailTemplateEditor');
      throw new AccessError(await this._t('Only users belonging to the "%s" group can modify dynamic templates.', await group.label));
    }
  }

  // ------------------------------------------------------------
  // RENDERING
  // ------------------------------------------------------------

  /**
   * Evaluation context used in all rendering engines. Contains

      * ``user``: current user browse record;
      * ``ctx```: current context;
      * various formatting tools;
   * @returns 
   */
  @api.model()
  async _renderEvalContext() {
    const renderContext = {
      'formatDate': (date, dateFormat?: any, langCode?: any) => formatDate(this.env, date, dateFormat, langCode),
      'formatDatetime': (dt, tz?: any, dtFormat?: any, langCode?: any) => formatDatetime(this.env, dt, tz, dtFormat, langCode),
      'formatTime': (time, tz?: any, timeFormat?: any, langCode?: any) => formatTime(this.env, time, tz, timeFormat, langCode),
      'formatAmount': (amount, currency, langCode) => formatAmount(this.env, amount, currency, langCode),
      'formatDuration': (value) => formatDuration(value),
      'user': await this.env.user(),
      'ctx': this._context,
      'isHtmlEmpty': isHtmlEmpty,
    }
    Object.assign(renderContext, templateEnvGlobals);
    return renderContext;
  }

  /**
   * Render a raw QWeb template.

    :param str template_src: raw QWeb template to render;
    :param str model: see ``MailRenderMixin._render_template()``;
    :param list resIds: see ``MailRenderMixin._render_template()``;

    :param dict add_context: additional context to give to renderer. It
      allows to add or update values to base rendering context generated
      by ``MailRenderMixin._render_eval_context()``;
    :param dict options: options for rendering (not used currently);

    :return dict: {resId: string of rendered template based on record}

    :notice: Experimental. Use at your own risks only.
   * @param templateSrc 
   * @param model 
   * @param resIds 
   * @param addContext 
   * @param options 
   * @returns 
   */
  @api.model()
  async _renderTemplateQweb(templateSrc, model, resIds, addContext?: {}, options?: {}) {
    const results = Dict.fromKeys(resIds, "");
    if (!templateSrc) {
      return results;
    }

    // prepare template variables
    const variables = await this._renderEvalContext();
    if (addContext) {
      Object.assign(variables, addContext);
    }

    const isRestricted = !this.cls._unrestrictedRendering && ! await this.env.isAdmin() && ! await (await this.env.user()).hasGroup('mail.groupMailTemplateEditor');

    for (const record of this.env.items(model).browse(resIds)) {
      let renderResult;
      variables['object'] = record;
      try {
        renderResult = await this.env.items('ir.qweb')._render(
          fragmentFromString(templateSrc, { createParent: 'div' }),
          variables,
          isRestricted,
        );
        // remove the rendered tag <div> that was added in order to wrap potentially multiples nodes into one.
        renderResult = renderResult.slice(5, -6);
      } catch (e) {
        if (isInstance(e, QWebCodeFound)) {
          const group = await this.env.ref('mail.group_mail_template_editor');
          throw new AccessError(await this._t('Only users belonging to the "%s" group can modify dynamic templates.', await group.label));
        } else {
          // except Exception as e:
          console.info("Failed to render template : %s", templateSrc);
          throw new UserError(await this._t("Failed to render QWeb template : %s)", e));
        }
      }
      results[record.id] = renderResult;
    }
    return results;
  }

  /**
   * Render a QWeb template based on an ir.ui.view content.

    In addition to the generic evaluation context available, some other
    variables are added:
      * ``object``: record based on which the template is rendered;

    :param str template_src: source QWeb template. It should be a string
      XmlID allowing to fetch an ``ir.ui.view``;
    :param str model: see ``MailRenderMixin._render_template()``;
    :param list resIds: see ``MailRenderMixin._render_template()``;

    :param dict add_context: additional context to give to renderer. It
      allows to add or update values to base rendering context generated
      by ``MailRenderMixin._render_eval_context()``;
    :param dict options: options for rendering (not used currently);

    :return dict: {resId: string of rendered template based on record}
   * @param templateSrc 
   * @param model 
   * @param resIds 
   * @param addContext 
   * @param options 
   * @returns 
   */
  @api.model()
  async _renderTemplateQwebView(templateSrc, model, resIds, addContext?: {}, options?: {}) {
    // prevent wrong values (rendering on a void record set, ...)
    if (resIds.some(r => r == null)) {
      throw new ValueError(await this._t('Template rendering should be called on a valid record IDs.'));
    }

    const view = await this.env.ref(templateSrc, false) ?? this.env.items('ir.ui.view');
    const results = Dict.fromKeys(resIds, "");
    if (!bool(view)) {
      return results;
    }

    // prepare template variables
    const variables = await this._renderEvalContext();
    if (addContext) {
      Object.assign(variables, addContext);
    }
    checkValues(variables);

    for (const record of this.env.items(model).browse(resIds)) {
      let renderResult;
      variables['object'] = record;
      try {
        renderResult = await view._render(variables, 'ir.qweb', true);
      } catch (e) {
        console.info("Failed to render template : %s (%s)", templateSrc, view.id);
        throw new UserError(_f(await this._t("Failed to render template : {xmlid} ({viewId})"),
          { xmlid: templateSrc, viewId: view.id }));
      }
      results[record.id] = renderResult;
    }
    return results;
  }

  /**
   * Render a string-based template on records given by a model and a list
    of IDs, using inlineTemplate.

    In addition to the generic evaluation context available, some other
    variables are added:
      * ``object``: record based on which the template is rendered;

    :param str templateTxt: template text to render
    :param str model: see ``MailRenderMixin._renderTemplate()``;
    :param list resIds: see ``MailRenderMixin._renderTemplate()``;

    :param dict addContext: additional context to give to renderer. It
      allows to add or update values to base rendering context generated
      by ``MailRenderMixin._renderInlineTemplateEvalContext()``;
    :param dict options: options for rendering;

    :return dict: {resId: string of rendered template based on record}
   * @param templateTxt 
   * @param model 
   * @param resIds 
   * @param addContext 
   * @param options 
   * @returns 
   */
  @api.model()
  async _renderTemplateInlineTemplate(templateTxt, model, resIds, addContext?: {}, options?: {}) {
    // prevent wrong values (rendering on a void record set, ...)
    if (resIds.some(r => r == null)) {
      throw new ValueError(await this._t('Template rendering should be called on a valid record IDs.'));
    }

    const results = Dict.fromKeys(resIds, "");
    if (!templateTxt) {
      return results;
    }

    const templateInstructions = parseInlineTemplate(String(templateTxt));
    const isDynamic = templateInstructions.length > 1 || templateInstructions[0][1];

    if (!this.cls._unrestrictedRendering && isDynamic && ! await this.env.isAdmin() &&
      ! await (await this.env.user()).hasGroup('mail.groupMailTemplateEditor')) {
      const group = await this.env.ref('mail.groupMailTemplateEditor');
      throw new AccessError(await this._t('Only users belonging to the "%s" group can modify dynamic templates.', await group.label));
    }

    if (!isDynamic) {
      // Either the content is a raw text without placeholders, either we fail to
      // detect placeholders code. In both case we skip the rendering and return
      // the raw content, so even if we failed to detect dynamic code,
      // non "mail_template_editor" users will not gain rendering tools available
      // only for template specific group users
      return Dict.from(resIds.map(recordId => [recordId, templateInstructions[0][0]]));
    }
    // prepare template variables
    const variables = await this._renderEvalContext();
    if (addContext) {
      Object.assign(variables, addContext);
    }

    for (const record of this.env.items(model).browse(resIds)) {
      variables['object'] = record;

      try {
        results[record.id] = await renderInlineTemplate(templateInstructions, variables);
      } catch (e) {
        console.info("Failed to render inlineTemplate: \n%s", String(templateTxt));
        throw new UserError(await this._t("Failed to render inlineTemplate template : %s)", e));
      }
    }
    return results;
  }

  /**
   * Tool method for post processing. In this method we ensure local
    links ('/shop/Basil-1') are replaced by global links ('https://www.
    mygarden.com/shop/Basil-1').

    :param rendered: result of ``_renderTemplate``;

    :return dict: updated version of rendered per record ID;
   * @param rendered 
   * @returns 
   */
  @api.model()
  async _renderTemplatePostprocess(rendered) {
    for (const [resId, renderedHtml] of Object.entries(rendered)) {
      rendered[resId] = await this._replaceLocalLinks(renderedHtml);
    }
    return rendered;
  }

  /**
   * Render the given string on records designed by model / resIds using
    the given rendering engine. Possible engine are smallWeb, qweb, or
    qwebView.

    :param str templateSrc: template text to render or xml id of a qweb view;
    :param str model: model name of records on which we want to perform
      rendering (aka 'crm.lead');
    :param list resIds: list of ids of records. All should belong to the
      Verp model given by model;
    :param string engine: inlineTemplate, qweb or qwebView;

    :param dict addContext: additional context to give to renderer. It
      allows to add or update values to base rendering context generated
      by ``MailRenderMixin._render_<engine>_eval_context()``;
    :param dict options: options for rendering;
    :param boolean postProcess: perform a post processing on rendered result
      (notably html links management). See``_renderTemplatePostprocess``;

    :return dict: {resId: string of rendered template based on record}
   * @param templateSrc 
   * @param model 
   * @param resIds 
   * @param engine 
   * @param addContext 
   * @param options 
   * @param postProcess 
   */
  @api.model()
  async _renderTemplate(templateSrc, model, resIds, engine = 'inlineTemplate',
    addContext?: any, options?: any, postProcess?: boolean) {
    if (!isList(resIds)) {
      throw new ValueError(await this._t('Template rendering should be called only using on a list of IDs.'));
    }
    if (!['inlineTemplate', 'qweb', 'qwebView'].includes(engine)) {
      throw new ValueError(await this._t('Template rendering supports only inline_template, qweb, or qweb_view (view or raw).'));
    }

    let rendered;
    if (engine === 'qwebView') {
      rendered = await this._renderTemplateQwebView(templateSrc, model, resIds, addContext, options);
    }
    else if (engine === 'qweb') {
      rendered = await this._renderTemplateQweb(templateSrc, model, resIds, addContext, options);
    }
    else {
      rendered = await this._renderTemplateInlineTemplate(templateSrc, model, resIds, addContext, options);
    }
    if (postProcess) {
      rendered = await this._renderTemplatePostprocess(rendered);
    }

    return rendered;
  }
  /**
   * Given some record ids, return the lang for each record based on
    lang field of template or through specific context-based key. Lang is
    computed by performing a rendering on resIds, based on self.renderModel.

    :param list resIds: list of ids of records. All should belong to the
      Verp model given by model;
    :param string engine: inlineTemplate or qweb_view;

    :return dict: {resId: lang code (i.e. en_US)}
   * @param resIds 
   * @param engine 
   * @returns 
   */
  async _renderLang(resIds, engine = 'inlineTemplate') {
    this.ensureOne();
    if (!isList(resIds)) {
      throw new ValueError(await this._t('Template rendering for language should be called with a list of IDs.'));
    }

    const renderedLangs = await this._renderTemplate(await this['lang'], await this['renderModel'], resIds, engine);
    return renderedLangs;
  }

  /**
   * Given some record ids, return for computed each lang a contextualized
    template and its subset of resIds.

    :param list resIds: list of ids of records (all belonging to same model
      defined by self.renderModel)
    :param string engine: inlineTemplate, qweb, or qwebView;

    :return dict: {lang: (template with lang=langCode if specific lang computed
      or template, resIds targeted by that language}
   * @param resIds 
   * @param engine 
   * @returns 
   */
  async _classifyPerLang(resIds, engine = 'inlineTemplate') {
    this.ensureOne();

    let langToResIds;
    if (this.env.context['templatePreviewLang']) {
      langToResIds = { [this.env.context['templatePreviewLang']]: resIds };
    }
    else {
      langToResIds = {}
      for (const [resId, lang] of await this._renderLang(resIds, engine)) {
        setdefault(langToResIds, lang, []).push(Number(resId));
      }
    }
    const result = new Dict<any>();
    for (const [lang, langResIds] of Object.entries(langToResIds)) {
      result[lang] = [lang ? await this.withContext({ lang }) : this, langResIds];
    }
    return result;
  }

  /**
   * Given some record ids, render a template located on field on all
    records. ``field`` should be a field of self (i.e. ``body_html`` on
    ``mail.template``). resIds are record IDs linked to ``model`` field
    on self.

    :param field: a field name existing on self;
    :param list resIds: list of ids of records (all belonging to same model
      defined by ``self.render_model``)
    :param string engine: inline_template, qweb, or qweb_view;

    :param boolean compute_lang: compute language to render on translated
      version of the template instead of default (probably english) one.
      Language will be computed based on ``self.lang``;
    :param string set_lang: force language for rendering. It should be a
      valid lang code matching an activate res.lang. Checked only if
      ``compute_lang`` is false;
    :param dict add_context: additional context to give to renderer;
    :param dict options: options for rendering;
    :param boolean post_process: perform a post processing on rendered result
      (notably html links management). See``_render_template_postprocess``);

    :return dict: {resId: string of rendered template based on record}
   * @param field 
   * @param resIds 
   * @param engine 
   * @param options 
   */
  async _renderField(field, resIds, kwargs: {
    engine?: string,
    computeLang?: boolean, setLang?: boolean,
    addContext?: any, options?: any, postProcess?: boolean
  } = {}) {
    this.ensureOne();
    kwargs.engine = kwargs.engine ?? 'inlineTemplate';
    const options = kwargs.options ?? {};
    let templatesResIds
    if (kwargs.computeLang) {
      templatesResIds = await this._classifyPerLang(resIds);
    }
    else if (kwargs.setLang) {
      templatesResIds = { [`${kwargs.setLang}`]: [await this.withContext({ lang: kwargs.setLang }), resIds] };
    }
    else {
      templatesResIds = { [this._context['lang']]: [this, resIds] };
    }

    // rendering options
    const engine = this._fields[field]['renderEngine'] ?? kwargs.engine;
    setOptions(options, { ...(this._fields[field]['renderOptions'] ?? {}) });
    options.postProcess = options.postProcess ?? kwargs.postProcess;
    const result = new Dict<any>();
    for (const [template, tplResIds] of Object.values<any>(templatesResIds)) {
      for (const [resId, rendered] of Object.entries<any>(await template._renderTemplate(
        await template[field], await template.renderModel, tplResIds, engine,
        options.addContext, options, options.postProcess
      ))) {
        result[resId] = rendered;
      }
    }
    return result;
  }
}
