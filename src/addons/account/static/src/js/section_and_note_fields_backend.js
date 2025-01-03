
verp.define('account.sectionAndNoteBackend', function (require) {
// The goal of this file is to contain JS hacks related to allowing
// section and note on sale order and invoice.

// [UPDATED] now also allows configuring products on sale order.

"use strict";
var FieldChar = require('web.basicFields').FieldChar;
var FieldOne2Many = require('web.relationalFields').FieldOne2Many;
var fieldRegistry = require('web.fieldRegistry');
var ListFieldText = require('web.basicFields').ListFieldText;
var ListRenderer = require('web.ListRenderer');

var SectionAndNoteListRenderer = ListRenderer.extend({
    /**
     * We want section and note to take the whole line (except handle and trash)
     * to look better and to hide the unnecessary fields.
     *
     * @override
     */
    _renderBodyCell: function (record, node, index, options) {
        var $cell = this._super.apply(this, arguments);

        var isSection = record.data.displayType === 'lineSection';
        var isNote = record.data.displayType === 'lineNote';

        if (isSection || isNote) {
            if (node.attrs.widget === "handle") {
                return $cell;
            } else if (node.attrs.name === "label") {
                var nbrColumns = this._getNumberOfCols();
                if (this.handleField) {
                    nbrColumns--;
                }
                if (this.addTrashIcon) {
                    nbrColumns--;
                }
                $cell.attr('colspan', nbrColumns);
            } else {
                $cell.removeClass('o-invisible-modifier');
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
            $row.addClass('o-is-' + record.data.displayType.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
        }

        return $row;
    },
    /**
     * We want to add .o-section-and-note-list-view on the table to have stronger CSS.
     *
     * @override
     * @private
     */
    _renderView: function () {
        var self = this;
        return this._super.apply(this, arguments).then(function () {
            self.$('.o-list-table').addClass('o-section-and-note-list-view');
        });
    }
});

// We create a custom widget because this is the cleanest way to do it:
// to be sure this custom code will only impact selected fields having the widget
// and not applied to any other existing ListRenderer.
var SectionAndNoteFieldOne2Many = FieldOne2Many.extend({
    /**
     * We want to use our custom renderer for the list.
     *
     * @override
     */
    _getRenderer: function () {
        if (this.view.arch.tag === 'tree') {
            return SectionAndNoteListRenderer;
        }
        return this._super.apply(this, arguments);
    },
});

// This is a merge between a FieldText and a FieldChar.
// We want a FieldChar for section,
// and a FieldText for the rest (product and note).
var SectionAndNoteFieldText = function (parent, name, record, options) {
    var isSection = record.data.displayType === 'lineSection';
    var Constructor = isSection ? FieldChar : ListFieldText;
    return new Constructor(parent, name, record, options);
};

fieldRegistry.add('sectionAndNoteOne2many', SectionAndNoteFieldOne2Many);
fieldRegistry.add('sectionAndNoteText', SectionAndNoteFieldText);

return SectionAndNoteListRenderer;
});
