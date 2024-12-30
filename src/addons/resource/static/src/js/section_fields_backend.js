
verp.define('resource.sectionBackend', function (require) {
// The goal of this file is to contain JS hacks related to allowing
// section on resource calendar.

"use strict";
var FieldOne2Many = require('web.relationalFields').FieldOne2Many;
var fieldRegistry = require('web.fieldRegistry');
var ListRenderer = require('web.ListRenderer');

var SectionListRenderer = ListRenderer.extend({
    /**
     * We want section to take the whole line (except handle and trash)
     * to look better and to hide the unnecessary fields.
     *
     * @override
     */
    _renderBodyCell: function (record, node, index, options) {
        var $cell = this._super.apply(this, arguments);

        var isSection = record.data.displayType === 'lineSection';

        if (isSection) {
            if (node.attrs.widget === "handle") {
                return $cell;
            } else if (node.attrs.name === "displayName") {
                var nbrColumns = this._getNumberOfCols();
                if (this.handleField) {
                    nbrColumns--;
                }
                if (this.addTrashIcon) {
                    nbrColumns--;
                }
                $cell.attr('colspan', nbrColumns);
            } else {
                return $cell.addClass('o-hidden');
            }
        }

        return $cell;
    },
    /**
     * We add the o-is-{displayType} class to allow custom behaviour both in JS and CSS.
     *
     * @override
     */
    _renderRow: function (record, index) {
        var $row = this._super.apply(this, arguments);

        if (record.data.displayType) {
            $row.addClass('o-is-' + record.data.displayType.replace(/_/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
        }

        return $row;
    },
    /**
     * We want to add .o-section-list-view on the table to have stronger CSS.
     *
     * @override
     * @private
     */
    _renderView: function () {
        var self = this;
        return this._super.apply(this, arguments).then(function () {
            self.$('.o-list-table').addClass('o-section-list-view');
            // Discard the possibility to remove the sections
            self.$('.o-is-line-section .o-list-record-remove').remove()
        });
    },
});

// We create a custom widget because this is the cleanest way to do it:
// to be sure this custom code will only impact selected fields having the widget
// and not applied to any other existing ListRenderer.
var SectionFieldOne2Many = FieldOne2Many.extend({
    /**
     * We want to use our custom renderer for the list.
     *
     * @override
     */
    _getRenderer: function () {
        if (this.view.arch.tag === 'tree') {
            return SectionListRenderer;
        }
        return this._super.apply(this, arguments);
    },
});

fieldRegistry.add('sectionOne2many', SectionFieldOne2Many);

});
