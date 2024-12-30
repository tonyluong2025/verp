/** @verp-module **/

import KanbanRecord from 'web.KanbanRecord';

var ActivityRecord = KanbanRecord.extend({
    /**
     * @override
     */
    init: function (parent, state) {
        this._super.apply(this,arguments);

        this.fieldsInfo = state.fieldsInfo.activity;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _render: function () {
        this.defs = [];
        this._replaceElement(this.qweb.render('activity-box', this.qwebContext));
        this.$el.on('click', this._onGlobalClick.bind(this));
        this.$el.addClass('o-activity-record');
        this._processFields();
        this._setupColor();
        return Promise.all(this.defs);
    },
    /**
     * @override
     * @private
     */
    _setFieldDisplay: function ($el, fieldName) {
        this._super.apply(this, arguments);

        // attribute muted
        if (this.fieldsInfo[fieldName].muted) {
            $el.addClass('text-muted');
        }
    },
    /**
     * @override
     * @private
     */
    _setState: function () {
        this._super.apply(this, arguments);

        // activity has a different qweb context
        this.qwebContext = {
            activityImage: this._getImageURL.bind(this),
            record: this.record,
            userContext: this.getSession().userContext,
            widget: this,
        };
    },
});

export default ActivityRecord;
