/** @verp-module **/

import { session } from "@web/session";
import { browser } from "../browser/browser";
import { registry } from "../registry";
import { strftimeToLuxonFormat } from "./dates";
import { localization } from "./localization";
import { translatedTerms, _t } from "./translation";

const { Settings } = luxon;

/** @type {[RegExp, string][]} */
const NUMBERING_SYSTEMS = [
    [/^ar-(sa|001)$/i, "arab"],
    [/^bn/i, "beng"],
    [/^bo/i, "tibt"],
    // [/^fa/i, "Farsi (Persian)"], // No numberingSystem found in Intl
    // [/^(hi|mr|ne)/i, "Hindi"], // No numberingSystem found in Intl
    // [/^my/i, "Burmese"], // No numberingSystem found in Intl
    [/^pa-in/i, "guru"],
    [/^ta/i, "tamldec"],
    [/.*/i, "latn"],
];

export const localizationService = {
    dependencies: ["user"],
    start: async (env, { user }) => {
        // add "data-toolip" to the list of translatable attributes in owl templates
        owl.config.translatableAttributes.push("data-tooltip");

        const cacheHashes = session.cacheHashes || {};
        const translationsHash = cacheHashes.translations || new Date().getTime().toString();
        const lang = user.lang || null;
        const translationURL = session.translationURL || "/web/webclient/translations";
        let url = `${translationURL}/${translationsHash}`;
        if (lang) {
            url += `?lang=${lang}`;
        }

        const response = await browser.fetch(url);
        if (!response.ok) {
            throw new Error("Error while fetching translations");
        }

        const {
            langParameters: userLocalization,
            modules: modules,
            multiLang: multiLang,
        } = await response.json();

        // FIXME We flatten the result of the javascript route.
        // Eventually, we want a new javascript route to return directly the good result.
        let terms = {};
        for (const addon of Object.keys(modules)) {
            for (const message of modules[addon].messages) {
                terms[message.id] = message.string;
            }
        }

        Object.setPrototypeOf(translatedTerms, terms);
        env._t = _t;
        env.qweb.translateFn = _t;

        if (lang) {
            // Setup lang inside luxon. The locale codes received from the server contain "_",
            // whereas the Intl codes use "-" (Unicode BCP 47). There's only one exception, which
            // is locale "sr@latin", for which we manually fallback to the "sr-Latn-RS" locale.
            const locale = lang === "sr@latin" ? "sr-Latn-RS" : lang.replace(/_/g, "-");
            Settings.defaultLocale = locale;
            for (const [re, numberingSystem] of NUMBERING_SYSTEMS) {
                if (re.test(locale)) {
                    Settings.defaultNumberingSystem = numberingSystem;
                    break;
                }
            }
        }

        const dateFormat = strftimeToLuxonFormat(userLocalization.dateFormat);
        const timeFormat = strftimeToLuxonFormat(userLocalization.timeFormat);
        const dateTimeFormat = `${dateFormat} ${timeFormat}`;
        const grouping = JSON.parse(userLocalization.grouping);

        Object.assign(localization, {
            dateFormat,
            timeFormat,
            dateTimeFormat,
            decimalPoint: userLocalization.decimalPoint,
            direction: userLocalization.direction,
            grouping,
            multiLang,
            thousandsSep: userLocalization.thousandsSep,
            weekStart: userLocalization.weekStart,
        });
    },
};

registry.category("services").add("localization", localizationService);
