import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class MailMail extends Model {
    static _module = module;
    static _parents = 'mail.mail';

    static fetchmailServerId = Fields.Many2one('fetchmail.server', {string: "Inbound Mail Server", readonly: true, index: true});
}