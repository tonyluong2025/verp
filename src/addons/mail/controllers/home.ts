import { http } from '../../../core';
import * as web from '../../../core/addons/web/controllers';
import { Environment } from '../../../core/api';
import { ipAddress } from '../../../core/service/middleware/ipaddress';
import { bool } from '../../../core/tools/bool';

/**
 * Admin still has `admin` password, flash a message via chatter.

  Uses a private mail.channel from the system (/ verpbot) to the user, as
  using a more generic mail.thread could send an email which is undesirable

  Uses mail.channel directly because using mail.thread might send an email instead.
 */
async function _adminPasswordWarn(req, uid) {
  if (req.params['password'] !== 'admin') {
    return;
  }
  if (ipAddress(req.httpRequest.socket.remoteAddress).isPrivate) {
    return;
  }
  const env: Environment = await req.getEnv(global.SUPERUSER_ID, true);
  const admin = await env.ref('base.partnerAdmin');
  if (!(await admin.userIds).ids.includes(uid)) {
    return;
  }
  const hasDemo = bool(await env.items('ir.module.module').searchCount([['demo', '=', true]]));
  if (hasDemo) {
    return;
  }

  const user = (await req.getEnv(uid)).items('res.users');
  const MailChannel = (await env.change({context: await user.contextGet()})).items('mail.channel');
  await MailChannel.browse((await MailChannel.channelGet([admin.id]))['id']).messagePost(
    {body: await this._t("Your password is the default (admin)! If this system is exposed to untrusted users it is important to change it immediately for security reasons. I will keep nagging you about it!"),
    messageType: 'comment',
    subtypeXmlid: 'mail.mtComment'}
  );
}

@http.define()
class MailHome extends web.Home {
  static _module = module;
  
  async _loginRedirect(req: any, res: any, uid: any, redirect: any): Promise<string> {
    if (req.params['loginSuccess']) {
      _adminPasswordWarn(req, uid);
    }

    return super._loginRedirect(req, res, uid, redirect);
  }
}