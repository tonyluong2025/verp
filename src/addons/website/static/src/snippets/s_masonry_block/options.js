/** @verp-module */

import options from 'web_editor.snippets.options';

options.registry.MasonryLayout = options.registry.SelectTemplate.extend({
    /**
     * @constructor
     */
    init() {
        this._super(...arguments);
        this.containerSelector = '> .container, > .container-fluid, > .o-container-small';
        this.selectTemplateWidgetName = 'masonryTemplateOpt';
    },
});
