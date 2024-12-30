import * as crypto from 'crypto';
import _ from 'lodash';
import { DateTime, Duration } from 'luxon';
import assert from 'node:assert';
import { api, tools } from '../../..';
import { Environment } from '../../../api/api';
import { getattr, hasattr } from '../../../api/func';
import { DefaultDict, Dict, FrozenDict } from "../../../helper/collections";
import { AccessDenied, AccessError, UserError, ValidationError } from '../../../helper/errors';
import { WebRequest } from '../../../http';
import { MetaModel, Model } from "../../../models";
import { expression } from '../../../osv';
import * as ipaddress from '../../../service/middleware/ipaddress';
import { bool, doWith, isCallable, isInstance, quoteList, singleEmailRe } from '../../../tools';
import * as context from '../../../tools/context';
import { chain, extend, len, repeat, sorted, sortedAsync } from '../../../tools/iterable';
import { stringify } from '../../../tools/json';
import * as lazy from '../../../tools/lazy';
import { allTimezones, partition, pop, setOptions, sha256, update } from "../../../tools/misc";
import { _f, f, urandom } from '../../../tools/utils';
import { E, serializeXml } from "../../../tools/xml";
import { Command, Fields, NO_ACCESS } from './../../../fields';
import { AbstractModel, ModelRecords, TransientModel, _super } from './../../../models';
import { MODULE_UNINSTALL_FLAG } from './ir_model';
import { MetaDatebase } from '../../../service/db';

const USER_PRIVATE_FIELDS = []

const LIFE_TIME = 30*24*60*60*60; // 1 month

function nameSelectionGroups(ids: any[]) {
  return 'selGroups_' + sorted(ids).map(id => String(id)).join('_');
}

function nameBooleanGroup(id: number) {
  return 'inGroup_' + String(id);
}

function isBooleanGroup(name: string) {
  return name.startsWith('inGroup_');
}

export function isSelectionGroups(name: string) {
  return name.startsWith('selGroups_');
}

function isReifiedGroup(name: string) {
  return isBooleanGroup(name) || isSelectionGroups(name);
}

function getBooleanGroup(name: string) {
  return parseInt(name.slice(9));
}

function getSelectionGroups(name: string) {
  return name.slice(10).split('_').map(v => parseInt(v));
}

/**
 * return a list of ids corresponding to a many2many value
 * @param commands 
 * @returns 
 */
function parseM2m(commands) {
  let ids = [];
  for (const command of commands) {
    if (Array.isArray(command)) {
      if ([Command.UPDATE, Command.LINK].includes(command[0])) {
        ids.push(command[1]);
      }
      else if (command[0] === Command.CLEAR) {
        ids = [];
      }
      else if (command[0] === Command.SET) {
        ids = Array.from(command[2]);
      }
    }
    else {
      ids.push(command);
    }
  }
  return ids;
}

function _jsonable(o) {
  try {
    stringify(o);
  } catch (e) {
    return false
  }
  return true;
}

/**
 * Wrapped method should be an *action method* (called from a button
    type=object), and requires extra security to be executed. This decorator
    checks if the identity (password) has been checked in the last 10mn, and
    pops up an identity check wizard if not.

    Prevents access outside of interactive contexts (aka with a request)
 * @param fn 
 * @returns 
 */
function checkIdentity() {
  function decorator(target: any, propertyKey: string, descriptor: PropertyDescriptor): any {
    const originalFunc = descriptor.value;
    const wrapped = async function (...args: any[]) {
      const req = this.env.req;
      if (!req) {
        throw new UserError(await this._t("This method can only be accessed over HTTP"));
      }

      if ((req.session['identity-check-last'] || 0) > (new Date()).getSeconds() - 10 * 60) {
        return originalFunc.call(this, ...args);
      }

      const w = await (await this.sudo()).env.items('res.users.identitycheck').create({
        'request': stringify([
          Object.fromEntries(Object.entries(this.env.context).filter(([k, v]) => _jsonable(v))),
          this._name,
          this.ids,
          originalFunc.name
        ])
      })
      return {
        'type': 'ir.actions.actwindow',
        'resModel': 'res.users.identitycheck',
        'resId': w.id,
        'label': await this._t("Security Control"),
        'target': 'new',
        'views': [[false, 'form']],
      }
    }
    wrapped.__hasCheckIdentity = true;
    wrapped.originalFunc = originalFunc;
    descriptor.value = wrapped;
    return wrapped;
  };
  return decorator;
}

@MetaModel.define()
class Groups extends Model {
  static _module = module;
  static _name = "res.groups";
  static _description = "Access Groups";
  static _recName = 'fullName';
  static _order = 'label';

  static label = Fields.Char({ required: true, translate: true });
  static users = Fields.Many2many('res.users', { relation: 'resGroupsUsersRel', column1: 'gid', column2: 'uid' });
  static modelAccess = Fields.One2many('ir.model.access', 'groupId', { string: 'Access Controls', copy: true });
  static ruleGroups = Fields.Many2many('ir.rule', { relation: 'ruleGroupRel', column1: 'groupId', column2: 'ruleGroupId', string: 'Rules', domain: [['global', '=', false]], recursive: true });
  static menuAccess = Fields.Many2many('ir.ui.menu', { relation: 'irUiMenuGroupRel', column1: 'gid', column2: 'menuId', string: 'Access Menu' });
  static viewAccess = Fields.Many2many('ir.ui.view', { relation: 'irUiViewGroupRel', column1: 'groupId', column2: 'viewId', string: 'Views' });
  static comment = Fields.Text({ translate: true });
  static categoryId = Fields.Many2one('ir.module.category', { string: 'Application', index: true });
  static color = Fields.Integer({ string: 'Color Index' });
  static fullName = Fields.Char({ compute: '_computeFullName', string: 'Group Name', search: '_searchFullNname' });
  static share = Fields.Boolean({ string: 'Share Group', help: "Group created to set access rights for sharing data with some users." })

  static _sqlConstraints = [
    ['label_uniq', 'unique ("categoryId", label)', 'The name of the group must be unique within an application!']
  ]

  @api.constrains('users')
  async _checkOneUserType() {
    const users = await (this as any).users;
    await users._checkOneUserType();
  }

  @api.depends('categoryId.label', 'label')
  async _computeFullName() {
    // Important: value must be stored in environment of group, not group1!
    for (const [group, group1] of _.zip<any, any>([...this], [...(await this.sudo())])) {
      const { categoryId, label } = (await group1.read(['categoryId', 'label']))[0];
      if (categoryId.ok) {
        await group.set('fullName', `${await categoryId.label} / ${label}`);
      }
      else {
        await group.set('fullName', await group1.label);
      }
    }
  }

  async _searchFullName(operator, operand) {
    let list = true;
    if (typeof operand === 'boolean') {
      const domains = [[['label', operator, operand]], [['categoryId.label', operator, operand]]];
      if (expression.NEGATIVE_TERM_OPERATORS.includes(operator) == (!operand))
        return expression.AND(domains);
      else
        return expression.OR(domains);
    }
    if (typeof operand === 'string') {
      list = false;
      operand = [operand];
    }
    let where = [];
    for (const group of operand) {
      const values: string[] = group.split('/').filter(v => !!v)
      const groupName = values.pop().trim();
      const categoryName = bool(values) && values.join('/').trim() || groupName;
      const groupDomain = [['label', operator, (list && [groupName]) ?? groupName]];
      let categoryDomain = [['categoryId.label', operator, (list && [categoryName]) ?? categoryName]];
      if (expression.NEGATIVE_TERM_OPERATORS.includes(operator) && !len(values)) {
        categoryDomain = expression.OR([categoryDomain, [['categoryId', '=', false]]]);
      }
      let subWhere;
      if (expression.NEGATIVE_TERM_OPERATORS.includes(operator) == (!len(values)))
        subWhere = expression.AND([groupDomain, categoryDomain]);
      else
        subWhere = expression.OR([groupDomain, categoryDomain]);
      if (expression.NEGATIVE_TERM_OPERATORS.includes(operator))
        where = expression.AND([where, subWhere]);
      else
        where = expression.OR([where, subWhere])
    }
    return where;
  }

  @api.model()
  async _search(args, options: { offset?: number, limit?: null, order?: null, count?: false, accessRightsUid?: null } = {}) {
    const order: string = options.order;
    const offset: number = options.offset || 0;
    const limit: number = options.limit;
    // add explicit ordering if search is sorted on fullName
    if (order && order.startsWith('fullName')) {
      let groups: ModelRecords = await _super(Groups, this).search(args);
      groups = await groups.sorted('fullName', order.endsWith('DESC'));
      groups = options.limit
        ? await groups([offset, offset + limit])
        : await groups([offset]);
      return options.count ? len(groups) : groups.ids;
    }
    return _super(Groups, this)._search(args, options);
  }

  async copy(defaultValue) {
    this.ensureOne();
    const chosenName = defaultValue ? defaultValue['label'] : '';
    const defaultName = chosenName || await this._t('%s (copy)', await this['label']);
    defaultValue = Object.assign({}, defaultValue, { label: defaultName });
    return _super(Groups, this).copy(defaultValue);
  }

  async write(vals) {
    if ('label' in vals) {
      if (vals['label'].startsWith('-'))
        throw new UserError(await this._t('The name of the group can not start with "-"'));
    }
    // invalidate caches before updating groups, since the recomputation of
    // field 'share' depends on method hasGroup()
    if (len(this.ids)) {
      await this.env.items('ir.model.access').callCacheClearingMethods();
    }
    return _super(Groups, this).write(vals);
  }

}

@MetaModel.define()
class ResUsersLog extends Model {
  static _module = module;
  static _name = 'res.users.log';
  static _order = 'id desc';
  static _description = 'Users Log';
  // Currenly only uses the magical fields: createdUid, createdAt,
  // for recording logins. To be extended for other uses (chat presence, etc.)

