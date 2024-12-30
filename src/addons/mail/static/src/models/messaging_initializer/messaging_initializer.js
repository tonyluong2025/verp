/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { executeGracefully } from '@mail/utils/utils';
import { link, insert, insertAndReplace } from '@mail/model/model_field_command';

function factory(dependencies) {

    class MessagingInitializer extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * Fetch messaging data initially to populate the store specifically for
         * the current user. This includes pinned channels for instance.
         */
        async start() {
            this.messaging.update({
                history: insertAndReplace({
                    id: 'history',
                    isServerPinned: true,
                    model: 'mail.box',
                    label: this.env._t("History"),
                }),
                inbox: insertAndReplace({
                    id: 'inbox',
                    isServerPinned: true,
                    model: 'mail.box',
                    label: this.env._t("Inbox"),
                }),
                starred: insertAndReplace({
                    id: 'starred',
                    isServerPinned: true,
                    model: 'mail.box',
                    label: this.env._t("Starred"),
                }),
            });
            const device = this.messaging.device;
            device.start();
            const data = await this.async(() => this.env.services.rpc({
                route: '/mail/initMessaging',
            }, { shadow: true }));
            await this.async(() => this._init(data));
            if (this.messaging.autofetchPartnerImStatus) {
                this.messaging.models['mail.partner'].startLoopFetchImStatus();
            }
            if (this.messaging.currentUser) {
                this._loadMessageFailures();
            }
        }

        //----------------------------------------------------------------------
        // Private
        //----------------------------------------------------------------------

        /**
         * @private
         * @param {Object} param0
         * @param {Object[]} param0.channels
         * @param {Object} param0.currentGuest
         * @param {Object} param0.currentPartner
         * @param {integer} param0.currentUserId
         * @param {Object} param0.currentUserSettings
         * @param {Object} [param0.mailFailures=[]]
         * @param {integer} [param0.needactionInboxCounter=0]
         * @param {Object} param0.partnerRoot
         * @param {Object[]} param0.publicPartners
         * @param {Object[]} [param0.shortcodes=[]]
         * @param {integer} [param0.starredCounter=0]
         */
        async _init({
            channels,
            commands = [],
            companyName,
            currentPartner,
            currentGuest,
            currentUserId,
            currentUserSettings,
            mailFailures = [],
            menuId,
            needactionInboxCounter = 0,
            partnerRoot,
            publicPartners,
            shortcodes = [],
            starredCounter = 0
        }) {
            const discuss = this.messaging.discuss;
            // partners first because the rest of the code relies on them
            this._initPartners({
                currentGuest,
                currentPartner,
                currentUserId,
                partnerRoot,
                publicPartners,
            });
            // mailboxes after partners and before other initializers that might
            // manipulate threads or messages
            this._initMailboxes({
                needactionInboxCounter,
                starredCounter,
            });
            // init mail user settings
            if (currentUserSettings) {
                this._initResUsersSettings(currentUserSettings);
            } else {
                this.messaging.update({
                    userSetting: insertAndReplace({
                        id: -1, // fake id for guest
                    }),
                });
            }
            // various suggestions in no particular order
            this._initCannedResponses(shortcodes);
            // FIXME: guests should have (at least some) commands available
            if (!this.messaging.isCurrentUserGuest) {
                this._initCommands();
            }
            // channels when the rest of messaging is ready
            await this.async(() => this._initChannels(channels));
            // failures after channels
            this._initMailFailures(mailFailures);
            discuss.update({ menuId });
            // company related data
            this.messaging.update({ companyName });
        }

        /**
         * @private
         * @param {Object[]} cannedResponsesData
         */
        _initCannedResponses(cannedResponsesData) {
            this.messaging.update({
                cannedResponses: insert(cannedResponsesData),
            });
        }

        /**
         * @private
         * @param {Object[]} channelsData
         */
        async _initChannels(channelsData) {
            return executeGracefully(channelsData.map(channelData => () => {
                const convertedData = this.messaging.models['mail.thread'].convertData(channelData);
                if (!convertedData.members) {
                    // channelInfo does not return all members of channel for
                    // performance reasons, but code is expecting to know at
                    // least if the current partner is member of it.
                    // (e.g. to know when to display "invited" notification)
                    // Current partner can always be assumed to be a member of
                    // channels received at init.
                    if (this.messaging.currentPartner) {
                        convertedData.members = link(this.messaging.currentPartner);
                    }
                    if (this.messaging.currentGuest) {
                        convertedData.guestMembers = link(this.messaging.currentGuest);
                    }
                }
                const channel = this.messaging.models['mail.thread'].insert(
                    Object.assign({ model: 'mail.channel' }, convertedData)
                );
                // flux specific: channels received at init have to be
                // considered pinned. task-2284357
                if (!channel.isPinned) {
                    channel.pin();
                }
            }));
        }

        /**
         * @private
         */
        _initCommands() {
            this.messaging.update({
                commands: insert([
                    {
                        help: this.env._t("Show a helper message"),
                        methodName: 'executeCommandHelp',
                        label: "help",
                    },
                    {
                        help: this.env._t("Leave this channel"),
                        methodName: 'executeCommandLeave',
                        label: "leave",
                    },
                    {
                        channelTypes: ['channel', 'chat'],
                        help: this.env._t("List users in the current channel"),
                        methodName: 'executeCommandWho',
                        label: "who",
                    }
                ]),
            });
        }

        /**
         * @private
         * @param {Object} param0
         * @param {integer} param0.needactionInboxCounter
         * @param {integer} param0.starredCounter
         */
        _initMailboxes({
            needactionInboxCounter,
            starredCounter,
        }) {
            this.messaging.inbox.update({ counter: needactionInboxCounter });
            this.messaging.starred.update({ counter: starredCounter });
        }

        /**
         * @private
         * @param {Object[]} mailFailuresData
         */
        async _initMailFailures(mailFailuresData) {
            await executeGracefully(mailFailuresData.map(messageData => () => {
                const message = this.messaging.models['mail.message'].insert(
                    this.messaging.models['mail.message'].convertData(messageData)
                );
                // implicit: failures are sent by the server at initialization
                // only if the current partner is author of the message
                if (!message.author && this.messaging.currentPartner) {
                    message.update({ author: link(this.messaging.currentPartner) });
                }
            }));
            this.messaging.notificationGroupManager.computeGroups();
        }

        /**
         * @param {object} resUsersSettings
         * @param {integer} resUsersSettings.id
         * @param {boolean} resUsersSettings.isDiscussSidebarCategoryChannelOpen
         * @param {boolean} resUsersSettings.isDiscussSidebarCategoryChatOpen
         * @param {boolean} resUsersSettings.usePushToTalk
         * @param {String} resUsersSettings.pushToTalkKey
         * @param {number} resUsersSettings.voiceActiveDuration
         * @param {Object} [resUsersSettings.volumeSettings]
         */
        _initResUsersSettings({
            id,
            isDiscussSidebarCategoryChannelOpen,
            isDiscussSidebarCategoryChatOpen,
            usePushToTalk,
            pushToTalkKey,
            voiceActiveDuration,
            volumeSettings = [],
        }) {
            this.messaging.currentUser.update({ resUsersSettingsId: id });
            this.messaging.update({
                userSetting: insertAndReplace({
                    id,
                    usePushToTalk: usePushToTalk,
                    pushToTalkKey: pushToTalkKey,
                    voiceActiveDuration: voiceActiveDuration,
                    volumeSettings: volumeSettings,
                }),
            });
            this.messaging.discuss.update({
                categoryChannel: insertAndReplace({
                    autocompleteMethod: 'channel',
                    commandAddTitleText: this.env._t("Add or join a channel"),
                    hasAddCommand: true,
                    hasViewCommand: true,
                    isServerOpen: isDiscussSidebarCategoryChannelOpen,
                    label: this.env._t("Channels"),
                    newItemPlaceholderText: this.env._t("Find or create a channel..."),
                    serverStateKey: 'isDiscussSidebarCategoryChannelOpen',
                    sortComputeMethod: 'name',
                    supportedChannelTypes: ['channel'],
                }),
                categoryChat: insertAndReplace({
                    autocompleteMethod: 'chat',
                    commandAddTitleText: this.env._t("Start a conversation"),
                    hasAddCommand: true,
                    isServerOpen: isDiscussSidebarCategoryChatOpen,
                    label: this.env._t("Direct Messages"),
                    newItemPlaceholderText: this.env._t("Find or start a conversation..."),
                    serverStateKey: 'isDiscussSidebarCategoryChatOpen',
                    sortComputeMethod: 'lastAction',
                    supportedChannelTypes: ['chat', 'group'],
                }),
            });
        }

        /**
         * @private
         * @param {Object} currentGuest
         * @param {Object} currentPartner
         * @param {integer} currentUserId
         * @param {Object} partnerRoot
         * @param {Object[]} [publicPartners=[]]
         */
        _initPartners({
            currentGuest,
            currentPartner,
            currentUserId: currentUserId,
            partnerRoot,
            publicPartners = [],
        }) {
            if (currentGuest) {
                this.messaging.update({ currentGuest: insert(currentGuest) });
            }
            if (currentPartner) {
                const partnerData = this.messaging.models['mail.partner'].convertData(currentPartner);
                this.messaging.update({
                    currentPartner: insert(partnerData),
                    currentUser: insert({ id: currentUserId }),
                });
            }
            this.messaging.update({
                partnerRoot: insert(this.messaging.models['mail.partner'].convertData(partnerRoot)),
                publicPartners: insert(publicPartners.map(
                    publicPartner => this.messaging.models['mail.partner'].convertData(publicPartner)
                )),
            });
        }

        /**
         * @private
         */
        async _loadMessageFailures() {
            const data = await this.env.services.rpc({
                route: '/mail/loadMessageFailures',
            }, { shadow: true });
            this._initMailFailures(data);
        }

    }
    MessagingInitializer.identifyingFields = ['messaging'];
    MessagingInitializer.modelName = 'mail.messagingInitializer';

    return MessagingInitializer;
}

registerNewModel('mail.messagingInitializer', factory);
