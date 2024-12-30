/** @verp-module alias=web.legacySetup **/

import { registry } from "../core/registry";
import {
    makeLegacyNotificationService,
    makeLegacyRpcService,
    makeLegacySessionService,
    makeLegacyDialogMappingService,
    makeLegacyCrashManagerService,
    makeLegacyCommandService,
    makeLegacyDropdownService,
} from "./utils";
import { makeLegacyActionManagerService } from "./backend_utils";
import * as AbstractService from "web.AbstractService";
import * as legacyEnv from "web.env";
import * as session from "web.session";
import * as makeLegacyWebClientService from "web.pseudoWebClient";

const { Component, config, utils } = owl;
const { whenReady } = utils;

let legacySetupResolver;
export const legacySetupProm = new Promise((resolve) => {
    legacySetupResolver = resolve;
});

// build the legacy env and set it on owl.Component (this was done in main.js,
// with the starting of the webclient)
(async () => {
    config.mode = legacyEnv.isDebug() ? "dev" : "prod";
    AbstractService.prototype.deployServices(legacyEnv);
    Component.env = legacyEnv;
    const legacyActionManagerService = makeLegacyActionManagerService(legacyEnv);
    const serviceRegistry = registry.category("services");
    serviceRegistry.add("legacyActionManager", legacyActionManagerService);
    // add a service to redirect rpc events triggered on the bus in the
    // legacy env on the bus in the wowl env
    const legacyRpcService = makeLegacyRpcService(legacyEnv);
    serviceRegistry.add("legacyRpc", legacyRpcService);
    const legacySessionService = makeLegacySessionService(legacyEnv, session);
    serviceRegistry.add("legacySession", legacySessionService);
    const legacyWebClientService = makeLegacyWebClientService(legacyEnv);
    serviceRegistry.add("legacyWebClient", legacyWebClientService);
    serviceRegistry.add("legacyNotification", makeLegacyNotificationService(legacyEnv));
    serviceRegistry.add("legacyCrashManager", makeLegacyCrashManagerService(legacyEnv));
    const legacyDialogMappingService = makeLegacyDialogMappingService(legacyEnv);
    serviceRegistry.add("legacyDialogMapping", legacyDialogMappingService);
    const legacyCommandService = makeLegacyCommandService(legacyEnv);
    serviceRegistry.add("legacyCommand", legacyCommandService);
    serviceRegistry.add("legacyDropdown", makeLegacyDropdownService(legacyEnv));
    await Promise.all([whenReady(), session.isBound]);
    legacyEnv.qweb.addTemplates(session.owlTemplates);
    legacySetupResolver(legacyEnv);
})();
