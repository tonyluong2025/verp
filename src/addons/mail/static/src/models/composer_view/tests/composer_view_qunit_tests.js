/** @verp-module **/

import { registerFieldPatchModel, registerIdentifyingFieldsPatch, registerInstancePatchModel } from '@mail/model/model_core';
import { one2one } from '@mail/model/model_field';
import { replace } from '@mail/model/model_field_command';

registerInstancePatchModel('mail.composer.view', 'qunit', {
    _computeComposer() {
        if (this.qunitTest && this.qunitTest.composer) {
            return replace(this.qunitTest.composer);
        }
        return this._super();
    }
});

registerFieldPatchModel('mail.composer.view', 'qunit', {
    qunitTest: one2one('mail.qunitTest', {
        inverse: 'composerView',
        readonly: true,
    }),
});

registerIdentifyingFieldsPatch('mail.composer.view', 'qunit', identifyingFields => {
    identifyingFields[0].push('qunitTest');
});
