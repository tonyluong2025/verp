import { Fields, api } from "../../../core"
import { NotImplementedError } from "../../../core/helper/errors"
import { AbstractModel, MetaModel } from "../../../core/models"

/**
 * Mixin class for objects reacting when a barcode is scanned in their form views which contains `<field name="_barcodeScanned" widget="barcodeHandler"/>`.
    Models using this mixin must implement the method onBarcodeScanned. It works like an onchange and receives the scanned barcode in parameter.
 */
@MetaModel.define()
class BarcodeEventsMixin extends AbstractModel {
  static _module = module;
  static _name = 'barcodes.barcode.events.mixin'
  static _description = 'Barcode Event Mixin'

  static _barcodeScanned = Fields.Char("Barcode Scanned", {help: "Value of the last barcode scanned.", store: false})

  @api.onchange('_barcodeScanned')
  async _onBarcodeScanned() {
    const barcode = await (this as any)._barcodeScanned;
    if (barcode) {
      await this.set('_barcodeScanned', "");
      return this.onBarcodeScanned(barcode);
    }
  }

  async onBarcodeScanned(barcode) {
    throw new NotImplementedError("In order to use barcodes.barcode.events.mixin, method onBarcodeScanned must be implemented");
  }
}