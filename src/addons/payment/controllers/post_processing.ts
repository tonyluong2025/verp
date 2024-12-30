import _ from "lodash";
import { _Datetime, http } from "../../../core"
import { DatabaseError } from "../../../core/helper";
import { WebRequest } from "../../../core/http";
import { bool, isInstance, subDate } from "../../../core/tools";

/**
 * This controller is responsible for the monitoring and finalization of the post-processing of
    transactions.

    It exposes the route `/payment/status`: All payment flows must go through this route at some
    point to allow the user checking on the transactions' status, and to trigger the finalization of
    their post-processing.
 */
@http.define()
export class PaymentPostProcessing extends http.Controller {
    static _module = module;

    static MONITORED_TX_IDS_KEY = '__paymentMonitoredTxIds__'

    /**
     * Display the payment status page.

        :param dict kwargs: Optional data. This parameter is not used here
        :return: The rendered status page
        :rtype: str
     * @param req 
     * @param res 
     * @param opts 
     * @returns 
     */
    @http.route('/payment/status', {type: 'http', auth: 'public', website: true, sitemap: false})
    async displayStatus(req: WebRequest, res, opts={}) {
        return req.render(req, 'payment.paymentStatus');
    }

    /**
     * Fetch the transactions to display on the status page and finalize their post-processing.

        :return: The post-processing values of the transactions
        :rtype: dict
     * @returns 
     */
    @http.route('/payment/status/poll', {type: 'json', auth: 'public'})
    async pollStatus(req, res, opts={}) {
        const env = await req.getEnv();
        // Retrieve recent user's transactions from the session
        const limitDate = subDate(_Datetime.now(), {days: 1});
        const monitoredTxs = await (await env.items('payment.transaction').sudo()).search([
            ['id', 'in', PaymentPostProcessing.getMonitoredTransactionIds(req)],
            ['lastStateChange', '>=', limitDate]
        ]);
        if (! bool(monitoredTxs)) {  // The transaction was not correctly created
            return {
                'success': false,
                'error': 'noTxFound',
            }
        }

        // Build the list of display values with the display message and post-processing values
        const displayValuesList = [];
        for (const tx of monitoredTxs) {
            let displayMessage;
            const [state, acquirerId] = await tx('state', 'acquirerId');
            if (state === 'pending') {
                displayMessage = await acquirerId.pendingMsg;
            }
            else if (state === 'done') {
                displayMessage = await acquirerId.doneMsg;
            }
            else if (state === 'cancel') {
                displayMessage = await acquirerId.cancelMsg;
            }
            displayValuesList.push({
                'displayMessage': displayMessage,
                ... await tx._getPostProcessingValues(),
            });
        }

        // Stop monitoring already post-processed transactions
        const postProcessedTxs = await monitoredTxs.filtered('isPostProcessed');
        PaymentPostProcessing.removeTransactions(req, postProcessedTxs);

        // Finalize post-processing of transactions before displaying them to the user
        const txsToPostProcess = await monitoredTxs.sub(postProcessedTxs).filtered(
            async (t) => await t.state == 'done'
        );
        let success =true;
        let error;
        try {
            await txsToPostProcess._finalizePostProcessing();
        } catch(e) {
            if (isInstance(e, DatabaseError)) {
            // except psycopg2.OperationalError:  # A collision of accounting sequences occurred
                await env.cr.rollback();  // Rollback and try later
                success = false;
                error = 'txProcessRetry';
            } else {
                await env.cr.rollback();
                success = false;
                error = e.stack;
                console.error(
                    "encountered an error while post-processing transactions with ids %s:\n%s",
                    String(txsToPostProcess.ids), e
                );
            }
        }
        return {
            'success': success,
            'error': error,
            'displayValuesList': displayValuesList,
        }
    }

    /**
     * Add the ids of the provided transactions to the list of monitored transaction ids.

        :param recordset transactions: The transactions to monitor, as a `payment.transaction`
                                       recordset
        :return: void
     * @param transactions 
     */
    static monitorTransactions(req: WebRequest, transactions) {
        if (bool(transactions)) {
            const monitoredTxIds = req.session[PaymentPostProcessing.MONITORED_TX_IDS_KEY] ?? [];
            req.session[PaymentPostProcessing.MONITORED_TX_IDS_KEY] = _.union(monitoredTxIds, transactions.ids);
        }
    }

    /**
     * Return the ids of transactions being monitored.

        Only the ids and not the recordset itself is returned to allow the caller browsing the
        recordset with sudo privileges, and using the ids in a custom query.

        :return: The ids of transactions being monitored
        :rtype: list
     * @returns 
     */
    static getMonitoredTransactionIds(req: WebRequest) {
        return req.session[PaymentPostProcessing.MONITORED_TX_IDS_KEY] ?? [];
    }

    /**
     * Remove the ids of the provided transactions from the list of monitored transaction ids.

        :param recordset transactions: The transactions to remove, as a `payment.transaction`
                                       recordset
        :return: void
     * @param req 
     * @param transactions 
     */
    static removeTransactions(req: WebRequest, transactions) {
        if (bool(transactions)) {
            const monitoredTxIds = req.session[PaymentPostProcessing.MONITORED_TX_IDS_KEY] ?? [];
            req.session[PaymentPostProcessing.MONITORED_TX_IDS_KEY] = monitoredTxIds.filter(txId => !transactions.ids.includes(txId));
        }
    }
}