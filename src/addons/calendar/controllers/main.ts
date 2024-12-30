import { http } from "../../../core";
import { bool, f, getLang, parseInt } from "../../../core/tools";

@http.define()
class CalendarController extends http.Controller {
  static _module = module;

  // YTI Note: Keep id and kwargs only for retrocompatibility purpose
  @http.route('/calendar/meeting/accept', { type: 'http', auth: "calendar" })
  async acceptMeeting(req, res, opts: { token?: any, id?: any } = {}) {
    const attendee = await (await (await req.getEnv()).items('calendar.attendee').sudo()).search([
      ['accessToken', '=', opts.token],
      ['state', '!=', 'accepted']]);
    await attendee.doAccept();
    return this.viewMeeting(req, res, opts);
  }

  @http.route('/calendar/recurrence/accept', { type: 'http', auth: "calendar" })
  async acceptRecurrence(req, res, opts: { token?: any, id?: any, } = {}) {
    const env = await req.getEnv();
    const attendee = await (await env.items('calendar.attendee').sudo()).search([
      ['accessToken', '=', opts.token],
      ['state', '!=', 'accepted']]);
    if (bool(attendee)) {
      const attendees = await (await env.items('calendar.attendee').sudo()).search([
        ['eventId', 'in', (await (await (await attendee.eventId).recurrenceId).calendarEventIds).ids],
        ['partnerId', '=', (await attendee.partnerId).id],
        ['state', '!=', 'accepted'],
      ]);
      await attendees.doAccept();
    }
    return this.viewMeeting(req, res, opts);
  }

  @http.route('/calendar/meeting/decline', { type: 'http', auth: "calendar" })
  async declineMeeting(req, res, opts: { token?: any, id?: any } = {}) {
    const attendee = await (await (await req.getEnv()).items('calendar.attendee').sudo()).search([
      ['accessToken', '=', opts.token],
      ['state', '!=', 'declined']]);
    await attendee.doDecline();
    return this.viewMeeting(req, res, opts);
  }

  @http.route('/calendar/recurrence/decline', { type: 'http', auth: "calendar" })
  async declineRecurrence(req, res, opts: { token?: any, id?: any } = {}) {
    const env = await req.getEnv();
    const attendee = await (await env.items('calendar.attendee').sudo()).search([
      ['accessToken', '=', opts.token],
      ['state', '!=', 'declined']]);
    if (bool(attendee)) {
      const attendees = await (await env.items('calendar.attendee').sudo()).search([
        ['eventId', 'in', (await (await (await attendee.eventId).recurrenceId).calendarEventIds).ids],
        ['partnerId', '=', (await attendee.partnerId).id],
        ['state', '!=', 'declined'],
      ]);
      await attendees.doDecline();
    }
    return this.viewMeeting(req, res, opts);
  }

  @http.route('/calendar/meeting/view', { type: 'http', auth: "calendar" })
  async viewMeeting(req, res, opts: { token?: any, id?: any } = {}) {
    const env = await req.getEnv();
    const attendee = await (await env.items('calendar.attendee').sudo()).search([
      ['accessToken', '=', opts.token],
      ['eventId', '=', parseInt(opts.id)]]);
    if (!bool(attendee)) {
      return req.notFound(res);
    }
    const partner = await attendee.partnerId;
    const timezone = await partner.tz;
    const lang = await partner.lang || await (await getLang(env)).code;
    const event = (await (await env.items('calendar.event').withContext({ tz: timezone, lang: lang })).sudo()).browse(parseInt(opts.id));
    const user = await event.userId;
    let company = user.ok && await user.companyId;
    company = company.ok ? company : await (await event.createdUid).companyId;

    // If user is internal and logged, redirect to form view of event
    // otherwise, display the simplifyed web page with event informations
    if (req.session.uid && await env.items('res.users').browse(req.session.uid).userHasGroups('base.groupUser')) {
      return req.redirect(res, f('/web?db=%s#id=%s&viewType=form&model=calendar.event', env.cr.dbName, opts.id));
    }

    // NOTE : we don't use request.render() since:
    // - we need a template rendering which is not lazy, to render before cursor closing
    // - we need to display the template in the language of the user (not possible with
    //   request.render())
    const responseContent = await (await env.items('ir.ui.view').withContext({ lang: lang }))._renderTemplate(
      'calendar.invitationPageAnonymous', {
      'company': company,
      'event': event,
      'attendee': attendee,
    })
    return req.makeResponse(res, responseContent, [['Content-Type', 'text/html']]);
  }

  @http.route('/calendar/meeting/join', { type: 'http', auth: "user", website: true })
  async calendarJoinMeeting(req, res, opts: { token?: any } = {}) {
    const env = await req.getEnv();
    const event = await (await env.items('calendar.event').sudo()).search([['accessToken', '=', opts.token]]);
    if (!bool(event)) {
      return req.notFound(res);
    }
    const user = await env.user();
    await event.actionJoinMeeting((await user.partnerId).id);
    const attendee = await (await env.items('calendar.attendee').sudo()).search([['partnerId', '=', (await user.partnerId).id], ['eventId', '=', event.id]]);
    return req.redirect(res, f('/calendar/meeting/view?token=%s&id=%s', await attendee.accessToken, event.id));
  }

  // Function used, in RPC to check every 5 minutes, if notification to do for an event or not
  @http.route('/calendar/notify', { type: 'json', auth: "user" })
  async notify(req, res) {
    return (await req.getEnv()).items('calendar.alarm.manager').getNextNotif();
  }

  @http.route('/calendar/notifyAck', { type: 'json', auth: "user" })
  async notifyAck(req, res) {
    return (await (await req.getEnv()).items('res.partner').sudo())._setCalendarLastNotifAck();
  }
}