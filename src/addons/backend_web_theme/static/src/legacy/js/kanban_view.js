verp.define('backend_web_theme.KanbanView', function (require) {
"use strict";

const config = require("web.config");

const KanbanView = require('web.KanbanView');

KanbanView.include({
    init() {
        this._super.apply(this, arguments);
        this.jsLibs.push("/web/static/lib/jquery.touchSwipe/jquery.touchSwipe.js");
    },
});

});
