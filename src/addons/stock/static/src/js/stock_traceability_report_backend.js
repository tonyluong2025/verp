verp.define('stock.stockReportGeneric', function (require) {
'use strict';

var AbstractAction = require('web.AbstractAction');
var core = require('web.core');
var session = require('web.session');
var ReportWidget = require('stock.ReportWidget');
var framework = require('web.framework');

var QWeb = core.qweb;

var stockReportGeneric = AbstractAction.extend({
    hasControlPanel: true,

    // Stores all the parameters of the action.
    init: function(parent, action) {
        this._super.apply(this, arguments);
        this.actionManager = parent;
        this.givenContext = Object.assign({}, session.userContext);
        this.controllerUrl = action.context.url;
        if (action.context.context) {
            this.givenContext = action.context.context;
        }
        this.givenContext.activeId = action.context.activeId || action.params.activeId;
        this.givenContext.model = action.context.activeModel || false;
        this.givenContext.ttype = action.context.ttype || false;
        this.givenContext.autoUnfold = action.context.autoUnfold || false;
        this.givenContext.lotName = action.context.lotName || false;
    },
    willStart: function() {
        return Promise.all([this._super.apply(this, arguments), this.getHtml()]);
    },
    setHtml: function() {
        var self = this;
        var def = Promise.resolve();
        if (!this.reportWidget) {
            this.reportWidget = new ReportWidget(this, this.givenContext);
            def = this.reportWidget.appendTo(this.$('.o-content'));
        }
        return def.then(function () {
            self.reportWidget.$el.html(self.html);
            self.reportWidget.$el.find('.o-report-heading').html('<h1>Traceability Report</h1>');
            if (self.givenContext.autoUnfold) {
                _.each(self.$el.find('.fa-caret-right'), function (line) {
                    self.reportWidget.autounfold(line, self.givenContext.lotName);
                });
            }
        });
    },
    start: async function() {
        this.controlPanelProps.cpContent = { $buttons: this.$buttons };
        await this._super(...arguments);
        this.setHtml();
    },
    // Fetches the html and is previous report.context if any, else create it
    getHtml: async function() {
        const { html } = await this._rpc({
            args: [this.givenContext],
            method: 'getHtml',
            model: 'stock.traceability.report',
        });
        this.html = html;
        this.renderButtons();
    },
    // Updates the control panel and render the elements that have yet to be rendered
    updateCp: function() {
        if (!this.$buttons) {
            this.renderButtons();
        }
        this.controlPanelProps.cpContent = { $buttons: this.$buttons };
        return this.updateControlPanel();
    },
    renderButtons: function() {
        var self = this;
        this.$buttons = $(QWeb.render("stockReports.buttons", {}));
        // pdf output
        this.$buttons.bind('click', function () {
            var $element = $(self.$el[0]).find('.o-stock-reports-table tbody tr');
            var dict = [];

            $element.each(function( index ) {
                var $el = $($element[index]);
                dict.push({
                        'id': $el.data('id'),
                        'modelId': $el.data('modelId'),
                        'modelName': $el.data('model'),
                        'unfoldable': $el.data('unfold'),
                        'level': $el.find('td:first').data('level') || 1
                });
            });
            framework.blockUI();
            var urlData = self.controllerUrl.replace(':activeId', self.givenContext.activeId);
            urlData = urlData.replace(':activeModel', self.givenContext.model);
            session.getFile({
                url: urlData.replace('outputFormat', 'pdf'),
                data: {data: JSON.stringify(dict)},
                complete: framework.unblockUI,
                error: (error) => self.call('crashManager', 'rpcError', error),
            });
        });
        return this.$buttons;
    },
});

core.actionRegistry.add("stockReportGeneric", stockReportGeneric);
return stockReportGeneric;
});
