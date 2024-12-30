verp.define('account.upload.bill.mixin', function (require) {
"use strict";

    var core = require('web.core');
    var _t = core._t;

    var qweb = core.qweb;

    var UploadBillMixin = {

        start: function () {
            // define a unique uploadId and a callback method
            this.fileUploadID = _.uniqueId('accountBillFileUpload');
            $(window).on(this.fileUploadID, this._onFileUploaded.bind(this));
            return this._super.apply(this, arguments);
        },

        _onAddAttachment: function (ev) {
            // Auto submit form once we've selected an attachment
            var $input = $(ev.currentTarget).find('input.o-input-file');
            if ($input.val() !== '') {
                var $binaryForm = this.$('.o-vendor-bill-upload form.o-form-binary-form');
                $binaryForm.submit();
            }
        },

        _onFileUploaded: function () {
            // Callback once attachment have been created, create a bill with attachment ids
            var self = this;
            var attachments = Array.prototype.slice.call(arguments, 1);
            // Get id from result
            var attachentIds = attachments.reduce(function(filtered, record) {
                if (record.id) {
                    filtered.push(record.id);
                }
                return filtered;
            }, []);
            return this._rpc({
                model: 'account.journal',
                method: 'createInvoiceFromAttachment',
                args: ["", attachentIds],
                context: this.initialState.context,
            }).then(function(result) {
                self.doAction(result);
            });
        },

        _onUpload: function (event) {
            var self = this;
            // If hidden upload form don't exists, create it
            var $formContainer = this.$('.o-content').find('.o-vendor-bill-upload');
            if (!$formContainer.length) {
                $formContainer = $(qweb.render('account.BillsHiddenUploadForm', {widget: this}));
                $formContainer.appendTo(this.$('.o-content'));
            }
            // Trigger the input to select a file
            this.$('.o-vendor-bill-upload .o-input-file').click();
        },
    }
    return UploadBillMixin;
});


verp.define('account.bills.tree', function (require) {
"use strict";
    var core = require('web.core');
    var ListController = require('web.ListController');
    var ListView = require('web.ListView');
    var UploadBillMixin = require('account.upload.bill.mixin');
    var viewRegistry = require('web.viewRegistry');

    var BillsListController = ListController.extend(UploadBillMixin, {
        buttonsTemplate: 'BillsListView.buttons',
        events: _.extend({}, ListController.prototype.events, {
            'click .o-button-upload-bill': '_onUpload',
            'change .o-vendor-bill-upload .o-form-binary-form': '_onAddAttachment',
        }),
    });

    var BillsListView = ListView.extend({
        config: _.extend({}, ListView.prototype.config, {
            Controller: BillsListController,
        }),
    });

    viewRegistry.add('accountTree', BillsListView);
});

verp.define('account.bills.kanban', function (require) {
    var KanbanController = require('web.KanbanController');
    var KanbanView = require('web.KanbanView');
    var UploadBillMixin = require('account.upload.bill.mixin');
    var viewRegistry = require('web.viewRegistry');

    var BillsKanbanController = KanbanController.extend(UploadBillMixin, {
        buttonsTemplate: 'BillsKanbanView.buttons',
        events: _.extend({}, KanbanController.prototype.events, {
            'click .o-button-upload-bill': '_onUpload',
            'change .o-vendor-bill-upload .o-form-binary-form': '_onAddAttachment',
        }),
    });

    var BillsKanbanView = KanbanView.extend({
        config: _.extend({}, KanbanView.prototype.config, {
            Controller: BillsKanbanController,
        }),
    });

    viewRegistry.add('accountBillsKanban', BillsKanbanView);
});

verp.define('account.dashboard.kanban', function (require) {
"use strict";
    var core = require('web.core');
    var KanbanController = require('web.KanbanController');
    var KanbanView = require('web.KanbanView');
    var UploadBillMixin = require('account.upload.bill.mixin');
    var viewRegistry = require('web.viewRegistry');

    var DashboardKanbanController = KanbanController.extend(UploadBillMixin, {
        events: _.extend({}, KanbanController.prototype.events, {
            'click .o-button-upload-bill': '_onUpload',
            'change .o-vendor-bill-upload .o-form-binary-form': '_onAddAttachment',
        }),
        /**
         * We override _onUpload (from the upload bill mixin) to pass default_journalId
         * and default_moveType in context.
         *
         * @override
         */
        _onUpload: function (event) {
            var kanbanRecord = $(event.currentTarget).closest('.o-kanban-record').data('record');
            this.initialState.context['default_journalId'] = kanbanRecord.id;
            if ($(event.currentTarget).attr('journalType') == 'sale') {
                this.initialState.context['default_moveType'] = 'outInvoice'
            } else if ($(event.currentTarget).attr('journalType') == 'purchase') {
                this.initialState.context['default_moveType'] = 'inInvoice'
            }
            UploadBillMixin._onUpload.apply(this, arguments);
        }
    });

    var DashboardKanbanView = KanbanView.extend({
        config: _.extend({}, KanbanView.prototype.config, {
            Controller: DashboardKanbanController,
        }),
    });

    viewRegistry.add('accountDashboardKanban', DashboardKanbanView);
});
