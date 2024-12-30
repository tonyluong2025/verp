/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { many2one, one2one } from '@mail/model/model_field';

function factory(dependencies) {

    class FollowerSubtypeList extends dependencies['mail.model'] {}

    FollowerSubtypeList.fields = {
        /**
         * States the dialog displaying this follower subtype list.
         */
        dialog: one2one('mail.dialog', {
            inverse: 'followerSubtypeList',
            isCausal: true,
            readonly: true,
        }),
        follower: many2one('mail.follower', {
            inverse: 'subtypeList',
            readonly: true,
            required: true,
        }),
    };
    FollowerSubtypeList.identifyingFields = ['follower'];
    FollowerSubtypeList.modelName = 'mail.followerSubtypeList';

    return FollowerSubtypeList;
}

registerNewModel('mail.followerSubtypeList', factory);
