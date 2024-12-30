import fs from 'fs/promises';
import { http } from "../../../core";
import { AccessError, UserError } from "../../../core/helper";
import { NotFound } from "../../../core/service/middleware/exceptions";
import { consteq, f, filePath, isInstance, len, sorted, update } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { addDate } from "../../../core/tools/date_utils";
import { stringify } from '../../../core/tools/json';
import { getLang } from "../../../core/tools/models";

@http.define()
class DiscussController extends http.Controller {
  static _module = module;

  // Public Pages

  @http.route([
    '/chat/<string:createToken>',
    '/chat/<string:createToken>/<string:channelName>',
  ], { methods: ['GET'], type: 'http', auth: 'public' })
  async discussChannelChatFromToken(req, res, opts: { createToken?: any, channelName?: any } = {}) {
    return this._responseDiscussChannelFromToken(req, res, opts.createToken, opts.channelName);
  }

  @http.route([
    '/meet/<string:createToken>',
    '/meet/<string:createToken>/<string:channelName>',
  ], { methods: ['GET'], type: 'http', auth: 'public' })
  async discussChannelMeetFromToken(req, res, opts: { createToken?: any, channelName?: any } = {}) {
    return this._responseDiscussChannelFromToken(req, res, opts.createToken, opts.channelName, 'videoFullScreen');
  }

  @http.route('/chat/<int:channelId>/<string:invitationToken>', { methods: ['GET'], type: 'http', auth: 'public' })
  async discussChannelInvitation(req, res, opts: { channelId?: any, invitationToken?: any } = {}) {
    const channelSudo = await (await (await req.getEnv()).items('mail.channel').browse(opts.channelId).sudo()).exists();
    if (!bool(channelSudo) || ! await channelSudo.uuid || !consteq(await channelSudo.uuid, opts.invitationToken)) {
      throw new NotFound(res);
    }
    return this._responseDiscussChannelInvitation(req, res, channelSudo);
  }

