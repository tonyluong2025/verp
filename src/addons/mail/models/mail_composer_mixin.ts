import assert from "assert";
import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { ValueError } from "../../../core/helper/errors";
import { AbstractModel, MetaModel, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { htmlSanitize } from "../../../core/tools/mail";

/**
 * Mixin used to edit and render some fields used when sending emails or
    notifications based on a mail template.

    Main current purpose is to hide details related to subject and body computation
    and rendering based on a mail.template. It also give the base tools to control
    who is allowed to edit body, notably when dealing with templating language
    like inline_template or qweb.

    It is meant to evolve in a near future with upcoming support of qweb and fine
    grain control of rendering access.
 */
@MetaModel.define()
class MailComposerMixin extends AbstractModel {
  static _module = module;
  static _name = 'mail.composer.mixin';
  static _parents = 'mail.render.mixin';
  static _description = 'Mail Composer Mixin';

  // Content
  static subject = Fields.Char('Subject', {compute: '_computeSubject', readonly: false, store: true});
  static body = Fields.Html('Contents', {compute: '_computeBody', renderEngine: 'qweb', store: true, readonly: false, sanitize: false});
  static templateId = Fields.Many2one('mail.template', {string: 'Mail Template', domain: "[['model', '=', renderModel]]"});
  // Access
  static isMailTemplateEditor = Fields.Boolean('Is Editor', {compute: '_computeIsMailTemplateEditor'});
  static canEditBody = Fields.Boolean('Can Edit Body', {compute: '_computeCanEditBody'});

  @api.depends('templateId')
  async _computeSubject() {
    for (const composerMixin of this) {
      const templateId = await composerMixin.templateId;
      if (bool(templateId)) {
        await composerMixin.set('subject', await templateId.subject);
      }
      else if (! await composerMixin.subject) {
        await composerMixin.set('subject', false);
      }
    }
  }

  @api.depends('templateId')
  async _computeBody() {
    for (const composerMixin of this) {
      const templateId = await composerMixin.templateId;
      if (bool(templateId)) {
        await composerMixin.set('body', await templateId.bodyHtml);
      }
      else if (! await composerMixin.body) {
        await composerMixin.set('body', false);
      }
    }
  }

  @api.dependsContext('uid')
  async _computeIsMailTemplateEditor() {
    const isMailTemplateEditor = await this.env.isAdmin() || await (await this.env.user()).hasGroup('mail.groupMailTemplateEditor')
    for (const record of this) {
      await record.set('isMailTemplateEditor', isMailTemplateEditor);
    }
  }

  @api.depends('templateId', 'isMailTemplateEditor')
  async _computeCanEditBody() {
    for (const record of this) {
      await record.set('canEditBody', await record.isMailTemplateEditor
        || ! bool(await record.templateId)
      );
    }
  }

  /**
   * Render the given field on the given records.
    This method bypass the rights when needed to
    be able to render the template values in mass mode.
   * @param field 
   * @param resIds 
   * @param engine 
   * @param kwargs 
   * @returns 
   */
  async _renderField(field, resIds, kwargs: {engine?: string, computeLang?: boolean, setLang?: boolean,
    addContext?: any, options?: any, postProcess?: boolean}={}) {
    
    kwargs.engine = kwargs.engine ?? 'inlineTemplate';
    if (!(field in this._fields)) {
      throw new ValueError(await this._t("The field %s does not exist on the model %s", field, this._name));
    }

    let [composerValue, templateId, isMailTemplateEditor, canEditBody] = await this(field, 'templateId', 'isMailTemplateEditor', 'canEditBody');

    if (! bool(templateId) || isMailTemplateEditor) {
      // Do not need to bypass the verification
      return _super(MailComposerMixin, this)._renderField(field, resIds, kwargs);
    }

    const templateField = field === 'body' ? 'bodyHtml' : field;
    assert(templateField in templateId._fields)
    const templateValue = await templateId[templateField];

    const sudo = await this.sudo();
    if (field === 'body') {
      const sanitizedTemplateValue = htmlSanitize(templateValue);
      if (! canEditBody || [sanitizedTemplateValue, templateValue].includes(composerValue)) {
        // Take the previous body which we can trust without HTML editor reformatting
        await this.set('body', await templateId.bodyHtml);
        return _super(MailComposerMixin, sudo)._renderField(field, resIds, kwargs);
      }
    }
    else if (composerValue === templateValue) {
      // The value is the same as the mail template so we trust it
      return _super(MailComposerMixin, sudo)._renderField(field, resIds, kwargs);
    }

    return _super(MailComposerMixin, sudo)._renderField(field, resIds, kwargs);
  }
}