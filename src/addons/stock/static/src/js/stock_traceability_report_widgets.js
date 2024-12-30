verp.define('stock.ReportWidget', function (require) {
'use strict';

var core = require('web.core');
var Widget = require('web.Widget');

var QWeb = core.qweb;

var _t = core._t;

var ReportWidget = Widget.extend({
    events: {
        'click span.o-stock-reports-foldable': 'fold',
        'click span.o-stock-reports-unfoldable': 'unfold',
        'click .o-stock-reports-web-action': 'boundLink',
        'click .o-stock-reports-stream': 'updownStream',
        'click .o-stock-report-lot-action': 'actionOpenLot'
    },
    init: function(parent) {
        this._super.apply(this, arguments);
    },
    start: function() {
        QWeb.addTemplate("/stock/static/src/xml/stock_traceability_report_line.xml");
        return this._super.apply(this, arguments);
    },
    boundLink: function(e) {
        e.preventDefault();
        return this.doAction({
            type: 'ir.actions.actwindow',
            resModel: $(e.target).data('res-model'),
            resId: $(e.target).data('active-id'),
            views: [[false, 'form']],
            target: 'current'
        });
    },
    actionOpenLot: function(e) {
        e.preventDefault();
        var $el = $(e.target).parents('tr');
        this.doAction({
            type: 'ir.actions.client',
            tag: 'stockReportGeneric',
            name: $el.data('lotName') !== undefined && $el.data('lotName').toString(),
            context: {
                activeId : $el.data('lotId'),
                activeModel : 'stock.production.lot',
                url: '/stock/output_format/stock/activeId'
            },
        });
    },
    updownStream: function(e) {
        var $el = $(e.target).parents('tr');
        this.doAction({
            type: "ir.actions.client",
            tag: 'stockReportGeneric',
            name: _t("Traceability Report"),
            context: {
                activeId : $el.data('modelId'),
                activeModel : $el.data('model'),
                autoUnfold: true,
                lotName: $el.data('lotName') !== undefined && $el.data('lotName').toString(),
                url: '/stock/output_format/stock/activeId'
            },
        });
    },
    removeLine: function(element) {
        var self = this;
        var el, $el;
        var recId = element.data('id');
        var $stockEl = element.nextAll('tr[data-parentId=' + recId + ']')
        for (el in $stockEl) {
            $el = $($stockEl[el]).find(".o-stock-reports-domain-line-0, .o-stock-reports-domain-line-1");
            if ($el.length === 0) {
                break;
            }
            else {
                var $nextEls = $($el[0]).parents("tr");
                self.removeLine($nextEls);
                $nextEls.remove();
            }
            $el.remove();
        }
        return true;
    },
    fold: function(e) {
        this.removeLine($(e.target).parents('tr'));
        var activeId = $(e.target).parents('tr').find('td.o-stock-reports-foldable').data('id');
        $(e.target).parents('tr').find('td.o-stock-reports-foldable').attr('class', 'o-stock-reports-unfoldable ' + activeId); // Change the class, rendering, and remove line from model
        $(e.target).parents('tr').find('span.o-stock-reports-foldable').replaceWith(QWeb.render("unfoldable", {lineId: activeId}));
        $(e.target).parents('tr').toggleClass('o-stock-reports-unfolded');
    },
    autounfold: function(target, lotName) {
        var self = this;
        var $CurretElement;
        $CurretElement = $(target).parents('tr').find('td.o-stock-reports-unfoldable');
        var activeId = $CurretElement.data('id');
        var activeModelName = $CurretElement.data('model');
        var activeModelId = $CurretElement.data('modelId');
        var rowLevel = $CurretElement.data('level');
        var $cursor = $(target).parents('tr');
        this._rpc({
                model: 'stock.traceability.report',
                method: 'getLines',
                args: [parseInt(activeId, 10)],
                kwargs: {
                    'modelId': activeModelId,
                    'modelName': activeModelName,
                    'level': parseInt(rowLevel) + 30 || 1
                },
            })
            .then(function (lines) {// After loading the line
                _.each(lines, function (line) { // Render each line
                    $cursor.after(QWeb.render("reportMrpLine", {l: line}));
                    $cursor = $cursor.next();
                    if ($cursor && line.unfoldable && line.lotName == lotName) {
                        self.autounfold($cursor.find(".fa-caret-right"), lotName);
                    }
                });
            });
        $CurretElement.attr('class', 'o-stock-reports-foldable ' + activeId); // Change the class, and rendering of the unfolded line
        $(target).parents('tr').find('span.o-stock-reports-unfoldable').replaceWith(QWeb.render("foldable", {lineId: activeId}));
        $(target).parents('tr').toggleClass('o-stock-reports-unfolded');
    },
    unfold: function(e) {
        this.autounfold($(e.target));
    },

});

return ReportWidget;

});