  @http.route('/discuss/channel/<int:channelId>', { methods: ['GET'], type: 'http', auth: 'public' })
  async discussChannel(req, res, opts: { channelId?: any } = {}) {
    const channelPartnerSudo = (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    return this._responseDiscussPublicChannelTemplate(req, res, await channelPartnerSudo.channelId)
  }

  async _responseDiscussChannelFromToken(req, res, createToken, channelName?: any, defaultDisplayMode?: any) {
    const env = await req.getEnv();
    if (! await (await env.items('ir.config.parameter').sudo()).getParam('mail.chatFromToken')) {
      throw new NotFound(res);
    }
    let channelSudo = await (await env.items('mail.channel').sudo()).search([['uuid', '=', createToken]]);
    if (!bool(channelSudo)) {
      try {
        channelSudo = await channelSudo.create({
          'default_displayMode': defaultDisplayMode,
          'label': channelName ?? createToken,
          'isPublic': 'public',
          'uuid': createToken,
        })
      } catch (e) {
        // except IntegrityError as e:
        if (e.code !== 'UNIQUE_VIOLATION') {
          throw e;
        }
        // concurrent insert attempt: another request created the channel.
        // commit the current transaction and get the channel.
        await env.cr.commit();
        await env.cr.reset();
        channelSudo = await channelSudo.search([['uuid', '=', createToken]]);
      }
    }
    return this._responseDiscussChannelInvitation(req, res, channelSudo, false);
  }

  async _responseDiscussChannelInvitation(req: any, res: any, channelSudo: any, isChannelTokenSecret?: boolean) {
    if (await channelSudo.channelType == 'chat') {
      throw new NotFound(res);
    }
    const discussPublicViewData = {
      'isChannelTokenSecret': isChannelTokenSecret,
    }
    let guest;
    let addGuestCookie = false;
    const channelPartnerSudo = await channelSudo.env.items('mail.channel.partner')._getAsSudoFromRequest(req, channelSudo.id);
    if (bool(channelPartnerSudo)) {
      channelSudo = await channelPartnerSudo.channelId  // ensure guest is in context
    }
    else {
      const user = await channelSudo.env.user();
      if (! await user._isPublic()) {
        try {
          await channelSudo.addMembers([(await user.partnerId).id])
        } catch (e) {
          if (isInstance(e, UserError)) {
            throw new NotFound(res);
          }
          else {
            throw e;
          }
        }
      }
      else {
        guest = await channelSudo.env.items('mail.guest')._getGuestFromRequest(req);
        if (bool(guest)) {
          channelSudo = await channelSudo.withContext({ guest: guest });
          try {
            await channelSudo.addMembers([guest.id]);
          } catch (e) {
            if (isInstance(e, UserError)) {
              throw new NotFound(res);
            } else {
              throw e;
            }
          }
        }
        else {
          if (await channelSudo.isPublic === 'groups') {
            throw new NotFound(res);
          }
          guest = await channelSudo.env.items('mail.guest').create({
            'countryId': (await channelSudo.env.items('res.country').search([['code', '=', (req.session['geoip'] ?? {})['countryCode']]], { limit: 1 })).id,
            'lang': await (await getLang(channelSudo.env)).code,
            'label': await this._t(await req.getEnv(), "Guest"),
            'timezone': await channelSudo.env.items('mail.guest')._getTimezoneFromRequest(req),
          });
          addGuestCookie = true;
          update(discussPublicViewData, {
            'shouldAddGuestAsMemberOnJoin': true,
            'shouldDisplayWelcomeViewInitially': true,
          });
        }
        channelSudo = await channelSudo.withContext({ guest: guest });
      }
    }
    const response = await this._responseDiscussPublicChannelTemplate(req, res, channelSudo, discussPublicViewData);
    if (addGuestCookie) {
      // Discuss Guest ID: every route in this file will make use of it to authenticate
      // the guest through `_get_as_sudo_from_request` or `_getAsSudoFromRequestOrRaise`.
      const expirationDate = addDate(new Date(), { days: 365 });
      response.setCookie(guest._cookieName, `${guest.id}${guest._cookieSeparator}${await guest.accessToken}`, { httponly: true, expires: expirationDate });
    }
    return response;
  }

  async _responseDiscussPublicChannelTemplate(req, res, channelSudo, discussPublicViewData: {} = {}) {
    return req.render(res, 'mail.discussPublicChannelTemplate', {
      'data': {
        'channelData': (await channelSudo.channelInfo())[0],
        'discussPublicViewData': Object.assign({
          'channel': [['insert', { 'id': channelSudo.id, 'model': 'mail.channel' }]],
          'shouldDisplayWelcomeViewInitially': await channelSudo.defaultDisplayMode === 'videoFullScreen',
        }, discussPublicViewData),
      },
      'sessionInfo': await channelSudo.env.items('ir.http').sessionInfo(req),
    })
  }

  // Semi-Static Content (GET requests with possible cache)

  @http.route('/mail/channel/<int:channelId>/partner/<int:partnerId>/avatar128', { methods: ['GET'], type: 'http', auth: 'public' })
  async mailChannelPartnerAvatar128(req, res, opts: { channelId?: any, partnerId?: any } = {}) {
    const env = await req.getEnv();
    const channelPartnerSudo = await env.items('mail.channel.partner')._getAsSudoFromRequest(req, opts.channelId);
    if (!bool(channelPartnerSudo) || !bool(channelPartnerSudo.env.items('mail.channel.partner').search([['channelId', '=', opts.channelId], ['partnerId', '=', opts.partnerId]], { limit: 1 }))) {
      if (await (await env.user()).share) {
        const placeholder = await (await channelPartnerSudo.env.items('res.partner').browse(opts.partnerId).exists())._avatarGetPlaceholder();
        return channelPartnerSudo.env.items('ir.http')._placeholderImageGetResponse(placeholder);
      }
      return (await channelPartnerSudo.sudo(false)).env.items('ir.http')._contentImage(req, res, { model: 'res.partner', resId: opts.partnerId, field: 'avatar128' });
    }
    return channelPartnerSudo.env.items('ir.http')._contentImage(req, res, { model: 'res.partner', resId: opts.partnerId, field: 'avatar128' });
  }

  @http.route('/mail/channel/<int:channelId>/guest/<int:guest_id>/avatar128', { methods: ['GET'], type: 'http', auth: 'public' })
  async mailChannelGuestAvatar128(req, res, opts: { channelId?: any, guestId?: any } = {}) {
    const env = await req.getEnv();
    const channelPartnerSudo = await env.items('mail.channel.partner')._getAsSudoFromRequest(req, opts.channelId);
    if (!bool(channelPartnerSudo) || !bool(channelPartnerSudo.env.items('mail.channel.partner').search([['channelId', '=', opts.channelId], ['guestId', '=', opts.guestId]], { limit: 1 }))) {
      if (await (await env.user()).share) {
        const placeholder = await (await channelPartnerSudo.env.items('mail.guest').browse(opts.guestId).exists())._avatarGetPlaceholder();
        return channelPartnerSudo.env.items('ir.http')._placeholderImageGetResponse(placeholder);
      }
      return (await channelPartnerSudo.sudo(false)).env.items('ir.http')._contentImage(req, res, { model: 'mail.guest', resId: opts.guestId, field: 'avatar128' });
    }
    return channelPartnerSudo.env.items('ir.http')._contentImage(req, res, { model: 'mail.guest', resId: opts.guestId, field: 'avatar128' });
  }

  @http.route('/mail/channel/<int:channelId>/attachment/<int:attachmentId>', { methods: ['GET'], type: 'http', auth: 'public' })
  async mailChannelAttachment(req, res, opts: { channelId?: any, attachmentId?: any, download?: any } = {}) {
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, opts.channelId);
    if (!bool(channelPartnerSudo.env.items('ir.attachment').search([['id', '=', parseInt(opts.attachmentId)], ['resId', '=', parseInt(opts.channelId)], ['resModel', '=', 'mail.channel']], { limit: 1 }))) {
      throw new NotFound(res);
    }
    return channelPartnerSudo.env.items('ir.http')._getContentCommon(req, res, { resId: parseInt(opts.attachmentId), download: opts.download })
  }

