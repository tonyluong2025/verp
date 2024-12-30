import * as uuid from "uuid";
import { Fields, api } from "../../../core";
import { _tzGet } from "../../../core/addons/base";
import { DefaultDict2, UserError, ValueError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { b64encode, bool } from "../../../core/tools";

export const STATE_SELECTION = [
  ['needsAction', 'Needs Action'],
  ['tentative', 'Uncertain'],
  ['declined', 'Declined'],
  ['accepted', 'Accepted'],
];

/**
 * Calendar Attendee Information
 */
@MetaModel.define()
class Attendee extends Model {
  static _module = module;
  static _name = 'calendar.attendee';
  static _recName = 'commonName';
  static _description = 'Calendar Attendee Information';
  static _order = 'createdAt ASC';

  _defaultAccessToken() {
    return uuid.v4();
  }

  // event
  static eventId = Fields.Many2one('calendar.event', { string: 'Meeting linked', required: true, ondelete: 'CASCADE' });
  static recurrenceId = Fields.Many2one('calendar.recurrence', { related: 'eventId.recurrenceId' });
  // attendee
  static partnerId = Fields.Many2one('res.partner', { string: 'Attendee', required: true, readonly: true });
  static email = Fields.Char('Email', { related: 'partnerId.email', help: "Email of Invited Person" });
  static phone = Fields.Char('Phone', { related: 'partnerId.phone', help: "Phone number of Invited Person" });
  static commonName = Fields.Char('Common name', { compute: '_computeCommonName', store: true });
  static accessToken = Fields.Char('Invitation Token', { default: self => self._defaultAccessToken() });
  static mailTz = Fields.Selection(_tzGet, { compute: '_computeMailTz', help: 'Timezone used for displaying time in the mail template' });
  // state
  static state = Fields.Selection(STATE_SELECTION, {
    string: 'Status', readonly: true, default: 'needsAction',
    help: "Status of the attendee's participation"
  });
  static availability = Fields.Selection(
    [['free', 'Available'], ['busy', 'Busy']], { string: 'Available/Busy', readonly: true });

  @api.depends('partnerId', 'partnerId.label', 'email')
  async _computeCommonName() {
    for (const attendee of this) {
      await attendee.set('commonName', await (await attendee.partnerId).label || await attendee.email);
    }
  }

  async _computeMailTz() {
    for (const attendee of this) {
      await attendee.set('mailTz', await (await attendee.partnerId).tz);
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const values of valsList) {
      // by default, if no state is given for the attendee corresponding to the current user
      // that means he's the event organizer so we can set his state to "accepted"
      if (!('state' in values) && values['partnerId'] === (await (await this.env.user()).partnerId).id) {
        values['state'] = 'accepted';
      }
      if (!values["email"] && values["commonName"]) {
        const commonNameval = values["commonName"].split(':');
        const email = commonNameval.filter(x => x.includes('@'));
        values['email'] = email ? email[0] : '';
        values['commonName'] = values["commonName"];
      }
    }
    const attendees = await _super(Attendee, this).create(valsList);
    await attendees._subscribePartner();
    return attendees;
  }

  async unlink() {
    await this._unsubscribePartner();
    return _super(Attendee, this).unlink();
  }

  @api.returns('self', (value) => value.id)
  async copy(defaultValue?: any) {
    throw new UserError(await this._t('You cannot duplicate a calendar attendee.'));
  }

  async _subscribePartner() {
    const mappedFollowers = new DefaultDict2(() => this.env.items('calendar.event'));
    for (const event of await this['eventId']) {
      let partners = (await (await event.attendeeIds).and(this).partnerId).sub(await event.messagePartnerIds);
      // current user is automatically added as followers, don't add it twice.
      partners = partners.sub(await (await this.env.user()).partnerId);
      mappedFollowers[partners] = mappedFollowers[partners].or(event);
    }
    for (const [partners, events] of mappedFollowers) {
      await events.messageSubscribe(partners.ids);
    }
  }

  async _unsubscribePartner() {
    for (const event of await this['eventId']) {
      const partners = (await (await event.attendeeIds).and(this).partnerId).and(await event.messagePartnerIds);
      await event.messageUnsubscribe(partners.ids);
    }
  }

  /**
   * Send mail for event invitation to event attendees.
          :param mailTemplate: a mail.template record
          :param forceSend: if set to True, the mail(s) will be sent immediately (instead of the next queue processing)
   * @param mailTemplate 
   * @param forceSend 
   * @returns 
   */
  async _sendMailToAttendees(mailTemplate, forceSend?: boolean) {
    if (typeof mailTemplate === 'string') {
      throw new ValueError('Template should be a template record, not an XML ID anymore.');
    }
    if (bool(await (await this.env.items('ir.config.parameter').sudo()).getParam('calendar.blockMail')) || this._context["noMailToAttendees"]) {
      return false;
    }
    if (!bool(mailTemplate)) {
      console.warn("No template passed to %s notification process. Skipped.", this.toString());
      return false;
    }

    // get ics file for all meetings
    const icsFiles = await (await this.mapped('eventId'))._getIcsFile();

    for (const attendee of this) {
      if (await attendee.email && !(await attendee.partnerId).eq(await (await this.env.user()).partnerId)) {
        const event = await attendee.eventId;
        const eventId = event.id;
        const icsFile = icsFiles[eventId];

        let attachmentValues = [];
        if (icsFile) {
          attachmentValues = [
            [0, 0, {
              'label': 'invitation.ics',
              'mimetype': 'text/calendar',
              'datas': b64encode(icsFile)
            }]
          ];
        }
        const body = (await mailTemplate._renderField(
          'bodyHtml',
          attendee.ids,
          {
            computeLang: true,
            postProcess: true
          }))[attendee.id];
        const subject = (await mailTemplate._renderField(
          'subject',
          attendee.ids,
          { computeLang: true }))[attendee.id];
        await (await event.withContext({ noDocument: true })).messageNotify({
          emailFrom: await (await event.userId).emailFormatted || await (await this.env.user()).emailFormatted,
          authorId: (await (await event.userId).partnerId).id || (await (await this.env.user()).partnerId).id,
          body: body,
          subject: subject,
          partnerIds: (await attendee.partnerId).ids,
          emailLayoutXmlid: 'mail.mailNotificationLight',
          attachmentIds: attachmentValues,
          forceSend: forceSend
        });
      }
    }
  }

  /**
   * Makes event invitation as Tentative.
   * @returns 
   */
  async doTentative() {
    return this.write({ 'state': 'tentative' });
  }

  /**
   * Marks event invitation as Accepted.
   * @returns 
   */
  async doAccept() {
    for (const attendee of this) {
      await (await attendee.eventId).messagePost({
        body: await this._t("%s has accepted invitation", await attendee.commonName),
        subtypeXmlid: "calendar.subtypeInvitation"
      });
    }
    return this.write({ 'state': 'accepted' });
  }

  /**
   * Marks event invitation as Declined.
   * @returns 
   */
  async doDecline() {
    for (const attendee of this) {
      await (await attendee.eventId).messagePost({
        body: await this._t("%s has declined invitation", await attendee.commonName),
        subtypeXmlid: "calendar.subtypeInvitation"
      });
    }
    return this.write({ 'state': 'declined' });
  }
}