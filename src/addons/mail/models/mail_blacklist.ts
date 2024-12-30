import { api } from "../../../core"
import { Fields } from "../../../core/fields"
import { UserError } from "../../../core/helper/errors"
import { MetaModel, Model, _super } from "../../../core/models"
import { isList, quoteList } from "../../../core/tools"
import { bool } from "../../../core/tools/bool"
import { emailNormalize } from "../../../core/tools/mail"

/**
 * Model of blacklisted email addresses to stop sending emails.
 */
@MetaModel.define()
class MailBlackList extends Model {
  static _module = module;
  static _name = 'mail.blacklist'
  static _parents = ['mail.thread']
  static _description = 'Mail Blacklist'
  static _recName = 'email'

  static email = Fields.Char({string: 'Email Address', required: true, index: true, help: 'This field is case insensitive.', tracking: true});
  static active = Fields.Boolean({default: true, tracking: true});

  static _sqlConstraints = [
    ['unique_email', 'unique (email)', 'Email address already exists!']
  ];

  @api.modelCreateMulti()
  async create(values) {
    // First of all, extract values to ensure emails are really unique (and don't modify values in place)
    const newValues = [];
    const allEmails = [];
    for (const value of values) {
      const email = emailNormalize(value['email'])
      if (!email) {
        throw new UserError(await this._t('Invalid email address %s', value['email']));
      }
      if (allEmails.includes(email)) {
        continue;
      }
      allEmails.push(email);
      const newValue = Object.assign(value, {email: email});
      newValues.push(newValue);
    }
    // To avoid crash during import due to unique email, return the existing records if any
    const sql = `SELECT email, id FROM "mailBlacklist" WHERE email IN (%s)`
    const emails = newValues.map(v => v['email']);
    const res = await this._cr.execute(sql, [quoteList(emails)]);
    const toCreate = newValues.filter(v => !(v['email'] in res)); 

    // TODO DBE Fixme : reorder ids according to incoming ids.
    const results = await _super(MailBlackList, this).create(toCreate);
    return this.env.items('mail.blacklist').browse(res.map(v => v['id'])).or(results);
  }

  async write(values) {
    if ('email' in values) {
      values['email'] = emailNormalize(values['email']);
    }
    return _super(MailBlackList, this).write(values);
  }

  /**
   * Override _search in order to grep search on email field and make it
      lower-case and sanitized
   * @param args 
   * @param options 
   */
  async _search(args, options: {offset?: number, limit?: number, order?: string, count?: boolean, accessRightsUid?: boolean}={}): Promise<any> {
    let newArgs;
    if (bool(args)) {
      newArgs = [];
      for (const arg of args) {
        if (isList(arg) && arg[0] === 'email' && typeof(arg[2]) === 'string') {
          const normalized = emailNormalize(arg[2]);
          if (normalized) {
            newArgs.push([arg[0], arg[1], normalized]);
          }
          else {
            newArgs.push(arg);
          }
        }
        else {
          newArgs.push(arg);
        }
      }
    }
    else {
      newArgs = args;
    }
    return _super(MailBlackList, this)._search(newArgs, options);
  }

  async _plus(email) {
    const normalized = emailNormalize(email);
    let record = await (await this.env.items("mail.blacklist").withContext({activeTest: false})).search([['email', '=', normalized]]);
    if (record._length > 0) {
      await record.actionUnarchive();
    }
    else {
      record = await this.create({'email': email});
    }
    return record;
  }

  async actionRemoveWithReason(email, reason: any) {
    const record = await this._remove(email);
    if (reason) {
      await record.messagePost(await this._t("Unblacklisting Reason: %s", reason));
    }
    
    return record
  }

  async _remove(email) {
    const normalized = emailNormalize(email);
    let record = await (await this.env.items("mail.blacklist").withContext({activeTest: false})).search([['email', '=', normalized]]);
    if (record._length > 0) {
      await record.actionArchive();
    }
    else {
      record = await record.create({'email': email, 'active': false});
    }
    return record;
  }

  async mailActionBlacklistRemove() {
    return {
      'label': await this._t('Are you sure you want to unblacklist this Email Address?'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel': 'mail.blacklist.remove',
      'target': 'new',
    }
  }
  
  async actionAdd() {
    await this._plus(await (this as any).email);
  }
}