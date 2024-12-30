/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { one2one } from '@mail/model/model_field';
import { insertAndReplace } from '@mail/model/model_field_command';

function factory(dependencies) {

    class SoundEffects extends dependencies['mail.model'] {
    }

    SoundEffects.fields = {
        channelJoin: one2one('mail.soundEffect', {
            default: insertAndReplace({ filename: 'channel_01_in' }),
            isCausal: true,
        }),
        channelLeave: one2one('mail.soundEffect', {
            default: insertAndReplace({ filename: 'channel_04_out' }),
            isCausal: true,
        }),
        incomingCall: one2one('mail.soundEffect', {
            default: insertAndReplace({ filename: 'call_02_in_' }),
            isCausal: true,
        }),
        memberLeave: one2one('mail.soundEffect', {
            default: insertAndReplace({ filename: 'channel_01_out' }),
            isCausal: true,
        }),
        newMessage: one2one('mail.soundEffect', {
            default: insertAndReplace({ filename: 'dm_02' }),
            isCausal: true,
        }),
        pushToTalk: one2one('mail.soundEffect', {
            default: insertAndReplace({ filename: 'dm_01' }),
            isCausal: true,
        }),
        screenSharing: one2one('mail.soundEffect', {
            default: insertAndReplace({ filename: 'share_02' }),
            isCausal: true,
        }),
    };
    SoundEffects.identifyingFields = ['messaging'];
    SoundEffects.modelName = 'mail.soundEffects';

    return SoundEffects;
}

registerNewModel('mail.soundEffects', factory);