  @http.route([
    '/mail/channel/<int:channelId>/image/<int:attachmentId>',
    '/mail/channel/<int:channelId>/image/<int:attachmentId>/<int:width>x<int:height>',
  ], { methods: ['GET'], type: 'http', auth: 'public' })
  async fetchImage(req, res, opts: { channelId?: any, attachmentId?: any, width?: any, height?: any } = {}) {
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    if (!bool(channelPartnerSudo.env.items('ir.attachment').search([['id', '=', parseInt(opts.attachmentId)], ['resId', '=', parseInt(opts.channelId)], ['resModel', '=', 'mail.channel']], { limit: 1 }))) {
      throw new NotFound(res);
    }
    return channelPartnerSudo.env.items('ir.http')._contentImage(req, res, { resId: parseInt(opts.attachmentId), height: parseInt(opts.height), width: parseInt(opts.width) });
  }

  // Client Initialization

  @http.route('/mail/initMessaging', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailInitMessaging(req, res, opts: {} = {}) {
    const env = await req.getEnv();
    const user = await env.user();
    if (! await (await user.sudo())._isPublic()) {
      return (await user.sudo(false))._initMessaging();
    }
    const guest = await env.items('mail.guest')._getGuestFromRequest(req);
    if (bool(guest)) {
      return (await guest.sudo())._initMessaging();
    }
    throw new NotFound(req);
  }

  @http.route('/mail/loadMessageFailures', { methods: ['POST'], type: 'json', auth: 'user' })
  async mailLoadMessageFailures(req, res, opts: {} = {}) {
    return (await (await (await req.getEnv()).user()).partnerId)._messageFetchFailed();
  }

  // Mailbox

  @http.route('/mail/inbox/messages', { methods: ['POST'], type: 'json', auth: 'user' })
  async discussInboxMessages(req, res, opts: { maxId?: any, minId?: any, limit?: number } = {}) {
    return (await req.getEnv()).items('mail.message')._messageFetch([['needaction', '=', true]], opts.maxId, opts.minId, opts.limit);
  }

  @http.route('/mail/history/messages', { methods: ['POST'], type: 'json', auth: 'user' })
  async discussHistoryMessages(req, res, opts: { maxId?: any, minId?: any, limit?: number } = {}) {
    return (await req.getEnv()).items('mail.message')._messageFetch([['needaction', '=', false]], opts.maxId, opts.minId, opts.limit);
  }

  @http.route('/mail/starred/messages', { methods: ['POST'], type: 'json', auth: 'user' })
  async discussStarredMessages(req, res, opts: { maxId?: any, minId?: any, limit?: number } = {}) {
    const env = await req.getEnv();
    return env.items('mail.message')._messageFetch([['starredPartnerIds', 'in', [(await (await env.user()).partnerId).id]]], opts.maxId, opts.minId, opts.limit);
  }

  // Thread API (channel/chatter common)

  _getAllowedMessagePostParams() {
    return ['attachmentIds', 'body', 'messageType', 'partnerIds', 'subtypeXmlid', 'parentId'];
  }

  @http.route('/mail/message/post', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailMessagePost(req, res, opts: { threadModel?: any, threadId?: any, postData?: any } = {}) {
    const env = await req.getEnv();
    const guest = await env.items('mail.guest')._getGuestFromRequest(req);
    await guest.env.items('ir.attachment').browse(opts.postData['attachmentIds'] || [])._checkAttachmentsAccess(opts.postData['attachmentTokens']);
    let thread;
    if (opts.threadModel === 'mail.channel') {
      const channelPartnerSudo = await env.items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.threadId));
      thread = await channelPartnerSudo.channelId;
    }
    else {
      thread = await env.items(opts.threadModel).browse(parseInt(opts.threadId)).exists();
    }
    const message = {};
    for (const [key, value] of Object.entries(opts.postData)) {
      if (this._getAllowedMessagePostParams().includes(key)) {
        message[key] = value;
      }
    }
    return (await (await thread.messagePost(message)).messageFormat())[0];
  }

