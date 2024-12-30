/** @verp-module **/

import {
    registerInstancePatchModel,
    registerFieldPatchModel,
} from '@mail/model/model_core';
import { attr } from '@mail/model/model_field';

registerInstancePatchModel('mail.messaging', 'snailmail/static/src/models/messaging/messaging.js', {
    async fetchSnailmailCreditsUrl() {
        const snailmailCreditsUrl = await this.async(() => this.env.services.rpc({
            model: 'iap.account',
            method: 'getCreditsUrl',
            args: ['snailmail'],
        }));
        this.update({
            snailmailCreditsUrl,
        });
    },
    async fetchSnailmailCreditsUrlTrial() {
        const snailmailCreditsUrlTrial = await this.async(() => this.env.services.rpc({
            model: 'iap.account',
            method: 'getCreditsUrl',
            args: ['snailmail', '', 0, true],
        }));
        this.update({
            snailmailCreditsUrlTrial,
        });
    },
});

registerFieldPatchModel('mail.messaging', 'snailmail/static/src/models/messaging/messaging.js', {
    snailmailCreditsUrl: attr(),
    snailmailCreditsUrlTrial: attr(),
});
