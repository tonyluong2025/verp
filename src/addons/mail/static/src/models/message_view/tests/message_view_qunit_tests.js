/** @verp-module **/

import { registerFieldPatchModel, registerIdentifyingFieldsPatch } from '@mail/model/model_core';
import { one2one } from '@mail/model/model_field';

registerFieldPatchModel('mail.message.view', 'qunit', {
    qunitTest: one2one('mail.qunitTest', {
        inverse: 'messageView',
        readonly: true,
    }),
});

registerIdentifyingFieldsPatch('mail.message.view', 'qunit', identifyingFields => {
    identifyingFields[0].push('qunitTest');
});
