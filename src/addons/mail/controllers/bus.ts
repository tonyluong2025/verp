import { ServerResponse } from "http";
import { WebRequest } from "../../../core/http";
import { http } from "../../../core";
import { BusController } from "../../bus/controllers/main"
import { bool } from "../../../core/tools/bool";
import { plaintext2html } from "../../../core/tools/mail";

@http.define()
class MailChatController extends BusController {
  static _module = module;

  /**
   * For Anonymous people, they receive the access right of SUPERUSER_ID since they have NO access (auth=none)
      !!! Each time a method from this controller is call, there is a check if the user (who can be anonymous and Sudo access) can access to the resource.
   * @returns 
   */
  async _defaultRequestUid(req) {
    return req.session.uid && req.session.uid || global.SUPERUSER_ID;
  }

  // --------------------------
  // Extends BUS Controller Poll
  // --------------------------
  async _poll(req: WebRequest, res: ServerResponse, dbname, channels, last, options) {
    const env = await req.getEnv();
    channels = Array.from(channels);  // do not alter original list
    const guestSudo = await (await env.items('mail.guest')._getGuestFromRequest(req)).sudo();
    let mailChannels = env.items('mail.channel');
    if (req.session.uid) {
      const partner = await (await env.user()).partnerId;
      mailChannels = await partner.channelIds;
      channels.push(partner);
    }
    else if (bool(guestSudo)) {
      if ('busInactivity' in options) {
        await guestSudo.env.items('bus.presence').updateBus({inactivityPeriod: options['busInactivity'], identityField: 'guestId', identityValue: guestSudo.id});
      }
      mailChannels = await guestSudo.channelIds;
      channels.push(guestSudo);
    }
    for (const mailChannel of mailChannels) {
      channels.push(mailChannel);
    }
    return super._poll(req, res, dbname, channels, last, options);
  }

  // --------------------------
  //# Anonymous routes (Common Methods)
  // --------------------------
  @http.route('/mail/chatPost', {type: "json", auth: "public", cors: "*"})
  async mailChatPost(req, res, opts: {uuid?: any, messageContent?: any} ={}) {
    const env = await req.getEnv();
    const mailChannel = await (await env.items('mail.channel').sudo()).search([['uuid', '=', opts.uuid]], {limit: 1});
    if (! mailChannel.ok) {
      return false;
    }

    // find the author from the user session
    let authorId, emailFrom;
    if (req.session.uid) {
      const author = await (await env.items('res.users').sudo()).browse(req.session.uid).partnerId;
      authorId = author.id
      emailFrom = await author.emailFormatted;
    }
    else {  // If Public User, use catchall email from company
      authorId = false;
      emailFrom = await mailChannel.anonymousName || await (await (await mailChannel.createdUid).companyId).catchallFormatted;
    }
    // post a message without adding followers to the channel. emailFrom=false avoid to get author from email data
    const body = plaintext2html(opts.messageContent);
    const message = await (await mailChannel.withContext({mailCreateNosubscribe: true})).messagePost({
      authorId: authorId,
      emailFrom: emailFrom,
      body: body,
      messageType: 'comment',
      subtypeXmlid: 'mail.mtComment'
    });
    return message.ok ? message.id : false;
  }

  @http.route(['/mail/chatHistory'], {type: "json", auth: "public", cors: "*"})
  async mailChatHistory(req, res, opts: {uuid?: any, lastId?: any, limit?: 20}={}) {
    const channel = await (await (await req.getEnv()).items("mail.channel").sudo()).search([['uuid', '=', opts.uuid]], {limit: 1});
    if (! channel.ok) {
      return [];
    }
    else {
      return channel._channelFetchMessage(opts.lastId, opts.limit);
    }
  }
}