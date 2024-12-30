/** @verp-module **/

import { datetimeToStr } from 'web.time';

/**
 * Allows to generate mocked models that will be used by the mocked server.
 * This is defined as a class to allow patches by dependent modules and a new
 * data object is generated every time to ensure any test can modify it without
 * impacting other tests.
 */
export class MockModels {

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Returns a new data set of mocked models.
     *
     * @static
     * @returns {Object}
     */
    static generateData() {
        return {
            'ir.attachment': {
                fields: {
                    checksum: { string: 'cheksum', type: 'char' },
                    createdAt: { type: 'date' },
                    createdUid: { string: "Created By", type: "many2one", relation: 'res.users' },
                    datas: { string: "File Content (base64)", type: 'binary' },
                    mimetype: { string: "mimetype", type: 'char' },
                    name: { string: "attachment name", type: 'char', required: true },
                    resId: { string: "res id", type: 'integer' },
                    resModel: { type: 'char', string: "res model" },
                    type: { type: 'selection', selection: [['url', "URL"], ['binary', "BINARY"]] },
                    url: { string: 'url', type: 'char' },
                },
                records: [],
            },
            'mail.activity': {
                fields: {
                    activityCategory: { string: "Category", type: 'selection', selection: [['default', 'Other'], ['upload_file', 'Upload File']] },
                    activityTypeId: { string: "Activity type", type: "many2one", relation: "mail.activity.type" },
                    canWrite: { string: "Can write", type: "boolean" },
                    chainingType: { string: 'Chaining Type', type: 'selection', selection: [['suggest', 'Suggest Next Activity'], ['trigger', 'Trigger Next Activity']], default: 'suggest' },
                    createdUid: { string: "Created By", type: "many2one", relation: 'res.users' },
                    displayName: { string: "Display name", type: "char" },
                    dateDeadline: { string: "Due Date", type: "date", default() { return moment().format('YYYY-MM-DD'); } },
                    icon: { type: 'char' },
                    note: { string: "Note", type: "html" },
                    resId: { type: 'integer' },
                    resModel: { type: 'char' },
                    state: { string: 'State', type: 'selection', selection: [['overdue', 'Overdue'], ['today', 'Today'], ['planned', 'Planned']] },
                    userId: { string: "Assigned to", type: "many2one", relation: 'res.users' },
                },
                records: [],
            },
            'mail.activity.type': {
                fields: {
                    chainingType: { string: 'Chaining Type', type: 'selection', selection: [['suggest', 'Suggest Next Activity'], ['trigger', 'Trigger Next Activity']], default: 'suggest' },
                    category: { string: 'Category', type: 'selection', selection: [['default', 'Other'], ['upload_file', 'Upload File']] },
                    decoration_type: { string: "Decoration Type", type: "selection", selection: [['warning', 'Alert'], ['danger', 'Error']] },
                    icon: { string: 'icon', type: "char" },
                    name: { string: "Name", type: "char" },
                },
                records: [
                    { icon: 'fa-envelope', id: 1, name: "Email" },
                ],
            },
            'mail.channel': {
                fields: {
                    // In javascript this is not a real field but a compute. Here for simplicity.
                    avatarCacheKey: { string: "Avatar Cache Key", type: "datetime", default() { moment.utc().format("YYYYMMDDHHmmss"); } },
                    channelType: { string: "Channel Type", type: "selection", default: 'channel' },
                    // In javascript this belongs to mail.channel.partner. Here for simplicity.
                    custom_channel_name: { string: "Custom channel name", type: 'char' },
                    fetched_message_id: { string: "Last Fetched", type: 'many2one', relation: 'mail.message' },
                    group_based_subscription: { string: "Group based subscription", type: "boolean", default: false },
                    id: { string: "Id", type: 'integer' },
                    // In javascript this belongs to mail.channel.partner. Here for simplicity.
                    isMinimized: { string: "isMinimized", type: "boolean", default: false },
                    // In javascript this belongs to mail.channel.partner. Here for simplicity.
                    is_pinned: { string: "isPinned", type: "boolean", default: true },
                    // In javascript this belongs to mail.channel.partner. Here for simplicity.
                    last_interest_dt: { string: "Last Interest", type: "datetime", default() {
                        return datetimeToStr(new Date());
                    } },
                    members: { string: "Members", type: 'many2many', relation: 'res.partner', default() { return [this.currentPartnerId]; } },
                    message_unread_counter: { string: "# unread messages", type: 'integer' },
                    name: { string: "Name", type: "char", required: true },
                    isPublic: { string: "Public", type: "boolean", default: 'groups' },
                    seen_message_id: { string: "Last Seen", type: 'many2one', relation: 'mail.message' },
                    // In javascript this belongs to mail.channel.partner. Here for simplicity.
                    state: { string: "FoldState", type: "char", default: 'open' },
                    // naive and non RFC-compliant UUID, good enough for the
                    // string comparison that are done with it during tests
                    uuid: { string: "UUID", type: "char", required: true, default() { return _.uniqueId('mail.channel_uuid-'); } },
                },
                records: [],
            },
            'mail.followers': {
                fields: {
                    email: { type: 'char' },
                    id: { type: 'integer' },
                    is_active: { type: 'boolean' },
                    is_editable: { type: 'boolean' },
                    name: { type: 'char' },
                    partnerId: { type: 'integer' },
                    resId: { type: 'many2one_reference' },
                    resModel: { type: 'char' },
                    subtype_ids: { type: 'many2many', relation: 'mail.message.subtype' }
                },
                records: [],
            },
            'mail.message': {
                fields: {
                    attachmentIds: { string: "Attachments", type: 'many2many', relation: 'ir.attachment', default: [] },
                    authorId: { string: "Author", type: 'many2one', relation: 'res.partner', default() { return this.currentPartnerId; } },
                    body: { string: "Contents", type: 'html', default: "<p></p>" },
                    date: { string: "Date", type: 'datetime', default() { return moment.utc().format("YYYY-MM-DD HH:mm:ss"); } },
                    email_from: { string: "From", type: 'char' },
                    history_partner_ids: { string: "Partners with History", type: 'many2many', relation: 'res.partner' },
                    id: { string: "Id", type: 'integer' },
                    isDiscussion: { string: "Discussion", type: 'boolean' },
                    isNote: { string: "Note", type: 'boolean' },
                    isNotification: { string: "Notification", type: 'boolean' },
                    messageType: { string: "Type", type: 'selection', default: 'email' },
                    model: { string: "Related Document model", type: 'char' },
                    needaction: { string: "Need Action", type: 'boolean' },
                    needactionPartnerIds: { string: "Partners with Need Action", type: 'many2many', relation: 'res.partner' },
                    notification_ids: { string: "Notifications", type: 'one2many', relation: 'mail.notification' },
                    partnerIds: { string: "Recipients", type: 'many2many', relation: 'res.partner' },
                    recordName: { string: "Name", type: 'char' },
                    resId: { string: "Related Document ID", type: 'integer' },
                    // In javascript, result of a formatter. Here for simplicity.
                    resModelName: { string: "Res Model Name", type: 'char' },
                    starredPartnerIds: { string: "Favorited By", type: 'many2many', relation: 'res.partner' },
                    subject: { string: "Subject", type: 'char' },
                    subtypeId: { string: "Subtype id", type: 'many2one', relation: 'mail.message.subtype' },
                    trackingValueIds: { relation: 'mail.tracking.value', string: "Tracking values", type: 'one2many' },
                },
                records: [],
            },
            'mail.message.subtype': {
                fields: {
                    default: { type: 'boolean', default: true },
                    description: { type: 'text' },
                    hidden: { type: 'boolean' },
                    internal: { type: 'boolean' },
                    name: { type: 'char' },
                    parentId: { type: 'many2one', relation: 'mail.message.subtype' },
                    relationField: { type: 'char' },
                    resModel: { type: 'char' },
                    sequence: { type: 'integer', default: 1 },
                    // not a field in Javascript but xml id of data
                    subtype_xmlid: { type: 'char' },
                },
                records: [
                    { name: "Discussions", sequence: 0, subtype_xmlid: 'mail.mtComment' },
                    { default: false, internal: true, name: "Note", sequence: 100, subtype_xmlid: 'mail.mt_note' },
                    { default: false, internal: true, name: "Activities", sequence: 90, subtype_xmlid: 'mail.mt_activities' },
                ],
            },
            'mail.notification': {
                fields: {
                    failureType: { string: "Failure Type", type: 'selection', selection: [["SMTP", "Connection failed (outgoing mail server problem)"], ["RECIPIENT", "Invalid email address"], ["BOUNCE", "Email address rejected by destination"], ["UNKNOWN", "Unknown error"]] },
                    is_read: { string: "Is Read", type: 'boolean', default: false },
                    mail_message_id: { string: "Message", type: 'many2one', relation: 'mail.message' },
                    notification_status: { string: "Notification Status", type: 'selection', selection: [['ready', 'Ready to Send'], ['sent', 'Sent'], ['bounce', 'Bounced'], ['exception', 'Exception'], ['canceled', 'Canceled']], default: 'ready' },
                    notificationType: { string: "Notification Type", type: 'selection', selection: [['email', 'Handle by Emails'], ['inbox', 'Handle in Verp']], default: 'email' },
                    resPartnerId: { string: "Needaction Recipient", type: 'many2one', relation: 'res.partner' },
                },
                records: [],
            },
            'mail.shortcode': {
                fields: {
                    source: { type: 'char' },
                    substitution: { type: 'char' },
                },
                records: [],
            },
            'mail.tracking.value': {
                fields: {
                    changed_field: { string: 'Changed field', type: 'char' },
                    field_type: { string: 'Field type', type: 'char' },
                    new_value: { string: 'New value', type: 'char' },
                    old_value: { string: 'Old value', type: 'char' },
                },
                records: [],
            },
            'res.users.settings': {
                fields: {
                    isDiscussSidebarCategoryChannelOpen: { string: "Is Discuss Sidebar Category Channel Open?", type: 'boolean', default: true },
                    isDiscussSidebarCategoryChatOpen: { string: "Is Discuss Sidebar Category Chat Open?", type: 'boolean', default: true },
                    userId: { string: "User Id", type: 'many2one', relation: 'res.users' },
                },
                records: [],
            },
            'res.country': {
                fields: {
                    code: { string: "Code", type: 'char' },
                    name: { string: "Name", type: 'char' },
                },
                records: [],
            },
            'res.partner': {
                fields: {
                    active: { string: "Active", type: 'boolean', default: true },
                    activityIds: { string: "Activities", type: 'one2many', relation: 'mail.activity' },
                    contact_address_complete: { string: "Address", type: 'char' },
                    countryId: { string: "Country", type: 'many2one', relation: 'res.country' },
                    description: { string: 'description', type: 'text' },
                    displayName: { string: "Displayed name", type: "char" },
                    email: { type: 'char' },
                    avatar128: { string: "Image 128", type: 'image' },
                    imStatus: { string: "IM Status", type: 'char' },
                    messageFollowerIds: { relation: 'mail.followers', string: "Followers", type: "one2many" },
                    messageAttachmentCount: { string: 'Attachment count', type: 'integer' },
                    messageIds: { string: "Messages", type: 'one2many', relation: 'mail.message' },
                    name: { string: "Name", type: 'char' },
                    partner_latitude: { string: "Latitude", type: 'float' },
                    partner_longitude: { string: "Longitude", type: 'float' },
                    partner_share: { string: "Share Partner", type: 'boolean', default: false }, // in javascript a compute, hard-coded value here for simplicity
                    user_ids: { string: "Users", type: "one2many", relation: 'res.users', default:[] },
                },
                records: [],
            },
            'res.users': {
                fields: {
                    active: { string: "Active", type: 'boolean', default: true },
                    displayName: { string: "Display name", type: "char" },
                    imStatus: { string: "IM Status", type: 'char' },
                    name: { string: "Name", type: 'char' },
                    partnerId: { string: "Related partners", type: 'many2one', relation: 'res.partner' },
                    share: { string: "Shared users", type: 'boolean', default: false },
                },
                records: [],
            },
            'res.fake': {
                fields: {
                    activityIds: { string: "Activities", type: 'one2many', relation: 'mail.activity' },
                    emailCc: { type: 'char' },
                    partnerIds: {
                        string: "Related partners",
                        type: 'one2many',
                        relation: 'res.partner'
                    },
                },
                records: [],
            },
        };
    }

}
