import { Fields } from "../../../core/fields";
import { MetaModel, Model, _super } from "../../../core/models";

@MetaModel.define()
class AccountFullReconcile extends Model {
  static _module = module;
  static _name = "account.full.reconcile";
  static _description = "Full Reconcile";

  static label = Fields.Char({ string: 'Number', required: true, copy: false, default: self => self.env.items('ir.sequence').nextByCode('account.reconcile') });
  static partialReconcileIds = Fields.One2many('account.partial.reconcile', 'fullReconcileId', { string: 'Reconciliation Parts' });
  static reconciledLineIds = Fields.One2many('account.move.line', 'fullReconcileId', { string: 'Matched Journal Items' });
  static exchangeMoveId = Fields.Many2one('account.move', { index: true });

  /**
   * When removing a full reconciliation, we need to revert the eventual journal entries we created to book the
          fluctuation of the foreign currency's exchange rate.
          We need also to reconcile together the origin currency difference line and its reversal in order to completely
          cancel the currency difference entry on the partner account (otherwise it will still appear on the aged balance
          for example).
   * @returns 
   */
  async unlink() {
    // Avoid cyclic unlink calls when removing partials.
    if (!this.ok) {
      return true;
    }

    const movesToReverse = await this['exchangeMoveId'];

    const res = await _super(AccountFullReconcile, this).unlink();

    // Reverse all exchange moves at once.
    if (movesToReverse.ok) {
      const defaultValuesList = await movesToReverse.map(async (move) => {
        const [label, date] = await move('label', 'date');
        return {
          'date': await move._getAccountingDate(date, await move._affectTaxReport()),
          'ref': await this._t('Reversal of: %s', label)
        }
      })
      await movesToReverse._reverseMoves(defaultValuesList, true);
    }
    return res;
  }
}