import { Fields } from "../../../core";
import { hasattr } from "../../../core/api";
import { _super, MetaModel, Model } from "../../../core/models"
import { bool, f } from "../../../core/tools";

@MetaModel.define()
class PaymentTransaction extends Model {
    static _module = module;
    static _parents = "payment.transaction";

    static isDonation = Fields.Boolean({string: "Is donation", help: "Is the payment a donation"});

    async _finalizePostProcessing() {
        await _super(PaymentTransaction, this)._finalizePostProcessing();
        for (const tx of await this.filtered('isDonation')) {
            await tx._sendDonationEmail();
            const msg = [await this._t('Payment received from donation with following details:')];
            for (const field of ['companyId', 'partnerId', 'partnerName', 'partnerCountryId', 'partnerEmail']) {
                const fieldName = tx.cls._fields[field].string;
                let value = await tx[field];
                if (bool(value)) {
                    if (hasattr(value, 'name')) {
                        value = value.name;
                    }
                    msg.push(f('<br/>- %s: %s', fieldName, value));
                }
            }
            await (await tx.paymentId)._messageLog({body: msg.join('')});
        }
    }

    async _sendDonationEmail(isInternalNotification=false, comment?: any, recipientEmail?: any) {
        this.ensureOne();
        if (isInternalNotification || await this['state'] === 'done') {
            const subject = isInternalNotification ? await this._t('A donation has been made on your website') : await this._t('Donation confirmation');
            const body = await (await this.env.ref('website_payment.donationMailBody'))._render({
                'isInternalNotification': isInternalNotification,
                'tx': this,
                'comment': comment,
            }, 'ir.qweb', true);
            await (await this.env.ref('website_payment.mailTemplateDonation')).sendMail(
                this.id, {notifLayout: "mail.mailNotificationLight",
                forceSend: true,
                emailValues: {
                    'emailTo': isInternalNotification ? recipientEmail : await this['partnerEmail'],
                    'emailFrom': await (await this['companyId']).emailFormatted,
                    'authorId': (await this['partnerId']).id,
                    'subject': subject,
                    'bodyHtml': body,
                },
            });
        }
    }
}
