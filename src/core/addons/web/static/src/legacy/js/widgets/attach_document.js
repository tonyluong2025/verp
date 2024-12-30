verp.define('web.AttachDocument', function (require) {
"use static";

var core = require('web.core');
var framework = require('web.framework');
var {Markup} = require('web.utils');
var widgetRegistry = require('web.widgetRegistryOld');
var Widget = require('web.Widget');

var _t = core._t;

var AttachDocument = Widget.extend({
    template: 'AttachDocument',
    events: {
        'click': '_onClickAttachDocument',
        'change input.o-input-file': '_onFileChanged',
    },
    /**
     * @constructor
     * @param {Widget} parent
     * @param {Object} record
     * @param {Object} nodeInfo
     */
    init: function (parent, record, nodeInfo) {
        this._super.apply(this, arguments);
        this.resId = record.resId;
        this.resModel = record.model;
        this.state = record;
        this.node = nodeInfo;
        this.fileuploadID = _.uniqueId('oFileupload');
    },
    /**
     * @override
     */
    start: function () {
        $(window).on(this.fileuploadID, this._onFileLoaded.bind(this));
        return this._super.apply(this, arguments);
    },
    /**
     * @override
     */
    destroy: function () {
        $(window).off(this.fileuploadID);
        this._super.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // private
    //--------------------------------------------------------------------------

    /**
     * Helper function to display a warning that some fields have an invalid
     * value. This is used when a save operation cannot be completed.
     *
     * @private
     * @param {string[]} invalidFields - list of field names
     */
    _notifyInvalidFields: function (invalidFields) {
        var fields = this.state.fields;
        var warnings = invalidFields.map(function (fieldName) {
            var fieldStr = fields[fieldName].string;
            return _.str.sprintf('<li>%s</li>', _.escape(fieldStr));
        });
        warnings.unshift('<ul>');
        warnings.push('</ul>');
        this.displayNotification({
            title: _t("Invalid fields:"),
            message: Markup(warnings.join('')),
            type: 'danger',
        });
     },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Opens File Explorer dialog if all fields are valid and record is saved
     *
     * @private
     * @param {Event} ev
     */
    _onClickAttachDocument: function (ev) {
        if ($(ev.target).is('input.o-input-file')) {
            return;
        }
        var fieldNames = this.getParent().canBeSaved(this.state.id);
        if (fieldNames.length) {
            return this._notifyInvalidFields(fieldNames);
        }
        // We want to save record on widget click and then open File Selection Explorer
        // but due to this security restriction give warning to save record first.
        // https://stackoverflow.com/questions/29728705/trigger-click-on-input-file-on-asynchronous-ajax-done/29873845#29873845
        if (!this.resId) {
            return this.displayNotification({ message: _t('Please save before attaching a file'), type: 'danger' });
        }
        this.$('input.o-input-file').trigger('click');
    },
    /**
     * Submits file
     *
     * @private
     * @param {Event} ev
     */
    _onFileChanged: function (ev) {
        ev.stopPropagation();
        this.$('form.o-form-binary-form').trigger('submit');
        framework.blockUI();
    },
    /**
     * Call action given as node attribute after file submission
     *
     * @private
     */
    _onFileLoaded: function () {
        var self = this;
        // the first argument isn't a file but the jQuery.Event
        var files = Array.prototype.slice.call(arguments, 1);
        return new Promise(function (resolve) {
            if (self.node.attrs.action) {
                self._rpc({
                    model: self.resModel,
                    method: self.node.attrs.action,
                    args: [self.resId],
                    kwargs: {
                        attachmentIds: _.map(files, function (file) {
                            return file.id;
                        }),
                    }
                }).then(function () {
                    resolve();
                });
            } else {
                resolve();
            }
        }).then(function () {
            self.triggerUp('reload');
            framework.unblockUI();
        });
    },

});
widgetRegistry.add('attachDocument', AttachDocument);
});
