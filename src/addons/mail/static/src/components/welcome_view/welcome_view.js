/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';
import { useRefToModel } from '@mail/component_hooks/use_ref_to_model/use_ref_to_model';
import { useUpdateToModel } from '@mail/component_hooks/use_update_to_model/use_update_to_model';

export class WelcomeView extends owl.Component {

    /**
     * @override
     */
    setup() {
        super.setup();
        useRefToModel({ fieldName: 'guestNameInputRef', modelName: 'mail.welcome.view', propNameAsRecordLocalId: 'localId', refName: 'guestNameInput' });
        useUpdateToModel({ methodName: 'onComponentUpdate', modelName: 'mail.welcome.view', propNameAsRecordLocalId: 'localId' });
    }

    /**
     * @returns {mail.welcome.view}
     */
    get welcomeView() {
        return this.messaging && this.messaging.models['mail.welcome.view'].get(this.props.localId);
    }

}

Object.assign(WelcomeView, {
    props: { localId: String },
    template: 'mail.WelcomeView',
});

registerMessagingComponent(WelcomeView);
