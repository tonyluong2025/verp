import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models"

@MetaModel.define()
class Notification extends Model {
  static _module = module;
  static _parents = 'mail.notification';

  static notificationType = Fields.Selection({ selectionAdd: [['snail', 'Snailmail']], ondelete: { 'snail': 'CASCADE' } });
  static letterId = Fields.Many2one('snailmail.letter', { string: "Snailmail Letter", index: true, ondelete: 'CASCADE' });
  static failureType = Fields.Selection({
    selectionAdd: [
      ['snCredit', "Snailmail Credit Error"],
      ['snTrial', "Snailmail Trial Error"],
      ['snPrice', "Snailmail No Price Available"],
      ['snFields', "Snailmail Missing Required Fields"],
      ['snFormat', "Snailmail Format Error"],
      ['snError', "Snailmail Unknown Error"],
    ]
  });
}