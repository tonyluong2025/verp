/** @verp-module **/

import { patch } from "web.utils";
import { useService } from "@web/core/utils/hooks";
import { SIZES } from "@web/core/ui/ui_service";

import LegacyControlPanel from "web.ControlPanel";
import { ControlPanel } from "@web/search/control_panel/control_panel";
import { SearchBar } from "@web/search/search_bar/search_bar";

const {useState, useContext} = owl.hooks;

patch(LegacyControlPanel.prototype, "backend_web_theme.LegacyControlPanelMobile", {
    setup() {
        this._super();
        this.state = useState({
            mobileSearchMode: "",
        });
    },
    setMobileSearchMode(ev) {
        this.state.mobileSearchMode = ev.detail;
    },
});

patch(ControlPanel.prototype, "backend_web_theme.ControlPanelMobile", {
    setup() {
        this._super();
        this.state = useState({
            mobileSearchMode: "",
        });
        this.SIZES = SIZES;
        this.uiService = useService("ui");
        console.log(this);
    },
    setMobileSearchMode(ev) {
        this.state.mobileSearchMode = ev.detail;
    },
});

patch(SearchBar, "backend_web_theme.SearchBarMobile", {
    template: "backend_web_theme.SearchBar",
});