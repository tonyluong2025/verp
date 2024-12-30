/** @verp-module **/

import { _lt } from "@web/core/l10n/translation";
import { Dialog } from "@web/core/dialog/dialog";
import { formatDateTime, parseDateTime } from "@web/core/l10n/dates";
import { formatMany2one } from "@web/fields/formatters";
import { registry } from "@web/core/registry";

const { hooks } = owl;
const { useState } = hooks;

const debugRegistry = registry.category("debug");

class GetMetadataDialog extends Dialog {
    setup() {
        super.setup();
        this.state = useState({});
    }

    async willStart() {
        await this.getMetadata();
    }

    async toggleNoupdate() {
        await this.env.services.orm.call("ir.model.data", "toggleNoupdate", [
            this.props.resModel,
            this.state.id,
        ]);
        await this.getMetadata();
    }

    async getMetadata() {
        const metadata = (
            await this.env.services.orm.call(this.props.resModel, "getMetadata", [
                this.props.selectedIds,
            ])
        )[0];
        this.state.id = metadata.id;
        this.state.xmlid = metadata.xmlid;
        this.state.creator = formatMany2one(metadata.createdUid);
        this.state.lastModifiedBy = formatMany2one(metadata.updatedUid);
        this.state.noupdate = metadata.noupdate;
        this.state.createdAt = formatDateTime(parseDateTime(metadata.createdAt), { timezone: true });
        this.state.updatedAt = formatDateTime(parseDateTime(metadata.updatedAt), { timezone: true });
    }
}
GetMetadataDialog.bodyTemplate = "web.DebugMenu.getMetadataBody";
GetMetadataDialog.title = _lt("View Metadata");
class SetDefaultDialog extends Dialog {
    setup() {
        super.setup();
        this.state = {
            fieldToSet: "",
            condition: "",
            scope: "self",
        };
        this.dataWidgetState = this.getDataWidgetState();
        this.defaultFields = this.getDefaultFields();
        this.conditions = this.getConditions();
    }

    getDataWidgetState() {
        const renderer = this.props.component.widget.renderer;
        const state = renderer.state;
        const fields = state.fields;
        const fieldsInfo = state.fieldsInfo.form;
        const fieldNamesInView = state.getFieldNames();
        const fieldNamesOnlyOnView = ["messageAttachmentCount"];
        const fieldsValues = state.data;
        const modifierDatas = {};
        fieldNamesInView.forEach((fieldName) => {
            modifierDatas[fieldName] = renderer.allModifiersData.find((modifierdata) => {
                return modifierdata.node.attrs.name === fieldName;
            });
        });
        return {
            fields,
            fieldsInfo,
            fieldNamesInView,
            fieldNamesOnlyOnView,
            fieldsValues,
            modifierDatas,
            stateId: state.id,
        };
    }

    getDefaultFields() {
        const {
            fields,
            fieldsInfo,
            fieldNamesInView,
            fieldNamesOnlyOnView,
            fieldsValues,
            modifierDatas,
            stateId,
        } = this.dataWidgetState;
        return fieldNamesInView
            .filter((fieldName) => !fieldNamesOnlyOnView.includes(fieldName))
            .map((fieldName) => {
                const modifierData = modifierDatas[fieldName];
                let invisibleOrReadOnly;
                if (modifierData) {
                    const evaluatedModifiers = modifierData.evaluatedModifiers[stateId];
                    invisibleOrReadOnly =
                        evaluatedModifiers.invisible || evaluatedModifiers.readonly;
                }
                const fieldInfo = fields[fieldName];
                const valueDisplayed = this.display(fieldInfo, fieldsValues[fieldName]);
                const value = valueDisplayed[0];
                const displayed = valueDisplayed[1];
                // ignore fields which are empty, invisible, readonly, o2m
                // or m2m
                if (
                    !value ||
                    invisibleOrReadOnly ||
                    fieldInfo.type === "one2many" ||
                    fieldInfo.type === "many2many" ||
                    fieldInfo.type === "binary" ||
                    fieldsInfo[fieldName].options.isPassword ||
                    fieldInfo.depends === undefined ||
                    fieldInfo.depends.length !== 0
                ) {
                    return false;
                }
                return {
                    name: fieldName,
                    string: fieldInfo.string,
                    value: value,
                    displayed: displayed,
                };
            })
            .filter((val) => val)
            .sort((field) => field.string);
    }