  @api.autovacuum()
  async _gcUserLogs() {
    const res = await this._cr.execute(`
          DELETE FROM "resUsersLog" log1 WHERE EXISTS (
              SELECT 1 FROM "resUsersLog" log2
              WHERE log1."createdUid" = log2."createdUid"
              AND log1."createdAt" < log2."createdAt"
          )
      `);
    console.info("GC'd %d user log entries", res.length);
  }
}

const DEFAULT_CRYPT_CONTEXT = new context.CryptContext(
  // kdf which can be verified by the context. The default encryption kdf is the first of the list
  ['pbkdf2_sha512', 'plaintext'],
  // deprecated algorithms are still verified as usual, but ``needs_update`` will indicate that the stored hash should be replaced by a more recent algorithm. Passlib 1.6 supports an `auto` value which deprecates any algorithm but the default, but Ubuntu LTS only provides 1.5 so far.
  { deprecated: ['plaintext'] },
)

const PREFIX_HASH = '$scrypted$';

/**
 * User class. A res.users record models an VERP user and is different from an employee.

    res.users class now inherits from res.partner. The partner model is used to store the data related to the partner: lang, label, address, avatar, ... The user model is now dedicated to technical data.
 */
@MetaModel.define()
class Users extends Model {
  static _module = module;
  static _name = "res.users";
  static _description = 'Users';
  static _inherits = { 'res.partner': 'partnerId' };
  static _order = 'label, login';

  static partnerId = Fields.Many2one('res.partner', { required: true, ondelete: 'RESTRICT', autojoin: true, index: true, string: 'Related Partner', help: 'Partner-related data of the user' });
  static login = Fields.Char({ required: true, help: "Used to log into the system" });
  static password = Fields.Char({ compute: '_computePassword', inverse: '_setPassword', invisible: true, copy: false, help: "Keep empty if you don't want the user to be able to connect on the system." });
  static newPassword = Fields.Char({ string: 'Set Password', compute: '_computePassword', inverse: '_setNewPassword', help: "Specify a value only when creating a user or if you're changing the user's password, otherwise leave empty. After a change of password, the user has to login again." });
  static signature = Fields.Html({ string: "Email Signature", default: "" });
  static active = Fields.Boolean({ default: true });
  static activePartner = Fields.Boolean({ related: 'partnerId.active', readonly: true, string: "Partner is Active" });
  static actionId = Fields.Many2one('ir.actions.actions', { string: 'Home Action', help: "If specified, this action will be opened at log on for this user, in addition to the standard menu." });
  static groupsId = Fields.Many2many('res.groups', { relation: 'resGroupsUsersRel', column1: 'uid', column2: 'gid', string: 'Groups', default: async (self) => await self._defaultGroups() });
  static logIds = Fields.One2many('res.users.log', 'createdUid', { string: 'User log entries' });
  static loginDate = Fields.Datetime({ related: 'logIds.createdAt', string: 'Latest authentication', readonly: false });
  static share = Fields.Boolean({ compute: '_computeShare', computeSudo: true, string: 'Share User', store: true, help: "External user with limited access, created only for the purpose of sharing data." });
  static companiesCount = Fields.Integer({ compute: '_computeCompaniesCount', string: "Number of Companies" });
  static tzOffset = Fields.Char({ compute: '_computeTzOffset', string: 'TimeZone offset', invisible: true });
  // Special behavior for this field: res.company.search() will only return the companies
  // available to the current user (should be the user's companies?), when the user_preference
  // context is set.
  static companyId = Fields.Many2one('res.company', { string: 'Company', required: true, default: async (self) => (await self.env.company()).id, help: 'The default company for this user.', context: { 'userPreference': true } });
  static companyIds = Fields.Many2many('res.company', { relation: 'resCompanyUsersRel', column1: 'userId', column2: 'cid', string: 'Companies', default: async (self) => (await self.env.company()).ids });
  // overridden inherited fields to bypass access rights, in case you have
  // access to the user but not its corresponding partner
  static label = Fields.Char({ related: 'partnerId.label', inherited: true, readonly: false });
  static email = Fields.Char({ related: 'partnerId.email', inherited: true, readonly: false });

  static accessesCount = Fields.Integer('# Access Rights', { help: 'Number of access rights that apply to the current user', compute: '_computeAccessesCount', computeSudo: true });
  static rulesCount = Fields.Integer('# Record Rules', { help: 'Number of record rules that apply to the current user', compute: '_computeAccessesCount', computeSudo: true });
  static groupsCount = Fields.Integer('# Groups', { help: 'Number of groups that apply to the current user', compute: '_computeAccessesCount', computeSudo: true });

  static _sqlConstraints = [
    ['login_key', 'unique (login)', 'You can not have two users with the same login !']
  ];

  async _login(req: WebRequest, db, login, password, userAgentEnv) {
    if (!password) {
      throw new AccessDenied();
    }
    const ip = req ? req.socket.remoteAddress : 'n/a';
    let user;
    try {
      const cr = (this as any).pool.cursor();
      const self = (await Environment.new(cr, global.SUPERUSER_ID, {}, false, req)).items(this._name);
      await self._assertCanAuth(req, async () => {
        user = await self.search(await self._getLoginDomain(login), { order: self._getLoginOrder(), limit: 1 });
        if (!bool(user)) {
          throw new AccessDenied();
        }
        user = await user.withUser(user);
        await user._checkCredentials(password, userAgentEnv);
        let tz;
        tz = req ? req.cookie['tz'] : null;
        if (allTimezones.includes(tz) && (! await user.tz || ! await user.loginDate)) {
          // first login or missing tz -> set tz to browser tz
          await user.set('tz', tz);
        }
        await user._updateLastLogin();
      });
    } catch (e) {
      if (isInstance(e, AccessDenied)) {
        console.info("Login failed for db:%s login:%s from %s", db, login, ip);
        throw e;
      }
      else {
        throw e;
      }
    }

    console.info("Login successful for db:%s login:%s id=%s from %s", db, login, user.id, ip)

    return user.id;
  }

  /**
   * Verifies and returns the user ID corresponding to the given
      ``login`` and ``password`` combination, or false if there was
      no matching user.

   * @param db the database on which user is trying to authenticate
   * @param login username
   * @param password user password
   * @param userAgentEnv environment dictionary describing any
            relevant environment attributes
   * @returns 
   */
  async authenticate(req, db, login, password, userAgentEnv) {
    const uid = await this._login(req, db, login, password, userAgentEnv);
    if (userAgentEnv && userAgentEnv['baseLocation']) {
      const cr = (this as any).pool.cursor();
      const env = await Environment.new(cr, uid, {}, false, req);
      if (await (await env.user()).hasGroup('base.groupSystem')) {
        // Successfully logged in as system user!
        // Attempt to guess the web base url...
        try {
          const base = userAgentEnv['baseLocation'];
          const ICP = env.items('ir.config.parameter');
          if (! await ICP.getParam('web.base.url.freeze')) {
            await ICP.setParam('web.base.url', base);
          }
        } catch (e) {
          console.error("Failed to update web.base.url configuration parameter");
        }
      }
      await cr.close();
    }
    return uid;
  }

  /**
   * Verifies that the given (uid, password) is authorized for the database ``db`` and
         raise an exception if it is not.
   * @param req 
   * @param db 
   * @param uid 
   * @param passwd 
   */
  @tools.ormcache('uid', 'passwd')
  async check(req, db, uid, passwd) {
    if (!passwd) {
      // empty passwords disallowed for obvious security reasons
      throw new AccessDenied();
    }
    const cr = (this as any).pool.cursor();
    await doWith(cr, async () => {
      const self = (await Environment.new(cr, uid, {}, false, req)).items(this._name);
      await self._assertCanAuth(req, async () => {
        if (! await (await self.env.user()).active) {
          throw new AccessDenied();
        }
        self._checkCredentials(passwd, { 'interactive': false });
      });
    });;
  }

  async init() {
    const cr = this.env.cr;

    // allow setting plaintext passwords via SQL and have them
    // automatically encrypted at startup: look for passwords which don't
    // match the "extended" MCF and pass those through passlib.
    // Alternative: iterate on *all* passwords and use CryptContext.identify
    const rows = await cr.execute(`
    SELECT id, password FROM "resUsers"
    WHERE password IS NOT NULL
      AND password !~ '^\\$[^$]+\\$[^$]+\\$.'
    `);
    if (rows.length) {
      const Users = await this.sudo();
      for (const { id, password } of rows) {
        await Users.browse(id).set('password', password);
      }
    }
  }

  /**
   * The list of fields a user can read on their own user record.
    In order to add fields, please override this property on model extensions.
   */
  static SELF_READABLE_FIELDS = [
    'signature', 'companyId', 'login', 'email', 'label', 'image1920',
    'image1024', 'image512', 'image256', 'image128', 'lang', 'tz',
    'tzOffset', 'groupsId', 'partnerId', '__lastUpdate', 'actionId',
    'avatar1920', 'avatar1024', 'avatar512', 'avatar256', 'avatar128',
  ];

  SELF_READABLE_FIELDS() {
    return this.cls.SELF_READABLE_FIELDS;
  }

  /**
   * The list of fields a user can write on their own user record.
      In order to add fields, please override this property on model extensions.
   */
  static SELF_WRITEABLE_FIELDS = ['signature', 'actionId', 'companyId', 'email', 'label', 'image1920', 'lang', 'tz'];

  SELF_WRITEABLE_FIELDS() {
    return this.cls.SELF_WRITEABLE_FIELDS;
  }

  async _defaultGroups() {
    const defaultUserId = await this.env.items('ir.model.data')._xmlidToResId('base.defaultUser', false);
    return defaultUserId ? await (await this.env.items('res.users').browse(defaultUserId).sudo()).groupsId : []
  }

