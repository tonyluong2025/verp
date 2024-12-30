/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';

const { Component } = owl;

export class DiscussSidebarCategory extends Component {

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @returns {mail.discussSidebarCategory}
     */
    get category() {
        return this.messaging.models['mail.discussSidebarCategory'].get(this.props.categoryLocalId);
    }
}

Object.assign(DiscussSidebarCategory, {
    props: {
        categoryLocalId: String,
    },
    template: 'mail.DiscussSidebarCategory',
});

registerMessagingComponent(DiscussSidebarCategory);
