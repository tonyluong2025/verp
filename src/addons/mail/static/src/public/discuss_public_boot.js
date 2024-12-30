/** @verp-module **/

import { data } from 'mail.discuss_public_channel_template';

// ensure components are registered beforehand.
import '@mail/components/dialog_manager/dialog_manager';
import '@mail/components/discuss_public_view/discuss_public_view';
import { MessagingService } from '@mail/services/messaging/messaging';
import { getMessagingComponent } from '@mail/utils/messaging_component';

import { processTemplates } from '@web/core/assets';
import { MainComponentsContainer } from '@web/core/main_components_container';
import { registry } from '@web/core/registry';
import { makeEnv, startServices } from '@web/env';
import { session } from '@web/session';

import * as AbstractService from 'web.AbstractService';
import { serviceRegistry as legacyServiceRegistry } from 'web.core';
import * as legacyEnv from 'web.env';
import {
    makeLegacyCrashManagerService,
    makeLegacyDialogMappingService,
    makeLegacyNotificationService,
    makeLegacyRpcService,
    makeLegacySessionService,
    mapLegacyEnvToWowlEnv,
} from '@web/legacy/utils';
import * as legacySession from 'web.session';

owl.Component.env = legacyEnv;

(async function boot() {
    await owl.utils.whenReady();
    owl.config.mode = owl.Component.env.isDebug() ? 'dev' : 'prod';
    AbstractService.prototype.deployServices(owl.Component.env);
    const serviceRegistry = registry.category('services');
    serviceRegistry.add('legacyRpc', makeLegacyRpcService(owl.Component.env));
    serviceRegistry.add('legacySession', makeLegacySessionService(owl.Component.env, legacySession));
    serviceRegistry.add('legacyNotification', makeLegacyNotificationService(owl.Component.env));
    serviceRegistry.add('legacyCrashManager', makeLegacyCrashManagerService(owl.Component.env));
    serviceRegistry.add('legacyDialogMapping', makeLegacyDialogMappingService(owl.Component.env));
    await legacySession.isBound;
    owl.Component.env.qweb.addTemplates(legacySession.owlTemplates);
    Object.assign(verp, {
        info: {
            db: session.db,
            serverVersion: session.serverVersion,
            serverVersionInfo: session.serverVersionInfo,
            isEnterprise: session.serverVersionInfo.slice(-1)[0] === 'e',
        },
        isReady: false,
    });
    const env = makeEnv();
    const [, templates] = await Promise.all([
        startServices(env),
        verp.loadTemplatesPromise.then(processTemplates),
    ]);
    env.qweb.addTemplates(templates);
    mapLegacyEnvToWowlEnv(owl.Component.env, env);
    verp.isReady = true;
    legacyServiceRegistry.add('messaging', MessagingService.extend({
        messagingValues: {
            autofetchPartnerImStatus: false,
        },
    }));
    await owl.mount(MainComponentsContainer, { env, target: document.body });
    createAndMountDiscussPublicView();
})();

async function createAndMountDiscussPublicView() {
    const messaging = await owl.Component.env.services.messaging.get();
    // needed by the attachment viewer
    const DialogManager = getMessagingComponent('DialogManager');
    const dialogManagerComponent = new DialogManager(null, {});
    await dialogManagerComponent.mount(document.body);
    messaging.models['mail.thread'].insert(messaging.models['mail.thread'].convertData(data.channelData));
    const discussPublicView = messaging.models['mail.discussPublicView'].create(data.discussPublicViewData);
    if (discussPublicView.shouldDisplayWelcomeViewInitially) {
        discussPublicView.switchToWelcomeView();
    } else {
        discussPublicView.switchToThreadView();
    }
    const DiscussPublicView = getMessagingComponent('DiscussPublicView');
    const discussPublicViewComponent = new DiscussPublicView(null, {
        localId: discussPublicView.localId,
    });
    await discussPublicViewComponent.mount(document.body);
}
