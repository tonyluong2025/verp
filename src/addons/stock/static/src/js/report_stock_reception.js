/** @verp-module **/

import clientAction from 'report.clientAction';
import core from 'web.core';

const qweb = core.qweb;

const ReceptionReport = clientAction.extend({
    /**
     * @override
     */
    init: function (parent, action, options) {
        this._super(...arguments);
        this.context = Object.assign(action.context || {}, {
            activeIds: action.context.default_pickingIds,
        });
        this.reportName = `stock.reportReception`;
        this.reportUrl = `/report/html/${this.reportName}/?context=${JSON.stringify(this.context)}`;
        this._title = action.label;
    },

    /**
     * @override
     */
     start: function () {
        return Promise.all([
            this._super(...arguments),
        ]).then(() => {
            this._renderButtons();
        });
    },

    /**
     * @override
     */
    onAttachCallback: function () {
        this._super();
        this.iframe.addEventListener("load",
            () => this._bindAdditionalActionHandlers(),
            { once: true }
        );
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Renders extra report buttons in control panel
     */
     _renderButtons: function () {
        this.$buttons.append(qweb.render('receptionReportButtons', {}));
        this.$buttons.on('click', '.o-report-reception-assign', this._onClickAssign.bind(this));
        this.$buttons.on('click', '.o-print-label', this._onClickPrintLabel.bind(this));
        this.controlPanelProps.cpContent = {
            $buttons: this.$buttons,
        };
    },

    /**
     * Bind additional <button> action handlers
     */
    _bindAdditionalActionHandlers: function () {
        const rr = $(this.iframe).contents().find('.o-report-reception');
        rr.on('click', '.o-report-reception-assign', this._onClickAssign.bind(this));
        rr.on('click', '.o-report-reception-unassign', this._onClickUnassign.bind(this));
        rr.on('click', '.o-report-reception-forecasted', this._onClickForecastReport.bind(this));
        rr.on('click', '.o-print-label', this._onClickPrintLabel.bind(this));
    },


    _switchButton: function (button) {
        button.innerText = button.innerText.includes('Unassign') ? "Assign" : "Unassign";
        button.name = button.name === 'assignLink' ? 'unassignLink' : 'assignLink';
        button.classList.toggle("o-report-reception-assign");
        button.classList.toggle("o-report-reception-unassign");
    },

    /**
     * Assign the specified move(s)
     *
     * @returns {Promise}
     */
    _onClickAssign: function (ev) {
        const el = ev.currentTarget;
        const quantities = []; // incoming qty amounts to assign
        const moveIds = [];
        const inIds = [];
        let nodeToAssign = [];
        if (el.name === 'assignLink') { // One line "Assign"
            nodeToAssign = [el];
            el.closest('tbody').previousElementSibling.querySelectorAll('.o-print-label-all').forEach(button => button.removeAttribute('disabled'));
        } else {
            el.style.display = 'none';
            if (el.name === "assignAllLink") { // Global "Assign All"
                const iframe = this.iframe.contentDocument;
                iframe.querySelectorAll('.o-assign-all').forEach(button => button.style.display = 'none');
                iframe.querySelectorAll('.o-print-label-all').forEach(button => button.removeAttribute('disabled'));
                nodeToAssign = iframe.querySelectorAll('.o-report-reception-assign:not(.o-assign-all)');
            } else { // Local assign all
                nodeToAssign = el.closest('thead').nextElementSibling.querySelectorAll('.o-report-reception-assign:not(.o-assign-all)');
                el.closest('thead').nextElementSibling.querySelectorAll('.o-print-label-all').forEach(button => button.removeAttribute('disabled'));
            }
        }
        nodeToAssign.forEach(node => {
            node.closest('td').nextElementSibling.querySelectorAll('.o-print-label').forEach(button => button.removeAttribute('disabled'));
            moveIds.push(parseInt(node.getAttribute('move-id')));
            quantities.push(parseFloat(node.getAttribute('qty')));
            inIds.push(JSON.parse(node.getAttribute('move-ins-ids')));
            this._switchButton(node);
        });

        return this._rpc({
            model: 'stock.report.reception',
            args: [false, moveIds, quantities, inIds],
            method: 'actionAssign'
        });
    },

    /**
     * Unassign the specified move
     *
     * @returns {Promise}
     */
     _onClickUnassign: function (ev) {
        const el = ev.currentTarget;
        this._switchButton(el);
        const quantity = parseFloat(el.getAttribute('qty'));
        const modelId = parseInt(el.getAttribute('move-id'));
        const inIds = JSON.parse("[" + el.getAttribute('move-ins-ids') + "]");
        el.closest('td').nextElementSibling.querySelectorAll('.o-print-label').forEach(button => button.setAttribute('disabled', true));
        return this._rpc({
            model: 'stock.report.reception',
            args: [false, modelId, quantity, inIds[0]],
            method: 'actionUnassign'
        });
    },

    /**
     * Open the forecast report for the product of the selected move.
     *
     * @returns {Promise}
     */
    _onClickForecastReport: function (ev) {
        const modelId = parseInt(ev.currentTarget.getAttribute('move-id'));
        return this._rpc({
            model: 'stock.move',
            args: [[modelId]],
            method: 'actionProductForecastReport'
        }).then((action) => {
            return this.doAction(action);
        });
    },

    /**
     * Print the corresponding source label
     */
    _onClickPrintLabel: function (ev) {
        // unfortunately, due to different reports needed for different models, we will handle
        // pickings here and others models will have to be extended/printed separately until better
        // technique to merge into continuous pdf to written
        return this._printLabel(ev, 'stock.reportReceptionReportLabel', 'stock.picking');
    },

    _printLabel: function (ev, reportFile, sourceModel) {
        const el = ev.currentTarget;
        const modelIds = [];
        const productQtys = [];
        let nodeToPrint = [];

        if (el.name === 'printLabel') { // One line print
            nodeToPrint = [el];
        } else {
            if (el.name === "printAllLabels") { // Global "Print Labels"
                nodeToPrint = this.iframe.contentDocument.querySelectorAll('.o-print-label:not(.o-print-label-all):not(:disabled)');
            } else { // Local "Print Labels"
                nodeToPrint = el.closest('thead').nextElementSibling.querySelectorAll('.o-print-label:not(.o-print-label-all):not(:disabled)');
            }
        }

        nodeToPrint.forEach(node => {
            if (node.getAttribute('source-model') === sourceModel) {
                modelIds.push(parseInt(node.getAttribute('source-id')));
                productQtys.push(Math.ceil(node.getAttribute('qty')) || '1');
            }
        });

        if (!modelIds.length) { // Nothing to print for this model.
            return Promise.resolve();
        }
        const reportName = `${reportFile}?docids=${modelIds}&reportType=qweb-pdf&quantity=${productQtys}`;
        const action = {
            type: 'ir.actions.report',
            reportType: 'qweb-pdf',
            reportName,
            reportFile,
        };
        return this.doAction(action);
    }

});

core.actionRegistry.add('receptionReport', ReceptionReport);

export default ReceptionReport;
