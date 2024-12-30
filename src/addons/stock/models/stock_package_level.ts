import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { DefaultDict } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { itemgetter, sortedAsync, sum } from "../../../core/tools/iterable";
import { groupbyAsync } from "../../../core/tools/misc";

@MetaModel.define()
class StockPackageLevel extends Model {
  static _module = module;
  static _name = 'stock.package.level';
  static _description = 'Stock Package Level';
  static _checkCompanyAuto = true;

  static packageId = Fields.Many2one(
    'stock.quant.package', {
    string: 'Package', required: true, checkCompany: true,
    domain: "[['locationId', 'childOf', parent.locationId], '|', ['companyId', '=', false], ['companyId', '=', companyId]]"
  });
  static pickingId = Fields.Many2one('stock.picking', { string: 'Picking', checkCompany: true });
  static moveIds = Fields.One2many('stock.move', 'packageLevelId');
  static moveLineIds = Fields.One2many('stock.move.line', 'packageLevelId');
  static locationId = Fields.Many2one('stock.location', { string: 'From', compute: '_computeLocationId', checkCompany: true });
  static locationDestId = Fields.Many2one(
    'stock.location', {
    string: 'To', checkCompany: true,
    domain: "[['id', 'childOf', parent.locationDestId], '|', ['companyId', '=', false], ['companyId', '=', companyId]]"
  });
  static isDone = Fields.Boolean('Done', { compute: '_computeIsDone', inverse: '_setIsDone' });
  static state = Fields.Selection([
    ['draft', 'Draft'],
    ['confirmed', 'Confirmed'],
    ['assigned', 'Reserved'],
    ['new', 'New'],
    ['done', 'Done'],
    ['cancel', 'Cancelled'],
  ], { string: 'State', compute: '_computeState' });
  static isFreshPackage = Fields.Boolean({ compute: '_computeFreshPack' });

  static pickingTypeCode = Fields.Selection({ related: 'pickingId.pickingTypeCode' });
  static showLotsM2o = Fields.Boolean({ compute: '_computeShowLot' });
  static showLotsText = Fields.Boolean({ compute: '_computeShowLot' });
  static companyId = Fields.Many2one('res.company', { string: 'Company', required: true, index: true });


  @api.depends('moveLineIds', 'moveLineIds.qtyDone')
  async _computeIsDone() {
    for (const packageLevel of this) {
      // If it is an existing package
      if (await packageLevel.isFreshPackage) {
        await packageLevel.set('isDone', true);
      }
      else {
        await packageLevel('isDone', await packageLevel._checkMoveLinesMapQuantPackage(await packageLevel.packageId));
      }
    }
  }

  async _setIsDone() {
    for (const packageLevel of this) {
      if (await packageLevel.isDone) {
        if (! await packageLevel.isFreshPackage) {
          const [packageId, moveLineIds, locationId, locationDestId, pickingId, moveIds] = await packageLevel('packageId', 'moveLineIds', 'locationId', 'locationDestId', 'pickingId', 'moveIds');
          const mlUpdateDict = new DefaultDict<Model, any>();//float);
          for (const quant of await packageId.quantIds) {
            const [productId, lotId, quantity, ownerId] = await quant('productId', 'lotId', 'quantity', 'ownerId');
            const correspondingMl = await moveLineIds.filtered(async (ml) => (await ml.productId).eq(productId) && (await ml.lotId).eq(lotId));
            if (bool(correspondingMl)) {
              const key = correspondingMl(0);
              if (!mlUpdateDict.has(key)) {
                mlUpdateDict.set(key, 0.0);
              }
              const value = mlUpdateDict.get(key);
              mlUpdateDict.set(key, value + quantity);
            }
            else {
              const correspondingMove = (await moveIds.filtered(async (m) => (await m.productId).eq(productId))).slice(0, 1);
              await this.env.items('stock.move.line').create({
                'locationId': locationId.id,
                'locationDestId': locationDestId.id,
                'pickingId': pickingId.id,
                'productId': productId.id,
                'qtyDone': quantity,
                'productUomId': (await productId.uomId).id,
                'lotId': lotId.id,
                'packageId': packageId.id,
                'resultPackageId': packageId.id,
                'packageLevelId': packageLevel.id,
                'moveId': correspondingMove.id,
                'ownerId': ownerId.id,
              })
            }
          }
          // const promises = [];
          for (const [rec, quant] of mlUpdateDict.items()) {
            await rec.set('qtyDone', quant);
          }
          // await Promise.all(promises);
        }
      }
      else {
        const moveLineIds = await packageLevel.moveLineIds;
        await (await moveLineIds.filtered(async (ml) => await ml.productQty == 0)).unlink();
        await (await moveLineIds.filtered(async (ml) => await ml.productQty != 0)).write({ 'qtyDone': 0 });
      }
    }
  }

