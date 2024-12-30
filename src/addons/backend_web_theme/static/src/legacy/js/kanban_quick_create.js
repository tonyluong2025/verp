verp.define('backend_web_theme.kanbanColumnQuickCreate', function (require) {
"use strict";

const config = require('web.config');

const KanbanRenderer = require('web.kanbanColumnQuickCreate');

KanbanRenderer.include({
    init() {
        this._super(...arguments);
        this.isMobile = config.device.isMobile;
    },
    _cancel() {
    	if (!config.device.isMobile) {
    		this._super(...arguments);
    	} else if (!this.folded) {
            this.$input.val('');
        }
    },
});

});