  async _setPassword() {
    const ctx = this._cryptContext();
    for (const user of this) {
      // console.log('_setEncryptedPassword login="%s" pass="%s"', await user.login, await user.password);
      await this._setEncryptedPassword(user.id, ctx.hash(await user.password));
    }
  }

  async _setEncryptedPassword(uid, pw) {
    pw = PREFIX_HASH + pw;
    await this.env.cr.execute(
      `UPDATE "resUsers" SET password='%s' WHERE id=%s`,
      [pw, uid]
    )
    this.invalidateCache(['password'], [uid]);
  }

  /**
   * Validates the current user's password.

    Override this method to plug additional authentication methods.

    Overrides should:

    * call `super` to delegate to parents for credentials-checking
    * catch AccessDenied and perform their own checking
    * (re)raise AccessDenied if the credentials are still invalid
      according to their own validation method

    When trying to check for credentials validity, call _check_credentials
    instead.
   * @param password 
   * @param env 
   */
  async _checkCredentials(password, env) {
    // Override this method to plug additional authentication methods
    assert(password);
    const user = await this.env.user();
    const res = await this.env.cr.execute(
      `SELECT COALESCE(password, '') AS password FROM "resUsers" WHERE id=%s`,
      [user.id]
    )
    const hashed = res[0]['password'].replace(PREFIX_HASH, '');
    const [valid, replacement] = this._cryptContext().verifyAndUpdate(password, hashed);
    if (replacement != null) {
      const [time, pass] = replacement.split('$');
      if (Date.now() > Number(time) + LIFE_TIME) {
        await this._setEncryptedPassword(user.id, replacement);
      }
    }
    if (!valid) {
      throw new AccessDenied();
    }
  }

  /**
   * We check that no users are both portal and users (same with public).
        This could typically happen because of implied groups.
   */
  @api.constrains('groupsId')
  async _checkOneUserType() {
    const userTypesCategory = await this.env.ref('base.category_userType', false);
    const userTypesGroups = bool(userTypesCategory)
      ? await this.env.items('res.groups').search([['categoryId', '=', userTypesCategory.id]])
      : false;
    if (bool(userTypesGroups)) { // needed at install
      if (await this._hasMultipleGroups(userTypesGroups.ids)) {
        throw new ValidationError(await this._t('The user cannot have more than one user types.'));
      }
    }
  }

  /**
   * The method is not fast if the list of ids is very long;
        so we rather check all users than limit to the size of the group

   * @param self 
   * @param groupIds list of group ids
   */
  async _hasMultipleGroups(groupIds) {
    if (bool(groupIds)) {
      let whereClause = ""; // default; we check ALL users (actually pretty efficient);
      if (len(this.ids) == 1) {
        whereClause = `AND r.uid = ${this.id}`;
      }
      const query = `
        SELECT 1 FROM "resGroupsUsersRel" WHERE EXISTS(
          SELECT r.uid
          FROM "resGroupsUsersRel" r
          WHERE r.gid IN (${String(groupIds)}) ` + whereClause + `
          GROUP BY r.uid HAVING COUNT(r.gid) > 1
        )
      `;
      const res = await this.env.cr.execute(query);
      return bool(res);
    }
    else {
      return false;
    }
  }

  /**
   * Change current user password. Old password must be provided explicitly
      to prevent hijacking an existing user session, or for cases where the cleartext
      password is not used to authenticate requests.

   * @param oldPasswd 
   * @param newPasswd 
   * @returns true
   * @throws verp.exceptions.AccessDenied when old password is wrong
   * @throws verp.exceptions.UserError when new password is not set or empty
   */
  @api.model()
  async changePassword(oldPasswd, newPasswd) {
    if (!oldPasswd) {
      throw new AccessDenied();
    }
    if (!newPasswd) {
      throw new UserError(await this._t("Setting empty passwords is not allowed for security reasons!"));
    }

    // alternatively: use identitycheck wizard?
    await this._checkCredentials(oldPasswd, { 'interactive': true });

    const ip = this.env.req ? this.env.req.socket.remoteAddress : 'n/a';
    const user = await this.env.user();
    console.info("Password change for '%s' (#%s) from %s", await user.login, this.env.uid, ip);

    // use `await this.env.user()` here, because it has uid=SUPERUSER_ID
    return user.write({ 'password': newPasswd });
  }

  preferenceSave() {
    return {
      'type': 'ir.actions.client',
      'tag': 'reloadContext',
    }
  }

  preferenceChangePassword() {
    return {
      'type': 'ir.actions.client',
      'tag': 'changePassword',
      'target': 'new',
    }
  }

  @api.model()
  async hasGroup(groupExtId): Promise<boolean> {
    // use singleton's id if called on a non-empty recordset, otherwise
    // context uid
    let self = this as any;
    const uid = self.id;
    if (uid && uid !== self._uid) {
      self = await self.withUser(uid);
    }
    return self._hasGroup(groupExtId);
  }

  /**
   * Checks whether user belongs to given group.
   * 
   * @param groupExtId external ID (XML ID) of the group.
        Must be provided in fully-qualified form (``module.extId``), as there
        is no implicit module to use..
   * @returns true if the current user is a member of the group with the
        given external ID (XML ID), else false.
   */
  @api.model()
  @tools.ormcache('self._uid', 'groupExtId')
  async _hasGroup(groupExtId): Promise<boolean> {
    assert(groupExtId && groupExtId.includes('.'), `External ID '${groupExtId}' must be fully qualified`);
    const [module, extId] = groupExtId.split('.');
    // if (! req.uid) {
    //   req.uid = global.SUPERUSER_ID;
    // }
    const uid = this._uid;
    const res = await this._cr.execute(`SELECT 1 AS group FROM "resGroupsUsersRel" WHERE "uid"=${uid} AND "gid" IN (SELECT "resId" FROM "irModelData" WHERE module='${module}' AND label='${extId}')`)
    return bool(res[0] && res[0]['group']);
  }

  /**
   * If this is a singleton, directly access the form view. If it is a recordset, open a tree view
   * @returns 
   */
  async _actionShow() {
    const viewId = (await this.env.ref('base.viewUsersForm')).id;
    const action = {
      'type': 'ir.actions.actwindow',
      'resModel': 'res.users',
      'context': { 'create': false },
    }
    if (this._length > 1) {
      update(action, {
        'label': await this._t('Users'),
        'viewMode': 'list,form',
        'views': [[null, 'list'], [viewId, 'form']],
        'domain': [['id', 'in', this.ids]],
      });
    }
    else {
      update(action, {
        'viewMode': 'form',
        'views': [[viewId, 'form']],
        'resId': this.id,
      })
    }
    return action
  }

  async actionShowGroups() {
    this.ensureOne();
    return {
      'label': await this._t('Groups'),
      'viewMode': 'tree,form',
      'resModel': 'res.groups',
      'type': 'ir.actions.actwindow',
      'context': { 'create': false, 'delete': false },
      'domain': [['id', 'in', (await this['groupsId']).ids]],
      'target': 'current',
    }
  }

  async actionShowAccesses() {
    this.ensureOne();
    return {
      'label': await this._t('Access Rights'),
      'viewMode': 'tree,form',
      'resModel': 'ir.model.access',
      'type': 'ir.actions.actwindow',
      'context': { 'create': false, 'delete': false },
      'domain': [['id', 'in', (await (await this['groupsId']).modelAccess).ids]],
      'target': 'current',
    }
  }

  async actionShowRules() {
    this.ensureOne();
    return {
      'label': await this._t('Record Rules'),
      'viewMode': 'tree,form',
      'resModel': 'ir.rule',
      'type': 'ir.actions.actwindow',
      'context': { 'create': false, 'delete': false },
      'domain': [['id', 'in', (await (await this['groupsId']).ruleGroups).ids]],
      'target': 'current',
    }
  }

  async _isInternal(): Promise<boolean> {
    this.ensureOne();
    return !await this['share'];
  }

  async _isPublic(): Promise<boolean> {
    this.ensureOne();
    return this.hasGroup('base.groupPublic');
  }

  async _isSystem(): Promise<boolean> {
    this.ensureOne();
    return this.hasGroup('base.groupSystem');
  }

  async _isAdmin(): Promise<boolean> {
    this.ensureOne();
    return this._isSuperuser() || await this.hasGroup('base.groupErpManager');
  }

  _isSuperuser(): boolean {
    this.ensureOne();
    return (this as any).id === global.SUPERUSER_ID;
  }

  @api.model()
  async getCompanyCurrencyId() {
    return (await (await this.env.company()).currencyId).id;
  }

  /**
   * Passlib CryptContext instance used to encrypt and verify
        passwords. Can be overridden if technical, legal or political matters
        require different kdfs than the provided default.

        Requires a CryptContext as deprecation and upgrade notices are used
        internally
   * @returns 
   */
  _cryptContext() {
    return DEFAULT_CRYPT_CONTEXT;
  }

  async _read(fields: string[] = []) {
    await _super(Users, this)._read(fields);
    const canwrite = await this.checkAccessRights('write', false);
    if (!canwrite && _.intersection(USER_PRIVATE_FIELDS, fields).length) {
      for (const record of this) {
        for (const f in USER_PRIVATE_FIELDS) {
          try {
            record._cache.get(f);
            record._cache.set(f, '********');
          } catch (e) {
            // skip SpecialValue (e.g. for missing record or access right)
            // pass
          }
        }
      }
    }
  }

