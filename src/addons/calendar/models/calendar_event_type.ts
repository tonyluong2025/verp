import { randomInt } from "crypto";
import { Fields } from "../../../core";
import { MetaModel, Model } from "../../../core/models";

@MetaModel.define()
class MeetingType extends Model {
  static _module = module;
  static _name = 'calendar.event.type';
  static _description = 'Event Meeting Type';

  _defaultColor() {
    return randomInt(1, 11);
  }

  static label = Fields.Char('Name', { required: true });
  static color = Fields.Integer('Color', { default: self => self._defaultColor() });

  static _sqlConstraints = [
    ['nameUniq', 'unique (label)', "Tag name already exists !"],
  ]
}