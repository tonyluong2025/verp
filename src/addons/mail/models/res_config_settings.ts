import { DateTime } from "luxon";
import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { DEFAULT_SERVER_DATETIME_FORMAT } from "../../../core/tools/misc";

/**
 * Inherit the base settings to add a counter of failed email + configure the alias domain.
 */
@MetaModel.define()
class ResConfigSettings extends TransientModel {
  static _module = module;
  static _parents = 'res.config.settings';

  static failCounter = Fields.Integer('Fail Mail', {readonly: true});
  static aliasDomain = Fields.Char('Alias Domain', {help: "If you have setup a catch-all email domain redirected to the Verp server, enter the domain name here.", configParameter: 'mail.catchall.domain'});
  static restrictTemplateRendering = Fields.Boolean(
    'Restrict Template Rendering', {configParameter: 'mail.restrict.template.rendering', help: 'Users will still be able to render templates.\nHowever only Mail Template Editors will be able to create new dynamic templates or modify existing ones.'});
  static useTwilioRtcServers = Fields.Boolean(
    'Use Twilio ICE servers', {help: "If you want to use twilio as TURN/STUN server provider", configParameter: 'mail.useTwilioRtcServers'},
  );
  static twilioAccountSid = Fields.Char(
    'Twilio Account SID', {configParameter: 'mail.twilioAccountSid'},
  );
  static twilioAccountToken = Fields.Char(
    'Twilio Account Auth Token', {configParameter: 'mail.twilioAccountToken'},
  );

  @api.model()
  async getValues() {
    const res = await _super(ResConfigSettings, this).getValues();

    const previousDate = DateTime.now().plus({days: 30});

    Object.assign(res, {failCounter: await (await this.env.items('mail.mail').sudo()).searchCount([
      ['date', '>=', previousDate.toFormat(DEFAULT_SERVER_DATETIME_FORMAT)],
      ['state', '=', 'exception']]),
    });

    return res;
  }

  async setValues() {
    await _super(ResConfigSettings, this).setValues();
    await this.env.items('ir.config.parameter').setParam("mail.catchall.domain", await (this as any).aliasDomain || '')
  }
}