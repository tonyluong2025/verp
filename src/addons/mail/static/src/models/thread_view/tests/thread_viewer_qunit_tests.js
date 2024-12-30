/** @verp-module **/

import { registerFieldPatchModel, registerIdentifyingFieldsPatch } from '@mail/model/model_core';
import { one2one } from '@mail/model/model_field';

registerFieldPatchModel('mail.thread.viewer', 'qunit', {
    qunitTest: one2one('mail.qunitTest', {
        inverse: 'threadViewer',
        readonly: true,
    }),
});

registerIdentifyingFieldsPatch('mail.thread.viewer', 'qunit', identifyingFields => {
    identifyingFields[0].push('qunitTest');
});
