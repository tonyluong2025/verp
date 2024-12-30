
import { http } from "../../../core";
import { AccessError } from "../../../core/helper/errors";
import { WebRequest } from "../../../core/http";
import { isSubclass } from "../../../core/models";
import { expression } from "../../../core/osv";
import { Forbidden, NotFound } from "../../../core/service";
import { urlEncode, urlParse } from "../../../core/service/middleware/utils";
import { bool } from "../../../core/tools/bool";
import { isInstance } from "../../../core/tools/func";
import { plaintext2html } from "../../../core/tools/mail";
import { consteq, pop, setOptions, update } from "../../../core/tools/misc";
import * as mail from '../../mail';


async function _checkSpecialAccess(req: WebRequest, resModel, resId, token = '', hash = '', pid = false) {
  const env = await req.getEnv();
  const record = await env.items(resModel).browse(resId).sudo();
  if (hash && pid) {  // Signed Token Case: hash implies token is signed by partner pid
    return consteq(hash, await record._signToken(pid));
  }
  else if (token) {  // Token Case: token is the global one of the document
    const tokenField = env.items(resModel)._mailPostTokenField;
    return (token && record.ok && consteq(await record[tokenField], token));
  }
  else {
    throw new Forbidden();
  }
}

/**
 * Generic chatter function, allowing to write on *any* object that inherits mail.thread. We
    distinguish 2 cases:
        1/ If a token is specified, all logged in users will be able to write a message regardless
        of access rights; if the user is the public user, the message will be posted under the name
        of the partnerId of the object (or the public user if there is no partnerId on the object).

        2/ If a signed token is specified (`hash`) and also a partnerId (`pid`), all post message will
        be done under the name of the partnerId (as it is signed). This should be used to avoid leaking
        token to all users.

    Required parameters
    :param string resModel: model name of the object
    :param int resId: id of the object
    :param string message: content of the message

    Optional keywords arguments:
    :param string token: access token if the object's model uses some kind of public access
                            using tokens (usually a uuid4) to bypass access rules
    :param string hash: signed token by a partner if model uses some token field to bypass access right
                        post messages.
    :param string pid: identifier of the res.partner used to sign the hash
    :param bool nosubscribe: set false if you want the partner to be set as follower of the object when posting (default to true)

    The rest of the kwargs are passed on to message_post()
 * @param opts 
 */
export async function _messagePostHelper(req: WebRequest, opts: { resModel?: any, resId?: any, message?: any, token?: any, hash?: any, pid?: any, nosubscribe?: any, messageType?: any, subtypeXmlid?: any, partnerIds?: any, attachments?: any } = {}) {
  setOptions(opts, { token: '', hash: false, pid: false, nosubscribe: true });
  const env = await req.getEnv();
  let record = env.items(opts.resModel).browse(opts.resId);

  // check if user can post with special token/signed token. The "else" will try to post message with the
  // current user access rights (_mail_post_access use case).
  let pid = opts.pid;
  if (opts.token || (opts.hash && pid)) {
    pid = pid ? parseInt(pid) : false;
    if (await _checkSpecialAccess(req, opts.resModel, opts.resId, opts.token, opts.hash, pid)) {
      record = await record.sudo();
    }
    else {
      throw new Forbidden();
    }
  }
  // deduce author of message
  const partnerId = await (await env.user()).partnerId;
  let authorId = partnerId.ok ? partnerId.id : false;

  // Signed Token Case: authorId is forced
  if (opts.hash && pid) {
    authorId = pid;
  }
  // Token Case: author is document customer (if not logged) or itself even if user has not the access
  else if (opts.token) {
    if (await (await env.user()).IsPublic()) {
      // TODO : After adding the pid and signToken in accessUrl when send invoice by email, remove this line
      // TODO : Author must be Public User (to rename to 'Anonymous')
      authorId = record._fields['partnerId'] && bool(await record.partnerId.id) ? (await record.partnerId).id : authorId;
    }
    else {
      if (!authorId) {
        throw new NotFound();
      }
    }
  }
  let emailFrom;// = None
  if (authorId && !('emailFrom' in opts)) {
    const partner = (await env.items('res.partner').sudo()).browse(authorId);
    emailFrom = await partner.email ? await partner.emailFormatted : null;
  }

  const messagePostArgs = {
    body: opts.message,
    messageType: pop(opts, 'messageType', "comment"),
    subtypeXmlid: pop(opts, 'subtypeXmlid', "mail.mtComment"),
    authorId: authorId,
    ...opts
  }

  // This is necessary as mail.message checks the presence
  // of the key to compute its default email from
  if (emailFrom) {
    messagePostArgs['emailFrom'] = emailFrom;
  }

  return (await record.withContext({ mailCreateNosubscribe: opts.nosubscribe })).messagePost(messagePostArgs);
}

