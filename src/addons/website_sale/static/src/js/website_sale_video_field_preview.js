verp.define('website_sale.videoFieldPreview', function (require) {
"use strict";


var AbstractField = require('web.AbstractField');
var core = require('web.core');
const {Markup} = require('web.utils');
var fieldRegistry = require('web.fieldRegistry');

var QWeb = core.qweb;

/**
 * Displays preview of the video showcasing product.
 */
var FieldVideoPreview = AbstractField.extend({
    className: 'd-block o-field-video-preview',

    _render: function () {
        this.$el.html(QWeb.render('productVideo', {
            embedCode: Markup(this.value),
        }));
    },
});

fieldRegistry.add('videoPreview', FieldVideoPreview);

return FieldVideoPreview;

});
