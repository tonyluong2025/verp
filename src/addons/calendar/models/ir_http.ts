import { WebRequest } from "../../../core/http";
import { AbstractModel, MetaModel } from "../../../core/models";
import { BadRequest } from "../../../core/service";
import { bool, f } from "../../../core/tools";

@MetaModel.define()
class IrHttp extends AbstractModel {
  static _module = module;
  static _parents = 'ir.http';

  async _authMethodCalendar(req: WebRequest) {
    const token = req.params.get('token', '');
    const env = await req.getEnv();
    let errorMessage;

    const attendee = await (await env.items('calendar.attendee').sudo()).search([['accessToken', '=', token]], { limit: 1 });
    if (!bool(attendee)) {
      errorMessage = "Invalid Invitation Token.";
    }
    else if (req.session.uid && req.session.login !== 'anonymous') {
      // if valid session but user is not match
      const user = (await env.items('res.users').sudo()).browse(req.session.uid);
      if (!(await attendee.partnerId).eq(await user.partnerId)) {
        errorMessage = f("Invitation cannot be forwarded via email. This event/meeting belongs to %s and you are logged in as %s. Please ask organizer to add you.", await attendee.email, await user.email);
      }
    }
    if (errorMessage) {
      throw new BadRequest(errorMessage);
    }
    await (this as any)._authMethodPublic(req);
  }
}