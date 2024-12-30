verp.define('web.selectCreateControllersRegistry', function (require) {
"use strict";

return {};

});

verp.define('web._selectCreateControllersRegistry', function (require) {
"use strict";

var KanbanController = require('web.KanbanController');
var ListController = require('web.ListController');
var selectCreateControllersRegistry = require('web.selectCreateControllersRegistry');

var SelectCreateKanbanController = KanbanController.extend({
    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Override to select the clicked record instead of opening it
     *
     * @override
     * @private
     */
    _onOpenRecord: function (ev) {
        var selectedRecord = this.model.get(ev.data.id);
        this.triggerUp('selectRecord', {
            id: selectedRecord.resId,
            displayName: selectedRecord.data.displayName,
        });
    },
});

var SelectCreateListController = ListController.extend({
    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Override to select the clicked record instead of opening it
     *
     * @override
     * @private
     */
    _onOpenRecord: function (ev) {
        var selectedRecord = this.model.get(ev.data.id);
        this.triggerUp('selectRecord', {
            id: selectedRecord.resId,
            displayName: selectedRecord.data.displayName,
        });
    },
});

_.extend(selectCreateControllersRegistry, {
    SelectCreateListController: SelectCreateListController,
    SelectCreateKanbanController: SelectCreateKanbanController,
});

});