  async read(fields?: string[], load = '_classicRead'): Promise<Dict<any>[]> {
    let self: any = this;
    if (len(fields) && self.eq(await self.env.user())) {
      const readable = self.SELF_READABLE_FIELDS();
      let done = true;
      for (const key of fields) {
        if (!(readable.includes(key) || key.startsWith('context'))) {
          done = false;
          break;
        }
      }
      if (done) {
        // safe fields only, so we read as super-user to bypass access rights
        self = await self.sudo();
      }
    }

    return _super(Users, self).read(fields, load);
  }

  @api.model()
  async readGroup(domain, fields, groupby, options?: { offset?: number, limit?: number, orderby?: string, lazy?: true }) {
    const groupbyFields = (typeof groupby === 'string') ? [groupby] : groupby;
    if (_.intersection(groupbyFields, USER_PRIVATE_FIELDS).length) {
      throw new AccessError(await this._t("Invalid 'group by' parameter"));
    }
    return _super(Users, this).readGroup(domain, fields, groupby, options);
  }

  @api.model()
  async _search(args, options?: { offset?: 0, limit?: number, order?: string, count?: boolean, accessRightsUid?: any }) {
    if (!this.env.su && len(args)) {
      const domainFields = args.filter(term => Array.isArray(term)).map(term => term[0]);
      if (_.intersection(domainFields, USER_PRIVATE_FIELDS).length) {
        throw new AccessError(await this._t('Invalid search criterion'));
      }
    }
    return _super(Users, this)._search(args, options);
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const users = await _super(Users, this).create(valsList);

    for (const user of users) {
      // if partner is global we keep it that way
      const partnerId = await user.partnerId;
      if ((await partnerId.companyId).ok) {
        await partnerId.set('companyId', await user.companyId);
      }
      await partnerId.set('active', await user.active);
    }
    return users;
  }

  async write(values) {
    let self: any = this;
    if (values['active'] && self._ids.includes(global.SUPERUSER_ID))
      throw new UserError(await this._t("You cannot activate the superuser."))
    if (values['active'] === false && self._ids.includes(self._uid))
      throw new UserError(await this._t("You cannot deactivate the user you're currently logged in as."))

    if (values['active']) {
      for (const user of self) {
        const partnerId = await user.partnerId;
        if (!await user.active && !await partnerId.active)
          await partnerId.toggleActive();
      }
    }
    if (self.eq(await self.env.user())) {
      const writeable = self.SELF_WRITEABLE_FIELDS();
      let done = true;
      for (const key of Object.keys(values)) {
        if (!(writeable.includes(key) || key.startsWith('context'))) {
          done = false;
          break
        }
      }
      if (done) {
        if ('companyId' in values) {
          const companyIds = await (await self.env.user()).companyIds;
          if (!companyIds.ids.includes(values['companyId']))
            delete values['companyId'];
        }
        // safe fields only, so we write as super-user to bypass access rights
        self = await (await self.sudo()).withContext({ binaryFieldRealUser: await self.env.user() });
      }
    }
    const res = await _super(Users, self).write(values);
    if ('companyId' in values) {
      for (const user of self) {
        // if partner is global we keep it that way
        const partnerId = await user.partnerId;
        const companyId = await partnerId.companyId;
        if (companyId.ok && companyId.id != values['companyId']) {
          await partnerId.write({ 'companyId': companyId.id });
        }
      }
    }

    if ('companyId' in values || 'companyIds' in values) {
      // Reset lazy properties `company` & `companies` on all envs
      // This is unlikely in a business code to change the company of a user and then do business stuff
      // but in case it happens this is handled.
      // e.g. `account_test_savepoint.js` `setup_company_data`, triggered by `test_account_invoice_report.js`
      for (const env of self.env.transaction.envs) {
        if (self.contains(await env.user())) {
          lazy.resetAll(env);
        }
      }
    }

    // clear caches linked to the users
    if (self.ids && 'groupsId' in values) {
      // DLE P139: Calling invalidate_cache on a new, well you lost everything as you wont be able to take it back from the cache
      // `test_00_equipment_multicompany_user`
      await self.env.items('ir.model.access').callCacheClearingMethods();
    }
    // per-method / per-model caches have been removed so the various
    // clearCache/clearCaches methods pretty much just end up calling
    // Registry._clearCache
    const invalidationFields = [
      'groupsId', 'active', 'lang', 'tz', 'companyId',
      ...USER_PRIVATE_FIELDS,
      ...self._getSessionTokenFields()
    ]
    if (_.intersection(invalidationFields, Object.keys(values)).length || Object.keys(values).some(key => key.startsWith('context'))) {
      self.clearCaches();
    }
    return res;
  }

  @api.ondelete(true)
  async _unlinkExceptSuperuser() {
    if (this.ids.includes(global.SUPERUSER_ID)) {
      throw new UserError(await this._t('You can not remove the admin user as it is used internally for resources created by Verp (updates, module installation, ...)'));
    }
    this.clearCaches();
  }

  @api.model()
  async _nameSearch(name: string, args?: any, operator: string = 'ilike', { limit = 100, nameGetUid = false } = {}) {
    args = args || [];
    let userIds = [];
    let domain;
    if (!expression.NEGATIVE_TERM_OPERATORS.includes(operator)) {
      if (operator === 'ilike' && !(name || '').trim()) {
        domain = [];
      }
      else {
        domain = [['login', '=', name]];
      }
      userIds = await this._search(expression.AND([domain, args]), { limit: limit, accessRightsUid: nameGetUid });
    }
    if (!bool(userIds)) {
      userIds = await this._search(expression.AND([[['label', operator, name]], args]), { limit: limit, accessRightsUid: nameGetUid });
    }
    return userIds;
  }

  async copy(defaultValue?: any) {
    this.ensureOne();
    defaultValue = Object.assign({}, defaultValue ?? {});
    if (!('label' in defaultValue) && (!('partnerId' in defaultValue))) {
      defaultValue['label'] = await this._t("%s (copy)", await this['label']);
    }
    if (!('login' in defaultValue)) {
      defaultValue['login'] = await this._t("%s (copy)", await this['login']);
    }
    return _super(Users, this).copy(defaultValue);
  }

  @api.model()
  @tools.ormcache('self._uid')
  async contextGet() {
    const user = await this.env.user();
    // determine field names to read
    const nameToKey = new Dict<any>();
    for (const name of this._fields.keys()) {
      if (name.startsWith('context_') || ['lang', 'tz'].includes(name)) {
        nameToKey[name] = name.startsWith('context_') ? name.slice(8) : name
      }
    }
    // use read() to not read other fields: this must work while modifying
    // the schema of models res.users or res.partner
    const values = (await user.read(nameToKey.keys(), { load: false }))[0];
    return new FrozenDict<any>(nameToKey.items().map(([name, key]) => [key, values[name]])
    );
  }

  @api.model()
  async actionGet() {
    const sudo = await this.sudo();
    return (await sudo.env.ref('base.actionResUsersMy')).readOne();
  }


  async checkSuper(passwd) {
    return MetaDatebase.checkSuper(passwd);
  }

  @api.model()
  async _updateLastLogin() {
    // only create new records to avoid any side-effect on concurrent transactions
    //  extra records will be deleted by the periodical garbage collection
    await this.env.items('res.users.log').create({}); // populated by defaults
  }

  @api.model()
  async _getLoginDomain(login) {
    return [['login', '=', login]];
  }

  @api.model()
  _getLoginOrder() {
    return this.cls._order;
  }

  _getSessionTokenFields() {
    return ['id', 'login', 'password', 'active'];
  }

  async _computePassword() {
    for (const user of this) {
      await user.set('password', '');
      await user.set('newPassword', '');
    }
  }

  async _setNewPassword() {
    for (const user of this) {
      const newPassword = await user.newPassword;
      if (!newPassword) {
        // Do not update the password if no value is provided, ignore silently.
        // For example web client submits false values for all empty fields.
        continue;
      }
      if (user.eq(await this.env.user())) {
        // To change their own password, users must use the client-specific change password wizard,
        // so that the new password is immediately used for further RPC requests, otherwise the user
        // will face unexpected 'Access Denied' exceptions.
        throw new UserError(await this._t('Please use the change password wizard (in User Preferences or User menu) to change your own password.'));
      }
      else {
        await user.set('password', newPassword);
      }
    }
  }

  @api.depends('groupsId')
  async _computeShare() {
    const userGroupId = await this.env.items('ir.model.data')._xmlidToResId('base.groupUser');
    const internalUsers = await this.filteredDomain([['groupsId', 'in', [userGroupId]]]);
    await internalUsers.set('share', false);
    await this.sub(internalUsers).set('share', true);
  }

  async _computeCompaniesCount() {
    await this.set('companiesCount', await (await this.env.items('res.company').sudo()).searchCount([]));
  }

