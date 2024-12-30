verp.define('account.activity', function (require) {
"use strict";

var AbstractField = require('web.AbstractField');
var core = require('web.core');
var fieldRegistry = require('web.fieldRegistry');

var QWeb = core.qweb;
var _t = core._t;

var VatActivity = AbstractField.extend({
    className: 'o-journal-activity-kanban',
    events: {
        'click .see-all-activities': '_onOpenAll',
        'click .see-activity': '_onOpenActivity',
    },
    init: function () {
        this.MAX_ACTIVITY_DISPLAY = 5;
        this._super.apply(this, arguments);
    },
    //------------------------------------------------------------
    // Private
    //------------------------------------------------------------
    _render: function () {
        var self = this;
        var info = JSON.parse(this.value);
        if (!info) {
            this.$el.html('');
            return;
        }
        info.moreActivities = false;
        if (info.activities.length > this.MAX_ACTIVITY_DISPLAY) {
            info.moreActivities = true;
            info.activities = info.activities.slice(0, this.MAX_ACTIVITY_DISPLAY);
        }
        this.$el.html(QWeb.render('accountJournalDashboardActivity', info));
    },

    _onOpenActivity: function(e) {
        e.preventDefault();
        var self = this;
        self.doAction({
            type: 'ir.actions.actwindow',
            label: _t('Journal Entry'),
            target: 'current',
            resId: $(e.target).data('resId'),
            resModel:  'account.move',
            views: [[false, 'form']],
        });
    },

    _onOpenAll: function(e) {
        e.preventDefault();
        var self = this;
        self.doAction({
            type: 'ir.actions.actwindow',
            label: _t('Journal Entries'),
            resModel:  'account.move',
            views: [[false, 'kanban'], [false, 'form']],
            searchViewId: [false],
            domain: [['journalId', '=', self.resId], ['activityIds', '!=', false]],
        });
    }
})

fieldRegistry.add('kanbanVatActivity', VatActivity);

return VatActivity;
});
