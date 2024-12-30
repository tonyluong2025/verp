verp.define('web.KanbanColumnProgressBar', function (require) {
'use strict';

const core = require('web.core');
var session = require('web.session');
var utils = require('web.utils');
var Widget = require('web.Widget');

const _t = core._t;

var KanbanColumnProgressBar = Widget.extend({
    template: 'KanbanView.ColumnProgressBar',
    events: {
        'click .progress-bar': '_onProgressBarClick',
    },
    /**
     * Allows to disable animations for tests.
     * @type {boolean}
     */
    ANIMATE: true,

    /**
     * @constructor
     */
    init: function (parent, options, columnState) {
        this._super.apply(this, arguments);

        this.columnID = options.columnID;
        this.columnState = columnState;
        this.activeFilter = {};

        // <progressbar/> attributes
        this.fieldName = columnState.progressBarValues.field;
        this.colors = _.extend({}, columnState.progressBarValues.colors, {
            __false: 'muted', // color to use for false value
        });
        this.sumField = columnState.progressBarValues.sumField;
        this.sumFieldLabel = this.sumField ? columnState.fields[this.sumField].string : false;

        // Previous progressBar state
        var state = options.progressBarStates[this.columnID];
        if (state) {
            this.groupCount = state.groupCount;
            this.subgroupCounts = state.subgroupCounts;
            this.totalCounterValue = state.totalCounterValue;
            this.activeFilter = columnState.activeFilter || state.activeFilter;
        }

        // Prepare currency (TODO this should be automatic... use a field ?)
        var sumFieldInfo = this.sumField && columnState.fieldsInfo.kanban[this.sumField];
        var currencyField = sumFieldInfo && sumFieldInfo.options && sumFieldInfo.options.currencyField;
        if (currencyField && columnState.data.length) {
            this.currency = session.currencies[columnState.data[0].data[currencyField].resId];
        }
    },
    /**
     * @override
     */
    start: function () {
        var self = this;

        this.$bars = {};
        _.each(this.colors, function (val, key) {
            self.$bars[key] = self.$(`.progress-bar[data-filter=${key}]`);
        });
        this.$counter = this.$('.o-kanban-counter-side');
        this.$number = this.$counter.find('b');

        if (this.currency) {
            var $currency = $('<span/>', {
                text: this.currency.symbol,
            });
            if (this.currency.position === 'before') {
                $currency.prependTo(this.$counter);
            } else {
                $currency.appendTo(this.$counter);
            }
        }

        return this._super.apply(this, arguments).then(function () {
            // This should be executed when the progressbar is fully rendered
            // and is in the DOM, this happens to be always the case with
            // current use of progressbars
            self.computeCounters();
            self._notifyState();
            self._render();
        });
    },
    /**
     * Computes the count of each sub group and the total count
     */
    computeCounters() {
        const subgroupCounts = {};
        for (const key of Object.keys(this.colors)) {
            const subgroupCount = this.columnState.progressBarValues.counts[key] || 0;
            if (this.activeFilter.value === key && subgroupCount === 0) {
                this.activeFilter = {};
            }
            subgroupCounts[key] = subgroupCount;
        }

        this.groupCount = this.columnState.count;
        this.subgroupCounts = subgroupCounts;
        this.prevTotalCounterValue = this.totalCounterValue;
        this.totalCounterValue = this.sumField ? (this.columnState.aggregateValues[this.sumField] || 0) : this.columnState.count;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Updates the rendering according to internal data. This is done without
     * qweb rendering because there are animations.
     *
     * @private
     */
    _render: function () {
        var self = this;

        // Update column display according to active filter
        this.triggerUp('tweakColumn', {
            callback: function ($el) {
                $el.removeClass('o-kanban-group-show');
                _.each(self.colors, function (val, key) {
                    $el.removeClass('o-kanban-group-show-' + val);
                });
                if (self.activeFilter.value) {
                    $el.addClass('o-kanban-group-show o-kanban-group-show-' + self.colors[self.activeFilter.value]);
                }
            },
        });
        this.triggerUp('tweakColumnRecords', {
            callback: function ($el, recordData) {
                var categoryValue = recordData[self.fieldName] ? recordData[self.fieldName] : '__false';
                _.each(self.colors, function (val, key) {
                    $el.removeClass('oe-kanban-card-' + val);
                });
                if (self.colors[categoryValue]) {
                    $el.addClass('oe-kanban-card-' + self.colors[categoryValue]);
                }
            },
        });

        // Display and animate the progress bars
        var barNumber = 0;
        var barMinWidth = 6; // In %
        const selection = self.columnState.fields[self.fieldName].selection;
        _.each(self.colors, function (val, key) {
            var $bar = self.$bars[key];
            var count = self.subgroupCounts && self.subgroupCounts[key] || 0;

            if (!$bar) {
                return;
            }

            // Adapt tooltip
            let value;
            if (selection) { // progressbar on a field of type selection
                const option = selection.find(option => option[0] === key);
                value = option && option[1] || _t('Other');
            } else {
                value = key;
            }
            $bar.attr('data-original-title', count + ' ' + value);
            $bar.tooltip({
                delay: 0,
                trigger: 'hover',
            });

            // Adapt active state
            $bar.toggleClass('progress-bar-animated progress-bar-striped', key === self.activeFilter.value);

            // Adapt width
            $bar.removeClass('o-bar-has-records transition-off');
            window.getComputedStyle($bar[0]).getPropertyValue('width'); // Force reflow so that animations work
            if (count > 0) {
                $bar.addClass('o-bar-has-records');
                // Make sure every bar that has records has some space
                // and that everything adds up to 100%
                var maxWidth = 100 - barMinWidth * barNumber;
                self.$('.progress-bar.o-bar-has-records').css('max-width', maxWidth + '%');
                $bar.css('width', (count * 100 / self.groupCount) + '%');
                barNumber++;
                $bar.attr('aria-valuemin', 0);
                $bar.attr('aria-valuemax', self.groupCount);
                $bar.attr('aria-valuenow', count);
            } else {
                $bar.css('width', '');
            }
        });
        this.$('.progress-bar').css('min-width', '');
        this.$('.progress-bar.o-bar-has-records').css('min-width', barMinWidth + '%');

        // Display and animate the counter number
        var start = this.prevTotalCounterValue;
        var end = this.totalCounterValue;

        if (this.activeFilter.value) {
            if (this.sumField) {
                end = 0;
                _.each(self.columnState.data, function (record) {
                    var recordData = record.data;
                    if (self.activeFilter.value === recordData[self.fieldName] ||
                        (self.activeFilter.value === '__false' && !recordData[self.fieldName])) {
                        end += parseFloat(recordData[self.sumField]);
                    }
                });
            } else {
                end = this.subgroupCounts[this.activeFilter.value];
            }
        }
        this.prevTotalCounterValue = end;
        var animationClass = start > 999 ? 'o-kanban-grow' : 'o-kanban-grow-huge';

        if (start !== undefined && (end > start || this.activeFilter.value) && this.ANIMATE) {
            $({currentValue: start}).animate({currentValue: end}, {
                duration: 1000,
                start: function () {
                    self.$counter.addClass(animationClass);
                },
                step: function () {
                    self.$number.html(_getCounterHTML(this.currentValue));
                },
                complete: function () {
                    self.$number.html(_getCounterHTML(this.currentValue));
                    self.$counter.removeClass(animationClass);
                },
            });
        } else {
            this.$number.html(_getCounterHTML(end));
        }

        function _getCounterHTML(value) {
            return utils.humanNumber(value, 0, 3);
        }
    },
    /**
     * Notifies the new progressBar state so that if a full rerender occurs, the
     * new progressBar that would replace this one will be initialized with
     * current state, so that animations are correct.
     *
     * @private
     */
    _notifyState: function () {
        this.triggerUp('setProgressBarState', {
            columnID: this.columnID,
            values: {
                groupCount: this.groupCount,
                subgroupCounts: this.subgroupCounts,
                totalCounterValue: this.totalCounterValue,
                activeFilter: this.activeFilter,
            },
        });
    },
    /**
     * Toggles the active filter on this progressbar.
     * It also computes the corresponding domain extension.
     *
     * @private
     * @param {string} value
     */
    _toggleActiveFilter(value) {
        const activeFilter = Object.assign({}, this.activeFilter);
        if (activeFilter.value === value) {
            // If the filter was active and we click again on the same one, deactivate.
            activeFilter.domain = [];
            activeFilter.value = false;
        } else {
            const field = this.fieldName;
            if (value === '__false') {
                const values = Object.keys(this.colors).filter(el => el !== value);
                activeFilter.domain = ['!', [field, 'in', values]];
            } else {
                activeFilter.domain = [[field, '=', value]];
            }
            activeFilter.value = value;
        }
        this.activeFilter = activeFilter;
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------
    /**
     * @private
     * @param {Event} ev
     */
    _onProgressBarClick: function (ev) {
        this.$clickedBar = $(ev.currentTarget);
        const filterValue = this.$clickedBar.data('filter');
        this._toggleActiveFilter(filterValue);
        this._notifyState();
        this.triggerUp('kanbanLoadColumnRecords', {
            activeFilter: this.activeFilter
        });
    },
});
return KanbanColumnProgressBar;
});
