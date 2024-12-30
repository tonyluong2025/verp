/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';
import { useComponentToModel } from '@mail/component_hooks/use_component_to_model/use_component_to_model';
const { Component } = owl;

export class AttachmentImage extends Component {

    setup() {
        super.setup();
        useComponentToModel({ fieldName: 'component', modelName: 'mail.attachmentImage', propNameAsRecordLocalId: 'attachmentImageLocalId' });
    }

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @returns {mail.attachmentImage}
     */
    get attachmentImage() {
        return this.messaging && this.messaging.models['mail.attachmentImage'].get(this.props.attachmentImageLocalId);
    }

}

Object.assign(AttachmentImage, {
    props: {
        attachmentImageLocalId: String,
    },
    template: 'mail.AttachmentImage',
});

registerMessagingComponent(AttachmentImage);