  @api.depends('moveLineIds', 'moveLineIds.packageId', 'moveLineIds.resultPackageId')
  async _computeFreshPack() {
    for (const packageLevel of this) {
      const moveLineIds = await packageLevel.moveLineIds;
      let all = true;
      if (bool(moveLineIds)) {
        for (const ml of moveLineIds) {
          const packageId = await ml.packageId;
          if (!(bool(packageId) && packageId.eq(await ml.resultPackageId))) {
            all = false;
            break;
          }
        }
      }
      if (!bool(moveLineIds) || all) {
        await packageLevel.set('isFreshPackage', false);
      }
      else {
        await packageLevel.set('isFreshPackage', true);
      }
    }
  }

  @api.depends('moveIds', 'moveIds.state', 'moveLineIds', 'moveLineIds.state')
  async _computeState() {
    for (const packageLevel of this) {
      const [packageId, moveIds, moveLineIds, isFreshPackage] = await packageLevel('packageId', 'moveIds', 'moveLineIds', 'isFreshPackage');
      let state;
      if (moveIds.nok && moveLineIds.nok) {
        state = 'draft';
      }
      else if (moveLineIds.nok && (await moveIds.filtered(async (m) => !['done', 'cancel'].includes(await m.state))).ok) {
        state = 'confirmed';
      }
      else if (moveLineIds.ok && (await moveLineIds.filtered(async (ml) => await ml.state === 'done')).nok) {
        if (isFreshPackage) {
          state = 'new';
        }
        else if (await packageLevel._checkMoveLinesMapQuantPackage(packageId, 'productUomQty')) {
          state = 'assigned';
        }
        else {
          state = 'confirmed';
        }
      }
      else if ((await moveLineIds.filtered(async (ml) => await ml.state === 'done')).ok) {
        state = 'done';
      }
      else if ((await moveLineIds.filtered(async (ml) => await ml.state === 'cancel')).ok || (await moveIds.filtered(async (m) => await m.state === 'cancel')).ok) {
        state = 'cancel';
      }
      else {
        state = 'draft';
      }
      await packageLevel.set('state', state);
    }
  }

  async _computeShowLot() {
    for (const packageLevel of this) {
      const [moveLineIds, pickingId, state] = await packageLevel('moveLineIds', 'pickingId', 'state');
      let some;
      for (const ml of moveLineIds) {
        if (await (await ml.productId).tracking !== 'none') {
          some = true;
          break;
        }
      }
      let showLotsM2o, showLotsText;
      if (some) {
        if (await (await pickingId.pickingTypeId).useExistingLots || state === 'done') {
          showLotsM2o = true;
          showLotsText = false;
        }
        else {
          if (await (await pickingId.pickingTypeId).useCreateLots && state !== 'done') {
            showLotsM2o = false;
            showLotsText = true;
          }
          else {
            showLotsM2o = false;
            showLotsText = false;
          }
        }
      }
      else {
        showLotsM2o = false;
        showLotsText = false;
      }
      // await Promise.all([
        await packageLevel.set('showLotsM2o', showLotsM2o),
        await packageLevel.set('showLotsText', showLotsText)
      // ])
    }
  }

  async _generateMoves() {
    for (const packageLevel of this) {
      const [companyId, packageId, pickingId, locationId, locationDestId] = await packageLevel('companyId', 'packageId', 'pickingId', 'locationId', 'locationDestId');
      if (packageId.ok) {
        for (const quant of await packageId.quantIds) {
          const [productId, quantity] = await quant('productId', 'quantity');
          await this.env.items('stock.move').create({
            'pickingId': pickingId.id,
            'label': await productId.displayName,
            'productId': productId.id,
            'productUomQty': quantity,
            'productUom': (await productId.uomId).id,
            'locationId': locationId.id,
            'locationDestId': locationDestId.id,
            'packageLevelId': packageLevel.id,
            'companyId': companyId.id,
          });
        }
      }
    }
  }

