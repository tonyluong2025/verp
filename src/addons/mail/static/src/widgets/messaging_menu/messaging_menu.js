/** @verp-module **/

import { getMessagingComponent } from "@mail/utils/messaging_component";

import Widget from 'web.Widget';

/**
 * Verp Widget, necessary to instantiate component.
 */
export const MessagingMenuWidget = Widget.extend({
    template: 'mail.widgets.MessagingMenu',
    /**
     * @override
     */
    init() {
        this._super(...arguments);
        this.component = undefined;
    },
    /**
     * @override
     */
    destroy() {
        if (this.component) {
            this.component.destroy();
        }
        this._super(...arguments);
    },
    async onAttachCallback() {
        const MessagingMenu = getMessagingComponent("MessagingMenu");
        this.component = new MessagingMenu(null);
        await this.component.mount(this.el);
        // unwrap
        this.el.parentNode.insertBefore(this.component.el, this.el);
        this.el.parentNode.removeChild(this.el);
    },
});
