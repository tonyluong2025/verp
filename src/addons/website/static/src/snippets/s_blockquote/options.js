verp.define('website.sBlockquoteOptions', function (require) {
'use strict';

const options = require('web_editor.snippets.options');

options.registry.Blockquote = options.Class.extend({

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * Change blockquote design.
     *
     * @see this.selectClass for parameters
     */
    display: function (previewMode, widgetValue, params) {

        // Classic
        this.$target.find('.s-blockquote-avatar').toggleClass('d-none', widgetValue !== 'classic');

        // Cover
        const $blockquote = this.$target.find('.s-blockquote-content');
        if (widgetValue === 'cover') {
            $blockquote.css({"background-image": "url('/web/image/website.sBlockquoteCoverDefaultImage')"});
            $blockquote.addClass('oe-img-bg o-bg-img-center');
            if (!$blockquote.find('.o-we-bg-filter').length) {
                const bgFilterEl = document.createElement('div');
                bgFilterEl.classList.add('o-we-bg-filter', 'bg-white-50');
                $blockquote.prepend(bgFilterEl);
            }
        } else {
            $blockquote.css({"background-image": ""});
            $blockquote.css({"background-position": ""});
            $blockquote.removeClass('oe-img-bg o-bg-img-center');
            $blockquote.find('.o-we-bg-filter').remove();
            $blockquote.find('.s-blockquote-filter').contents().unwrap(); // Compatibility
        }

        // Minimalist
        this.$target.find('.s-blockquote-icon').toggleClass('d-none', widgetValue === 'minimalist');
        this.$target.find('footer').toggleClass('d-none', widgetValue === 'minimalist');
    },
});
});
