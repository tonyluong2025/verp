/** @verp-module **/

import { evaluateExpr } from "@web/core/ast/index";
import { XMLParser } from "@web/core/utils/xml";
import { archParseBoolean } from "@web/views/helpers/utils";

export class PivotArchParser extends XMLParser {
    parse(arch) {
        const archInfo = {
            activeMeasures: [], // store the defined active measures
            colGroupBys: [], // store the defined groupby used on cols
            defaultOrder: null,
            fieldAttrs: {},
            rowGroupBys: [], // store the defined groupby used on rows
            widgets: {}, // wigdets defined in the arch
        };

        this.visitXML(arch, (node) => {
            switch (node.tagName) {
                case "pivot": {
                    if (node.hasAttribute("disableLinking")) {
                        archInfo.disableLinking = archParseBoolean(
                            node.getAttribute("disableLinking")
                        );
                    }
                    if (node.hasAttribute("defaultOrder")) {
                        archInfo.defaultOrder = node.getAttribute("defaultOrder");
                    }
                    if (node.hasAttribute("string")) {
                        archInfo.title = node.getAttribute("string");
                    }
                    if (node.hasAttribute("displayQuantity")) {
                        archInfo.displayQuantity = archParseBoolean(
                            node.getAttribute("displayQuantity")
                        );
                    }
                    break;
                }
                case "field": {
                    let fieldName = node.getAttribute("name"); // exists (rng validation)

                    archInfo.fieldAttrs[fieldName] = {};
                    if (node.hasAttribute("string")) {
                        archInfo.fieldAttrs[fieldName].string = node.getAttribute("string");
                    }
                    if (node.hasAttribute("invisible")) {
                        const isInvisible = Boolean(evaluateExpr(node.getAttribute("invisible")));
                        if (isInvisible) {
                            archInfo.fieldAttrs[fieldName].isInvisible = true;
                            break;
                        }
                    }

                    if (node.hasAttribute("interval")) {
                        fieldName += ":" + node.getAttribute("interval");
                    }
                    if (node.hasAttribute("widget")) {
                        archInfo.widgets[fieldName] = node.getAttribute("widget");
                    }
                    if (node.getAttribute("type") === "measure" || node.hasAttribute("operator")) {
                        archInfo.activeMeasures.push(fieldName);
                    }
                    if (node.getAttribute("type") === "col") {
                        archInfo.colGroupBys.push(fieldName);
                    }
                    if (node.getAttribute("type") === "row") {
                        archInfo.rowGroupBys.push(fieldName);
                    }
                    break;
                }
            }
        });

        return archInfo;
    }
}
