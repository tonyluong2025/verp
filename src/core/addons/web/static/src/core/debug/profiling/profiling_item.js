/** @verp-module **/

import { DropdownItem } from "@web/core/dropdown/dropdown_item";
import { useBus, useService } from "@web/core/utils/hooks";

const { Component } = owl;

export class ProfilingItem extends Component {
    setup() {
        this.profiling = useService("profiling");
        useBus(this.props.bus, "UPDATE", this.render);
    }

    changeParam(param, ev) {
        this.profiling.setParam(param, ev.target.value);
    }
    toggleParam(param, ev) {
        const value = this.profiling.state.params.executionContextQweb;
        this.profiling.setParam(param, !value);
    }
    openProfiles() {
        if (this.env.services.action) {
            // using doAction in the backend to preserve breadcrumbs and stuff
            this.env.services.action.doAction("base.actionMenuIrProfile");
        } else {
            // No action service means we are in the frontend.
            window.location = "/web/#action=base.actionMenuIrProfile";
        }
    }
}
ProfilingItem.components = { DropdownItem };
ProfilingItem.template = "web.DebugMenu.ProfilingItem";
