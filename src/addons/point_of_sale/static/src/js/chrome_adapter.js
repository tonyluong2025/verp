/** @verp-module */

import { useService } from "@web/core/utils/hooks";

import Chrome from "point_of_sale.Chrome";
import Registries from "point_of_sale.Registries";
import { configureGui } from "point_of_sale.Gui";
import { useBus } from "@web/core/utils/hooks";
const { Component } = owl;
import { registry } from "@web/core/registry";

function setupResponsivePlugin(env) {
    const isMobile = () => window.innerWidth <= 768;
    env.isMobile = isMobile();
    const updateEnv = owl.utils.debounce(() => {
        if (env.isMobile !== isMobile()) {
            env.isMobile = !env.isMobile;
            env.qweb.forceUpdate();
        }
    }, 15);
    window.addEventListener("resize", updateEnv);
}

export class ChromeAdapter extends Component {
    setup() {
        this.PosChrome = Registries.Component.get(Chrome);
        this.legacyActionManager = useService("legacyActionManager");

        this.env = owl.Component.env;
        useBus(this.env.qweb, "update", () => this.render());
        setupResponsivePlugin(this.env);

        const chrome = owl.hooks.useRef("chrome");
        owl.hooks.onMounted(async () => {
            // Add the pos error handler when the chrome component is available.
            registry.category('errorHandlers').add(
                'posErrorHandler',
                (env, ...noEnvArgs) => {
                    if (chrome.comp) {
                        return chrome.comp.errorHandler(this.env, ...noEnvArgs);
                    }
                    return false;
                },
                { sequence: 0 }
            );
            // Little trick to avoid displaying the block ui during the POS models loading
            const BlockUiFromRegistry = registry.category("mainComponents").get("BlockUI");
            registry.category("mainComponents").remove("BlockUI");
            configureGui({ component: chrome.comp });
            await chrome.comp.start();
            registry.category("mainComponents").add("BlockUI", BlockUiFromRegistry);
        });
    }
}
ChromeAdapter.template = owl.tags.xml`<PosChrome t-ref="chrome" webClient="legacyActionManager"/>`;
