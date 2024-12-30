verp.define('website.sDynamicSnippetCarouselOptions', function (require) {
'use strict';

const options = require('web_editor.snippets.options');
const sDynamicSnippetOptions = require('website.sDynamicSnippetOptions');

const dynamicSnippetCarouselOptions = sDynamicSnippetOptions.extend({

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     *
     * @override
     * @private
     */
    _setOptionsDefaultValues: function () {
        this._super.apply(this, arguments);
        this._setOptionValue('carouselInterval', '5000');
    }

});

options.registry.dynamicSnippetCarousel = dynamicSnippetCarouselOptions;

return dynamicSnippetCarouselOptions;
});
