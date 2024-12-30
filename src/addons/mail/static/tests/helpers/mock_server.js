/** @verp-module **/

import { nextAnimationFrame } from '@mail/utils/test_utils';

import MockServer from 'web.MockServer';
import { datetimeToStr } from 'web.time';

MockServer.include({
    /**
     * Param 'data' may have keys for the different magic partners/users.
     *
     * Note: we must delete these keys, so that this is not
     * handled as a model definition.
     *
     * @override
     * @param {Object} [data.currentPartnerId]
     * @param {Object} [data.currentUserId]
     * @param {Object} [data.partnerRootId]
     * @param {Object} [data.publicPartnerId]
     * @param {Object} [data.publicUserId]
     * @param {Widget} [options.widget] mocked widget (use to call services)
     */
    init(data, options) {
        if (data && data.currentPartnerId) {
            this.currentPartnerId = data.currentPartnerId;
            delete data.currentPartnerId;
        }
        if (data && data.currentUserId) {
            this.currentUserId = data.currentUserId;
            delete data.currentUserId;
        }
        if (data && data.partnerRootId) {
            this.partnerRootId = data.partnerRootId;
            delete data.partnerRootId;
        }
        if (data && data.publicPartnerId) {
            this.publicPartnerId = data.publicPartnerId;
            delete data.publicPartnerId;
        }
        if (data && data.publicUserId) {
            this.publicUserId = data.publicUserId;
            delete data.publicUserId;
        }
        this._widget = options.widget;

        this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    async _performFetch(resource, init) {
        if (resource === '/mail/attachment/upload') {
            const ufile = init.body.get('ufile');
            const is_pending = init.body.get('isPending') === 'true';
            const model = is_pending ? 'mail.compose.message' : init.body.get('threadModel');
            const id = is_pending ? 0 : parseInt(init.body.get('threadId'));
            const attachmentId = this._mockCreate('ir.attachment', {
                // datas,
                mimetype: ufile.type,
                label: ufile.name,
                resId: id,
                resModel: model,
            });
            const attachment = this._getRecords('ir.attachment', [['id', '=', attachmentId]])[0];
            return new window.Response(JSON.stringify({
                'filename': attachment.label,
                'id': attachment.id,
                'mimetype': attachment.mimetype,
                'size': attachment.fileSize
            }));
        }
        return this._super(...arguments);
    },
    /**
     * @override
     */
    async _performRpc(route, args) {
        // routes
        if (route === '/mail/message/post') {
            if (args.thread_model === 'mail.channel') {
                return this._mockMailChannelMessagePost(args.threadId, args.post_data, args.context);
            }
            return this._mockMailThreadMessagePost(args.thread_model, [args.threadId], args.post_data, args.context);
        }
        if (route === '/mail/attachment/delete') {
            const { attachmentId } = args;
            return this._mockRouteMailAttachmentRemove(attachmentId);
        }
        if (route === '/mail/chat_post') {
            const uuid = args.uuid;
            const message_content = args.message_content;
            const context = args.context;
            return this._mockRouteMailChatPost(uuid, message_content, context);
        }
        if (route === '/mail/get_suggested_recipients') {
            const model = args.model;
            const resIds = args.resIds;
            return this._mockRouteMailGetSuggestedRecipient(model, resIds);
        }
        if (route === '/mail/initMessaging') {
            return this._mockRouteMailInitMessaging();
        }
        if (route === '/mail/load_message_failures') {
            return this._mockRouteMailLoadMessageFailures();
        }
        if (route === '/mail/history/messages') {
            const { min_id, max_id, limit } = args;
            return this._mockRouteMailMessageHistory(min_id, max_id, limit);
        }
        if (route === '/mail/inbox/messages') {
            const { min_id, max_id, limit } = args;
            return this._mockRouteMailMessageInbox(min_id, max_id, limit);
        }
        if (route === '/mail/starred/messages') {
            const { min_id, max_id, limit } = args;
            return this._mockRouteMailMessageStarredMessages(min_id, max_id, limit);
        }
        if (route === '/mail/read_followers') {
            return this._mockRouteMailReadFollowers(args);
        }
        if (route === '/mail/read_subscription_data') {
            const follower_id = args.follower_id;
            return this._mockRouteMailReadSubscriptionData(follower_id);
        }
        if (route === '/mail/thread/data') {
            return this._mockRouteMailThreadData(args.thread_model, args.threadId, args.request_list);
        }
        if (route === '/mail/thread/messages') {
            const { min_id, max_id, limit, thread_model, threadId } = args;
            return this._mockRouteMailThreadFetchMessages(thread_model, threadId, max_id, min_id, limit);
        }
        if (route === '/mail/channel/messages') {
            const { channelId, min_id, max_id, limit } = args;
            return this._mockRouteMailChannelMessages(channelId, max_id, min_id, limit);
        }
        if (new RegExp('/mail/channel/\\d+/partner/\\d+/avatar128').test(route)) {
            return;
        }
        // mail.activity methods
        if (args.model === 'mail.activity' && args.method === 'activityFormat') {
            let res = this._mockRead(args.model, args.args, args.kwargs);
            res = res.map(function (record) {
                if (record.mailTemplateIds) {
                    record.mailTemplateIds = record.mailTemplateIds.map(function (template_id) {
                        return { id: template_id, name: "template" + template_id };
                    });
                }
                return record;
            });
            return res;
        }
        if (args.model === 'mail.activity' && args.method === 'get_activity_data') {
            const resModel = args.args[0] || args.kwargs.resModel;
            const domain = args.args[1] || args.kwargs.domain;
            return this._mockMailActivityGetActivityData(resModel, domain);
        }
        // mail.channel methods
        if (args.model === 'mail.channel' && args.method === 'action_unfollow') {
            const ids = args.args[0];
            return this._mockMailChannelActionUnfollow(ids);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_fetched') {
            const ids = args.args[0];
            return this._mockMailChannelChannelFetched(ids);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_fetch_listeners') {
            return [];
        }
        if (args.model === 'mail.channel' && args.method === 'channel_fetch_preview') {
            const ids = args.args[0];
            return this._mockMailChannelChannelFetchPreview(ids);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_fold') {
            const uuid = args.args[0] || args.kwargs.uuid;
            const state = args.args[1] || args.kwargs.state;
            return this._mockMailChannelChannelFold(uuid, state);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_get') {
            const partners_to = args.args[0] || args.kwargs.partners_to;
            const pin = args.args[1] !== undefined
                ? args.args[1]
                : args.kwargs.pin !== undefined
                    ? args.kwargs.pin
                    : undefined;
            return this._mockMailChannelChannelGet(partners_to, pin);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_info') {
            const ids = args.args[0];
            return this._mockMailChannelChannelInfo(ids);
        }
        if (args.model === 'mail.channel' && args.method === 'add_members') {
            const ids = args.args[0];
            const partnerIds = args.args[1] || args.kwargs.partnerIds;
            return this._mockMailChannelAddMembers(ids, partnerIds);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_pin') {
            const uuid = args.args[0] || args.kwargs.uuid;
            const pinned = args.args[1] || args.kwargs.pinned;
            return this._mockMailChannelChannelPin(uuid, pinned);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_rename') {
            const ids = args.args[0];
            const name = args.args[1] || args.kwargs.name;
            return this._mockMailChannelChannelRename(ids, name);
        }
        if (route === '/mail/channel/set_last_seen_message') {
            const id = args.channelId;
            const last_message_id = args.last_message_id;
            return this._mockMailChannel_ChannelSeen([id], last_message_id);
        }
        if (args.model === 'mail.channel' && args.method === 'channel_set_custom_name') {
            const ids = args.args[0];
            const name = args.args[1] || args.kwargs.name;
            return this._mockMailChannelChannelSetCustomName(ids, name);
        }
        if (args.model === 'mail.channel' && args.method === 'create_group') {
            const partners_to = args.args[0] || args.kwargs.partners_to;
            return this._mockMailChannelCreateGroup(partners_to);
        }
        if (args.model === 'mail.channel' && args.method === 'execute_command_leave') {
            return this._mockMailChannelExecuteCommandLeave(args);
        }
        if (args.model === 'mail.channel' && args.method === 'execute_command_who') {
            return this._mockMailChannelExecuteCommandWho(args);
        }
        if (args.model === 'mail.channel' && args.method === 'notify_typing') {
            const ids = args.args[0];
            const is_typing = args.args[1] || args.kwargs.is_typing;
            const context = args.kwargs.context;
            return this._mockMailChannelNotifyTyping(ids, is_typing, context);
        }
        if (args.model === 'mail.channel' && args.method === 'write' && 'image128' in args.args[1]) {
            const ids = args.args[0];
            return this._mockMailChannelWriteImage128(ids[0]);
        }
        // mail.message methods
        if (args.model === 'mail.message' && args.method === 'mark_all_as_read') {
            const domain = args.args[0] || args.kwargs.domain;
            return this._mockMailMessageMarkAllAsRead(domain);
        }
        if (args.model === 'mail.message' && args.method === 'message_format') {
            const ids = args.args[0];
            return this._mockMailMessageMessageFormat(ids);
        }
        if (args.model === 'mail.message' && args.method === 'set_message_done') {
            const ids = args.args[0];
            return this._mockMailMessageSetMessageDone(ids);
        }
        if (args.model === 'mail.message' && args.method === 'toggle_message_starred') {
            const ids = args.args[0];
            return this._mockMailMessageToggleMessageStarred(ids);
        }
        if (args.model === 'mail.message' && args.method === 'unstar_all') {
            return this._mockMailMessageUnstarAll();
        }
        if (args.model === 'res.users.settings' && args.method === '_find_or_create_for_user') {
            const userId = args.args[0][0];
            return this._mockResUsersSettings_FindOrCreateForUser(userId);
        }
        if (args.model === 'res.users.settings' && args.method === 'set_res_users_settings') {
            const id = args.args[0][0];
            const newSettings = args.kwargs.new_settings;
            return this._mockResUsersSettingsSetResUsersSettings(id, newSettings);
        }
        // res.partner methods
        if (args.method === 'get_mention_suggestions') {
            if (args.model === 'mail.channel') {
                return this._mockMailChannelGetMentionSuggestions(args);
            }
            if (args.model === 'res.partner') {
                return this._mockResPartnerGetMentionSuggestions(args);
            }
        }
        if (args.model === 'res.partner' && args.method === 'im_search') {
            const name = args.args[0] || args.kwargs.search;
            const limit = args.args[1] || args.kwargs.limit;
            return this._mockResPartnerImSearch(name, limit);
        }
        if (args.model === 'res.partner' && args.method === 'search_for_channel_invite') {
            const search_term = args.args[0] || args.kwargs.search_term;
            const channelId = args.args[1] || args.kwargs.channelId;
            const limit = args.args[2] || args.kwargs.limit;
            return this._mockResPartnerSearchForChannelInvite(search_term, channelId, limit);
        }
        // mail.thread methods (can work on any model)
        if (args.method === 'message_subscribe') {
            const ids = args.args[0];
            const partnerIds = args.args[1] || args.kwargs.partnerIds;
            const subtype_ids = args.args[2] || args.kwargs.subtype_ids;
            return this._mockMailThreadMessageSubscribe(args.model, ids, partnerIds, subtype_ids);
        }
        if (args.method === 'message_unsubscribe') {
            const ids = args.args[0];
            const partnerIds = args.args[1] || args.kwargs.partnerIds;
            return this._mockMailThreadMessageUnsubscribe(args.model, ids, partnerIds);
        }
        if (args.method === 'messagePost') {
            const id = args.args[0];
            const kwargs = args.kwargs;
            const context = kwargs.context;
            delete kwargs.context;
            return this._mockMailThreadMessagePost(args.model, [id], kwargs, context);
        }
        return this._super(route, args);
    },

    //--------------------------------------------------------------------------
    // Private Mocked Routes
    //--------------------------------------------------------------------------

    /**
     * Simulates the `/mail/attachment/delete` route.
     *
     * @private
     * @param {integer} attachmentId
     */
    async _mockRouteMailAttachmentRemove(attachmentId) {
        return this._mockUnlink('ir.attachment', [[attachmentId]]);
    },

    /**
     * Simulates the `/mail/channel/messages` route.
     *
     * @private
     * @param {integer} channelId
     * @param {integer} limit
     * @param {integer} max_id
     * @param {integer} min_id
     * @returns {Object} list of messages
     */
    async _mockRouteMailChannelMessages(channelId, max_id = false, min_id = false, limit = 30) {
        const domain = [
            ['resId', '=', channelId],
            ['model', '=', 'mail.channel'],
            ['messageType', '!=', 'userNotification'],
        ];
        return this._mockMailMessage_MessageFetch(domain, max_id, min_id, limit);
    },

    /**
     * Simulates the `/mail/chat_post` route.
     *
     * @private
     * @param {string} uuid
     * @param {string} message_content
     * @param {Object} [context={}]
     * @returns {Object} one key for list of followers and one for subtypes
     */
    async _mockRouteMailChatPost(uuid, message_content, context = {}) {
        const mailChannel = this._getRecords('mail.channel', [['uuid', '=', uuid]])[0];
        if (!mailChannel) {
            return false;
        }

        let userId;
        // find the author from the user session
        if ('mockedUserId' in context) {
            // can be falsy to simulate not being logged in
            userId = context.mockedUserId;
        } else {
            userId = this.currentUserId;
        }
        let authorId;
        let email_from;
        if (userId) {
            const author = this._getRecords('res.users', [['id', '=', userId]])[0];
            authorId = author.partnerId;
            email_from = `${author.displayName} <${author.email}>`;
        } else {
            authorId = false;
            // simpler fallback than catchall_formatted
            email_from = mailChannel.anonymous_name || "catchall@example.com";
        }
        // supposedly should convert plain text to html
        const body = message_content;
        // ideally should be posted with mail_create_nosubscribe=true
        return this._mockMailChannelMessagePost(
            mailChannel.id,
            {
                authorId,
                email_from,
                body,
                messageType: 'comment',
                subtype_xmlid: 'mail.mtComment',
            },
            context
        );
    },
    /**
     * Simulates `/mail/get_suggested_recipients` route.
     *
     * @private
     * @returns {string} model
     * @returns {integer[]} resIds
     * @returns {Object}
     */
    _mockRouteMailGetSuggestedRecipient(model, resIds) {
        if (model === 'res.fake') {
            return this._mockResFake_MessageGetSuggestedRecipients(model, resIds);
        }
        return this._mockMailThread_MessageGetSuggestedRecipients(model, resIds);
    },
    /**
     * Simulates the `/mail/initMessaging` route.
     *
     * @private
     * @returns {Object}
     */
    _mockRouteMailInitMessaging() {
        return this._mockResUsers_InitMessaging([this.currentUserId]);
    },
    /**
     * Simulates the `/mail/load_message_failures` route.
     *
     * @private
     * @returns {Object[]}
     */
    _mockRouteMailLoadMessageFailures() {
        return this._mockResPartner_MessageFetchFailed(this.currentPartnerId);
    },
    /**
     * Simulates the `/mail/history/messages` route.
     *
     * @private
     * @returns {Object}
     */
    _mockRouteMailMessageHistory(min_id = false, max_id = false, limit = 30) {
        const domain = [['needaction', '=', false]];
        return this._mockMailMessage_MessageFetch(domain, max_id, min_id, limit);
    },
    /**
     * Simulates the `/mail/inbox/messages` route.
     *
     * @private
     * @returns {Object}
     */
    _mockRouteMailMessageInbox(min_id = false, max_id = false, limit = 30) {
        const domain = [['needaction', '=', true]];
        return this._mockMailMessage_MessageFetch(domain, max_id, min_id, limit);
    },
    /**
     * Simulates the `/mail/starred/messages` route.
     *
     * @private
     * @returns {Object}
     */
    _mockRouteMailMessageStarredMessages(min_id = false, max_id = false, limit = 30) {
        const domain = [['starredPartnerIds', 'in', [this.currentPartnerId]]];
        return this._mockMailMessage_MessageFetch(domain, max_id, min_id, limit);
    },
    /**
     * Simulates the `/mail/read_followers` route.
     *
     * @private
     * @param {integer[]} follower_ids
     * @returns {Object} one key for list of followers and one for subtypes
     */
    async _mockRouteMailReadFollowers(args) {
        const resId = args.resId; // id of record to read the followers
        const resModel = args.resModel; // model of record to read the followers
        const followers = this._getRecords('mail.followers', [['resId', '=', resId], ['resModel', '=', resModel]]);
        const currentPartnerFollower = followers.find(follower => follower.id === this.currentPartnerId);
        const subtypes = currentPartnerFollower
            ? this._mockRouteMailReadSubscriptionData(currentPartnerFollower.id)
            : false;
        return { followers, subtypes };
    },
    /**
     * Simulates the `/mail/read_subscription_data` route.
     *
     * @private
     * @param {integer} follower_id
     * @returns {Object[]} list of followed subtypes
     */
    async _mockRouteMailReadSubscriptionData(follower_id) {
        const follower = this._getRecords('mail.followers', [['id', '=', follower_id]])[0];
        const subtypes = this._getRecords('mail.message.subtype', [
            '&',
            ['hidden', '=', false],
            '|',
            ['resModel', '=', follower.resModel],
            ['resModel', '=', false],
        ]);
        const subtypes_list = subtypes.map(subtype => {
            const parent = this._getRecords('mail.message.subtype', [
                ['id', '=', subtype.parentId],
            ])[0];
            return {
                'default': subtype.default,
                'followed': follower.subtype_ids.includes(subtype.id),
                'id': subtype.id,
                'internal': subtype.internal,
                'name': subtype.name,
                'parent_model': parent ? parent.resModel : false,
                'resModel': subtype.resModel,
                'sequence': subtype.sequence,
            };
        });
        // NOTE: server is also doing a sort here, not reproduced for simplicity
        return subtypes_list;
    },

    /**
     * Simulates the `/mail/thread/data` route.
     *
     * @param {string} thread_model
     * @param {integer} threadId
     * @param {string[]} request_list
     * @returns {Object}
     */
    async _mockRouteMailThreadData(thread_model, threadId, request_list) {
        const res = {};
        const thread = this._mockSearchRead(thread_model, [[['id', '=', threadId]]], {})[0];
        if (request_list.includes('attachments')) {
            const attachments = this._mockSearchRead('ir.attachment', [
                [['resId', '=', thread.id], ['resModel', '=', thread_model]],
            ], {}); // order not done for simplicity
            res['attachments'] = this._mockIrAttachment_attachmentFormat(attachments.map(attachment => attachment.id), true);
        }
        return res;
    },

    /**
     * Simulates the `/mail/thread/messages` route.
     *
     * @private
     * @param {string} resModel
     * @param {integer} resId
     * @param {integer} max_id
     * @param {integer} min_id
     * @param {integer} limit
     * @returns {Object[]} list of messages
     */
    async _mockRouteMailThreadFetchMessages(resModel, resId, max_id = false, min_id = false, limit = 30) {
        const domain = [
            ['resId', '=', resId],
            ['model', '=', resModel],
            ['messageType', '!=', 'userNotification'],
        ];
        return this._mockMailMessage_MessageFetch(domain, max_id, min_id, limit);
    },

    //--------------------------------------------------------------------------
    // Private Mocked Methods
    //--------------------------------------------------------------------------

    /**
     * Simulates `_attachment_format` on `ir.attachment`.
     *
     * @private
     * @param {string} resModel
     * @param {string} domain
     * @returns {Object}
     */
    _mockIrAttachment_attachmentFormat(ids, commands = false) {
        const attachments = this._mockRead('ir.attachment', [ids]);
        return attachments.map(attachment => {
            const res = {
                'checksum': attachment.checksum,
                'filename': attachment.name,
                'id': attachment.id,
                'mimetype': attachment.mimetype,
                'name': attachment.name,
            };
            if (commands) {
                res['originThread'] = [['insert', {
                    'id': attachment.resId,
                    'model': attachment.resModel,
                }]];
            } else {
                Object.assign(res, {
                    'resId': attachment.resId,
                    'resModel': attachment.resModel,
                });
            }
            return res;
        });
    },

    /**
     * Simulates `get_activity_data` on `mail.activity`.
     *
     * @private
     * @param {string} resModel
     * @param {string} domain
     * @returns {Object}
     */
    _mockMailActivityGetActivityData(resModel, domain) {
        const self = this;
        const records = this._getRecords(resModel, domain);

        const activityTypes = this._getRecords('mail.activity.type', []);
        const activityIds = _.pluck(records, 'activityIds').flat();

        const groupedActivities = {};
        const resIdToDeadline = {};
        const groups = self._mockReadGroup('mail.activity', {
            domain: [['id', 'in', activityIds]],
            fields: ['resId', 'activityTypeId', 'ids:array_agg(id)', 'dateDeadline:min(dateDeadline)'],
            groupby: ['resId', 'activityTypeId'],
            lazy: false,
        });
        groups.forEach(function (group) {
            // mockReadGroup doesn't correctly return all asked fields
            const activites = self._getRecords('mail.activity', group.__domain);
            group.activityTypeId = group.activityTypeId[0];
            let minDate;
            activites.forEach(function (activity) {
                if (!minDate || moment(activity.dateDeadline) < moment(minDate)) {
                    minDate = activity.dateDeadline;
                }
            });
            group.dateDeadline = minDate;
            resIdToDeadline[group.resId] = minDate;
            let state;
            if (group.dateDeadline === moment().format("YYYY-MM-DD")) {
                state = 'today';
            } else if (moment(group.dateDeadline) > moment()) {
                state = 'planned';
            } else {
                state = 'overdue';
            }
            if (!groupedActivities[group.resId]) {
                groupedActivities[group.resId] = {};
            }
            groupedActivities[group.resId][group.activityTypeId] = {
                count: group.__count,
                state: state,
                o-closest-deadline: group.dateDeadline,
                ids: _.pluck(activites, 'id'),
            };
        });

        return {
            activityTypes: activityTypes.map(function (type) {
                let mailTemplates = [];
                if (type.mailTemplateIds) {
                    mailTemplates = type.mailTemplateIds.map(function (id) {
                        const template = _.findWhere(self.data['mail.template'].records, { id: id });
                        return {
                            id: id,
                            name: template.name,
                        };
                    });
                }
                return [type.id, type.displayName, mailTemplates];
            }),
            activity_resIds: _.sortBy(_.pluck(records, 'id'), function (id) {
                return moment(resIdToDeadline[id]);
            }),
            grouped_activities: groupedActivities,
        };
    },
    /**
     * Simulates `action_unfollow` on `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     */
    _mockMailChannelActionUnfollow(ids) {
        const channel = this._getRecords('mail.channel', [['id', 'in', ids]])[0];
        if (!channel.members.includes(this.currentPartnerId)) {
            return true;
        }
        this._mockWrite('mail.channel', [
            [channel.id],
            {
                is_pinned: false,
                members: [[3, this.currentPartnerId]],
            },
        ]);
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.channel/leave',
            payload: {
                id: channel.id,
            },
        }]);
        /**
         * Leave message not posted here because it would send the new message
         * notification on a separate bus notification list from the unsubscribe
         * itself which would lead to the channel being pinned again (handler
         * for unsubscribe is weak and is relying on both of them to be sent
         * together on the bus).
         */
        // this._mockMailChannelMessagePost(channel.id, {
        //     authorId: this.currentPartnerId,
        //     body: '<div class="o-mail-notification">left the channel</div>',
        //     subtype_xmlid: "mail.mtComment",
        // });
        return true;
    },
    /**
     * Simulates `add_members` on `mail.channel`.
     * For simplicity only handles the current partner joining himself.
     *
     * @private
     * @param {integer[]} ids
     * @param {integer[]} partnerIds
     */
    _mockMailChannelAddMembers(ids, partnerIds) {
        const id = ids[0]; // ensure one
        const channel = this._getRecords('mail.channel', [['id', '=', id]])[0];
        // channel.partner not handled here for simplicity
        if (!channel.is_pinned) {
            this._mockWrite('mail.channel', [
                [channel.id],
                { is_pinned: true },
            ]);
            const body = `<div class="o-mail-notification">joined <a href="#" class="o_channel_redirect" data-oe-id="${channel.id}">#${channel.name}</a></div>`;
            const messageType = "notification";
            const subtype_xmlid = "mail.mtComment";
            this._mockMailChannelMessagePost(
                [channel.id],
                { body, messageType, subtype_xmlid },
            );
        }
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.channel/joined',
            payload: {
                'channel': this._mockMailChannelChannelInfo([channel.id])[0],
                'invited_by_user_id': this.currentUserId,
            },
        }]);
    },
    /**
     * Simulates `_broadcast` on `mail.channel`.
     *
     * @private
     * @param {integer} id
     * @param {integer[]} partnerIds
     * @returns {Object}
     */
    _mockMailChannel_broadcast(ids, partnerIds) {
        const notifications = this._mockMailChannel_channelChannelNotifications(ids, partnerIds);
        this._widget.call('busService', 'trigger', 'notification', notifications);
    },
    /**
     * Simulates `_channel_channel_notifications` on `mail.channel`.
     *
     * @private
     * @param {integer} id
     * @param {integer[]} partnerIds
     * @returns {Object}
     */
    _mockMailChannel_channelChannelNotifications(ids, partnerIds) {
        const notifications = [];
        for (const partnerId of partnerIds) {
            const user = this._getRecords('res.users', [['partnerId', 'in', partnerId]])[0];
            if (!user) {
                continue;
            }
            // Note: `channel_info` on the server is supposed to be called with
            // the proper user context, but this is not done here for simplicity
            // of not having `channel.partner`.
            const channelInfos = this._mockMailChannelChannelInfo(ids);
            for (const channelInfo of channelInfos) {
                notifications.push({
                    type: 'mail.channel/legacyInsert',
                    payload: {
                        id: channelInfo.id,
                        state: channelInfo.isMinimized ? 'open' : 'closed',
                    },
                });
            }
        }
        return notifications;
    },
    /**
     * Simulates `channel_fetched` on `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     * @param {string} extra_info
     */
    _mockMailChannelChannelFetched(ids) {
        const channels = this._getRecords('mail.channel', [['id', 'in', ids]]);
        for (const channel of channels) {
            const channelMessages = this._getRecords('mail.message', [
                ['model', '=', 'mail.channel'],
                ['resId', '=', channel.id],
            ]);
            const lastMessage = channelMessages.reduce((lastMessage, message) => {
                if (message.id > lastMessage.id) {
                    return message;
                }
                return lastMessage;
            }, channelMessages[0]);
            if (!lastMessage) {
                continue;
            }
            this._mockWrite('mail.channel', [
                [channel.id],
                { fetched_message_id: lastMessage.id },
            ]);
            this._widget.call('busService', 'trigger', 'notification', [{
                type: 'mail.channel.partner/fetched',
                payload: {
                    channelId: channel.id,
                    id: `${channel.id}/${this.currentPartnerId}`, // simulate channel.partner id
                    last_message_id: lastMessage.id,
                    partnerId: this.currentPartnerId,
                },
            }]);
        }
    },
    /**
     * Simulates `channel_fetch_preview` on `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     * @returns {Object[]} list of channels previews
     */
    _mockMailChannelChannelFetchPreview(ids) {
        const channels = this._getRecords('mail.channel', [['id', 'in', ids]]);
        return channels.map(channel => {
            const channelMessages = this._getRecords('mail.message', [
                ['model', '=', 'mail.channel'],
                ['resId', '=', channel.id],
            ]);
            const lastMessage = channelMessages.reduce((lastMessage, message) => {
                if (message.id > lastMessage.id) {
                    return message;
                }
                return lastMessage;
            }, channelMessages[0]);
            return {
                id: channel.id,
                last_message: lastMessage ? this._mockMailMessageMessageFormat([lastMessage.id])[0] : false,
            };
        });
    },
    /**
     * Simulates the 'channel_fold' route on `mail.channel`.
     * In particular sends a notification on the bus.
     *
     * @private
     * @param {string} uuid
     * @param {state} [state]
     */
    _mockMailChannelChannelFold(uuid, state) {
        const channel = this._getRecords('mail.channel', [['uuid', '=', uuid]])[0];
        this._mockWrite('mail.channel', [
            [channel.id],
            {
                isMinimized: state !== 'closed',
                state,
            }
        ]);
        const channelInfo = this._mockMailChannelChannelInfo([channel.id])[0];
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.channel/insert',
            payload: {
                id: channelInfo.id,
                serverFoldState: channelInfo.isMinimized ? 'open' : 'closed',
            },
        }]);
    },
    /**
     * Simulates 'channel_get' on 'mail.channel'.
     *
     * @private
     * @param {integer[]} [partners_to=[]]
     * @param {boolean} [pin=true]
     * @returns {Object}
     */
    _mockMailChannelChannelGet(partners_to = [], pin = true) {
        if (partners_to.length === 0) {
            return false;
        }
        if (!partners_to.includes(this.currentPartnerId)) {
            partners_to.push(this.currentPartnerId);
        }
        const partners = this._getRecords('res.partner', [['id', 'in', partners_to]]);

        // NOTE: this mock is not complete, which is done for simplicity.
        // Indeed if a chat already exists for the given partners, the server
        // is supposed to return this existing chat. But the mock is currently
        // always creating a new chat, because no test is relying on receiving
        // an existing chat.
        const id = this._mockCreate('mail.channel', {
            channelType: 'chat',
            isMinimized: true,
            is_pinned: true,
            last_interest_dt: datetimeToStr(new Date()),
            members: [[6, 0, partners_to]],
            name: partners.map(partner => partner.name).join(", "),
            isPublic: 'private',
            state: 'open',
        });
        return this._mockMailChannelChannelInfo([id])[0];
    },
    /**
     * Simulates `channel_info` on `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     * @returns {Object[]}
     */
    _mockMailChannelChannelInfo(ids) {
        const channels = this._getRecords('mail.channel', [['id', 'in', ids]]);
        const all_partners = [...new Set(channels.reduce((all_partners, channel) => {
            return [...all_partners, ...channel.members];
        }, []))];
        const direct_partners = [...new Set(channels.reduce((all_partners, channel) => {
            if (channel.channelType === 'chat') {
                return [...all_partners, ...channel.members];
            }
            return all_partners;
        }, []))];
        const partnerInfos = this._mockMailChannelPartnerInfo(all_partners, direct_partners);
        return channels.map(channel => {
            const members = channel.members.map(partnerId => partnerInfos[partnerId]);
            const messages = this._getRecords('mail.message', [
                ['model', '=', 'mail.channel'],
                ['resId', '=', channel.id],
            ]);
            const lastMessageId = messages.reduce((lastMessageId, message) => {
                if (!lastMessageId || message.id > lastMessageId) {
                    return message.id;
                }
                return lastMessageId;
            }, undefined);
            const messageNeedactionCounter = this._getRecords('mail.notification', [
                ['resPartnerId', '=', this.currentPartnerId],
                ['is_read', '=', false],
                ['mail_message_id', 'in', messages.map(message => message.id)],
            ]).length;
            const res = Object.assign({}, channel, {
                last_message_id: lastMessageId,
                members,
                messageNeedactionCounter: messageNeedactionCounter,
            });
            if (channel.channelType === 'channel') {
                delete res.members;
            } else {
                res['seen_partners_info'] = [{
                    partnerId: this.currentPartnerId,
                    seen_message_id: channel.seen_message_id,
                    fetched_message_id: channel.fetched_message_id,
                }];
            }
            return res;
        });
    },
    /**
     * Simulates the `channel_pin` method of `mail.channel`.
     *
     * @private
     * @param {string} uuid
     * @param {boolean} [pinned=false]
     */
    async _mockMailChannelChannelPin(uuid, pinned = false) {
        const channel = this._getRecords('mail.channel', [['uuid', '=', uuid]])[0];
        this._mockWrite('mail.channel', [
            [channel.id],
            { is_pinned: false },
        ]);
        if (!pinned) {
            this._widget.call('busService', 'trigger', 'notification', [{
                type: 'mail.channel/unpin',
                payload: { id: channel.id },
            }]);
        } else {
            this._widget.call('busService', 'trigger', 'notification', [{
                type: 'mail.channel/legacyInsert',
                payload: this._mockMailChannelChannelInfo([channel.id])[0],
            }]);
        }
    },
    /**
     * Simulates the `_channel_seen` method of `mail.channel`.
     *
     * @private
     * @param integer[] ids
     * @param {integer} last_message_id
     */
    async _mockMailChannel_ChannelSeen(ids, last_message_id) {
        // Update record
        const channelId = ids[0];
        if (!channelId) {
            throw new Error('Should only be one channel in channel_seen mock params');
        }
        const channel = this._getRecords('mail.channel', [['id', '=', channelId]])[0];
        const messagesBeforeGivenLastMessage = this._getRecords('mail.message', [
            ['id', '<=', last_message_id],
            ['model', '=', 'mail.channel'],
            ['resId', '=', channel.id],
        ]);
        if (!messagesBeforeGivenLastMessage || messagesBeforeGivenLastMessage.length === 0) {
            return;
        }
        if (!channel) {
            return;
        }
        if (channel.seen_message_id && channel.seen_message_id >= last_message_id) {
            return;
        }
        this._mockMailChannel_SetLastSeenMessage([channel.id], last_message_id);
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.channel.partner/seen',
            payload: {
                channelId: channel.id,
                last_message_id,
                partnerId: this.currentPartnerId,
            },
        }]);
    },
    /**
     * Simulates `channel_rename` on `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     */
    _mockMailChannelChannelRename(ids, name) {
        const channel = this._getRecords('mail.channel', [['id', 'in', ids]])[0];
        this._mockWrite('mail.channel', [
            [channel.id],
            { name },
        ]);
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.channel/insert',
            payload: {
                id: channel.id,
                name,
            },
        }]);
    },
    /**
     * Simulates `channel_set_custom_name` on `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     */
    _mockMailChannelChannelSetCustomName(ids, name) {
        const channel = this._getRecords('mail.channel', [['id', 'in', ids]])[0];
        this._mockWrite('mail.channel', [
            [channel.id],
            { custom_channel_name: name },
        ]);
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.channel/insert',
            payload: {
                id: channel.id,
                custom_channel_name: name,
            },
        }]);
    },
    /**
     * Simulates the `/mail/create_group` route.
     *
     * @private
     * @param {integer[]} partners_to
     * @returns {Object}
     */
    async _mockMailChannelCreateGroup(partners_to) {
        const partners = this._getRecords('res.partner', [['id', 'in', partners_to]]);
        const id = this._mockCreate('mail.channel', {
            channelType: 'group',
            is_pinned: true,
            members: [[6, 0, partners.map(partner => partner.id)]],
            name: '',
            isPublic: 'private',
            state: 'open',
        });
        this._mockMailChannel_broadcast(id, partners.map(partner => partner.id));
        return this._mockMailChannelChannelInfo([id])[0];
    },
    /**
     * Simulates `execute_command_leave` on `mail.channel`.
     *
     * @private
     */
    _mockMailChannelExecuteCommandLeave(args) {
        const channel = this._getRecords('mail.channel', [['id', 'in', args.args[0]]])[0];
        if (channel.channelType === 'channel') {
            this._mockMailChannelActionUnfollow([channel.id]);
        } else {
            this._mockMailChannelChannelPin(channel.uuid, false);
        }
    },
    /**
     * Simulates `execute_command_who` on `mail.channel`.
     *
     * @private
     */
    _mockMailChannelExecuteCommandWho(args) {
        const ids = args.args[0];
        const channels = this._getRecords('mail.channel', [['id', 'in', ids]]);
        for (const channel of channels) {
            const members = channel.members.map(memberId => this._getRecords('res.partner', [['id', '=', memberId]])[0].name);
            let message = "You are alone in this channel.";
            if (members.length > 0) {
                message = `Users in this channel: ${members.join(', ')} and you`;
            }
            this._widget.call('busService', 'trigger', 'notification', [{
                type: 'mail.channel/transientMessage',
                payload: {
                    'body': `<span class="o-mail-notification">${message}</span>`,
                    'model': 'mail.channel',
                    'resId': channel.id,
                }
            }]);
        }
    },
    /**
     * Simulates `get_mention_suggestions` on `mail.channel`.
     *
     * @private
     * @returns {Array[]}
     */
    _mockMailChannelGetMentionSuggestions(args) {
        const search = args.kwargs.search || '';
        const limit = args.kwargs.limit || 8;

        /**
         * Returns the given list of channels after filtering it according to
         * the logic of the Javascript method `get_mention_suggestions` for the
         * given search term. The result is truncated to the given limit and
         * formatted as expected by the original method.
         *
         * @param {Object[]} channels
         * @param {string} search
         * @param {integer} limit
         * @returns {Object[]}
         */
        const mentionSuggestionsFilter = function (channels, search, limit) {
            const matchingChannels = channels
                .filter(channel => {
                    // no search term is considered as return all
                    if (!search) {
                        return true;
                    }
                    // otherwise name or email must match search term
                    if (channel.name && channel.name.includes(search)) {
                        return true;
                    }
                    return false;
                }).map(channel => {
                    // expected format
                    return {
                        id: channel.id,
                        name: channel.name,
                        isPublic: channel.isPublic,
                    };
                });
            // reduce results to max limit
            matchingChannels.length = Math.min(matchingChannels.length, limit);
            return matchingChannels;
        };

        const mentionSuggestions = mentionSuggestionsFilter(this.data['mail.channel'].records, search, limit);

        return mentionSuggestions;
    },
    /**
     * Simulates `write` on `mail.channel` when `image128` changes.
     *
     * @param {integer} id
     */
    _mockMailChannelWriteImage128(id) {
        this._mockWrite('mail.channel', [
            [id],
            {
                avatarCacheKey: moment.utc().format("YYYYMMDDHHmmss"),
            },
        ]);
        const avatarCacheKey = this._getRecords('mail.channel', [['id', '=', id]])[0].avatarCacheKey;
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.channel/insert',
            payload: {
                id,
                avatarCacheKey: avatarCacheKey,
            },
        }]);
    },
    /**
     * Simulates `messagePost` on `mail.channel`.
     *
     * @private
     * @param {integer} id
     * @param {Object} kwargs
     * @param {Object} [context]
     * @returns {integer|false}
     */
    _mockMailChannelMessagePost(id, kwargs, context) {
        const messageType = kwargs.messageType || 'notification';
        const channel = this._getRecords('mail.channel', [['id', '=', id]])[0];
        if (channel.channelType !== 'channel') {
            // channel.partner not handled here for simplicity
            this._mockWrite('mail.channel', [
                [channel.id],
                {
                    last_interest_dt: datetimeToStr(new Date()),
                    is_pinned: true,
                },
            ]);
        }
        const messageData = this._mockMailThreadMessagePost(
            'mail.channel',
            [id],
            Object.assign(kwargs, {
                messageType,
            }),
            context,
        );
        if (kwargs.authorId === this.currentPartnerId) {
            this._mockMailChannel_SetLastSeenMessage([channel.id], messageData.id);
        } else {
            this._mockWrite('mail.channel', [
                [channel.id],
                { message_unread_counter: (channel.message_unread_counter || 0) + 1 },
            ]);
        }
        return messageData;
    },
    /**
     * Simulates `notify_typing` on `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     * @param {boolean} is_typing
     * @param {Object} [context={}]
     */
    _mockMailChannelNotifyTyping(ids, is_typing, context = {}) {
        const channels = this._getRecords('mail.channel', [['id', 'in', ids]]);
        let partnerId;
        if ('mockedPartnerId' in context) {
            partnerId = context.mockedPartnerId;
        } else {
            partnerId = this.currentPartnerId;
        }
        const partner = this._getRecords('res.partner', [['id', '=', partnerId]]);
        const notifications = [];
        for (const channel of channels) {
            const data = {
                type: 'mail.channel.partner/typingStatus',
                payload: {
                    channelId: channel.id,
                    is_typing: is_typing,
                    partnerId: partnerId,
                    partner_name: partner.name,
                },
            };
            notifications.push([data]);
        }
        this._widget.call('busService', 'trigger', 'notification', notifications);
    },
    /**
     * Simulates `_get_channel_partner_info` on `mail.channel`.
     *
     * @private
     * @param {integer[]} all_partners
     * @param {integer[]} direct_partners
     * @returns {Object[]}
     */
    _mockMailChannelPartnerInfo(all_partners, direct_partners) {
        const partners = this._getRecords(
            'res.partner',
            [['id', 'in', all_partners]],
            { activeTest: false },
        );
        const partnerInfos = {};
        for (const partner of partners) {
            const partnerInfo = {
                email: partner.email,
                id: partner.id,
                name: partner.name,
            };
            if (direct_partners.includes(partner.id)) {
                partnerInfo.imStatus = partner.imStatus;
            }
            partnerInfos[partner.id] = partnerInfo;
        }
        return partnerInfos;
    },
    /**
     * Simulates the `_set_last_seen_message` method of `mail.channel`.
     *
     * @private
     * @param {integer[]} ids
     * @param {integer} messageId
     */
    _mockMailChannel_SetLastSeenMessage(ids, messageId) {
        this._mockWrite('mail.channel', [ids, {
            fetched_message_id: messageId,
            seen_message_id: messageId,
        }]);
    },
    /**
     * Simulates `mark_all_as_read` on `mail.message`.
     *
     * @private
     * @param {Array[]} [domain]
     * @returns {integer[]}
     */
    _mockMailMessageMarkAllAsRead(domain) {
        const notifDomain = [
            ['resPartnerId', '=', this.currentPartnerId],
            ['is_read', '=', false],
        ];
        if (domain) {
            const messages = this._getRecords('mail.message', domain);
            const ids = messages.map(messages => messages.id);
            this._mockMailMessageSetMessageDone(ids);
            return ids;
        }
        const notifications = this._getRecords('mail.notification', notifDomain);
        this._mockWrite('mail.notification', [
            notifications.map(notification => notification.id),
            { is_read: true },
        ]);
        const messageIds = [];
        for (const notification of notifications) {
            if (!messageIds.includes(notification.mail_message_id)) {
                messageIds.push(notification.mail_message_id);
            }
        }
        const messages = this._getRecords('mail.message', [['id', 'in', messageIds]]);
        // simulate compute that should be done based on notifications
        for (const message of messages) {
            this._mockWrite('mail.message', [
                [message.id],
                {
                    needaction: false,
                    needactionPartnerIds: message.needactionPartnerIds.filter(
                        partnerId => partnerId !== this.currentPartnerId
                    ),
                },
            ]);
        }
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.message/markAsRead',
            payload: {
                messageIds: messageIds,
                needactionInboxCounter: this._mockResPartner_GetNeedactionCount(this.currentPartnerId),
            },
        }]);
        return messageIds;
    },
    /**
     * Simulates `_message_fetch` on `mail.message`.
     *
     * @private
     * @param {Array[]} domain
     * @param {string} [limit=20]
     * @returns {Object[]}
     */
    async _mockMailMessage_MessageFetch(domain, max_id, min_id, limit = 30) {
        // TODO FIXME delay RPC until next potential render as a workaround
        // to OWL issue (possibly https://github.com/verp/owl/issues/904)
        await nextAnimationFrame();
        if (max_id) {
            domain.push(['id', '<', max_id]);
        }
        if (min_id) {
            domain.push(['id', '>', min_id]);
        }
        let messages = this._getRecords('mail.message', domain);
        // sorted from highest ID to lowest ID (i.e. from youngest to oldest)
        messages.sort(function (m1, m2) {
            return m1.id < m2.id ? 1 : -1;
        });
        // pick at most 'limit' messages
        messages.length = Math.min(messages.length, limit);
        return this._mockMailMessageMessageFormat(messages.map(message => message.id));
    },
    /**
     * Simulates `message_format` on `mail.message`.
     *
     * @private
     * @returns {integer[]} ids
     * @returns {Object[]}
     */
    _mockMailMessageMessageFormat(ids) {
        const messages = this._getRecords('mail.message', [['id', 'in', ids]]);
        // sorted from highest ID to lowest ID (i.e. from most to least recent)
        messages.sort(function (m1, m2) {
            return m1.id < m2.id ? 1 : -1;
        });
        return messages.map(message => {
            const thread = message.model && this._getRecords(message.model, [
                ['id', '=', message.resId],
            ])[0];
            let formattedAuthor;
            if (message.authorId) {
                const author = this._getRecords(
                    'res.partner',
                    [['id', '=', message.authorId]],
                    { activeTest: false }
                )[0];
                formattedAuthor = [author.id, author.displayName];
            } else {
                formattedAuthor = [0, message.email_from];
            }
            const attachments = this._getRecords('ir.attachment', [
                ['id', 'in', message.attachmentIds],
            ]);
            const formattedAttachments = attachments.map(attachment => {
                return Object.assign({
                    'checksum': attachment.checksum,
                    'id': attachment.id,
                    'filename': attachment.name,
                    'name': attachment.name,
                    'mimetype': attachment.mimetype,
                    'is_main': thread && thread.message_main_attachment_id === attachment.id,
                    'resId': attachment.resId || messages.resId,
                    'resModel': attachment.resModel || message.model,
                });
            });
            const allNotifications = this._getRecords('mail.notification', [
                ['mail_message_id', '=', message.id],
            ]);
            const historyPartnerIds = allNotifications
                .filter(notification => notification.is_read)
                .map(notification => notification.resPartnerId);
            const needactionPartnerIds = allNotifications
                .filter(notification => !notification.is_read)
                .map(notification => notification.resPartnerId);
            let notifications = this._mockMailNotification_FilteredForWebClient(
                allNotifications.map(notification => notification.id)
            );
            notifications = this._mockMailNotification_NotificationFormat(
                notifications.map(notification => notification.id)
            );
            const trackingValueIds = this._getRecords('mail.tracking.value', [
                ['id', 'in', message.trackingValueIds],
            ]);
            const partners = this._getRecords(
                'res.partner',
                [['id', 'in', message.partnerIds]],
            );
            const response = Object.assign({}, message, {
                attachmentIds: formattedAttachments,
                authorId: formattedAuthor,
                history_partner_ids: historyPartnerIds,
                needactionPartnerIds: needactionPartnerIds,
                notifications,
                recipients: partners.map(p => ({ id: p.id, name: p.name })),
                trackingValueIds: trackingValueIds,
            });
            if (message.subtypeId) {
                const subtype = this._getRecords('mail.message.subtype', [
                    ['id', '=', message.subtypeId],
                ])[0];
                response.subtypeDescription = subtype.description;
            }
            return response;
        });
    },
    /**
     * Simulates `_message_notification_format` on `mail.message`.
     *
     * @private
     * @returns {integer[]} ids
     * @returns {Object[]}
     */
    _mockMailMessage_MessageNotificationFormat(ids) {
        const messages = this._getRecords('mail.message', [['id', 'in', ids]]);
        return messages.map(message => {
            let notifications = this._getRecords('mail.notification', [
                ['mail_message_id', '=', message.id],
            ]);
            notifications = this._mockMailNotification_FilteredForWebClient(
                notifications.map(notification => notification.id)
            );
            notifications = this._mockMailNotification_NotificationFormat(
                notifications.map(notification => notification.id)
            );
            return {
                'date': message.date,
                'id': message.id,
                'messageType': message.messageType,
                'model': message.model,
                'notifications': notifications,
                'resId': message.resId,
                'resModelName': message.resModelName,
            };
        });
    },
    /**
     * Simulates `set_message_done` on `mail.message`, which turns provided
     * needaction message to non-needaction (i.e. they are marked as read from
     * from the Inbox mailbox). Also notify on the longpoll bus that the
     * messages have been marked as read, so that UI is updated.
     *
     * @private
     * @param {integer[]} ids
     */
    _mockMailMessageSetMessageDone(ids) {
        const messages = this._getRecords('mail.message', [['id', 'in', ids]]);

        const notifications = this._getRecords('mail.notification', [
            ['resPartnerId', '=', this.currentPartnerId],
            ['is_read', '=', false],
            ['mail_message_id', 'in', messages.map(messages => messages.id)]
        ]);
        this._mockWrite('mail.notification', [
            notifications.map(notification => notification.id),
            { is_read: true },
        ]);
        // simulate compute that should be done based on notifications
        for (const message of messages) {
            this._mockWrite('mail.message', [
                [message.id],
                {
                    needaction: false,
                    needactionPartnerIds: message.needactionPartnerIds.filter(
                        partnerId => partnerId !== this.currentPartnerId
                    ),
                },
            ]);
            this._widget.call('busService', 'trigger', 'notification', [{
                type: 'mail.message/markAsRead',
                payload: {
                    messageIds: [message.id],
                    needactionInboxCounter: this._mockResPartner_GetNeedactionCount(this.currentPartnerId),
                },
            }]);
        }
    },
    /**
     * Simulates `toggle_message_starred` on `mail.message`.
     *
     * @private
     * @returns {integer[]} ids
     */
    _mockMailMessageToggleMessageStarred(ids) {
        const messages = this._getRecords('mail.message', [['id', 'in', ids]]);
        for (const message of messages) {
            const wasStared = message.starredPartnerIds.includes(this.currentPartnerId);
            this._mockWrite('mail.message', [
                [message.id],
                { starredPartnerIds: [[wasStared ? 3 : 4, this.currentPartnerId]] }
            ]);
            this._widget.call('busService', 'trigger', 'notification', [{
                type: 'mail.message/toggleStar',
                payload: {
                    messageIds: [message.id],
                    starred: !wasStared,
                },
            }]);
        }
    },
    /**
     * Simulates `unstar_all` on `mail.message`.
     *
     * @private
     */
    _mockMailMessageUnstarAll() {
        const messages = this._getRecords('mail.message', [
            ['starredPartnerIds', 'in', this.currentPartnerId],
        ]);
        this._mockWrite('mail.message', [
            messages.map(message => message.id),
            { starredPartnerIds: [[3, this.currentPartnerId]] }
        ]);
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'mail.message/toggleStar',
            payload: {
                messageIds: messages.map(message => message.id),
                starred: false,
            },
        }]);
    },
    /**
     * Simulates `_filtered_for_web_client` on `mail.notification`.
     *
     * @private
     * @returns {integer[]} ids
     * @returns {Object[]}
     */
    _mockMailNotification_FilteredForWebClient(ids) {
        const notifications = this._getRecords('mail.notification', [
            ['id', 'in', ids],
            ['notificationType', '!=', 'inbox'],
        ]);
        return notifications.filter(notification => {
            const partner = this._getRecords('res.partner', [['id', '=', notification.resPartnerId]])[0];
            return Boolean(
                ['bounce', 'exception', 'canceled'].includes(notification.notification_status) ||
                (partner && partner.partner_share)
            );
        });
    },
    /**
     * Simulates `_notification_format` on `mail.notification`.
     *
     * @private
     * @returns {integer[]} ids
     * @returns {Object[]}
     */
    _mockMailNotification_NotificationFormat(ids) {
        const notifications = this._getRecords('mail.notification', [['id', 'in', ids]]);
        return notifications.map(notification => {
            const partner = this._getRecords('res.partner', [['id', '=', notification.resPartnerId]])[0];
            return {
                'id': notification.id,
                'notificationType': notification.notificationType,
                'notification_status': notification.notification_status,
                'failureType': notification.failureType,
                'resPartnerId': partner ? [partner && partner.id, partner && partner.displayName] : undefined,
            };
        });
    },
    /**
     * Simulates `_message_compute_author` on `mail.thread`.
     *
     * @private
     * @param {string} model
     * @param {integer[]} ids
     * @param {Object} [context={}]
     * @returns {Array}
     */
    _MockMailThread_MessageComputeAuthor(model, ids, authorId, email_from, context = {}) {
        if (authorId === undefined) {
            // For simplicity partner is not guessed from email_from here, but
            // that would be the first step on the server.
            let userId;
            if ('mockedUserId' in context) {
                // can be falsy to simulate not being logged in
                userId = context.mockedUserId
                    ? context.mockedUserId
                    : this.publicUserId;
            } else {
                userId = this.currentUserId;
            }
            const user = this._getRecords(
                'res.users',
                [['id', '=', userId]],
                { activeTest: false },
            )[0];
            const author = this._getRecords(
                'res.partner',
                [['id', '=', user.partnerId]],
                { activeTest: false },
            )[0];
            authorId = author.id;
            email_from = `${author.displayName} <${author.email}>`;
        }

        if (email_from === undefined) {
            if (authorId) {
                const author = this._getRecords(
                    'res.partner',
                    [['id', '=', authorId]],
                    { activeTest: false },
                )[0];
                email_from = `${author.displayName} <${author.email}>`;
            }
        }

        if (!email_from) {
            throw Error("Unable to log message due to missing author email.");
        }

        return [authorId, email_from];
    },
    /**
     * Simulates `_message_add_suggested_recipient` on `mail.thread`.
     *
     * @private
     * @param {string} model
     * @param {integer[]} ids
     * @param {Object} result
     * @param {Object} [param3={}]
     * @param {string} [param3.email]
     * @param {integer} [param3.partner]
     * @param {string} [param3.reason]
     * @returns {Object}
     */
    _mockMailThread_MessageAddSuggestedRecipient(model, ids, result, { email, partner, reason = '' } = {}) {
        const record = this._getRecords(model, [['id', 'in', 'ids']])[0];
        // for simplicity
        result[record.id].push([partner, email, reason]);
        return result;
    },
    /**
     * Simulates `_message_get_suggested_recipients` on `mail.thread`.
     *
     * @private
     * @param {string} model
     * @param {integer[]} ids
     * @returns {Object}
     */
    _mockMailThread_MessageGetSuggestedRecipients(model, ids) {
        const result = ids.reduce((result, id) => result[id] = [], {});
        const records = this._getRecords(model, [['id', 'in', ids]]);
        for (const record in records) {
            if (record.userId) {
                const user = this._getRecords('res.users', [['id', '=', record.userId]]);
                if (user.partnerId) {
                    const reason = this.data[model].fields['userId'].string;
                    this._mockMailThread_MessageAddSuggestedRecipient(result, user.partnerId, reason);
                }
            }
        }
        return result;
    },
    /**
     * Simulates `_message_get_suggested_recipients` on `res.fake`.
     *
     * @private
     * @param {string} model
     * @param {integer[]} ids
     * @returns {Object}
     */
    _mockResFake_MessageGetSuggestedRecipients(model, ids) {
        const result = {};
        const records = this._getRecords(model, [['id', 'in', ids]]);

        for (const record of records) {
            result[record.id] = [];
            if (record.emailCc) {
                result[record.id].push([
                    false,
                    record.emailCc,
                    'CC email',
                ]);
            }
            const partners = this._getRecords(
                'res.partner',
                [['id', 'in', record.partnerIds]],
            );
            if (partners.length) {
                for (const partner of partners) {
                    result[record.id].push([
                        partner.id,
                        partner.displayName,
                        'Email partner',
                    ]);
                }
            }
        }

        return result;
    },
    /**
     * Simulates `messagePost` on `mail.thread`.
     *
     * @private
     * @param {string} model
     * @param {integer[]} ids
     * @param {Object} kwargs
     * @param {Object} [context]
     * @returns {Object}
     */
    _mockMailThreadMessagePost(model, ids, kwargs, context) {
        const id = ids[0]; // ensure_one
        if (kwargs.attachmentIds) {
            const attachments = this._getRecords('ir.attachment', [
                ['id', 'in', kwargs.attachmentIds],
                ['resModel', '=', 'mail.compose.message'],
                ['resId', '=', 0],
            ]);
            const attachmentIds = attachments.map(attachment => attachment.id);
            this._mockWrite('ir.attachment', [
                attachmentIds,
                {
                    resId: id,
                    resModel: model,
                },
            ]);
            kwargs.attachmentIds = attachmentIds.map(attachmentId => [4, attachmentId]);
        }
        const subtype_xmlid = kwargs.subtype_xmlid || 'mail.mt_note';
        const [authorId, email_from] = this._MockMailThread_MessageComputeAuthor(
            model,
            ids,
            kwargs.authorId,
            kwargs.email_from, context,
        );
        const values = Object.assign({}, kwargs, {
            authorId,
            email_from,
            isDiscussion: subtype_xmlid === 'mail.mtComment',
            isNote: subtype_xmlid === 'mail.mt_note',
            model,
            resId: id,
        });
        delete values.subtype_xmlid;
        const messageId = this._mockCreate('mail.message', values);
        this._mockMailThread_NotifyThread(model, ids, messageId);
        return this._mockMailMessageMessageFormat([messageId])[0];
    },
    /**
     * Simulates `message_subscribe` on `mail.thread`.
     *
     * @private
     * @param {string} model not in server method but necessary for thread mock
     * @param {integer[]} ids
     * @param {integer[]} partnerIds
     * @param {integer[]} subtype_ids
     * @returns {boolean}
     */
    _mockMailThreadMessageSubscribe(model, ids, partnerIds, subtype_ids) {
        // message_subscribe is too complex for a generic mock.
        // mockRPC should be considered for a specific result.
    },
    /**
     * Simulates `_notify_thread` on `mail.thread`.
     * Simplified version that sends notification to author and channel.
     *
     * @private
     * @param {string} model not in server method but necessary for thread mock
     * @param {integer[]} ids
     * @param {integer} messageId
     * @returns {boolean}
     */
    _mockMailThread_NotifyThread(model, ids, messageId) {
        const message = this._getRecords('mail.message', [['id', '=', messageId]])[0];
        const messageFormat = this._mockMailMessageMessageFormat([messageId])[0];
        const notifications = [];
        // author
        const notificationData = {
            type: 'author',
            payload: {
                message: messageFormat,
            },
        };
        if (message.authorId) {
            notifications.push([notificationData]);
        }
        // members
        const channels = this._getRecords('mail.channel', [['id', '=', message.resId]]);
        for (const channel of channels) {
            notifications.push({
                type: 'mail.channel/newMessage',
                payload: {
                    id: channel.id,
                    message: messageFormat,
                }
            });

            // notify update of last_interest_dt
            const now = datetimeToStr(new Date());
            this._mockWrite('mail.channel', [
                [channel.id],
                { last_interest_dt: now },
            ]);
            notifications.push({
                type: 'mail.channel/lastInterestDtChanged',
                payload: {
                    id: channel.id,
                    last_interest_dt: now, // channel.partner not used for simplicity
                },
            });
        }
        this._widget.call('busService', 'trigger', 'notification', notifications);
    },
    /**
     * Simulates `message_unsubscribe` on `mail.thread`.
     *
     * @private
     * @param {string} model not in server method but necessary for thread mock
     * @param {integer[]} ids
     * @param {integer[]} partnerIds
     * @returns {boolean|undefined}
     */
    _mockMailThreadMessageUnsubscribe(model, ids, partnerIds) {
        if (!partnerIds) {
            return true;
        }
        const followers = this._getRecords('mail.followers', [
            ['resModel', '=', model],
            ['resId', 'in', ids],
            ['partnerId', 'in', partnerIds || []],
        ]);
        this._mockUnlink('mail.followers', [followers.map(follower => follower.id)]);
    },
    /**
     * Simulates `_get_channels_as_member` on `res.partner`.
     *
     * @private
     * @param {integer[]} ids
     * @returns {Object}
     */
    _mockResPartner_GetChannelsAsMember(ids) {
        const partner = this._getRecords('res.partner', [['id', 'in', ids]])[0];
        const channels = this._getRecords('mail.channel', [
            ['channelType', 'in', ['channel', 'group']],
            ['members', 'in', partner.id],
        ]);
        const directMessages = this._getRecords('mail.channel', [
            ['channelType', '=', 'chat'],
            ['is_pinned', '=', true],
            ['members', 'in', partner.id],
        ]);
        return [
            ...channels,
            ...directMessages,
        ];
    },

    /**
     * Simulates `_find_or_create_for_user` on `res.users.settings`.
     *
     * @param {Object} user
     * @returns {Object}
     */
    _mockResUsersSettings_FindOrCreateForUser(userId) {
        let settings = this._getRecords('res.users.settings', [['userId', '=', userId]])[0];
        if (!settings) {
            const settingsId = this._mockCreate('res.users.settings', { userId: userId });
            settings = this._getRecords('res.users.settings', [['id', '=', settingsId]])[0];
        }
        return settings;
    },

    /**
     * Simulates `set_res_users_settings` on `res.users.settings`.
     *
     * @param {integer} id
     * @param {Object} newSettings
     */
    _mockResUsersSettingsSetResUsersSettings(id, newSettings) {
        const oldSettings = this._getRecords('res.users.settings', [['id', '=', id]])[0];
        const changedSettings = {};
        for (const setting in newSettings) {
            if (setting in oldSettings && newSettings[setting] !== oldSettings[setting]) {
                changedSettings[setting] = newSettings[setting];
            }
        }
        this._mockWrite('res.users.settings', [
            [id],
            changedSettings,
        ]);
        this._widget.call('busService', 'trigger', 'notification', [{
            type: 'res.users.settings/changed',
            payload: changedSettings,
        }]);
    },

    /**
     * Simulates `get_mention_suggestions` on `res.partner`.
     *
     * @private
     * @returns {Array[]}
     */
    _mockResPartnerGetMentionSuggestions(args) {
        const search = (args.args[0] || args.kwargs.search || '').toLowerCase();
        const limit = args.args[1] || args.kwargs.limit || 8;

        /**
         * Returns the given list of partners after filtering it according to
         * the logic of the Javascript method `get_mention_suggestions` for the
         * given search term. The result is truncated to the given limit and
         * formatted as expected by the original method.
         *
         * @param {Object[]} partners
         * @param {string} search
         * @param {integer} limit
         * @returns {Object[]}
         */
        const mentionSuggestionsFilter = (partners, search, limit) => {
            const matchingPartners = [...this._mockResPartnerMailPartnerFormat(
                partners
                    .filter(partner => {
                        // no search term is considered as return all
                        if (!search) {
                            return true;
                        }
                        // otherwise name or email must match search term
                        if (partner.name && partner.name.toLowerCase().includes(search)) {
                            return true;
                        }
                        if (partner.email && partner.email.toLowerCase().includes(search)) {
                            return true;
                        }
                        return false;
                    })
                    .map(partner => partner.id)
            ).values()];
            // reduce results to max limit
            matchingPartners.length = Math.min(matchingPartners.length, limit);
            return matchingPartners;
        };

        // add main suggestions based on users
        const partnersFromUsers = this._getRecords('res.users', [])
            .map(user => this._getRecords('res.partner', [['id', '=', user.partnerId]])[0])
            .filter(partner => partner);
        const mainMatchingPartners = mentionSuggestionsFilter(partnersFromUsers, search, limit);

        let extraMatchingPartners = [];
        // if not enough results add extra suggestions based on partners
        const remainingLimit = limit - mainMatchingPartners.length;
        if (mainMatchingPartners.length < limit) {
            const partners = this._getRecords('res.partner', [['id', 'not in', mainMatchingPartners.map(partner => partner.id)]]);
            extraMatchingPartners = mentionSuggestionsFilter(partners, search, remainingLimit);
        }
        return mainMatchingPartners.concat(extraMatchingPartners);
    },
    /**
     * Simulates `_get_needaction_count` on `res.partner`.
     *
     * @private
     * @param {integer} id
     * @returns {integer}
     */
    _mockResPartner_GetNeedactionCount(id) {
        const partner = this._getRecords('res.partner', [['id', '=', id]])[0];
        return this._getRecords('mail.notification', [
            ['resPartnerId', '=', partner.id],
            ['is_read', '=', false],
        ]).length;
    },
    /**
     * Simulates `im_search` on `res.partner`.
     *
     * @private
     * @param {string} [name='']
     * @param {integer} [limit=20]
     * @returns {Object[]}
     */
    _mockResPartnerImSearch(name = '', limit = 20) {
        name = name.toLowerCase(); // simulates ILIKE
        // simulates domain with relational parts (not supported by mock server)
        const matchingPartners = this._getRecords('res.users', [])
            .filter(user => {
                const partner = this._getRecords('res.partner', [['id', '=', user.partnerId]])[0];
                // user must have a partner
                if (!partner) {
                    return false;
                }
                // not current partner
                if (partner.id === this.currentPartnerId) {
                    return false;
                }
                // no name is considered as return all
                if (!name) {
                    return true;
                }
                if (partner.name && partner.name.toLowerCase().includes(name)) {
                    return true;
                }
                return false;
            }).map(user => {
                const partner = this._getRecords('res.partner', [['id', '=', user.partnerId]])[0];
                return {
                    id: partner.id,
                    imStatus: user.imStatus || 'offline',
                    email: partner.email,
                    name: partner.name,
                    userId: user.id,
                };
            }).sort((a, b) => (a.name === b.name) ? (a.id - b.id) : (a.name > b.name) ? 1 : -1);
        matchingPartners.length = Math.min(matchingPartners.length, limit);
        return matchingPartners;
    },
    /**
     * Simulates `mail_partner_format` on `res.partner`.
     *
     * @private
     * @returns {integer[]} ids
     * @returns {Map}
     */
    _mockResPartnerMailPartnerFormat(ids) {
        const partners = this._getRecords(
            'res.partner',
            [['id', 'in', ids]],
            { activeTest: false }
        );
        // Servers is also returning `isInternal_user` but not
        // done here for simplification.
        return new Map(partners.map(partner => {
            const users = this._getRecords('res.users', [['id', 'in', partner.user_ids]]);
            const internalUsers = users.filter(user => !user.share);
            let mainUser;
            if (internalUsers.length > 0) {
                mainUser = internalUsers[0];
            } else if (users.length > 0) {
                mainUser = users[0];
            } else {
                mainUser = [];
            }
            return [partner.id, {
                "active": partner.active,
                "displayName": partner.displayName,
                "email": partner.email,
                "id": partner.id,
                "imStatus": partner.imStatus,
                "label": partner.name,
                "userId": mainUser.id,
            }];
        }));
    },
    /**
     * Simulates `search_for_channel_invite` on `res.partner`.
     *
     * @private
     * @param {string} [search_term='']
     * @param {integer} [channelId]
     * @param {integer} [limit=30]
     * @returns {Object[]}
     */
    _mockResPartnerSearchForChannelInvite(search_term, channelId, limit = 30) {
        search_term = search_term.toLowerCase(); // simulates ILIKE
        // simulates domain with relational parts (not supported by mock server)
        const matchingPartners = [...this._mockResPartnerMailPartnerFormat(
            this._getRecords('res.users', [])
            .filter(user => {
                const partner = this._getRecords('res.partner', [['id', '=', user.partnerId]])[0];
                // user must have a partner
                if (!partner) {
                    return false;
                }
                // not current partner
                if (partner.id === this.currentPartnerId) {
                    return false;
                }
                // no name is considered as return all
                if (!search_term) {
                    return true;
                }
                if (partner.name && partner.name.toLowerCase().includes(search_term)) {
                    return true;
                }
                return false;
            })
            .map(user => user.partnerId)
        ).values()];
        const count = matchingPartners.length;
        matchingPartners.length = Math.min(count, limit);
        return {
            count,
            partners: matchingPartners
        };
    },
    /**
     * Simulates `_message_fetch_failed` on `res.partner`.
     *
     * @private
     * @param {integer} id
     * @returns {Object[]}
     */
    _mockResPartner_MessageFetchFailed(id) {
        const partner = this._getRecords('res.partner', [['id', '=', id]])[0];
        const messages = this._getRecords('mail.message', [
            ['authorId', '=', partner.id],
            ['resId', '!=', 0],
            ['model', '!=', false],
            ['messageType', '!=', 'userNotification'],
        ]).filter(message => {
            // Purpose is to simulate the following domain on mail.message:
            // ['notification_ids.notification_status', 'in', ['bounce', 'exception']],
            // But it's not supported by _getRecords domain to follow a relation.
            const notifications = this._getRecords('mail.notification', [
                ['mail_message_id', '=', message.id],
                ['notification_status', 'in', ['bounce', 'exception']],
            ]);
            return notifications.length > 0;
        });
        return this._mockMailMessage_MessageNotificationFormat(messages.map(message => message.id));
    },
    /**
     * Simulates `_init_messaging` on `res.users`.
     *
     * @private
     * @param {integer[]} ids
     * @returns {Object}
     */
    _mockResUsers_InitMessaging(ids) {
        const user = this._getRecords('res.users', [['id', 'in', ids]])[0];
        return {
            channels: this._mockMailChannelChannelInfo(this._mockResPartner_GetChannelsAsMember(user.partnerId).map(channel => channel.id)),
            currentPartner: this._mockResPartnerMailPartnerFormat(user.partnerId).get(user.partnerId),
            currentUserId: this.currentUserId,
            currentUserSettings: this._mockResUsersSettings_FindOrCreateForUser(user.id),
            mailFailures: [],
            menuId: false, // not useful in QUnit tests
            needactionInboxCounter: this._mockResPartner_GetNeedactionCount(user.partnerId),
            partnerRoot: this._mockResPartnerMailPartnerFormat(this.partnerRootId).get(this.partnerRootId),
            publicPartners: [...this._mockResPartnerMailPartnerFormat(this.publicPartnerId).values()],
            shortcodes: this._getRecords('mail.shortcode', []),
            starredCounter: this._getRecords('mail.message', [['starredPartnerIds', 'in', user.partnerId]]).length,
        };
    },
});
