/** @verp-module **/

import '@mail/js/activity';

import fieldRegistry from 'web.fieldRegistry';

const KanbanActivity = fieldRegistry.get('kanbanActivity');

const ActivityCell = KanbanActivity.extend({
    init(parent, name, record, options) {
        this._super.apply(this, arguments);
        this.activityType = options && options.activityType;
    },
    /**
     * @private
     * @override
     */
    _getActivityFormAction(id) {
        const action = this._super.apply(this, arguments);
        action.context['default_activityTypeId'] = this.activityType;
        return action;
    },
    /**
     * @override
     * @private
     */
    _render() {
        // replace clock by closest deadline
        const $date = $('<div class="o-closest-deadline">');
        const date = moment(this.record.data.closestDeadline).toDate();
        // To remove year only if current year
        if (moment().year() === moment(date).year()) {
            $date.text(date.toLocaleDateString(moment().locale(), {
                day: 'numeric', month: 'short'
            }));
        } else {
            $date.text(moment(date).format('ll'));
        }
        this.$('a').html($date);
        if (this.record.data.activityIds.resIds.length > 1) {
            this.$('a').append($('<span>', {
                class: 'badge badge-light badge-pill border-0 ' + this.record.data.activityState,
                text: this.record.data.activityIds.resIds.length,
            }));
        }
        if (this.$el.hasClass('show')) {
            // note: this part of the rendering might be asynchronous
            this._renderDropdown();
        }
    }
});

export default ActivityCell;