  @api.depends('tz')
  async _computeTzOffset() {
    const timestamp = new Date();
    for (const user of this) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      const userDate = DateTime.fromISO(timestamp.toISOString(), { zone: await user.tz || 'UTC', locale: locale }).toJSDate();
      const tzOffset = userDate.getTimezoneOffset();
      await user.set('tzOffset', (tzOffset >= 0 ? '+' : '-') + Math.abs(tzOffset).toString().padStart(4, '0'));
    }
  }

  @api.depends('groupsId')
  async _computeAccessesCount() {
    for (const user of this) {
      const groups = await user.groupsId;
      await user.set('accessesCount', len(await groups.modelAccess)),
      await user.set('rulesCount', len(await groups.ruleGroups)),
      await user.set('groupsCount', len(groups))
    }
  }

  @api.onchange('login')
  async onchangeLogin() {
    const login = await this['login'];
    if (login && singleEmailRe.test(login)) {
      await this.set('email', login);
    }
  }

  @api.onchange('parentId')
  async onchangeParentId() {
    return (await this['partnerId']).onchangeParentId();
  }

  @api.constrains('companyId', 'companyIds')
  async _checkCompany(fnames?: Dict<any>) {
    for (const user of this) {
      const [companyId, companyIds] = await user('companyId', 'companyIds');
      if (!companyIds.includes(companyId)) {
        throw new ValidationError(
          _f(await this._t('Company "{companyName}" is not in the allowed companies for user "{userName}" ({companyAllowed}).'), {
            companyName: await companyId.label,
            userName: await user.label,
            companyAllowed: (await user.mapped('companyIds.label')).join(', ')
          })
        )
      }
    }
  }

  @api.constrains('actionId')
  async _checkActionId() {
    const actionOpenWebsite = await this.env.ref('base.actionOpenWebsite', false);
    if (bool(actionOpenWebsite) && (await this.some(async (user) => (await user.actionId).id == actionOpenWebsite.id))) {
      throw new ValidationError(await this._t('The "App Switcher" action cannot be selected as home action.'));
    }
  }

  async toggleActive() {
    for (const user of this) {
      const [active, partnerId] = await user('active', 'partnerId');
      if (!active && ! await partnerId.active) {
        await partnerId.toggleActive();
      }
    }
    await _super(Users, this).toggleActive();
  }

  /**
   *  Compute a session token given a session id and a user id
   * @param sid 
   * @returns 
   */
  @tools.ormcache('sid')
  async _computeSessionToken(sid) {
    // retrieve the fields used to generate the session token
    const sessionFields = quoteList(this._getSessionTokenFields().sort(), (x) => `"${x}"`);
    const res = await this.env.cr.execute(
      `SELECT ${sessionFields}, (SELECT value FROM "irConfigParameter" WHERE key='database.secret')
      FROM "resUsers"
      WHERE id=${this.id}`);
    if (res.length != 1) {
      this.clearCaches();
      return false;
    }
    const dataFields = Object.values(res[0]);
    // generate hmac key
    const key = Buffer.from(`${dataFields}`, 'utf8');
    // hmac the session id
    const h = sha256(sid);

    // keep in the cache the token
    return h;
  }

  /**
   * Decides whether the user trying to log in is currently
    "on cooldown" and not even allowed to attempt logging in.

    The default cooldown function simply puts the user on cooldown for
    <login_cooldown_duration> seconds after each failure following the
    <login_cooldown_after>th (0 to disable).

    Can be overridden to implement more complex backoff strategies, or
    e.g. wind down or reset the cooldown period as the previous failure
    recedes into the far past.

    @param failures number of recorded failures (since last success)
    @param previous timestamp of previous failure
    @returns whether the user is currently in cooldown phase (true if cooldown, false if no cooldown and login can continue)
   */
  async _onLoginCooldown(failures, previous) {
    const cfg = await this.env.items('ir.config.parameter').sudo();
    const minFailures = tools.parseInt(await cfg.getParam('base.loginCooldownAfter', 5));
    if (minFailures == 0) {
      return false;
    }

    const delay = tools.parseInt(await cfg.getParam('base.loginCooldownDuration', 60));
    return failures >= minFailures && (Date.now() - previous) < Duration.fromObject({ seconds: delay }).milliseconds;
  }

  /**
   * Checks that the current environment even allows the current auth
    request to happen.

    The baseline implementation is a simple linear login cooldown: after
    a number of failures trying to log-in, the user (by login) is put on
    cooldown. During the cooldown period, login *attempts* are ignored
    and logged.

    .. warning::

        The login counter is not shared between workers and not
        specifically thread-safe, the feature exists mostly for
        rate-limiting on large number of login attempts (brute-forcing
        passwords) so that should not be much of an issue.

        For a more complex strategy (e.g. database or distribute storage)
        override this method. To simply change the cooldown criteria
        (configuration, ...) override _onLoginCooldown instead.

    .. note::

        This is a *context manager* so it can be called around the login
        procedure without having to call it itself.
   * @returns 
   */
  @context.contextmanager()
  async _assertCanAuth(req?: any, func?: Function) {
    // needs request for remote address
    if (!req) {
      if (isCallable(func)) {
        await func();
      }
      return;
    }

    const reg = this.env.registry;
    let failuresMap = getattr(reg, '_loginFailures', null);
    if (failuresMap === null) {
      failuresMap = new DefaultDict(); // () => [0, _Date.min]; 
      reg._loginFailures = failuresMap;
    }

    const source = req.socket.remoteAddress;
    reg._loginFailures[source] = reg._loginFailures[source] ?? [0, new Date(-8640000000000000)]
    //  which is Tuesday, April 20th, 271,821 BCE (BCE = Before Common Era, e.g., the year -271,821).
    const [failures, previous] = reg._loginFailures[source];
    if (await this._onLoginCooldown(failures, previous)) {
      console.warn(`
          Login attempt ignored for %s on %s: 
          %s failures since last success, last failure at %s. 
          You can configure the number of login failures before a 
          user is put on cooldown as well as the duration in the 
          System Parameters. Disable this feature by setting 
          \"base.login_cooldown_after\" to 0.`,
        source, this.env.cr.dbName, failures, previous);
      if (ipaddress.ipAddress(source).isPrivate) {
        console.warn(`
          The rate-limited IP address %s is classified as private 
          and *might* be a proxy. If your Verp is behind a proxy, 
          it may be mis-configured. Check that you are running 
          Verp in Proxy Mode and that the proxy is properly configured, see 
          https://www.theverp.com/documentation/1.0/administration/install/deploy.html#https for details.`,
          source
        )
      }
      throw new AccessDenied(await this._t("Too many login failures, please wait a bit before trying again."));
    }
    try {
      if (isCallable(func)) {
        const result = await func();
        return result;
      }
    } catch (e) {
      if (isInstance(e, AccessDenied)) {
        const [failures, __] = reg._loginFailures[source];
        reg._loginFailures[source] = [failures + 1, Date.now()]
        throw e;
      }
      else {
        reg._loginFailures.pop(source, null);
      }
    }
  }

  async _registerHook() {
    if (hasattr(this, 'checkCredentials')) {
      console.warn("The check_credentials method of res.users has been renamed _check_credentials. One of your installed modules defines one, but it will not be called anymore.");
    }
  }

  /**
   * If an MFA method is enabled, returns its type as a string.
   * @returns 
   */
  async _mfaType() {
    return;
  }

  /**
   * If an MFA method is enabled, returns the URL for its second step.
   * @returns 
   */
  async _mfaUrl() {
    return;
  }
}

@MetaModel.define()
class GroupsImplied extends Model {
  static _module = module;
  static _parents = "res.groups";
  static _description = "Groups Implied";

  static impliedIds = Fields.Many2many('res.groups', {
    relation: 'resGroupsImpliedRel', column1: 'gid', column2: 'hid',
    string: 'Inherits', help: 'Users of this group automatically inherit those groups'
  });
  static transImpliedIds = Fields.Many2many('res.groups', { string: 'Transitively inherits', compute: '_computeTransImplied', recursive: true });

  @api.depends('impliedIds.transImpliedIds')
  async _computeTransImplied() {
    // Compute the transitive closure recursively. Note that the performance is good, because the record cache behaves as a memo (the field is never computed twice on a given group.)
    for (const g of this) {
      const impliedIds = await g.impliedIds;
      const transImpliedIds = await impliedIds.transImpliedIds;
      await g.set('transImpliedIds', impliedIds.or(transImpliedIds));
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    const userIdsList = valsList.map(vals => vals.pop('users', null));
    const groups = await _super(GroupsImplied, this).create(valsList);
    for (const [group, userIds] of _.zip<ModelRecords, any>([...groups], userIdsList)) {
      if (len(userIds)) {
        // delegate addition of users to add implied groups
        await group.write({ 'users': userIds });
      }
    }
    return groups;
  }

  async write(values) {
    const res = await _super(GroupsImplied, this).write(values);
    if (values['users'] || values['impliedIds']) {
      // add all implied groups (to all users of each group)
      const self: any = this;
      for (const group of self) {
        await self._cr.execute(`
          WITH RECURSIVE "groupImply"(gid, hid) AS (
              SELECT gid, hid
                FROM "resGroupsImpliedRel"
              UNION
              SELECT i.gid, r.hid
                FROM "resGroupsImpliedRel" r
                JOIN "groupImply" i ON (i.hid = r.gid)
          )
          INSERT INTO "resGroupsUsersRel" (gid, uid)
              SELECT i.hid, r.uid
                FROM "groupImply" i, "resGroupsUsersRel" r
                WHERE r.gid = i.gid
                  AND i.gid = ${group.id}
              EXCEPT
              SELECT r.gid, r.uid
                FROM "resGroupsUsersRel" r
                JOIN "groupImply" i ON (r.gid = i.hid)
                WHERE i.gid = ${group.id}
        `);
      }
      await self._checkOneUserType();
    }
    return res;
  }

  /**
   * Add the given group to the groups implied by the current group
   * @param impliedGroup the implied group to add
   */
  async _applyGroup(impliedGroup) {
    const groups = await this.filtered(async (g) => !(await g.impliedIds).contains(impliedGroup));
    await groups.write({ 'impliedIds': [Command.link(impliedGroup.id)] });
  }

  /**
   * Remove the given group from the implied groups of the current group
   * @param impliedGroup the implied group to remove
   */
  async _removeGroup(impliedGroup) {
    const groups = await this.filtered(async (g) => (await g.impliedIds).contains(impliedGroup));
    if (groups.ok) {
      await groups.write({ 'impliedIds': [Command.unlink(impliedGroup.id)] });
      const users = await groups.users;
      if (users.ok) {
        await impliedGroup.write({ 'users': users.map(user => Command.unlink(user.id)) });
      }
    }
  }
}

@MetaModel.define()
class UsersImplied extends Model {
  static _module = module;
  static _parents = 'res.users';