@http.define()
export class PortalChatter extends http.Controller {
  static _module = module;

  _portalPostFilterParams() {
    return ['token', 'pid'];
  }

  async _portalPostCheckAttachments(req: WebRequest, attachmentIds, attachmentTokens) {
    await (await req.getEnv()).items('ir.attachment').browse(attachmentIds)._checkAttachmentsAccess(attachmentTokens);
  }

  /**
   * Create a new `mail.message` with the given `message` and/or `attachment_ids` and return new message values.

      The message will be associated to the record `resId` of the model
      `resModel`. The user must have access rights on this target document or
      must provide valid identifiers through `opts`. See `_message_post_helper`.
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route(['/mail/chatterPost'], { type: 'json', methods: ['POST'], auth: 'public', website: true })
  async portalChatterPost(req, res, opts: { resModel?: any, resId?: any, message?: any, attachmentIds?: any, attachmentTokens?: any } = {}) {
    const resId = parseInt(opts.resId);

    await this._portalPostCheckAttachments(req, opts.attachmentIds || [], opts.attachmentTokens || []);

    let message = opts.message;
    if (message || opts.attachmentIds) {
      const result = { 'default_message': opts.message };
      // message is received in plaintext and saved in html
      ;
      if (message) {
        message = plaintext2html(message);
      }
      const postValues = {
        'resModel': opts.resModel,
        'resId': resId,
        'message': message,
        'sendAfterCommit': false,
        'attachmentIds': false,  // will be added afterward
      }
      update(postValues, Object.fromEntries(this._portalPostFilterParams().map(fname => [fname, opts[fname]])));
      postValues['hash'] = opts['hash'];
      message = await _messagePostHelper(req, postValues);
      update(result, { 'default_messageId': message.id });

      if (opts.attachmentIds) {
        // sudo write the attachment to bypass the read access
        // verification in mail message
        const record = (await req.getEnv()).items(opts.resModel).browse(resId);
        const messageValues = { 'resId': resId, 'model': opts.resModel };
        const attachments = await record._messagePostProcessAttachments([], opts.attachmentIds, messageValues);

        if (attachments['attachmentIds']) {
          await (await message.sudo()).write(attachments);
        }

        update(result, { 'default_attachmentIds': await (await (await message.attachmentIds).sudo()).read(['id', 'label', 'mimetype', 'fileSize', 'accessToken']) });
      }
      return result;
    }
  }

  @http.route('/mail/chatterInit', { type: 'json', auth: 'public', website: true })
  async portalChatterInit(req: WebRequest, res, opts: { resModel?: any, resId?: any, domain?: any, limit?: any } = {}) {
    const env = await req.getEnv();
    const user = await env.user();
    const isUserPublic = await user.hasGroup('base.groupPublic');
    const messageData = await this.portalMessageFetch(req, res, opts);
    let displayComposer = false;
    if (opts['allowComposer']) {
      displayComposer = opts['token'] || !isUserPublic;
    }
    return {
      'messages': messageData['messages'],
      'options': {
        'messageCount': messageData['messageCount'],
        'isUserPublic': isUserPublic,
        'isUserEmployee': await user.hasGroup('base.groupUser'),
        'isUserPublisher': await user.hasGroup('website.groupWebsitePublisher'),
        'displayComposer': displayComposer,
        'partnerId': (await user.partnerId).id
      }
    }
  }

  @http.route('/mail/chatterFetch', { type: 'json', auth: 'public', website: true })
  async portalMessageFetch(req: WebRequest, res, opts: { resModel?: any, resId?: any, domain?: any, limit?: any, offset?: any } = {}) {
    setOptions(opts, { limit: 10, offset: 0 });
    if (!opts.domain) {
      opts.domain = [];
    }
    // Only search into website_message_ids, so apply the same domain to perform only one search
    // extract domain from the 'website_message_ids' field
    const env = await req.getEnv();
    const model = env.items(opts.resModel);
    const field = model._fields['websiteMessageIds'];
    const fieldDomain = await field.getDomainList(model);
    let domain = expression.AND([
      opts.domain,
      fieldDomain,
      [['resId', '=', opts.resId], '|', ['body', '!=', ''], ['attachmentIds', '!=', false]]
    ])

    // Check access
    let message = env.items('mail.message');
    if (opts['token']) {
      const accessAsSudo = await _checkSpecialAccess(opts.resModel, opts.resId, { token: opts['token'] });
      if (!bool(accessAsSudo)) {  // if token is not correct, raise Forbidden
        throw new Forbidden();
      }
      // Non-employee see only messages with not internal subtype (aka, no internal logs)
      if (! await env.items('res.users').hasGroup('base.groupUser')) {
        domain = expression.AND([await message._getSearchDomainShare(), domain]);
      }
      message = await env.items('mail.message').sudo();
    }
    return {
      'messages': await (await message.search(domain, { limit: opts.limit, offset: opts.offset })).portalMessageFormat(),
      'messageCount': await message.searchCount(domain)
    }
  }

  @http.route(['/mail/updateIsInternal'], { type: 'json', auth: "user", website: true })
  async portalMessageUpdateIsInternal(req, res, opts: { messageId?: any, isInternal?: any } = {}) {
    const message = (await req.getEnv()).items('mail.message').browse(parseInt(opts.messageId));
    await message.write({ 'isInternal': opts.isInternal })
    return message.isInternal;
  }
}

@http.define()
class MailController extends mail.MailController {
  static _module = module;

  /**
   * If the current user doesn't have access to the document, but provided
      a valid access token, redirect him to the front-end view.
      If the partnerId and hash parameters are given, add those parameters to the redirect url
      to authentify the recipient in the chatter, if any.

      :param model: the model name of the record that will be visualized
      :param resId: the id of the record
      :param accessToken: token that gives access to the record
          bypassing the rights and rules restriction of the user.
      :param kwargs: Typically, it can receive a partnerId and a hash (sign_token).
          If so, those two parameters are used to authentify the recipient in the chatter, if any.
      :return:
   * @param req 
   * @param model 
   * @param resId 
   * @param opts 
   * @returns 
   */
  static async _redirectToRecord(req, res, model, resId, accessToken, opts: {} = {}) {
    const env = await req.getEnv();
    // no model / resId, meaning no possible record -> direct skip to super
    if (!model || !resId || !(model in env.models)) {
      return super._redirectToRecord(req, res, model, resId, accessToken, opts);
    }

    if (isSubclass(env.items(model), env.registry.models['portal.mixin'])) {
      const uid = req.session.uid || (await env.ref('base.publicUser')).id;
      const recordSudo = await (await env.items(model).sudo()).browse(resId).exists();
      try {
        await (await recordSudo.withUser(uid)).checkAccessRights('read');
        await (await recordSudo.withUser(uid)).checkAccessRule('read');
      } catch (e) {
        if (isInstance(e, AccessError)) {
          if (await recordSudo.accessToken && accessToken && consteq(await recordSudo.accessToken, accessToken)) {
            const recordAction = await (await recordSudo.withContext({ forceWebsite: true })).getAccessAction();
            if (recordAction['type'] === 'ir.actions.acturl') {
              const pid = opts['pid'];
              const hash = opts['hash'];
              let url = recordAction['url'];
              if (pid && hash) {
                url = urlParse(url);
                const urlParams = url.searchQuery;
                update(urlParams, [["pid", pid], ["hash", hash]]);
                url.search = urlEncode(urlParams);
                url = url.toString();//replace(query=urlEncode(urlParams)).to_url()
              }
              return req.redirect(res, url);
            }
          }
        } else {
          throw e;
        }
      }
    }
    return super._redirectToRecord(req, res, model, resId, accessToken, opts);
  }
}