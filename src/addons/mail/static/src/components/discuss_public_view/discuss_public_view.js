/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';

const { Component } = owl;

class DiscussPublicView extends Component {

    /**
     * @returns {mail.discussPublicView}
     */
     get discussPublicView() {
        return this.messaging && this.messaging.models['mail.discussPublicView'].get(this.props.localId);
    }
}

Object.assign(DiscussPublicView, {
    props: { localId: String },
    template: 'mail.DiscussPublicView',
});

registerMessagingComponent(DiscussPublicView);