  @api.modelCreateMulti()
  async create(valsList) {
    for (const values of valsList) {
      if ('groupsId' in values) {
        // complete 'groupsId' with implied groups
        const user = await this.new(values);
        let gs = (await user.groupsId)._origin;
        gs = gs.or(await gs.transImpliedIds);
        values['groupsId'] = await this.cls._fields['groupsId'].convertToWrite(gs, user);
      }
    }
    return _super(UsersImplied, this).create(valsList);
  }

  async write(values) {
    const usersBefore = await this.filtered(async (u) => await u.hasGroup('base.groupUser'));
    const res = await _super(UsersImplied, this).write(values);
    if (values['groupsId']) {
      // add implied groups for all users
      for (const user of this) {
        if (! await user.hasGroup('base.groupUser') && usersBefore.includes(user)) {
          // if we demoted a user, we strip him of all its previous privileges (but we should not do it if we are simply adding a technical group to a portal user)
          const vals = { 'groupsId': [Command.clear()] + values['groupsId'] }
          await _super(UsersImplied, user).write(vals);
        }
        const gs = this.env.items('res.groups');
        for (const g of await user.groupsId) {
          const transImpliedIds = await g.transImpliedIds;
          gs.concat(transImpliedIds);
        } // gs = set(concat(g.transImpliedIds for g in user.groupsId))
        const groupsId = [];
        for (const g of gs) {
          groupsId.push(Command.link(g.id));
        }
        const vals = { 'groupsId': groupsId };
        await _super(UsersImplied, user).write(vals);
      }
    }
    return res;
  }
}

@MetaModel.define()
class GroupsView extends Model {
  static _module = module;
  static _parents = "res.groups";
  static _description = "Groups View";

  @api.model()
  async create(values) {
    const user = await _super(GroupsView, this).create(values);
    await this._updateUserGroupsView();
    this.env.items('ir.actions.actions').clearCaches();
    return user;
  }

  async write(values) {
    // determine which values the "user groups view" depends on
    const VIEW_DEPS = ['categoryId', 'impliedIds'];
    const viewValues0 = [];
    for (const name of VIEW_DEPS) {
      if (name in values) {
        for (const g of this) {
          viewValues0.push(await g[name]);
        }
      }
    }
    const res = await _super(GroupsView, this).write(values);
    // update the "user groups view" only if necessary
    const viewValues1 = [];
    for (const name of VIEW_DEPS) {
      if (name in values) {
        for (const g of this) {
          viewValues0.push(await g[name]);
        }
      }
    }
    if (_.difference(viewValues0, viewValues1).length) {
      await this._updateUserGroupsView();
    }
    this.env.items('ir.actions.actions').clearCaches();
    return res;
  }

  async unlink() {
    const res = await _super(GroupsView, this).unlink();
    await this._updateUserGroupsView();
    this.env.items('ir.actions.actions').clearCaches();
    return res;
  }

  /**
   * Modify the view with xmlid ``base.userGroupsView``, which inherits the user form view, and introduces the reified group Fields.
   */
  async _updateUserGroupsView() {
    const self: any = await this.withContext({ lang: null });
    const view = await self.env.ref('base.userGroupsView', false);
    if (!(view && bool(await view.exists()) && view.cls._name === 'ir.ui.view')) {
      return;
    }

    let xml: Element;
    if (self._context['installFilename'] || self._context[MODULE_UNINSTALL_FLAG]) {
      xml = E.field({ name: "groupsId", position: "after" });
    }
    else {
      const groupNoOne = await view.env.ref('base.groupNoOne');
      const groupEmployee = await view.env.ref('base.groupUser')
      const xml1 = [];
      const xml2 = [];
      const xml3 = [];
      const xmlByCategory = new Map<any, any>();
      xml1.push(E.separator({ string: 'User Type', colspan: "2", groups: 'base.groupNoOne' }));

      let userTypeAttrs;
      let userTypeFieldName = "";
      let userTypeReadonly = "{}";
      const groupsByApps = await self.getGroupsByApplication();
      const sortedTuples = await sortedAsync(groupsByApps, async (t) => await t[0].xmlid !== 'base.category_userType');
      for (const [app, kind, gs, categoryName] of sortedTuples) {
        const xmlid = await app.xmlid;
        const attrs = {};
        const _hiddenExtraCategories: string[] = self._getHiddenExtraCategories();
        if (_hiddenExtraCategories.includes(xmlid)) {
          attrs['groups'] = 'base.groupNoOne';
        }
        if (xmlid === 'base.category_userType') {
          // application name with a selection field
          const fieldName = nameSelectionGroups(gs.ids);
          userTypeFieldName = fieldName;
          userTypeReadonly = `{'readonly': [['${userTypeFieldName}', '!=', ${groupEmployee.id}]]}`;
          attrs['widget'] = 'radio';
          attrs['groups'] = 'base.groupNoOne';
          xml1.push(E.field({ name: fieldName, ...attrs }));
          xml1.push(E.newline());
        }
        else if (kind === 'selection') {
          const fieldName = nameSelectionGroups(gs.ids);
          attrs['attrs'] = userTypeReadonly;
          let cat = xmlByCategory.get(categoryName);
          if (cat == undefined) {
            cat = []
            xmlByCategory.set(categoryName, cat);
            cat.push(E.newline());
          }
          cat.push(E.field({ name: fieldName, ...attrs }));
          cat.push(E.newline());
        }
        else {
          // application separator with boolean fields
          const appName = await app.label || 'Other';
          xml3.push(E.withType('separator', { string: appName, colspan: "4", ...attrs }));
          attrs['attrs'] = userTypeReadonly;
          for (const g of gs) {
            const fieldName = nameBooleanGroup(g.id);
            if (g.eq(groupNoOne)) {
              // make the groupNoOne invisible in the form view
              xml3.push(E.field({ name: fieldName, invisible: "1", ...attrs }));
            }
            else {
              xml3.push(E.field({ name: fieldName, ...attrs }));
            }
          }
        }
      }

      xml3.push({ 'class': "o-label-nowrap" });
      if (userTypeFieldName) {
        userTypeAttrs = `{'invisible': [['${userTypeFieldName}', '!=', ${groupEmployee.id}]]}`;
      }
      else {
        userTypeAttrs = "{}";
      }

      for (const xmlCat of sorted(Object.keys(xmlByCategory), (it) => it[0])) {
        const masterCategoryName = xmlCat[1];
        xml2.push(E.group({ ...xmlByCategory[xmlCat], col: "2", string: masterCategoryName }));
      }

      xml = E.field({ name: "groupsId", position: "replace" });
      xml.appendChild(E.group(xml1, { col: "2" }));
      xml.appendChild(E.group(xml2, { col: "2", attrs: userTypeAttrs }));
      xml.appendChild(E.group(xml3, { col: "4", attrs: userTypeAttrs }));
      xml.parentNode.insertBefore(xml.ownerDocument.createComment('GENERATED AUTOMATICALLY BY GROUPS'), xml);
    }
    const xmlContent = serializeXml(xml);
    if (xmlContent !== await view.arch) {       // avoid useless xml validation if no change
      const newContext = new Dict(view._context);
      newContext.pop('installFilename', null);  // don't set arch_fs for this computed view
      newContext['lang'] = null;
      await (await view.withContext(newContext)).write({ 'arch': xmlContent })
    }
  }

  _getHiddenExtraCategories() {
    return ['base.category_hidden', 'base.category_extra', 'base.category_usability'];
  }

  /**
   * Return all groups classified by application (module category), as a list::
        [[app, kind, groups], ...],
    where ``app`` and ``groups`` are recordsets, and ``kind`` is either
    ``'boolean'`` or ``'selection'``. Applications are given in sequence order.  If ``kind`` is ``'selection'``, ``groups`` are given in reverse implication order.
   */
  @api.model()
  async getGroupsByApplication() {
    async function linearize(app, gs: ModelRecords, categoryName) {
      const xmlid = await app.xmlid;
      if (xmlid === 'base.category_userType') {
        return [app, 'selection', await gs.sorted((g) => g.id), categoryName];
      }
      const order = new Dict<any>();
      for (const g of gs) {
        let gt = await g.transImpliedIds;
        gt = gt.and(gs);
        order.set(g.id, gt._length);
      }
      if (xmlid === 'base.category_accountingAccounting') {
        return [app, 'selection', await gs.sorted((g) => order.get(g.id)), categoryName];
      }
      if (Object.values(order).length == gs._length) {
        return [app, 'selection', await gs.sorted((g) => order.get(g.id)), categoryName];
      }
      else {
        return [app, 'boolean', gs, [100, 'Other']];
      }
    }
    const byApp = new Dict<any>();
    let others = this.browse();
    const appGroups = await this.getApplicationGroups([]);
    for (const g of appGroups) {
      const category = await g.categoryId;
      if (category.ok) {
        const id = category.id;
        if (!byApp[id]) {
          byApp[id] = [await category.sequence, category, this.browse()];
        }
        byApp[id][2] = byApp[id][2].add(g);
      }
      else {
        others = others.add(g);
      }
    }
    const res = [];
    for (const [, app, gs] of sorted(byApp.values(), (it) => it[0] || 0)) {
      const parentId = await app.parentId;
      if (parentId.ok) {
        res.push(await linearize(app, gs, [await parentId.sequence, await parentId.label]))
      }
      else {
        res.push(await linearize(app, gs, [100, 'Other']));
      }
    }
    if (others.ok) {
      res.push([this.env.items('ir.module.category'), 'boolean', others, [100, 'Other']]);
    }
    return res;
  }

  /**
   * Return the non-share groups that satisfy ``domain``.
   * @param domain 
   */
  async getApplicationGroups(domain) {
    return this.search(domain.concat([['share', '=', false]]));
  }
}

@MetaModel.define()
class ModuleCategory extends Model {
  static _module = module;
  static _parents = "ir.module.category";

