/** @verp-module **/

import { useComponentToModel } from '@mail/component_hooks/use_component_to_model/use_component_to_model';
import { registerMessagingComponent } from '@mail/utils/messaging_component';

import { usePosition } from '@web/core/position/position_hook';

const { Component } = owl;

export class PopoverView extends Component {

    setup() {
        super.setup();
        useComponentToModel({ fieldName: 'component', modelName: 'mail.popoverView', propNameAsRecordLocalId: 'popoverViewLocalId' });
        usePosition(
            () => this.popoverView && this.popoverView.anchorRef && this.popoverView.anchorRef.el,
            {
                margin: 16,
                position: this.popoverView.position,
            }
        );
    }

    //--------------------------------------------------------------------------
    // Getters / Setters
    //--------------------------------------------------------------------------

    /**
     * @returns {mail.popoverView|undefined}
     */
    get popoverView() {
        return this.messaging && this.messaging.models['mail.popoverView'].get(this.props.popoverViewLocalId);
    }

}

Object.assign(PopoverView, {
    props: {
        popoverViewLocalId: String,
    },
    template: 'mail.PopoverView',
});

registerMessagingComponent(PopoverView);
