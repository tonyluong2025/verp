/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';

const { Component } = owl;

export class ComposerSuggestionList extends Component {

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @returns {mail.composer.view}
     */
    get composerView() {
        return this.messaging && this.messaging.models['mail.composer.view'].get(this.props.composerViewLocalId);
    }

}

Object.assign(ComposerSuggestionList, {
    defaultProps: {
        isBelow: false,
    },
    props: {
        composerViewLocalId: String,
        isBelow: Boolean,
    },
    template: 'mail.ComposerSuggestionList',
});

registerMessagingComponent(ComposerSuggestionList);
