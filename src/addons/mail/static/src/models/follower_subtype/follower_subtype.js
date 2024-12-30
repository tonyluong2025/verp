/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { attr } from '@mail/model/model_field';

function factory(dependencies) {

    class FollowerSubtype extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * @static
         * @param {Object} data
         * @returns {Object}
         */
        static convertData(data) {
            const data2 = {};
            if ('default' in data) {
                data2.isDefault = data.default;
            }
            if ('id' in data) {
                data2.id = data.id;
            }
            if ('internal' in data) {
                data2.isInternal = data.internal;
            }
            if ('label' in data) {
                data2.label = data.label;
            }
            if ('parentModel' in data) {
                data2.parentModel = data.parentModel;
            }
            if ('resModel' in data) {
                data2.resModel = data.resModel;
            }
            if ('sequence' in data) {
                data2.sequence = data.sequence;
            }
            return data2;
        }

    }

    FollowerSubtype.fields = {
        id: attr({
            readonly: true,
            required: true,
        }),
        isDefault: attr({
            default: false,
        }),
        isInternal: attr({
            default: false,
        }),
        label:attr(),
        // AKU FIXME: use relation instead
        parentModel: attr(),
        // AKU FIXME: use relation instead
        resModel: attr(),
        sequence: attr(),
    };
    FollowerSubtype.identifyingFields = ['id'];
    FollowerSubtype.modelName = 'mail.followerSubtype';

    return FollowerSubtype;
}

registerNewModel('mail.followerSubtype', factory);
