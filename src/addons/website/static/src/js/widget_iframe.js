verp.define('website.iframeWidget', function (require) {
"use strict";


var AbstractField = require('web.AbstractField');
var core = require('web.core');
var fieldRegistry = require('web.fieldRegistry');

var QWeb = core.qweb;

/**
 * Display iframe
 */
var FieldIframePreview = AbstractField.extend({
    className: 'd-block o-field-iframe-preview m-0 h-100',

    _render: function () {
        this.$el.html(QWeb.render('website.iframeWidget', {
            url: this.value,
        }));
    },
});

fieldRegistry.add('iframe', FieldIframePreview);

return FieldIframePreview;

});
