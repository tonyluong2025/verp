/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { one2one } from '@mail/model/model_field';

function factory(dependencies) {

    class QUnitTest extends dependencies['mail.model'] {
    }

    QUnitTest.fields = {
        composer: one2one('mail.composer', {
            isCausal: true,
        }),
        composerView: one2one('mail.composer.view', {
            inverse: 'qunitTest',
            isCausal: true,
        }),
        messageView: one2one('mail.message.view', {
            inverse: 'qunitTest',
            isCausal: true,
        }),
        threadViewer: one2one('mail.thread.viewer', {
            inverse: 'qunitTest',
            isCausal: true,
        }),
    };
    QUnitTest.identifyingFields = []; // singleton acceptable (only one test at a time)
    QUnitTest.modelName = 'mail.qunitTest';

    return QUnitTest;
}

registerNewModel('mail.qunitTest', factory);
