/** @verp-module **/

// ensure component is registered beforehand.
import '@mail/components/discuss/discuss';
import { getMessagingComponent } from "@mail/utils/messaging_component";

import AbstractAction from 'web.AbstractAction';

const { Component } = owl;

export const DiscussWidget = AbstractAction.extend({
    template: 'mail.widgets.Discuss',
    /**
     * @override {web.AbstractAction}
     * @param {web.ActionManager} parent
     * @param {Object} action
     * @param {Object} [action.context]
     * @param {string} [action.context.activeId]
     * @param {Object} [action.params]
     * @param {string} [action.params.default_activeId]
     * @param {Object} [options={}]
     */
    init(parent, action, options={}) {
        this._super(...arguments);
        // control panel attributes
        this.action = action;
        this.actionManager = parent;
        this.discuss = undefined;
        this.options = options;

        this.component = undefined;

        this._lastPushStateActiveThread = null;
        this.env = Component.env;
        Component.env.services.messaging.modelManager.messagingCreatedPromise.then(async () => {
            const messaging = Component.env.services.messaging.modelManager.messaging;
            const initActiveId = this.options.activeId ||
                (this.action.context && this.action.context.activeId) ||
                (this.action.params && this.action.params.default_activeId) ||
                'mail.boxInbox';
            this.discuss = messaging.discuss;
            this.discuss.update({ initActiveId, isOpen: true });
            // Wait for messaging to be initialized to make sure the system
            // knows of the "init thread" if it exists.
            await messaging.initializedPromise;
            if (!this.discuss.isInitThreadHandled) {
                this.discuss.update({ isInitThreadHandled: true });
                if (!this.discuss.thread) {
                    this.discuss.openInitThread();
                }
            }
        });
    },
    /**
     * @override {web.AbstractAction}
     */
    destroy() {
        if (this.component) {
            this.component.destroy();
            this.component = undefined;
        }
        if (this.$buttons) {
            this.$buttons.off().remove();
        }
        this._super(...arguments);
    },
    /**
     * @override {web.AbstractAction}
     */
    onAttachCallback() {
        this._super(...arguments);
        if (this.component) {
            // prevent twice call to onAttachCallback (FIXME)
            return;
        }
        const DiscussComponent = getMessagingComponent("Discuss");
        this.component = new DiscussComponent();
        this._pushStateActionManagerEventListener = ev => {
            ev.stopPropagation();
            if (this._lastPushStateActiveThread === this.discuss.thread) {
                return;
            }
            this._pushStateActionManager();
            this._lastPushStateActiveThread = this.discuss.thread;
        };
        this._showRainbowManEventListener = ev => {
            ev.stopPropagation();
            this._showRainbowMan();
        };
        this.el.addEventListener(
            'o-push-state-action-manager',
            this._pushStateActionManagerEventListener
        );
        this.el.addEventListener(
            'o-show-rainbow-man',
            this._showRainbowManEventListener
        );
        return this.component.mount(this.el);
    },
    /**
     * @override {web.AbstractAction}
     */
    onDetachCallback() {
        this._super(...arguments);
        if (this.component) {
            this.component.destroy();
        }
        this.component = undefined;
        this.el.removeEventListener(
            'o-push-state-action-manager',
            this._pushStateActionManagerEventListener
        );
        this.el.removeEventListener(
            'o-show-rainbow-man',
            this._showRainbowManEventListener
        );
        this._lastPushStateActiveThread = null;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _pushStateActionManager() {
        this.actionManager.doPushState({
            action: this.action.id,
            activeId: this.discuss.activeId,
        });
    },
    /**
     * @private
     */
    _showRainbowMan() {
        this.triggerUp('showEffect', {
            message: this.env._t("Congratulations, your inbox is empty!"),
            type: 'rainbowMan',
        });
    },
});
