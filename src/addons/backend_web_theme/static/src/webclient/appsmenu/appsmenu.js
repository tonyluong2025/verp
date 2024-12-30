/** @verp-module **/

import { session } from "@web/session";
import { url } from "@web/core/utils/urls";
// import { useService } from "@web/core/utils/hooks";
import { Dropdown } from "@web/core/dropdown/dropdown";

const { Component, hooks } = owl;

export class AppsMenu extends Dropdown {
    setup() {
    	super.setup();
    	if (session.themeHasBackgroundImage) {
            this.backgroundImageUrl = url('/web/image', {
                model: 'res.company',
                field: 'backgroundImage',
                id: this.env.services.company.currentCompany.id,
            });
    	} else {
    		this.backgroundImageUrl = '/backend_web_theme/static/img/background.png';
    	}
    	this.env.bus.on("ACTION_MANAGER:UI-UPDATED", this, ev => this.close());
    }
}

Object.assign(AppsMenu, {
    template: 'backend_web_theme.AppsMenu',
});