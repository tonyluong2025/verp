/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';

const { Component } = owl;

export class DiscussSidebarCategoryItem extends Component {

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @returns {mail.discussSidebarCategoryItem}
     */
    get categoryItem() {
        return this.messaging.models['mail.discussSidebarCategoryItem'].get(this.props.categoryItemLocalId);
    }
}

Object.assign(DiscussSidebarCategoryItem, {
    props: {
        categoryItemLocalId: String,
    },
    template: 'mail.DiscussSidebarCategoryItem',
});

registerMessagingComponent(DiscussSidebarCategoryItem);
