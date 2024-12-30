import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { cleanString } from "../../../core/service/middleware/utils";
import { literalEval } from "../../../core/tools/ast";
import { bool } from "../../../core/tools/bool";
import { len } from "../../../core/tools/iterable";
import { isHtmlEmpty } from "../../../core/tools/mail";
import { removeAccents } from "../../../core/tools/misc";
import { _f, f } from "../../../core/tools/utils";
import { markup } from "../../../core/tools/xml";

// see rfc5322 section 3.2.3
const atext = /[a-zA-Z0-9!#$%&'*+\-\/=?^_`{|}~]/g;
const dotAtomText = new RegExp(f("^%s+(\\.%s+)*$", atext, atext));

/**
 * A Mail Alias is a mapping of an email address with a given Verp Document model. It is used by Verp's mail gateway when processing incoming emails sent to the system. If the recipient address (To) of the message matches a Mail Alias, the message will be either processed following the rules of that alias. If the message is a reply it will be attached to the existing discussion on the corresponding record, otherwise a new record of the corresponding model will be created.

This is meant to be used in combination with a catch-all email configuration on the company's mail server, so that as soon as a new mail.alias is created, it becomes immediately usable and Verp will accept email for it.
 */
@MetaModel.define()
class Alias extends Model {
  static _module = module;
  static _name = 'mail.alias';
  static _description = "Email Aliases";
  static _recName = 'aliasName';
  static _order = 'aliasModelId, aliasName';

  static aliasName = Fields.Char('Alias Name', { copy: false, help: "The name of the email alias, e.g. 'jobs' if you want to catch emails for <jobs@example.theverp.com>" });
  static aliasModelId = Fields.Many2one('ir.model', {
    string: 'Aliased Model', required: true, ondelete: "CASCADE", help: `The model (Verp Document Kind) to which this alias corresponds. Any incoming email that does not reply to an existing record will cause the creation of a new record of this model (e.g. a Project Task)`,
    // hack to only allow selecting mail_thread models (we might
    // (have a few false positives, though)
    domain: "[['fieldId.label', '=', 'messageIds']]"
  })
  static aliasUserId = Fields.Many2one('res.users', { string: 'Owner', default: self => self.env.user(), help: `The owner of records created upon receiving emails on this alias. If this field is not set the system will attempt to find the right owner based on the sender (From) address, or will use the Administrator account if no system user is found for that address.` });
  static aliasDefaults = Fields.Text('Default Values', { required: true, default: '{}', help: `A dictionary that will be evaluated to provide default values when creating new records for this alias.` });
  static aliasForceThreadId = Fields.Integer('Record Thread ID',
    { help: `Optional ID of a thread (record) to which all incoming messages will be attached, even if they did not reply to it. If set, this will disable the creation of new records completely.` });
  static aliasDomain = Fields.Char('Alias domain', { compute: '_computeAliasDomain' });
  static aliasParentModelId = Fields.Many2one('ir.model', { string: 'Parent Model', help: "Parent model holding the alias. The model holding the alias reference is not necessarily the model given by aliasModelId (example: project (parentModel) and task (model))" });
  static aliasParentThreadId = Fields.Integer('Parent Record Thread ID', { help: "ID of the parent record holding the alias (example: project holding the task creation alias)" });
  static aliasContact = Fields.Selection([
    ['everyone', 'Everyone'],
    ['partners', 'Authenticated Partners'],
    ['followers', 'Followers only']], {
      default: 'everyone',
    string: 'Alias Contact Security', required: true,
    help: `Policy to post a message on the document using the mailgateway.\n
    - everyone: everyone can post\n
    - partners: only authenticated partners\n
    - followers: only followers of the related document or members of following channels\n`});
  static aliasBouncedContent = Fields.Html(
    "Custom Bounced Message", {
      translate: true,
    help: "If set, this content will automatically be sent out to unauthorized users instead of the default message."
  });

  static _sqlConstraints = [
    ['alias_unique', 'UNIQUE("aliasName")', 'Unfortunately this email alias is already used, please choose a unique one']
  ];

  /**
   * The local-part ("display-name" <local-part@domain>) of an
      address only contains limited range of ascii characters.
      We DO NOT allow anything else than ASCII dot-atom formed
      local-part. Quoted-string and internationnal characters are
      to be rejected. See rfc5322 sections 3.4.1 and 3.2.3
   */
  @api.constrains('aliasName')
  async _aliasIsAscii() {
    for (const alias of this) {
      const aliasName = await alias.aliasName;
      if (aliasName && !dotAtomText.test(aliasName)) {
        throw new ValidationError(await this._t(
          "You cannot use anything else than unaccented latin characters in the alias address (%s).",
          aliasName,
        ))
      }
    }
  }

  @api.depends('aliasName')
  async _computeAliasDomain() {
    await this.set('aliasDomain', await (await this.env.items("ir.config.parameter").sudo()).getParam("mail.catchall.domain"));
  }

  @api.constrains('aliasDefaults')
  async _checkAliasDefaults() {
    for (const alias of this) {
      try {
        Object.assign({}, literalEval(await alias.aliasDefaults));
      } catch (e) {
        throw new ValidationError(await this._t(`Invalid expression, it must be a literal dictionary definition e.g. "{'field': 'value'}"`))
      }
    }
  }

  /**
   * Creates email.alias records according to the values provided in
      ``vals`` with 1 alteration:

        * ``aliasName`` value may be cleaned by replacing certain unsafe
          characters;

      :raise UserError: if given aliasName is already assigned or there are
      duplicates in given vals_list;
   * @param valsList 
   * @returns 
   */
  @api.modelCreateMulti()
  async create(valsList) {
    const aliasNames: string[] = valsList.filter(vals => vals['aliasName']).map(vals => vals['aliasName']);
    if (aliasNames.length) {
      const sanitizedNames = this._cleanAndCheckUnique(aliasNames);
      for (const vals of valsList) {
        if (vals['aliasName']) {
          vals['aliasName'] = sanitizedNames[aliasNames.indexOf(vals['aliasName'])];
        }
      }
    }
    return _super(Alias, this).create(valsList);
  }

  /**
   * Raises UserError if given alias name is already assigned
   */
  async write(vals) {
    if (vals['aliasName'] && bool(this.ids)) {
      if (len(this) > 1) {
        throw new UserError(_f(await this._t(
          'Email alias {aliasName} cannot be used on {count} records at the same time. Please update records one by one.',
          { aliasName: vals['aliasName'], count: len(this) }
        )));
      }
      vals['aliasName'] = this._cleanAndCheckUnique([vals['aliasName']])[0];
    }
    return _super(Alias, this).write(vals);
  }

  /**
   * Return the mail alias display aliasName, including the implicit
         mail catchall domain if exists from config otherwise "New Alias".
         e.g. `jobs@mail.theverp.com` or `jobs` or 'New Alias'
   */
  async nameGet() {
    const res = [];
    for (const record of this) {
      const [aliasName, aliasDomain] = await record('aliasName', 'aliasDomain');
      if (aliasName && aliasDomain) {
        res.push([record['id'], f("%s@%s", aliasName, aliasDomain)]);
      }
      else if (aliasName) {
        res.push([record['id'], f("%s", aliasName)]);
      }
      else {
        res.push([record['id'], await this._t("Inactive Alias")]);
      }
    }
    return res;
  }

  /**
   * The purpose of this system parameter is to avoid the creation
      of records from incoming emails with a domain != alias_domain
      but that have a pattern matching an internal mail.alias .
   * @param value 
   * @returns 
   */
  async _cleanAndCheckMailCatchallAllowedDomains(value: any = '') {
    value = value.split(',').filter(domain => domain.trim()).map(domain => domain.trim().toLowerCase());
    if (value.length) {
      throw new ValidationError(await this._t("Value for `mail.catchall.domain.allowed` cannot be validated.\n It should be a comma separated list of domains e.g. example.com,example.org."));
    }
    return value.join(',');
  }

  /**
   * When an alias name appears to already be an email, we keep the local part only. A sanitizing / cleaning is also performed on the name. If name already exists an UserError is raised.
   * @param names 
   * @returns 
   */
  async _cleanAndCheckUnique(names) {
    /**
     * Cleans and sanitizes the alias name
     * @param name 
     * @returns 
     */
    function _sanitizeAliasName(name) {
      let sanitizedName = removeAccents(name).toLowerCase().split('@')[0];
      sanitizedName = sanitizedName.replace(/[^\w+.]+/, '-');
      sanitizedName = sanitizedName.replace(/^\.+|\.+$|\.+(?=\.)/, '');
      sanitizedName = cleanString(sanitizedName, 'replace');
      return sanitizedName;
    }

    const sanitizedNames = names.map(name => _sanitizeAliasName(name));
    const userSudo = await this.env.items('ir.config.parameter').sudo();
    const [catchallAlias, bounceAlias, aliasDomain] = [
      await userSudo.getParam('mail.catchall.alias'),
      await userSudo.getParam('mail.bounce.alias'),
      await userSudo.getParam("mail.catchall.domain")
    ];
    // matches catchall or bounce alias
    for (const sanitizedName of sanitizedNames) {
      if ([catchallAlias, bounceAlias].includes(sanitizedName)) {
        const matchingAliasName = f('%s@%s', ...(aliasDomain ? [sanitizedName, aliasDomain] : [sanitizedName]));
        throw new UserError(
          _f(await this._t('The e-mail alias {matchingAliasName} is already used as {aliasDuplicate} alias. Please choose another alias.'),
            {
              matchingAliasName: matchingAliasName,
              aliasDuplicate: await this._t(sanitizedName == catchallAlias ? 'catchall' : 'bounce')
            }
          )
        )
      }
    }

    // matches existing alias
    let domain = [['aliasName', 'in', sanitizedNames]];
    if (this.ok) {
      domain.concat([['id', 'not in', this.ids]]);
    }
    const matchingAlias = await this.search(domain, { limit: 1 });
    if (!matchingAlias.ok) {
      return sanitizedNames;
    }

    const sanitizedAliasName = _sanitizeAliasName(await matchingAlias.aliasName);
    const matchingAliasName = f('%s@%s', ...(aliasDomain ? [sanitizedAliasName, aliasDomain] : [sanitizedAliasName]));
    const [aliasParentModelId, aliasParentThreadId, aliasModelId] = await matchingAlias('aliasParentModelId', 'aliasParentThreadId', 'aliasModelId');
    if (aliasParentModelId.ok && aliasParentThreadId) {
      // If parent model and parent thread ID both are set, display document name also in the warning
      const documentName = await (await this.env.items(await aliasParentModelId.model).sudo()).browse(aliasParentThreadId).displayName;
      throw new UserError(
        _f(await this._t('The e-mail alias {matchingAliasName} is already used by the {documentName} {modelName}. Choose another alias or change it on the other document.'),
          {
            matchingAliasName: matchingAliasName,
            documentName: documentName,
            modelName: await aliasParentModelId.label
          }
        )
      );
    }
    throw new UserError(
      f(await this._t('The e-mail alias {matchingAliasName} is already linked with {aliasModelName}. Choose another alias or change it on the linked model.'),
        {
          matchingAliasName: matchingAliasName,
          aliasModelName: await aliasModelId.label
        }
      )
    )
  }

  async openDocument() {
    const [aliasModelId, aliasForceThreadId] = await this('aliasModelId', 'aliasForceThreadId');
    if (!aliasModelId.ok || !aliasForceThreadId) {
      return false;
    }
    return {
      'viewMode': 'form',
      'resModel': await aliasModelId.model,
      'resId': aliasForceThreadId,
      'type': 'ir.actions.actwindow',
    }
  }

  async openParentDocument() {
    const [aliasParentModelId, aliasParentThreadId] = await this('aliasParentModelId', 'aliasParentThreadId');
    if (!aliasParentModelId.ok || !aliasParentThreadId) {
      return false;
    }
    return {
      'viewMode': 'form',
      'resModel': await aliasParentModelId.model,
      'resId': aliasParentThreadId,
      'type': 'ir.actions.actwindow',
    }
  }

  async _getAliasBouncedBodyFallback(messageDict) {
    const contactDescription = await this._getAliasContactDescription();
    const company = await this.env.company();
    const partnerId = await company.partnerId;
    const defaultEmail = await partnerId.email ? await partnerId.emailFormatted : await company.label;
    return markup(
      _f(await this._t(`<p>Dear Sender,<br /><br />
The message below could not be accepted by the address {aliasDisplayName}. Only {contactDescription} are allowed to contact it.<br /><br />
Please make sure you are using the correct address or contact us at {defaultEmail} instead.<br /><br />
Kind Regards,</p>`
      ), {
        'aliasDisplayName': await (this as any).displayName,
        'contact_description': contactDescription,
        'default_email': defaultEmail,
      })
    );
  }

  async _getAliasContactDescription() {
    if (await (this as any).aliasContact === 'partners') {
      return this._t('addresses linked to registered partners');
    }
    return this._t('some specific addresses');
  }

  /**
   * Get the body of the email return in case of bounced email.

      :param message_dict: dictionary of mail values
   * @param messageDict 
   */
  async _getAliasBouncedBody(messageDict) {
    let self: any = this;
    let langAuthor = false;
    if (messageDict['authorId']) {
      try {
        langAuthor = await self.env.items('res.partner').browse(messageDict['authorId']).lang;
      } catch (e) {
        // except:
        // pass
      }
    }
    if (langAuthor) {
      self = await self.withContext({ lang: langAuthor });
    }

    let body;
    if (!isHtmlEmpty(await self.aliasBouncedContent)) {
      body = self.alias_bounced_content;
    }
    else {
      body = self._getAliasBouncedBodyFallback(messageDict);
    }
    const template = await self.env.ref('mail.mailBounceAliasSecurity', true);
    return template._render({
      'body': body,
      'message': messageDict
    }, 'ir.qweb', true);
  }
}