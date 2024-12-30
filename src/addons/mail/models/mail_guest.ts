import { v4 as uuid4 } from 'uuid';
import { Fields, api } from "../../../core";
import { UserError } from '../../../core/helper/errors';
import { WebRequest } from '../../../core/http';
import { MetaModel, Model } from "../../../core/models";
import { isInstance } from '../../../core/tools/func';
import { allTimezones, consteq } from '../../../core/tools/misc';

@MetaModel.define()
class MailGuest extends Model {
  static _module = module;
  static _name = 'mail.guest';
  static _description = "Guest";
  static _parents = ['avatar.mixin'];
  static _avatarNameField = "label";
  
  _cookieName = 'dgid';
  _cookieSeparator = '|';

  @api.model()
  async _langGget() {
    return this.env.items('res.lang').getInstalled();
  }

  static label = Fields.Char({string: "Name", required: true});
  static accessToken = Fields.Char({string: "Access Token", default: self => uuid4(), groups: 'base.groupSystem', required: true, readonly: true, copy: false});
  static countryId = Fields.Many2one('res.country', {string: "Country"});
  static lang = Fields.Selection('_langGet', {string: "Language"});
  static timezone = Fields.Selection('_tzGet', {string: "Timezone"});
  static channelIds = Fields.Many2many('mail.channel', {string: "Channels", relation: 'mailChannelPartner', column1: 'guestId', column2: 'channelId', copy: false});

  /**
   * Returns the current guest record from the context, if applicable.
   * @returns 
   */
  async _getGuestFromContext() {
    const guest = this.env.context['guest'];
    if (isInstance(guest, this.pool.models['mail.guest'])) {
        return guest;
    }
    return this.env.items('mail.guest');
  }

  async _getGuestFromRequest(request: WebRequest) {
    const parts = (request.httpRequest.cookie[this._cookieName] || '').split(this._cookieSeparator);
    if (parts.length != 2) {
      return this.env.items('mail.guest');
    }
    const [guestId, guestAccessToken] = parts;
    if (! guestId || ! guestAccessToken) {
      return this.env.items('mail.guest');
    }
    const guest = await (await this.env.items('mail.guest').browse(parseInt(guestId)).sudo()).exists();
    const accessToken = await guest.accessToken;
    if (! guest.ok || ! accessToken || ! consteq(accessToken, guestAccessToken)) {
      return this.env.items('mail.guest');
    }
    if (! await guest.timezone) {
      const timezone = this._getTimezoneFromRequest(request);
      if (timezone) {
        await guest._updateTimezone(timezone);
      }
    }
    return (await guest.sudo(false)).withContext({guest: guest});
  }

  _getTimezoneFromRequest(request) {
    const timezone = request.httpRequest.cookies['tz'];
    return allTimezones.includes(timezone) ? timezone : false;
  }

  async _updateName(name: string) {
    this.ensureOne();
    name = name.trim();
    if (name.length < 1) {
      throw new UserError(await this._t("Guest's name cannot be empty."));
    }
    if (name.length > 512) {
      throw new UserError(await this._t("Guest's name is too long."));
    }
    await this.set('label', name);
    const guestData = {
      'id': this.id,
      'label': name
    }
    const busNotifs = (await (this as any).channelIds).map(channel => [channel, 'mail.guest/insert', guestData]);
    busNotifs.push([this, 'mail.guest/insert', guestData]);
    await this.env.items('bus.bus')._sendmany(busNotifs);
  }

  async _updateTimezone(timezone) {
    const query = `
      UPDATE "mailGuest"
      SET timezone = $1
      WHERE id IN (
        SELECT id FROM "mailGuest" WHERE id = $2
        FOR NO KEY UPDATE SKIP LOCKED
      )
    `;
    await this.env.cr.execute(query, {bind: [timezone, this.id]});
  }

  async _initMessaging() {
    this.ensureOne();
    const partnerRoot = await this.env.ref('base.partnerRoot');
    return {
      'channels': await (await (this as any).channelIds).channelInfo(),
      'companyName': await (await this.env.company()).label,
      'currentGuest': {
        'id': this.id,
        'label': await (this as any).label,
      },
      'currentPartner': false,
      'currentUserId': false,
      'currentUserSettings': false,
      'mailFailures': [],
      'menuId': false,
      'needactionInboxCounter': false,
      'partnerRoot': {
        'id': partnerRoot.id,
        'label': await partnerRoot.label,
      },
      'publicPartners': [],
      'shortcodes': [],
      'starredCounter': false,
    }
  }

}