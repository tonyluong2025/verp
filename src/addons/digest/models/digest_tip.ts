import { Fields } from "../../../core/fields"
import { MetaModel, Model } from "../../../core/models"
import { htmlTranslate } from "../../../core/tools/translate"

@MetaModel.define()
class DigestTip extends Model {
  static _module = module;
  static _name = 'digest.tip';
  static _description = 'Digest Tips';
  static _order = 'sequence';

  static sequence = Fields.Integer(
    'Sequence', {default: 1,
    help: 'Used to display digest tip in email template base on order'});
  static label = Fields.Char('Name', {translate: true});
  static userIds = Fields.Many2many(
    'res.users', {string: 'Recipients',
    help: 'Users having already received this tip'});
  static tipDescription = Fields.Html('Tip description', {translate: htmlTranslate, sanitize: false});
  static groupId = Fields.Many2one(
    'res.groups', {string: 'Authorized Group',
    default: self => self.env.ref('base.groupUser')});
}