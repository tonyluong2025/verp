/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';

const { Component } = owl;

export class AttachmentList extends Component {

    /**
     * @returns {mail.attachmentList}
     */
    get attachmentList() {
        return this.messaging && this.messaging.models['mail.attachmentList'].get(this.props.attachmentListLocalId);
    }

}

Object.assign(AttachmentList, {
    props: {
        attachmentListLocalId: String,
    },
    template: 'mail.AttachmentList',
});

registerMessagingComponent(AttachmentList);
