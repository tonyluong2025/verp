verp.define('backend_web_theme.KanbanColumn', function (require) {
"use strict";

const config = require('web.config');

const KanbanColumn = require('web.KanbanColumn');

if (!config.device.isMobile) {
    return;
}

KanbanColumn.include({
    init() {
        this._super(...arguments);
        this.recordsDraggable = false;
        this.canBeFolded = false;
    },
});

});
