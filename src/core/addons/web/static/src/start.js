/** @verp-module **/

import { makeEnv, startServices } from "./env";
import { legacySetupProm } from "./legacy/legacy_setup";
import { mapLegacyEnvToWowlEnv } from "./legacy/utils";
import { processTemplates } from "./core/assets";
import { session } from "@web/session";

const { mount, utils } = owl;
const { whenReady } = utils;

/**
 * Function to start a webclient.
 * It is used both in community and enterprise in main.js.
 * It's meant to be webclient flexible so we can have a subclass of
 * webclient in enterprise with added features.
 *
 * @param {owl.Component} Webclient
 */
export async function startWebClient(Webclient) {
    verp.info = {
        db: session.db,
        serverVersion: session.serverVersion,
        serverVersionInfo: session.serverVersionInfo,
        isEnterprise: session.serverVersionInfo.slice(-1)[0] === "e",
    };
    verp.isReady = false;

    // setup environment
    const env = makeEnv();
    const [, templates] = await Promise.all([
        startServices(env),
        verp.loadTemplatesPromise.then(processTemplates),
    ]);
    env.qweb.addTemplates(templates);

    // start web client
    await whenReady();
    const legacyEnv = await legacySetupProm;
    mapLegacyEnvToWowlEnv(legacyEnv, env);
    const root = await mount(Webclient, { env, target: document.body, position: "self" });
    // delete verp.debug; // FIXME: some legacy code rely on this
    verp.__WOWL_DEBUG__ = { root };
    verp.isReady = true;

    // Update Favicons
    const favicon = `/web/image/res.company/${env.services.company.currentCompany.id}/favicon`;
    const icons = document.querySelectorAll("link[rel*='icon']");
    const msIcon = document.querySelector("meta[name='msapplication-TileImage']");
    for (const icon of icons) {
        icon.href = favicon;
    }
    if (msIcon) {
        msIcon.content = favicon;
    }
}
