/** @verp-module **/

import options from 'web_editor.snippets.options';

options.registry.SearchBar = options.Class.extend({
    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    setSearchType: function (previewMode, widgetValue, params) {
        const form = this.$target.parents('form');
        form.attr('action', params.formAction);

        if (!previewMode) {
            this.triggerUp('snippetEditionRequest', {exec: () => {
                const widget = this._requestUserValueWidgets('orderOpt')[0];
                const orderby = widget.getValue("selectDataAttribute");
                const order = widget.$el.find("we-button[data-select-data-attribute='" + orderby + "']")[0];
                if (order.classList.contains("d-none")) {
                    const defaultOrder = widget.$el.find("we-button[data-name='orderNameAscOpt']")[0];
                    defaultOrder.click(); // open
                    defaultOrder.click(); // close
                }
            }});
        }
    },

    setOrderBy: function (previewMode, widgetValue, params) {
        const form = this.$target.parents('form');
        form.find(".o-search-order-by").attr("value", widgetValue);
    },
});

export default {
    SearchBar: options.registry.SearchBar,
};
