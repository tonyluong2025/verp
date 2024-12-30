import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Company extends Model {
    static _module = module;
    static _parents = "res.company";

    static socialTwitter = Fields.Char('Twitter Account');
    static socialFacebook = Fields.Char('Facebook Account');
    static socialGithub = Fields.Char('GitHub Account');
    static socialLinkedin = Fields.Char('LinkedIn Account');
    static socialYoutube = Fields.Char('Youtube Account');
    static socialInstagram = Fields.Char('Instagram Account');
    static socialZalo = Fields.Char('Zalo Account');
    static socialTiktok = Fields.Char('Tiktok Account');
}