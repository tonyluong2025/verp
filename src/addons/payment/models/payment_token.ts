import { Fields, api } from "../../../core";
import { Dict } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { update } from "../../../core/tools";

@MetaModel.define()
class PaymentToken extends Model {
    static _module = module;
    static _name = 'payment.token';
    static _order = 'partnerId, id desc';
    static _description = 'Payment Token';

    static acquirerId = Fields.Many2one({
        string: "Acquirer Account", comodelName: 'payment.acquirer', required: true
    });
    static provider = Fields.Selection({ related: 'acquirerId.provider' });
    static label = Fields.Char({
        string: "Name", help: "The anonymized acquirer reference of the payment method",
        required: true
    });
    static partnerId = Fields.Many2one({ string: "Partner", comodelName: 'res.partner', required: true });
    static companyId = Fields.Many2one({  // Indexed to speed-up ORM searches (from ir_rule or others)
        related: 'acquirerId.companyId', store: true, index: true
    });
    static acquirerRef = Fields.Char({
        string: "Acquirer Reference", help: "The acquirer reference of the token of the transaction",
        required: true
    });  // This is not the same thing as the acquirer reference of the transaction
    static transactionIds = Fields.One2many({
        string: "Payment Transactions", comodelName: 'payment.transaction', relationField: 'tokenId'
    });
    static verified = Fields.Boolean({ string: "Verified" });
    static active = Fields.Boolean({ string: "Active", default: true });

    //=== CRUD METHODS ===#

    @api.modelCreateMulti()
    async create(valuesList) {
        for (const values of valuesList) {
            if ('acquirerId' in values) {
                const acquirer = this.env.items('payment.acquirer').browse(values['acquirerId']);

                // Include acquirer-specific create values
                update(values, await this._getSpecificCreateValues(await acquirer.provider, values));
            }
            else {
                //pass  // Let warn about the missing required field
            }
        }
        return _super(PaymentToken, this).create(valuesList);
    }

    /**
     * Complete the values of the `create` method with acquirer-specific values.

        For an acquirer to add its own create values, it must overwrite this method and return a
        dict of values. Acquirer-specific values take precedence over those of the dict of generic
        create values.

        :param str provider: The provider of the acquirer managing the token
        :param dict values: The original create values
        :return: The dict of acquirer-specific create values
        :rtype: dict
     * @param provider 
     * @param values 
     * @returns 
     */
    @api.model()
    async _getSpecificCreateValues(provider, values) {
        return new Dict();
    }

    /**
     * Delegate the handling of active state switch to dedicated methods.

        Unless an exception is raised in the handling methods, the toggling proceeds no matter what.
        This is because allowing users to hide their saved payment methods comes before making sure
        that the recorded payment details effectively get deleted.

        :return: The result of the write
        :rtype: bool
     * @param values 
     * @returns 
     */
    async write(values) {
        // Let acquirers handle activation/deactivation requests
        if ('active' in values) {
            for (const token of this) {
                // Call handlers in sudo mode because this method might have been called by RPC
                if (values['active'] && ! await token.active) {
                    await (await token.sudo())._handleReactivationRequest();
                }
                else if (!values['active'] && await token.active) {
                    await (await token.sudo())._handleDeactivationRequest();
                }
            }
        }
        // Proceed with the toggling of the active state
        return _super(PaymentToken, this).write(values);
    }

    //=== BUSINESS METHODS ===#

    /**
     * Handle the request for deactivation of the token.

        For an acquirer to support deactivation of tokens, or perform additional operations when a
        token is deactivated, it must overwrite this method and raise an UserError if the token
        cannot be deactivated.

        Note: this.ensureOne()

        :return: None
     */
    async _handleDeactivationRequest() {
        this.ensureOne();
    }

    /**
     * Handle the request for reactivation of the token.

        For an acquirer to support reactivation of tokens, or perform additional operations when a
        token is reactivated, it must overwrite this method and raise an UserError if the token
        cannot be reactivated.

        Note: this.ensureOne()

        :return: None
     * @returns 
     */
    async _handleReactivationRequest() {
        this.ensureOne();
    }

    /**
     * Return a list of information about records linked to the current token.

        For a module to implement payments and link documents to a token, it must override this
        method and add information about linked records to the returned list.

        The information must be structured as a dict with the following keys:
          - description: The description of the record's model (e.g. "Subscription")
          - id: The id of the record
          - name: The name of the record
          - url: The url to access the record.

        Note: this.ensureOne()

        :return: The list of information about linked documents
        :rtype: list
     * @returns 
     */
    async getLinkedRecordsInfo() {
        this.ensureOne();
        return [];
    }
}
