import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models"

/**
 * Shortcode
    Canned Responses, allowing the user to defined shortcuts in its message. Should be applied before storing message in database.
    Emoji allowing replacing text with image for visual effect. Should be applied when the message is displayed (only for final rendering).
    These shortcodes are global and are available for every user.
 */
@MetaModel.define()
class MailShortcode extends Model {
    static _module = module;
    static _name = 'mail.shortcode';
    static _description = 'Canned Response / Shortcode';

    static source = Fields.Char('Shortcut', {required: true, index: true, help: "The shortcut which must be replaced in the Chat Messages"})
    static substitution = Fields.Text('Substitution', {required: true, index: true, help: "The escaped html code replacing the shortcut"})
    static description = Fields.Char('Description')
    static messageIds = Fields.Many2one('mail.message', {string: "Messages", store: false})
}