  @http.route('/mail/message/update_content', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailMessageUpdateContent(req, res, opts: { messageId?: any, body?: any, attachmentIds?: any, attachmentTokens?: any } = {}) {
    const guest = await (await req.getEnv()).items('mail.guest')._getGuestFromRequest(req);
    await guest.env.items('ir.attachment').browse(opts.attachmentIds)._checkAttachmentsAccess(opts.attachmentTokens);
    const messageSudo = await (await guest.env.items('mail.message').browse(opts.messageId).sudo()).exists();
    if (! await messageSudo.isCurrentUserOrGuestAuthor && ! await (await guest.env.user())._isAdmin()) {
      throw new NotFound(res);
    }
    await messageSudo._updateContent(opts.body, opts.attachmentIds);
    return {
      'id': messageSudo.id,
      'body': await messageSudo.body,
      'attachments': [['insert-and-replace', (await messageSudo.attachmentIds).sorted()._attachmentFormat(true)]],
    }
  }

  @http.route('/mail/attachment/upload', { methods: ['POST'], type: 'http', auth: 'public' })
  async mailAttachmentUpload(req, res, opts: { ufile?: any, threadId?: any, threadModel?: any, isPending?: any } = {}) {
    const env = await req.getEnv();
    let channelPartner = env.items('mail.channel.partner');
    if (opts.threadModel === 'mail.channel') {
      channelPartner = await env.items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.threadId));
    }
    const vals = {
      'label': opts.ufile.filename,
      'raw': await fs.readFile(filePath(opts.ufile.filename)),
      'resId': parseInt(opts.threadId),
      'resModel': opts.threadModel,
    }
    if (opts.isPending && opts.isPending != 'false') {
      // Add this point, the message related to the uploaded file does
      // not exist yet, so we use those placeholder values instead.
      update(vals, {
        'resId': 0,
        'resModel': 'mail.compose.message',
      });
    }
    if (await (await channelPartner.env.user()).share) {
      // Only generate the access token if absolutely necessary (= not for internal user).
      vals['accessToken'] = channelPartner.env.items('ir.attachment')._generateAccessToken();
    }
    let attachmentData;
    try {
      const attachment = await channelPartner.env.items('ir.attachment').create(vals);
      await attachment._postAddCreate();
      attachmentData = {
        'filename': opts.ufile.filename,
        'id': attachment.id,
        'mimetype': await attachment.mimetype,
        'label': await attachment.label,
        'size': await attachment.fileSize
      }
      if (await attachment.accessToken) {
        attachmentData['accessToken'] = await attachment.accessToken;
      }
    } catch (e) {
      if (isInstance(e, AccessError)) {
        attachmentData = { 'error': await this._t(await req.getEnv(), "You are not allowed to upload an attachment here.") };
      }
    }
    return req.makeResponse(res,
      stringify(attachmentData),
      [['Content-Type', 'application/json']]
    );
  }

  @http.route('/mail/attachment/delete', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailAttachmentDelete(req, res, opts: { attachmentId?: any, accessToken?: any } = {}) {
    const env = await req.getEnv();
    const attachmentSudo = await (await env.items('ir.attachment').browse(parseInt(opts.attachmentId)).sudo()).exists();
    if (!bool(attachmentSudo)) {
      const target = await (await env.user()).partnerId;
      await env.items('bus.bus')._sendone(target, 'ir.attachment/delete', { 'id': opts.attachmentId });
      return;
    }
    if (! await (await env.user()).share) {
      // Check through standard access rights/rules for internal users.
      await (await attachmentSudo.sudo(false))._deleteAndNotify();
      return;
    }
    // For non-internal users 2 cases are supported:
    //   - Either the attachment is linked to a message: verify the request is made by the author of the message (portal user or guest).
    //   - Either a valid access token is given: also verify the message is pending (because unfortunately in portal a token is also provided to guest for viewing others' attachments).
    const guest = await env.items('mail.guest')._getGuestFromRequest(req);
    const messageSudo = await (await guest.env.items('mail.message').sudo()).search([['attachmentIds', 'in', attachmentSudo.ids]], { limit: 1 });
    if (bool(messageSudo)) {
      if (! await messageSudo.isCurrentUserOrGuestAuthor) {
        throw new NotFound(res);
      }
    }
    else {
      if (!opts.accessToken || ! await attachmentSudo.accessToken || !consteq(opts.accessToken, await attachmentSudo.accessToken)) {
        throw new NotFound(res);
      }
      if (await attachmentSudo.resModel !== 'mail.compose.message' || await attachmentSudo.resId !== 0) {
        throw new NotFound(res);
      }
    }
    await attachmentSudo._deleteand_notify();
  }

  @http.route('/mail/message/add_reaction', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailMessageAddReaction(req, res, opts: { messageId?: any, content?: any } = {}) {
    const env = await req.getEnv();
    const guestSudo = await (await env.items('mail.guest')._getGuestFromRequest(req)).sudo();
    const messageSudo = await guestSudo.env.items('mail.message').browse(parseInt(opts.messageId)).exists();
    if (!bool(messageSudo)) {
      throw new NotFound(res);
    }
    let guests, partners;
    if (await (await (env.user()).sudo())._isPublic()) {
      if (!bool(guestSudo) || await messageSudo.model !== 'mail.channel' || !(await guestSudo.channelIds).ids.includes(await messageSudo.resId)) {
        throw new NotFound(res);
      }
      await messageSudo._messageAddReaction(opts.content);
      guests = [['insert', { 'id': guestSudo.id }]];
      partners = [];
    }
    else {
      await (await messageSudo.sudo(false))._messageAddReaction(opts.content);
      guests = [];
      partners = [['insert', { 'id': (await (await env.user()).partnerId).id }]];
    }
    const reactions = await messageSudo.env.items('mail.message.reaction').search([['messageId', '=', messageSudo.id], ['content', '=', opts.content]]);
    return {
      'id': messageSudo.id,
      'messageReactionGroups': [[len(reactions) > 0 ? 'insert' : 'insert-and-unlink', {
        'messageId': messageSudo.id,
        'content': opts.content,
        'count': len(reactions),
        'guests': guests,
        'partners': partners,
      }]],
    }
  }

  @http.route('/mail/message/remove_reaction', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailMessageRemoveReaction(req, res, opts: { messageId?: any, content?: any } = {}) {
    const env = await req.getEnv();
    const guestSudo = await (await env.items('mail.guest')._getGuestFromRequest(req)).sudo();
    const messageSudo = await guestSudo.env.items('mail.message').browse(parseInt(opts.messageId)).exists();
    if (!bool(messageSudo)) {
      throw new NotFound(res);
    }
    let guests, partners;
    if (await (await (await env.user()).sudo())._isPublic()) {
      if (!bool(guestSudo) || await messageSudo.model !== 'mail.channel' || !(await guestSudo.channelIds).ids.includes(await messageSudo.resId)) {
        throw new NotFound(res);
      }
      await messageSudo._messageRemoveReaction(opts.content);
      guests = [['insert-and-unlink', { 'id': guestSudo.id }]];
      partners = [];
    }
    else {
      await (await messageSudo.sudo(false))._messageRemoveReaction(opts.content);
      guests = [];
      partners = [['insert-and-unlink', { 'id': (await (await env.user()).partnerId).id }]];
    }
    const reactions = await messageSudo.env.items('mail.message.reaction').search([['messageId', '=', messageSudo.id], ['content', '=', opts.content]]);
    return {
      'id': messageSudo.id,
      'messageReactionGroups': [[len(reactions) > 0 ? 'insert' : 'insert-and-unlink', {
        'messageId': messageSudo.id,
        'content': opts.content,
        'count': len(reactions),
        'guests': guests,
        'partners': partners,
      }]],
    }
  }

  // Channel API

  @http.route('/mail/channel/add_guest_as_member', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailChannelAddGuestAsMember(req, res, opts: { channelId?: any, channelUuid?: any } = {}) {
    let channelSudo = await (await (await req.getEnv()).items('mail.channel').browse(parseInt(opts.channelId)).sudo()).exists();
    if (!bool(channelSudo) || ! await channelSudo.uuid || !consteq(await channelSudo.uuid, opts.channelUuid)) {
      throw new NotFound(res);
    }
    if (await channelSudo.channelType === 'chat') {
      throw new NotFound(res);
    }
    const guest = await channelSudo.env.items('mail.guest')._getGuestFromRequest(req);
    // Only guests should take this route.
    if (!bool(guest)) {
      throw new NotFound(res);
    }
    const channelPartner = await channelSudo.env.items('mail.channel.partner')._getAsSudoFromRequest(req, opts.channelId);
    // Do not add the guest to channel members if they are already member.
    if (!bool(channelPartner)) {
      channelSudo = await channelSudo.withContext({ guest: guest });
      try {
        await channelSudo.addMembers([guest.id]);
      } catch (e) {
        if (isInstance(e, UserError)) {
          throw new NotFound(res);
        } else {
          throw e;
        }
      }
    }
  }

  @http.route('/mail/channel/messages', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailChannelMessages(req, res, opts: { channelId?: any, maxId?: any, minId?: any, limit?: number } = {}) {
    opts.limit = opts.limit || 30;
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    return channelPartnerSudo.env.items('mail.message')._messageFetch([
      ['resId', '=', opts.channelId],
      ['model', '=', 'mail.channel'],
      ['messageType', '!=', 'userNotification'],
    ], opts.maxId, opts.minId, opts.limit);
  }

  @http.route('/mail/channel/setLastSeenMessage', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailChannelMarkAsSeen(req, res, opts: { channelId?: any, lastMessageId?: any } = {}) {
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    return (await channelPartnerSudo.channelId)._channelSeen(parseInt(opts.lastMessageId));
  }

  @http.route('/mail/channel/ping', { methods: ['POST'], type: 'json', auth: 'public' })
  async channelPing(req, res, opts: { channelId?: any, rtcSessionId?: any, checkRtcSessionIds?: any } = {}) {
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    if (bool(opts.rtcSessionId)) {
      await (await (await (await channelPartnerSudo.channelId).rtcSessionIds).filteredDomain([
        ['id', '=', parseInt(opts.rtcSessionId)],
        ['channelPartnerId', '=', channelPartnerSudo.id],
      ])).write({});  // update updatedAt
    }
    const [currentRtcSessions, outdatedRtcSessions] = await channelPartnerSudo._rtcSyncSessions(opts.checkRtcSessionIds);
    return {
      'rtcSessions': [
        ['insert', await currentRtcSessions.map(rtcSessionSudo => rtcSessionSudo._mailRtcSessionFormat(false))],
        ['insert-and-unlink', outdatedRtcSessions.map(missingRtcSessionSudo => { return { 'id': missingRtcSessionSudo.id } })],
      ]
    };
  }

  // Chatter API

  @http.route('/mail/thread/data', { methods: ['POST'], type: 'json', auth: 'user' })
  async mailThreadData(req, res, opts: { threadModel?: any, threadId?: any, requestList?: any } = {}) {
    const result = {};
    const thread = await (await (await req.getEnv()).items(opts.threadModel).withContext({ activeTest: false })).search([['id', '=', opts.threadId]]);
    if ((opts.requestList || []).includes('attachments')) {
      result['attachments'] = await (await thread.env.items('ir.attachment').search([['resId', '=', thread.id], ['resModel', '=', thread._name]], { order: 'id desc' }))._attachmentFormat(true);
    }
    return result;
  }

  @http.route('/mail/thread/messages', { methods: ['POST'], type: 'json', auth: 'user' })
  async mailThreadMessages(req, res, opts: { threadModel?: any, threadId?: any, maxId?: any, minId?: any, limit?: any } = {}) {
    return (await req.getEnv()).items('mail.message')._messageFetch([
      ['resId', '=', parseInt(opts.threadId)],
      ['model', '=', opts.threadModel],
      ['messageType', '!=', 'userNotification'],
    ], opts.maxId, opts.minId, opts.limit || 30);
  }

  @http.route('/mail/readFollowers', { methods: ['POST'], type: 'json', auth: 'user' })
  async readFollowers(req, res, opts: { resModel?: any, resId?: any } = {}) {
    const env = await req.getEnv();
    await env.items('mail.followers').checkAccessRights("read");
    await env.items(opts.resModel).checkAccessRights("read");
    await env.items(opts.resModel).browse(opts.resId).checkAccessRule("read");

    const followerRecs = await env.items('mail.followers').search([['resModel', '=', opts.resModel], ['resId', '=', opts.resId]]);

    const followers = [];
    let followerId;// = None
    for (const follower of followerRecs) {
      const [label, displayName, email, partnerId, isActive] = await follower('label', 'displayName', 'email', 'partnerId', 'isActive');
      if (partnerId.eq(await (await env.user()).partnerId)) {
        followerId = follower.id;
      }
      followers.push({
        'id': follower.id,
        'partnerId': partnerId.id,
        'label': label,
        'displayName': displayName,
        'email': email,
        'isActive': isActive,
        // When editing the followers, the "pencil" icon that leads to the edition of subtypes
        // should be always be displayed and not only when "debug" mode is activated.
        'isEditable': true,
        'partner': (await partnerId.mailPartnerFormat()).get(partnerId),
      });
    }
    return {
      'followers': followers,
      'subtypes': followerId ? await this.readSubscriptionData(req, res, { followerId: followerId }) : null
    }
  }


  /**
   * Computes:
            - messageSubtypeData: data about document subtypes: which are
                available, which are followed if any 
   */

  @http.route('/mail/readSubscriptionData', { methods: ['POST'], type: 'json', auth: 'user' })
  async readSubscriptionData(req, res, opts: { followerId?: any } = {}) {
    const env = await req.getEnv();
    await env.items('mail.followers').checkAccessRights("read");
    const follower = (await env.items('mail.followers').sudo()).browse(opts.followerId);
    follower.ensureOne();
    const resModel = await follower.resModel;
    await env.items(resModel).checkAccessRights("read");
    const record = env.items(resModel).browse(await follower.resId);
    await record.checkAccessRule("read");

    // find current model subtypes, add them to a dictionary
    const subtypes = await record._mailGetMessageSubtypes();
    const followedSubtypesIds = new Set((await follower.subtypeIds).ids)
    const subtypesList = [];
    for (const subtype of subtypes) {
      const [label, resModel, sequence, defaultValue, internal, parentId] = await subtype('label', 'resModel', 'sequence', 'default', 'internal', 'parentId');
      subtypesList.push({
        'label': label,
        'resModel': resModel,
        'sequence': sequence,
        'default': defaultValue,
        'internal': internal,
        'followed': followedSubtypesIds.has(subtype.id),
        'parentModel': await parentId.resModel,
        'id': subtype.id
      });
    }
    return sorted(subtypesList, (it) => [it['parentModel'] || '', it['resModel'] || '', it['internal'], it['sequence']].join('@'));
  }

  @http.route('/mail/getSuggestedRecipients', { methods: ['POST'], type: 'json', auth: 'user' })
  async messageGetSuggestedRecipients(req, res, opts: { model?: any, resIds?: any } = {}) {
    const records = (await req.getEnv()).items(opts.model).browse(opts.resIds);
    try {
      await records.checkAccessRule('read');
      await records.checkAccessRights('read');
    } catch (e) {
      return {}
    }
    return records._messageGetSuggestedRecipients();
  }

  // RTC API TODO move check logic in routes.

  /**
   * Sends content to other session of the same channel, only works if the user is the user of that session.
          This is used to send peer to peer information between sessions.
 
          :param peer_notifications: list of tuple with the following elements:
              - int sender_session_id: id of the session from which the content is sent
              - list target_session_ids: list of the ids of the sessions that should receive the content
              - string content: the content to send to the other sessions
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/mail/rtc/session/notifyCallMembers', { methods: ['POST'], type: "json", auth: "public" })
  async sessionCallNotify(req, res, opts: { peerNotifications?: any } = {}) {
    const env = await req.getEnv();
    const guest = await env.items('mail.guest')._getGuestFromRequest(req);
    const notificationsBySession = new Map<any, any>();//list);
    for (const [senderSessionId, targetSessionIds, content] of opts.peerNotifications) {
      const sessionSudo = await (await guest.env.items('mail.channel.rtc.session').sudo()).browse(parseInt(senderSessionId)).exists();
      if (!bool(sessionSudo) || (bool(await sessionSudo.guestId) && !(await sessionSudo.guestId).eq(guest)) || (bool(await sessionSudo.partnerId) && !(await sessionSudo.partnerId).eq(await (await env.user()).partnerId))) {
        continue;
      }
      if (!notificationsBySession.has(sessionSudo)) {
        notificationsBySession.set(sessionSudo, []);
      }
      notificationsBySession.get(sessionSudo).push([targetSessionIds.map(sid => parseInt(sid)), content]);
    }
    for (const [sessionSudo, notifications] of notificationsBySession) {
      await sessionSudo._notifyPeers(notifications);
    }
  }

  /**
   * Update a RTC session and broadcasts the changes to the members of its channel,
          only works of the user is the user of that session.
          :param int sessionId: id of the session to update
          :param dict values: write dict for the fields to update
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/mail/rtc/session/updateAndBroadcast', { methods: ['POST'], type: "json", auth: "public" })
  async sessionUpdateAndBroadcast(req, res, opts: { sessionId?: any, values?: any } = {}) {
    const env = await req.getEnv();
    let session;
    if (await (await env.user())._isPublic()) {
      const guest = await env.items('mail.guest')._getGuestFromRequest(req);
      if (bool(guest)) {
        session = (await guest.env.items('mail.channel.rtc.session').sudo()).browse(parseInt(opts.sessionId)).exists();
        if (bool(session) && (await session.guestId).eq(guest)) {
          await session._updateAndBroadcast(opts.values);
          return;
        }
      }
      return;
    }
    session = await (await env.items('mail.channel.rtc.session').sudo()).browse(parseInt(opts.sessionId)).exists();
    if (bool(session) && (await session.partnerId).eq(await (await env.user()).partnerId)) {
      await session._updateAndBroadcast(opts.values);
    }
  }

  /**
   * Joins the RTC call of a channel if the user is a member of that channel
          :param int channelId: id of the channel to join
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/mail/rtc/channel/join_call', { methods: ['POST'], type: "json", auth: "public" })
  async channelCallJoin(req, res, opts: { channelId?: any, checkRtcSessionIds?: any } = {}) {
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    return channelPartnerSudo._rtcJoinCall(opts.checkRtcSessionIds);
  }

  /**
   * Disconnects the current user from a rtc call and clears any invitation sent to that user on this channel
          :param int channelId: id of the channel from which to disconnect
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/mail/rtc/channel/leaveCall', { methods: ['POST'], type: "json", auth: "public" })
  async channelCallLeave(req, res, opts: { channelId?: any } = {}) {
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    return channelPartnerSudo._rtcLeaveCall();
  }

  /**
   * Sends invitations to join the RTC call to all connected members of the thread who are not already invited.
          :param list partner_ids: list of the partner ids to invite
          :param list guest_ids: list of the guest ids to invite
 
          if either partner_ids or guest_ids is set, only the specified ids will be invited.
   * @param req 
   * @param res 
   * @param opts 
   * @returns 
   */
  @http.route('/mail/rtc/channel/cancelCallInvitation', { methods: ['POST'], type: "json", auth: "public" })
  async channelCallCancelInvitation(req, res, opts: { channelId?: any, partnerIds?: any, guestIds?: any } = {}) {
    const channelPartnerSudo = await (await req.getEnv()).items('mail.channel.partner')._getAsSudoFromRequestOrRaise(req, parseInt(opts.channelId));
    return (await channelPartnerSudo.channelId)._rtcCancelInvitations(opts.partnerIds, opts.guestIds);
  }

  /**
   * Returns a JS file that declares a WorkletProcessor class in
          a WorkletGlobalScope, which means that it cannot be added to the
          bundles like other assets.
   * @param req 
   * @param res 
   * @returns 
   */
  @http.route('/mail/rtc/audioWorkletProcessor', { methods: ['GET'], type: 'http', auth: 'public' })
  async audioWorkletProcessor(req, res) {
    return req.makeResponse(res,
      await fs.readFile(filePath('mail/static/src/worklets/audio_processor.js')),
      [
        ['Content-Type', 'application/javascript'],
        ['Cache-Control', f('max-age=%s', http.STATIC_CACHE)],
      ]
    )
  }

  // Guest API

  @http.route('/mail/guest/updateName', { methods: ['POST'], type: 'json', auth: 'public' })
  async mailGuestUpdateName(req, res, opts: { guestId?: any, label?: any } = {}) {
    const env = await req.getEnv();
    const guest = await env.items('mail.guest')._getGuestFromRequest(req);
    const guestToRenameSudo = await (await guest.env.items('mail.guest').browse(opts.guestId).sudo()).exists();
    if (!bool(guestToRenameSudo)) {
      throw new NotFound(res);
    }
    if (!guestToRenameSudo.eq(guest) && ! await (await env.user())._isAdmin()) {
      throw new NotFound(res);
    }
    await guestToRenameSudo._updateName(opts.label);
  }
}