    getConditions() {
        const { fields, fieldNamesInView, fieldsValues } = this.dataWidgetState;
        return fieldNamesInView
            .filter((fieldName) => {
                const fieldInfo = fields[fieldName];
                return fieldInfo.changeDefault;
            })
            .map((fieldName) => {
                const fieldInfo = fields[fieldName];
                const valueDisplayed = this.display(fieldInfo, fieldsValues[fieldName]);
                const value = valueDisplayed[0];
                const displayed = valueDisplayed[1];
                return {
                    name: fieldName,
                    string: fieldInfo.string,
                    value: value,
                    displayed: displayed,
                };
            });
    }

    display(fieldInfo, value) {
        let displayed = value;
        if (value && fieldInfo.type === "many2one") {
            displayed = value.data.displayName;
            value = value.data.id;
        } else if (value && fieldInfo.type === "selection") {
            displayed = fieldInfo.selection.find((option) => {
                return option[0] === value;
            })[1];
        }
        return [value, displayed];
    }

    async saveDefault() {
        if (!this.state.fieldToSet) {
            // TODO $defaults.parent().addClass('o-form-invalid');
            // It doesn't work in web.
            // Good solution: Create a FormView
            return;
        }
        const fieldToSet = this.defaultFields.find((field) => {
            return field.name === this.state.fieldToSet;
        }).value;
        await this.env.services.orm.call("ir.default", "set", [
            this.props.resModel,
            this.state.fieldToSet,
            fieldToSet,
            this.state.scope === "self",
            true,
            this.state.condition || false,
        ]);
        this.trigger("dialog-closed");
    }
}
SetDefaultDialog.bodyTemplate = "web.DebugMenu.setDefaultBody";
SetDefaultDialog.footerTemplate = "web.DebugMenu.SetDefaultFooter";
SetDefaultDialog.title = _lt("Set Default");

// Form view items

function setDefaults({ action, component, env }) {
    return {
        type: "item",
        description: env._t("Set Defaults"),
        callback: () => {
            env.services.dialog.add(SetDefaultDialog, {
                resModel: action.resModel,
                component,
            });
        },
        sequence: 310,
    };
}

function viewMetadata({ action, component, env }) {
    const selectedIds = component.widget.getSelectedIds();
    if (selectedIds.length !== 1) {
        return null;
    }
    return {
        type: "item",
        description: env._t("View Metadata"),
        callback: () => {
            env.services.dialog.add(GetMetadataDialog, {
                resModel: action.resModel,
                selectedIds,
            });
        },
        sequence: 320,
    };
}

function manageAttachments({ action, component, env }) {
    const selectedIds = component.widget.getSelectedIds();
    const description = env._t("Manage Attachments");
    if (selectedIds.length !== 1) {
        return null;
    }
    return {
        type: "item",
        description,
        callback: () => {
            const selectedId = selectedIds[0];
            env.services.action.doAction({
                resModel: "ir.attachment",
                name: description,
                views: [
                    [false, "list"],
                    [false, "form"],
                ],
                type: "ir.actions.actwindow",
                domain: [
                    ["resModel", "=", action.resModel],
                    ["resId", "=", selectedId],
                ],
                context: {
                    default_resModel: action.resModel,
                    default_resId: selectedId,
                },
            });
        },
        sequence: 330,
    };
}

debugRegistry
    .category("form")
    .add("setDefaults", setDefaults)
    .add("viewMetadata", viewMetadata)
    .add("manageAttachments", manageAttachments);