  async write(values) {
    const res = await _super(ModuleCategory, this).write(values);
    if ("label" in values) {
      await this.env.items("res.groups")._updateUserGroupsView();
    }
    return res;
  }

  async unlink() {
    const res = await _super(ModuleCategory, this).unlink();
    await this.env.items("res.groups")._updateUserGroupsView();
    return res;
  }
}

@MetaModel.define()
class UsersView extends Model {
  static _module = module;
  static _parents = 'res.users';

  @api.modelCreateMulti()
  async create(valsList) {
    const newValsList = []
    for (const values of valsList) {
      newValsList.push(await this._removeReifiedGroups(values));
    }
    const users = await _super(UsersView, this).create(newValsList);
    const groupMultiCompanyId = await this.env.items('ir.model.data')._xmlidToResId('base.groupMultiCompany', false);
    if (groupMultiCompanyId) {
      for (const user of users) {
        if (len(await user.companyIds) <= 1 && (await user.groupsId).ids.includes(groupMultiCompanyId)) {
          await user.write({ 'groupsId': [Command.unlink(groupMultiCompanyId)] });
        }
        else if (len(await user.companyIds) > 1 && !(await user.groupsId).ids.incudes(groupMultiCompanyId)) {
          await user.write({ 'groupsId': [Command.link(groupMultiCompanyId)] });
        }
      }
    }
    return users;
  }

  async write(values) {
    values = await this._removeReifiedGroups(values);
    const res = await _super(UsersView, this).write(values);
    if (!('companyIds' in values)) {
      return res;
    }
    const groupMultiCompany = await this.env.ref('base.groupMultiCompany', false);
    if (bool(groupMultiCompany)) {
      for (const user of this) {
        if (len(await user.companyIds) <= 1 && (await groupMultiCompany.users).ids.includes(user.id)) {
          await user.write({ 'groupsId': [Command.unlink(groupMultiCompany.id)] });
        }
        else if (len(await user.companyIds) > 1 && !(await groupMultiCompany.users).ids.includes(user.id)) {
          await user.write({ 'groupsId': [Command.link(groupMultiCompany.id)] });
        }
      }
    }
    return res;
  }

  @api.model()
  async new(values = {}, options: { origin?: any, ref?: any } = {}) {
    values = await this._removeReifiedGroups(values);
    const user = await _super(UsersView, this).new(values, options);
    const groupMultiCompany = await this.env.ref('base.groupMultiCompany', false);
    if (groupMultiCompany && 'companyIds' in values) {
      if (len(await user.companyIds) <= 1 && (await groupMultiCompany.users).ids.includes(user.id)) {
        await user.update({ 'groupsId': [Command.unlink(groupMultiCompany.id)] });
      }
      else if (len(await user.companyIds) > 1 && !(await groupMultiCompany.users).ids.includes(user.id)) {
        await user.update({ 'groupsId': [Command.link(groupMultiCompany.id)] });
      }
    }
    return user;
  }

  /**
   * return `values` without reified group fields
   * @param values 
   * @returns 
   */
  async _removeReifiedGroups(values: {} = {}) {
    const add = [];
    const rem = [];
    const values1 = {};

    for (const [key, val] of Object.entries(values)) {
      if (isBooleanGroup(key)) {
        (val ? add : rem).push(getBooleanGroup(key));
      }
      else if (isSelectionGroups(key)) {
        extend(rem, getSelectionGroups(key));
        if (val) {
          add.push(val);
        }
      }
      else {
        values1[key] = val;
      }
    }

    if (!('groupsId' in values) && (add.length || rem.length)) {
      // remove group ids in `rem` and add group ids in `add`
      values1['groupsId'] = Array.from(chain(
        _.zip<any, any>([...repeat(3, rem.length)], rem || []),
        _.zip<any, any>([...repeat(4, add.length)], add || [])
      ));
    }

    return values1;
  }

  @api.model()
  async defaultGet(fields) {
    let groupFields;
    [groupFields, fields] = partition((e) => isReifiedGroup(e), fields);
    const fields1 = groupFields.length ? fields.concat(['groupsId']) : fields;
    const values = await _super(UsersView, this).defaultGet(fields1);
    await this._addReifiedGroups(groupFields, values);
    return values;
  }

  async onchange(values, fieldName, fieldOnchange) {
    fieldOnchange['groupsId'] = '';
    const result = await _super(UsersView, this).onchange(values, fieldName, fieldOnchange);
    if (!fieldName) { // merged defaultGet
      await this._addReifiedGroups(
        fieldOnchange.filter(e => isReifiedGroup(e)),
        result.setdefault('value', {})
      );
    }
    return result;
  }

  async read(fields?: string[], load: string = '_classicRead'): Promise<Dict<any>[]> {
    // determine whether reified groups fields are required, and which ones
    const fields1 = fields || Array.from(await this.fieldsGet());
    let [groupFields, otherFields] = partition((e) => isReifiedGroup(e), fields1);

    // read regular fields (otherFields); add 'groupsId' if necessary
    let dropGroupsId = false;
    if (groupFields.length && fields.length) {
      if (!otherFields.includes('groupsId')) {
        otherFields.push('groupsId');
        dropGroupsId = true;
      }
    }
    else {
      otherFields = fields;
    }

    const res = await _super(UsersView, this).read(otherFields, load);

    // post-process result to add reified group fields
    if (groupFields.length) {
      for (const values of res) {
        this._addReifiedGroups(groupFields, values);
        if (dropGroupsId) {
          pop(values, 'groupsId', null);
        }
      }
    }
    return res;
  }

  @api.model()
  async readGroup(domain, fields, groupby, options: { offset?: number, limit?: number, orderby?: any, lazy?: boolean } = {}) {
    setOptions(options, { offset: 0, orderby: false, lazy: true });
    if (fields) {
      // ignore reified fields
      fields = fields.filter(fname => !isReifiedGroup(fname));
    }
    return _super(UsersView, this).readGroup(domain, fields, groupby, options);
  }

  /**
   * add the given reified group fields into `values`
   * @param fields 
   * @param values 
   */
  async _addReifiedGroups(fields, values) {
    const gids = new Set(parseM2m(values['groupsId'] ?? []));
    for (const f of fields) {
      if (isBooleanGroup(f)) {
        values[f] = gids.has(getBooleanGroup(f));
      }
      else if (isSelectionGroups(f)) {
        // determine selection groups, in order
        let selGroups = (await this.env.items('res.groups').sudo()).browse(getSelectionGroups(f));
        const selOrder = {}
        for (const g of selGroups) {
          selOrder[g] = len((await g.transImpliedIds).and(selGroups))
        }
        selGroups = await selGroups.sorted((k) => selOrder[k]);
        // determine which ones are in gids
        const selected = selGroups.ids.filter(gid => gids.has(gid));
        // if 'Internal User' is in the group, this is the "User Type" group
        // and we need to show 'Internal User' selected, not Public/Portal.
        if (selected.includes((await this.env.ref('base.groupUser')).id)) {
          values[f] = (await this.env.ref('base.groupUser')).id;
        }
        else {
          values[f] = selected && selected.slice(-1)[0];
          values[f] = values[f] ? values[f] : false;
        }
      }
    }
  }

  @api.model()
  async fieldsGet(allfields?: any, attributes?: any) {
    if (allfields && !Array.isArray(allfields)) {
      allfields = Object.keys(allfields);
    }
    const res = await _super(UsersView, this).fieldsGet(allfields, attributes);
    // add reified groups fields
    for (const [app, kind, gs, categoryName] of await (await this.env.items('res.groups').sudo()).getGroupsByApplication()) {
      if (kind === 'selection') {
        // 'User Type' should not be 'false'. A user is either 'employee', 'portal' or 'public' (required).
        let selectionVals = [[false, '']];
        if (app.xmlid === 'base.category_userType') {
          selectionVals = [];
        }
        const fieldName = nameSelectionGroups(gs.ids);
        if (allfields && !allfields.includes(fieldName)) {
          continue;
        }
        // selection group field
        const tips = []
        for (const g of gs) {
          if (await g.comment) {
            tips.push(f('%s: %s', await g.label, await g.comment));
          }
        }
        res[fieldName] = {
          'type': 'selection',
          'string': await app.label || await this._t('Other'),
          'selection': gs.forEach(g => selectionVals.push([g.id, g.label])),
          'help': tips.join('\n'),
          'exportable': false,
          'selectable': false,
        }
      }
      else {
        // boolean group fields
        for (const g of gs) {
          const fieldName = nameBooleanGroup(g.id);
          if (bool(allfields) && allfields.includes(fieldName)) {
            continue;
          }
          res[fieldName] = {
            'type': 'boolean',
            'string': await g.label,
            'help': await g.comment,
            'exportable': false,
            'selectable': false,
          }
        }
      }
    }
    return res;
  }
}

/**
 * Wizard used to re-check the user's credentials (password)

    Might be useful before the more security-sensitive operations, users might be
    leaving their computer unlocked & unattended. Re-checking credentials mitigates
    some of the risk of a third party using such an unattended device to manipulate
    the account.
 */
@MetaModel.define()
class CheckIdentity extends TransientModel {
  static _module = module;
  static _name = 'res.users.identitycheck';
  static _description = "Password Check Wizard";

  static request = Fields.Char({ readonly: true, groups: NO_ACCESS });
  static password = Fields.Char();

