verp.define('payment.postProcessing', function (require) {
    'use strict';

    var publicWidget = require('web.public.widget');
    var core = require('web.core');
    const {Markup} = require('web.utils');

    var _t = core._t;

    $.blockUI.defaults.css.border = '0';
    $.blockUI.defaults.css["background-color"] = '';
    $.blockUI.defaults.overlayCSS["opacity"] = '0.9';

    publicWidget.registry.PaymentPostProcessing = publicWidget.Widget.extend({
        selector: 'div[name="oPaymentStatus"]',
        xmlDependencies: ['/payment/static/src/xml/payment_post_processing.xml'],

        _pollCount: 0,

        start: function() {
            this.displayLoading();
            this.poll();
            return this._super.apply(this, arguments);
        },
        /* Methods */
        startPolling: function () {
            var timeout = 3000;
            //
            if(this._pollCount >= 10 && this._pollCount < 20) {
                timeout = 10000;
            }
            else if(this._pollCount >= 20) {
                timeout = 30000;
            }
            //
            setTimeout(this.poll.bind(this), timeout);
            this._pollCount ++;
        },
        poll: function () {
            var self = this;
            this._rpc({
                route: '/payment/status/poll',
                params: {
                    'csrfToken': core.csrfToken,
                }
            }).then(function(data) {
                if(data.success === true) {
                    self.processPolledData(data.displayValuesList);
                }
                else {
                    switch(data.error) {
                    case "txProcessRetry":
                        break;
                    case "noTxFound":
                        self.displayContent("payment.noTxFound", {});
                        break;
                    default: // if an exception is raised
                        self.displayContent("payment.exception", {exceptionMsg: data.error});
                        break;
                    }
                }
                self.startPolling();

            }).guardedCatch(function() {
                self.displayContent("payment.rpcError", {});
                self.startPolling();
            });
        },
        processPolledData: function (displayValuesList) {
            var renderValues = {
                'txDraft': [],
                'txPending': [],
                'txAuthorized': [],
                'txDone': [],
                'txCancel': [],
                'txError': [],
            };

            if (displayValuesList.length > 0) {
                // In almost every cases there will be a single transaction to display. If there are
                // more than one transaction, the last one will most likely be the one that was
                // confirmed. We use this one to redirect the user to the final page.
                window.location = displayValuesList[0].landingRoute;
                return;
            }

            // group the transaction according to their state
            displayValuesList.forEach(function (displayValues) {
                var key = 'tx' + _.upperFirst(displayValues.state);
                if (key in renderValues) {
                    if (displayValues["displayMessage"]) {
                        displayValues.displayMessage = Markup(displayValues.displayMessage)
                    }
                    renderValues[key].push(displayValues);
                }
            });

            function countTxInState(states) {
                var nbTx = 0;
                for (var prop in renderValues) {
                    if (states.indexOf(prop) > -1 && renderValues.hasOwnProperty(prop)) {
                        nbTx += renderValues[prop].length;
                    }
                }
                return nbTx;
            }
                       
            /*
            * When the server sends the list of monitored transactions, it tries to post-process 
            * all the successful ones. If it succeeds or if the post-process has already been made, 
            * the transaction is removed from the list of monitored transactions and won't be 
            * included in the next response. We assume that successful and post-process 
            * transactions should always prevail on others, regardless of their number or state.
            */
            if (renderValues['txDone'].length === 1 &&
                renderValues['txDone'][0].isPostProcessed) {
                    window.location = renderValues['txDone'][0].landingRoute;
                    return;
            }
            // If there are multiple transactions monitored, display them all to the customer. If
            // there is only one transaction monitored, redirect directly the customer to the
            // landing route.
            if(countTxInState(['txDone', 'txError', 'txPending', 'txAuthorized']) === 1) {
                // We don't want to redirect customers to the landing page when they have a pending
                // transaction. The successful transactions are dealt with before.
                var tx = renderValues['txAuthorized'][0] || renderValues['txError'][0];
                if (tx) {
                    window.location = tx.landingRoute;
                    return;
                }
            }

            this.displayContent("payment.displayTxList", renderValues);
        },
        displayContent: function (xmlid, renderValues) {
            var html = core.qweb.render(xmlid, renderValues);
            $.unblockUI();
            this.$el.find('div[name="oPaymentStatusContent"]').html(html);
        },
        displayLoading: function () {
            var msg = _t("We are processing your payment, please wait ...");
            $.blockUI({
                'message': '<h2 class="text-white"><img src="/web/static/img/spin.png" class="fa-pulse"/>' +
                    '    <br />' + msg +
                    '</h2>'
            });
        },
    });
});
