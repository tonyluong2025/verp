/** @verp-module **/

import { attr, one2one } from '@mail/model/model_field';
import { registerNewModel } from '@mail/model/model_core';
import { clear, insertAndReplace, link } from '@mail/model/model_field_command';

function factory(dependencies) {

    class DiscussPublicView extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * Creates and displays the thread view and clears the welcome view.
         */
        async switchToThreadView() {
            this.update({
                threadViewer: insertAndReplace({
                    extraClass: 'flex-grow-1',
                    hasMemberList: true,
                    hasThreadView: true,
                    hasTopbar: true,
                    thread: link(this.channel),
                }),
                welcomeView: clear(),
            });
            if (this.isChannelTokenSecret) {
                // Change the URL to avoid leaking the invitation link.
                window.history.replaceState(window.history.state, null, `/discuss/channel/${this.channel.id}${window.location.search}`);
            }
            if (this.channel.defaultDisplayMode === 'videoFullScreen') {
                await this.channel.toggleCall({ startWithVideo: true });
                await this.threadView.rtcCallViewer.activateFullScreen();
            }
        }

        /**
         * Creates and displays the welcome view and clears the thread viewer.
         */
        switchToWelcomeView() {
            this.update({
                threadViewer: clear(),
                welcomeView: insertAndReplace({
                    channel: link(this.channel),
                    isDoFocusGuestNameInput: true,
                    originalGuestName: this.messaging.currentGuest && this.messaging.currentGuest.label,
                    pendingGuestName: this.messaging.currentGuest && this.messaging.currentGuest.label,
                }),
            });
            if (this.welcomeView.mediaPreview) {
                this.welcomeView.mediaPreview.enableMicrophone();
                this.welcomeView.mediaPreview.enableVideo();
            }
        }

    }

    DiscussPublicView.fields = {
        /**
         * States the channel linked to this discuss public view.
         */
        channel: one2one('mail.thread', {
            readonly: true,
            required: true,
        }),
        isChannelTokenSecret: attr({
            default: true,
        }),
        shouldAddGuestAsMemberOnJoin: attr({
            default: false,
            readonly: true,
        }),
        shouldDisplayWelcomeViewInitially: attr({
            default: false,
            readonly: true,
        }),
        /**
         * States the thread view linked to this discuss public view.
         */
        threadView: one2one('mail.threadView', {
            readonly: true,
            related: 'threadViewer.threadView',
        }),
        /**
         * States the thread viewer linked to this discuss public view.
         */
        threadViewer: one2one('mail.thread.viewer', {
            inverse: 'discussPublicView',
            isCausal: true,
        }),
        /**
         * States the welcome view linked to this discuss public view.
         */
        welcomeView: one2one('mail.welcome.view', {
            inverse: 'discussPublicView',
            isCausal: true,
        }),
    };
    DiscussPublicView.identifyingFields = ['messaging'];
    DiscussPublicView.modelName = 'mail.discussPublicView';

    return DiscussPublicView;
}

registerNewModel('mail.discussPublicView', factory);
