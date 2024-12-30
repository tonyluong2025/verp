import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel, _super } from "../../../core/models"
import { update } from "../../../core/tools/misc";

@MetaModel.define()
class SnailmailLetterMissingRequiredFields extends TransientModel {
    static _module = module;
    static _name = 'snailmail.letter.missing.required.fields';
    static _description = 'Update address of partner';

    static partnerId = Fields.Many2one('res.partner');
    static letterId = Fields.Many2one('snailmail.letter');

    static street = Fields.Char('Street');
    static street2 = Fields.Char('Street2');
    static zip = Fields.Char('Zip');
    static city = Fields.Char('City');
    static stateId = Fields.Many2one("res.country.state", {string: 'State'});
    static countryId = Fields.Many2one('res.country', {string: 'Country'});

    @api.model()
    async defaultGet(fields) {
        const defaults = await _super(SnailmailLetterMissingRequiredFields, this).defaultGet(fields);
        if (defaults['letterId']) {
            const letter = this.env.items('snailmail.letter').browse(defaults['letterId']);
            update(defaults, {
                'partnerId': (await letter.partnerId).id,
                'street': await letter.street,
                'street2': await letter.street2,
                'zip': await letter.zip,
                'city': await letter.city,
                'stateId': (await letter.stateId).id,
                'countryId': (await letter.countryId).id,
            });
        }
        return defaults;
    }

    async updateAddressCancel() {
        await (await this['letterId']).cancel();
    }

    async updateAddressSave() {
        const addressData = {
            'street': await this['street'],
            'street2': await this['street2'],
            'zip': await this['zip'],
            'city': await this['city'],
            'stateId': (await this['stateId']).id,
            'countryId': (await this['countryId']).id,
        }
        await (await this['partnerId']).write(addressData);
        const lettersToResend = await this.env.items('snailmail.letter').search([
            ['partnerId', '=', (await this['partnerId']).id],
            ['errorCode', '=', 'MISSING_REQUIRED_FIELDS'],
        ]);
        await lettersToResend.write(addressData);
        await lettersToResend.snailmailPrint();
    }
}