  @api.model()
  async create(vals) {
    const result = await _super(StockPackageLevel, this).create(vals);
    if (vals['locationDestId']) {
      // await Promise.all([
        await (await result.mapped('moveLineIds')).write({ 'locationDestId': vals['locationDestId'] }),
        await (await result.mapped('moveIds')).write({ 'locationDestId': vals['locationDestId'] })
      // ]);
    }
    return result;
  }

  async write(vals) {
    const result = await _super(StockPackageLevel, this).write(vals);
    if (vals['locationDestId']) {
      // await Promise.all([
        await (await this.mapped('moveLineIds')).write({ 'locationDestId': vals['locationDestId'] }),
        await (await this.mapped('moveIds')).write({ 'locationDestId': vals['locationDestId'] })
      // ]);
    }
    return result;
  }

  async unlink() {
    // await Promise.all([
      await (await this.mapped('moveIds')).write({ 'packageLevelId': false }),
      await (await this.mapped('moveLineIds')).write({ 'resultPackageId': false })
    // ]);
    return _super(StockPackageLevel, this).unlink();
  }

  /**
   * should compare in good uom
   * @param package 
   * @param field 
   * @returns 
   */
  async _checkMoveLinesMapQuantPackage(pack, field = 'qtyDone') {
    const packMoveLines = await this['moveLineIds'];
    const keys = ['productId', 'lotId'];

    async function sortedKey(obj) {
      obj.ensureOne();
      const [productId, lotId] = await obj('productId', 'lotId');
      const maxLot = 10000;
      return maxLot * productId.id + lotId.id;
    }

    const groupedQuants = new Map<any, any>();
    for (const [k, g] of await groupbyAsync(await sortedAsync(await pack.quantIds, sortedKey), itemgetter(keys))) {
      groupedQuants.set(k, sum(await this.env.items['stock.quant'].concat(g).mapped('quantity')));
    }

    const groupedOps = new Map<any, any>();
    for (const [k, g] of await groupbyAsync(await sortedAsync(packMoveLines, sortedKey), itemgetter(keys))) {
      groupedOps.set(k, sum(await this.env.items('stock.move.line').concat(g).mapped(field)));
    }
    let allIn = true;
    for (const key in groupedQuants.keys()) {
      if ((groupedQuants.get(key) || 0) - (groupedOps.get(key) || 0) != 0) {
        allIn = false;
        break;
      }
    }
    if (allIn) {
      for (const key in groupedOps.keys()) {
        if ((groupedOps.get(key) || 0) - (groupedQuants.get(key) || 0) != 0) {
          allIn = false;
          break;
        }
      }
    }
    return allIn;
  }

  @api.depends('packageId', 'state', 'isFreshPackage', 'moveIds', 'moveLineIds')
  async _computeLocationId() {
    for (const pl of this) {
      let locationId;
      const [state, isFreshPackage] = await pl('state', 'isFreshPackage');
      if (state === 'new' || isFreshPackage) {
        locationId = false;
      }
      else {
        const packageId = await pl.packageId;
        if (packageId.ok) {
          locationId = await packageId.locationId;
        }
        else {
          const [moveIds, moveLineIds, pickingId] = await pl('moveIds', 'moveLineIds', 'pickingId');
          if (state === 'confirmed' && moveIds.ok) {
            locationId = await moveIds(0).locationId;
          }
          else if (['assigned', 'done'].includes(state) && moveLineIds.ok) {
            locationId = await moveLineIds(0).locationId;
          }
          else {
            locationId = await pickingId.locationId
          }
        }
      }
      await pl.set('locationId', locationId);
    }
  }

  async actionShowPackageDetails() {
    this.ensureOne();
    const view = await this.env.ref('stock.packageLevelFormEditView');

    return {
      'label': await this._t('Package Content'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'form',
      'resModel': 'stock.package.level',
      'views': [[view.id, 'form']],
      'viewId': view.id,
      'target': 'new',
      'resId': this.id,
      'flags': { 'mode': 'readonly' },
    }
  }
}