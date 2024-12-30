import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models"
import { bool } from "../../../core/tools/bool";

@MetaModel.define()
class ChooseDestinationLocation extends TransientModel {
  static _module = module;
  static _name = 'stock.package.destination';
  static _description = 'Stock Package Destination';

  static pickingId = Fields.Many2one('stock.picking', { required: true });
  static moveLineIds = Fields.Many2many('stock.move.line', { string: 'Products', compute: '_computeMoveLineIds', required: true });
  static locationDestId = Fields.Many2one('stock.location', { string: 'Destination location', required: true });
  static filteredLocation = Fields.One2many('stock.location', {compute: '_filterLocation' });

  @api.depends('pickingId')
  async _computeMoveLineIds() {
    for (const destination of this) {
      await destination.set('moveLineIds', await (await (await destination.pickingId).moveLineIds).filtered(async (l) => await l.qtyDone > 0 && !bool(l.resultPackageId)));
    }
  }

  @api.depends('moveLineIds')
  async _filterLocation() {
    for (const destination of this) {
      await destination.set('filteredLocation', await (await destination.moveLineIds).mapped('locationDestId'));
    }
  }

  async actionDone() {
    // set the same location on each move line and pass again in action_put_in_pack
    await (await this['moveLineIds']).set('locationDestId', this['locationDestId']);
    return (await this['pickingId']).actionPutInPack();
  }
}