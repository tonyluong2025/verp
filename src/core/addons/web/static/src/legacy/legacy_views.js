/** @verp-module **/
const { Component, hooks, tags } = owl;

import { useService } from "@web/core/utils/hooks";
import { useSetupAction } from "../webclient/actions/action_hook";
import legacyViewRegistry from "web.viewRegistry";
import { ViewAdapter } from "./action_adapters";
import Widget from "web.Widget";
import {
    breadcrumbsToLegacy,
    getGlobalState,
    getLocalState,
    searchModelStateToLegacy,
} from "./backend_utils";
import { setScrollPosition } from "../core/utils/scrolling";
import { registry } from "@web/core/registry";
import { loadPublicAsset } from "@web/core/assets";

const viewRegistry = registry.category("views");

function getJsClassWidget(fieldsInfo) {
    const parsedXML = new DOMParser().parseFromString(fieldsInfo.arch, "text/xml");
    const key = parsedXML.documentElement.getAttribute("jsClass");
    return legacyViewRegistry.get(key);
}

const legacyViewTemplate = tags.xml`
    <ViewAdapter Component="Widget" View="View" viewInfo="viewInfo" viewParams="viewParams"
                 widget="widget" onReverseBreadcrumb="onReverseBreadcrumb" t-ref="controller"
                 t-on-scrollTo.stop="onScrollTo"/>`;

// registers a view from the legacy view registry to the wowl one, but wrapped
// into an Owl Component
function registerView(name, LegacyView) {
    class Controller extends Component {
        constructor() {
            super(...arguments);
            this.vm = useService("view");
            this.controllerRef = hooks.useRef("controller");
            this.Widget = Widget; // fool the ComponentAdapter with a simple Widget
            this.View = LegacyView;
            this.viewInfo = {};

            let resIds;
            let searchModel;
            let searchpanel;
            const { globalState } = this.props;
            if (globalState) {
                resIds = globalState.resIds;
                searchModel = searchModelStateToLegacy(globalState.searchModel);
                searchpanel = globalState.searchpanel;
            }

            // always add user context to the action context
            this.user = useService("user");
            const action = Object.assign({}, this.props.action, {
                context: Object.assign({}, this.user.context, this.props.action.context),
            });

            const { actionFlags, breadcrumbs = [] } = this.env.config;
            this.viewParams = Object.assign({}, actionFlags, {
                action,
                // legacy views automatically add the last part of the breadcrumbs
                breadcrumbs: breadcrumbsToLegacy(breadcrumbs),
                modelName: this.props.resModel,
                currentId: this.props.resId,
                controllerState: {
                    currentId:
                        "resId" in this.props
                            ? this.props.resId
                            : this.props.state && this.props.state.currentId,
                    resIds: this.props.resIds || resIds,
                    searchModel,
                    searchpanel,
                },
            });

            // To open a new empty form view
            // Legacy demands undefined ids, not false
            if (this.viewParams.currentId === false) {
                this.viewParams.currentId = undefined;
                this.viewParams.controllerState.currentId = undefined;
            }

            // Only add mode to viewParams if it is specified to avoid overwriting the default mode in some view (eg graph)
            if (this.props.mode) {
                this.viewParams.mode = this.props.mode;
            }
            this.widget = this.props.state && this.props.state.__legacy_widget__;
            this.onReverseBreadcrumb =
                this.props.state && this.props.state.__on_reverse_breadcrumb__;
            useSetupAction({
                beforeLeave: () => this.controllerRef.comp.__widget.canBeRemoved(),
                getGlobalState: () => getGlobalState(this.controllerRef.comp.exportState()),
                getLocalState: () => getLocalState(this.controllerRef.comp.exportState()),
            });
            this.onScrollTo = (ev) => {
                setScrollPosition(this, { left: ev.detail.left, top: ev.detail.top });
            };
        }

        async willStart() {
            const params = {
                resModel: this.props.resModel,
                views: this.props.views,
                context: this.props.context,
            };
            const options = {
                actionId: this.env.config.actionId,
                loadActionMenus: this.props.loadActionMenus,
                loadIrFilters: this.props.loadIrFilters,
            };
            const viewDescriptions = await this.vm.loadViews(params, options);
            const result = viewDescriptions.__legacy__;
            const fieldsInfo = result.fieldsViews[this.props.type];
            const jsClass = getJsClassWidget(fieldsInfo);
            this.View = jsClass || this.View;
            this.viewInfo = Object.assign({}, fieldsInfo, {
                fields: result.fields,
                viewFields: fieldsInfo.fields,
            });
            let controlPanelFieldsView;
            if (result.fieldsViews.search) {
                controlPanelFieldsView = Object.assign({}, result.fieldsViews.search, {
                    favoriteFilters: result.filters,
                    fields: result.fields,
                    viewFields: result.fieldsViews.search.fields,
                });
            }
            const { viewSwitcherEntries = [] } = this.env.config;
            const views = this.viewParams.action.views
                .filter(([, vtype]) => vtype !== "search")
                .map(([vid, vtype]) => {
                    const view = viewSwitcherEntries.find((v) => v.type === vtype);
                    if (view) {
                        return Object.assign({}, view, { viewID: vid });
                    } else {
                        return {
                            viewID: vid,
                            type: vtype,
                            multiRecord: !this.constructor.multiRecord,
                        };
                    }
                });
            this.viewParams.action = Object.assign({}, this.viewParams.action, {
                controlPanelFieldsView,
                _views: this.viewParams.action.views,
                views,
            });
        }
    }
    Controller.template = legacyViewTemplate;

    Controller.components = { ViewAdapter };
    Controller.displayName = LegacyView.prototype.displayName;
    Controller.icon = LegacyView.prototype.icon;
    Controller.isMobileFriendly = LegacyView.prototype.mobileFriendly;
    Controller.multiRecord = LegacyView.prototype.multiRecord;
    Controller.type = LegacyView.prototype.viewType;
    Controller.isLegacy = true;
    if (!viewRegistry.contains(name)) {
        viewRegistry.add(name, Controller);
    }
}

// register views already in the legacy registry, and listens to future registrations
for (const [name, action] of Object.entries(legacyViewRegistry.entries())) {
    registerView(name, action);
}
legacyViewRegistry.onAdd(registerView);

export async function loadLegacyViews({ orm, rpc }) {
    if (!orm && rpc) {
        orm = {
            call: (...callArgs) => {
                const [model, method, args = [], kwargs = {}] = callArgs;
                return rpc({ model, method, args, kwargs });
            },
        };
    }
    await loadPublicAsset("web.assetsBackendLegacyLazy", orm);
}