  async runCheck() {
    const req = this.env.req;
    assert(req, "This method can only be accessed over HTTP");
    try {
      await (await this['createdUid'])._checkCredentials(await this['password'], { 'interactive': true });
    } catch (e) {
      if (isInstance(e, AccessDenied)) {
        throw new UserError(await this._t("Incorrect Password, try again or click on Forgot Password to reset your password."));
      }
      throw e;
    }

    await this.set('password', false);

    req.session['identity-check-last'] = new Date();
    let { ctx, model, ids, method } = JSON.parse(await (await this.sudo()).request);
    const self = (await this.env.change({ context: ctx })).items(model).browse(ids);
    method = self[method];
    assert(getattr(method, '__hasCheckIdentity', false));
    return method.call(self);
  }
}

/**
 * A wizard to manage the change of users' passwords.
 */
@MetaModel.define()
class ChangePasswordWizard extends TransientModel {
  static _module = module;
  static _name = "change.password.wizard";
  static _description = "Change Password Wizard";

  static userIds = Fields.One2many('change.password.user', 'wizardId', { string: 'Users', default: async (self) => await self._defaultUserIds() });

  async _defaultUserIds() {
    const userIds = this._context['activeModel'] === 'res.users' && bool(this._context['activeIds']) ? this._context['activeIds'] : [];
    return this.env.items('res.users').browse(userIds).map(async (user) => Command.create({ 'userId': user.id, 'userLogin': await user.login }));
  }

  async changePasswordButton() {
    this.ensureOne();
    const userIds = await this['userIds'];
    await userIds.changePasswordButton();
    if ((await userIds.userId).includes(await this.env.user())) {
      return { 'type': 'ir.actions.client', 'tag': 'reload' };
    }
    return { 'type': 'ir.actions.actwindow.close' };
  }
}

/**
 * A model to configure users in the change password wizard.
 */
@MetaModel.define()
class ChangePasswordUser extends TransientModel {
  static _module = module;
  static _name = 'change.password.user';
  static _description = 'User, Change Password Wizard';

  static wizardId = Fields.Many2one('change.password.wizard', { string: 'Wizard', required: true, ondelete: 'CASCADE' });
  static userId = Fields.Many2one('res.users', { string: 'User', required: true, ondelete: 'CASCADE' });
  static userLogin = Fields.Char({ string: 'User Login', readonly: true });
  static newPasswd = Fields.Char({ string: 'New Password', default: '' });

  async changePasswordButton() {
    for (const line of this) {
      if (! await line.newPasswd) {
        throw new UserError(await this._t("Before clicking on 'Change Password', you have to write a new password."));
      }
      await (await line.userId).write({ 'password': await line.newPasswd });
    }
    // don't keep temporary passwords in the database longer than necessary
    await this.write({ 'newPasswd': false });
  }
}

// API keys support
const API_KEY_SIZE = 20; // in bytes
const INDEX_SIZE = 8;    // in hex digits, so 4 bytes, or 20% of the key
const KEY_CRYPT_CONTEXT = new context.CryptContext(
  // default is 29000 rounds which is 25~50ms, which is probably unnecessary
  // given in this case all the keys are completely random data: dictionary
  // attacks on API keys isn't much of a concern
  ['pbkdf2_sha512'], { pbkdf2_sha512__rounds: 6000 },
)

@MetaModel.define()
class APIKeysUser extends Model {
  static _module = module;
  static _parents = 'res.users';
  static _description = 'res.users.apikeys.user';

  static apiKeyIds = Fields.One2many('res.users.apikeys', 'userId', { string: "API Keys" });

  /**
   * To be overridden if RPC access needs to be restricted to API keys, e.g. for 2FA
   * @returns 
   */
  async _rpcApiKeysOnly() {
    return false;
  }

  async _checkCredentials(password, userAgentEnv) {
    userAgentEnv = userAgentEnv || {};
    if (userAgentEnv['interactive'] ?? true) {
      if (!('interactive' in userAgentEnv)) {
        console.warn(
          `_checkCredentials without 'interactive' env key, assuming interactive login. \n
          Check calls and overrides to ensure the 'interactive' key is properly set in \n
          all _checkCredentials environments`
        )
      }
      return _super(APIKeysUser, this)._checkCredentials(password, userAgentEnv);
    }

    if (!await (await this.env.user())._rpcApiKeysOnly()) {
      try {
        const res = await _super(APIKeysUser, this)._checkCredentials(password, userAgentEnv);
        return res;
      } catch (e) {
        if (!isInstance(e, AccessDenied)) {
          throw e;
        }
      }
    }
    // 'rpc' scope does not really exist, we basically require a global key (scope NULL)
    if (this.env.items('res.users.apikeys')._checkCredentials('rpc', password) == this.env.uid) {
      return;
    }
    throw new AccessDenied();
  }

  @checkIdentity()
  async apiKeyWizard() {
    return {
      'type': 'ir.actions.actwindow',
      'resModel': 'res.users.apikeys.description',
      'label': 'New API Key',
      'target': 'new',
      'views': [[false, 'form']],
    }
  }
}

@MetaModel.define()
class APIKeys extends Model {
  static _module = module;
  static _name = 'res.users.apikeys';
  static _description = 'res.users.apikeys';
  static _auto = false; // so we can have a secret column

  static label = Fields.Char("Description", { required: true, readonly: true });
  static userId = Fields.Many2one('res.users', { index: true, required: true, readonly: true, ondelete: "CASCADE" });
  static scope = Fields.Char("Scope", { readonly: true });
  static createdAt = Fields.Datetime("Creation Date", { readonly: true });

  async init() {
    await this.env.cr.execute(`
    CREATE TABLE IF NOT EXISTS "${this.cls._table}" (
      id serial primary key,
      "label" varchar not null,
      "userId" integer not null REFERENCES "resUsers"(id),
      scope varchar,
      index varchar(${INDEX_SIZE}) not null CHECK (char_length(index) = ${INDEX_SIZE}),
      key varchar not null,
      "createdAt" timestamp without time zone DEFAULT (now() at time zone 'utc')
    )`);

    let indexName = this.cls._table + "_userId_idx"
    if (len(indexName) > 63) {
      // unique determinist index name
      indexName = this.cls._table.slice(0, 50) + "_idx_" + sha256(this.cls._table).slice(0, 8)
    }
    await this.env.cr.execute(`
      CREATE INDEX IF NOT EXISTS "${indexName}" ON "${this.cls._table}" ("userId", index);
    `);
  }

  @checkIdentity()
  async remove() {
    return this._remove();
  }

  /**
   * Use the remove() method to remove an API Key. This method implement logic, but won't check the identity (mainly used to remove trusted devices)
   * @returns 
   */
  async _remove() {
    if (!this.ok) {
      return { 'type': 'ir.actions.actwindow.close' }
    }
    if (await this.env.isSystem() || (await this.mapped('userId')).eq(await this.env.user())) {
      const ip = this.env.req ? this.env.req.socket.remoteAddress : 'n/a';
      console.info("API key(s) removed: scope: <%s> for '%s' (#%s) from %s", await this.mapped('scope'), await (await this.env.user()).login, this.env.uid, ip);
      await (await this.sudo()).unlink();
      return { 'type': 'ir.actions.actwindow.close' };
    }
    throw new AccessError(await this._t("You can not remove API keys unless they're yours or you are a system user"))
  }

  async _checkCredentials(scope, testKey: string) {
    assert(scope, "scope is required");
    let index = testKey.slice(0, INDEX_SIZE);
    const res = await this.env.cr.execute(`
      SELECT "userId", key
      FROM "${this.cls._table}" INNER JOIN "resUsers" u ON (u.id = "userId")
      WHERE u.active and index = %s AND (scope IS NULL OR scope = %s)
    `, [index, scope]);
    for (const { userId, key } of res) {
      if (KEY_CRYPT_CONTEXT.verify(testKey, key)) {
        return userId;
      }
    }
  }

  /**
   * Generates an api key.
   *
   * @param scope the scope of the key. If None, the key will give access to any rpc.
   * @param name the name of the key, mainly intended to be displayed in the UI.
   * @returns the key.
   */
  async _generate(scope, name) {
    // no need to clear the LRU when *adding* a key, only when removing
    const k = Number(urandom(API_KEY_SIZE)).toString(16);
    const iv = crypto.randomBytes(16);
    await this.env.cr.execute(_f(`
        INSERT INTO {table} (name, "userId", scope, key, index)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `, { table: this.cls._table }),
      [name, (await this.env.user()).id, scope, crypto.createDecipheriv('pbkdf2_sha512', Buffer.from(k), iv), k.slice(0, INDEX_SIZE)]);

    const ip = this.env.req ? this.env.req.socket.remoteAddress : 'n/a';
    console.info("%s generated: scope: <%s> for '%s' (#%s) from %s", this.cls._description, scope, await (await this.env.user()).login, this.env.uid, ip);

    return k;
  }
}

@MetaModel.define()
class APIKeyDescription extends TransientModel {
  static _module = module;
  static _name = 'res.users.apikeys.description';
  static _description = 'res.users.apikeys.description';

  static label = Fields.Char("Description", { required: true });

  @checkIdentity()
  async makeKey(): Promise<any> {
    // only create keys for users who can delete their keys
    await this.checkAccessMakeKey();

    const description = await this.sudo();
    const k = await this.env.items('res.users.apikeys')._generate(null, await description.label);
    await description.unlink();

    return {
      'type': 'ir.actions.actwindow',
      'resModel': 'res.users.apikeys.show',
      'label': 'API Key Ready',
      'views': [[false, 'form']],
      'target': 'new',
      'context': {
        'default_key': k,
      }
    }
  }

  async checkAccessMakeKey() {
    if (! await this.userHasGroups('base.groupUser')) {
      throw new AccessError(await this._t("Only internal users can create API keys"));
    }
  }
}

@MetaModel.define()
class APIKeyShow extends AbstractModel {
  static _module = module;
  static _name = 'res.users.apikeys.show';
  static _description = 'res.users.apikeys.show';

  // the field 'id' is necessary for the onchange that returns the value of 'key'
  static id = Fields.Id();
  static key = Fields.Char({ readonly: true });
}