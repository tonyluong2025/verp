verp.define('website.sTimelineOptions', function (require) {
'use strict';

const options = require('web_editor.snippets.options');

options.registry.Timeline = options.Class.extend({
    displayOverlayOptions: true,

    /**
     * @override
     */
    start: function () {
        var $buttons = this.$el.find('we-button.o-we-overlay-opt');
        var $overlayArea = this.$overlay.find('.o-overlay-options-wrap');
        $overlayArea.append($buttons);

        return this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * Moves the card to the right/left.
     *
     * @see this.selectClass for parameters
     */
    timelineCard: function (previewMode, widgetValue, params) {
        const $timelineRow = this.$target.closest('.s-timeline-row');
        $timelineRow.toggleClass('flex-row-reverse flex-row');
    },
});
});
