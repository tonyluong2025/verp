import { DateTime } from "luxon";
import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { floatRound } from "../../../core/tools/float_utils";
import { len } from "../../../core/tools/iterable";
import { pop, setOptions } from "../../../core/tools/misc";

@MetaModel.define()
class UoMCategory extends Model {
  static _module = module;
  static _name = 'uom.category';
  static _description = 'Product UoM Categories';

  static label = Fields.Char('Unit of Measure Category', {required: true, translate: true});
  static uomIds = Fields.One2many('uom.uom', 'categoryId');
  static referenceUomId = Fields.Many2one('uom.uom', {string: "Reference UoM", store: false, help: "Dummy field to keep track of reference uom change"});

  @api.onchange('uomIds')
  async _onchangeUomIds() {
    const self: any = this;
    const uomIds = await self.uomIds;
    if (len(uomIds) == 1) {
      // await Promise.all([
        await (await self.uomIds(0)).set('uomType', 'reference'),
        await (await self.uomIds(0)).set('factor', 1)
      // ]);
    }
    else {
      let referenceCount = 0;
      for (const uom of uomIds) {
        if (await uom.uomType === 'reference') {
          referenceCount++;
        }
      }
      if (referenceCount == 0 && bool(this._origin.id)) {
        return {
          'warning': {
            'title': await this._t('Warning!'),
            'message': await this._t("UoM category %s should have a reference unit of measure.", await self.label)
          }
        }
      }
      let newReference;
      if (bool(await self.referenceUomId)) {
        newReference = await uomIds.filtered(async (o) => (await o.uomType === 'reference' && o._origin.id != (await self.referenceUomId).id));
      }
      else {
        newReference = await uomIds.filtered(async (o) => (await o.uomType === 'reference' && await o._origin.uomType !== 'reference'));
      }
      if (newReference) {
        const otherUoms = (await uomIds.filtered((u) => u._origin.id)).sub(newReference);
        for (const uom of otherUoms) {
          await uom.set('factor', await uom._origin.factor / (await newReference._origin.factor ?? 1));
          if (await uom.factor > 1) {
            await uom.set('uomType', 'smaller');
          }
          else {
            await uom.set('uomType', 'bigger');
          }
        }
        await self.set('referenceUomId', newReference._origin.id)
      }
    }
  }
}

@MetaModel.define()
class UoM extends Model {
  static _module = module;
  static _name = 'uom.uom';
  static _description = 'Product Unit of Measure';
  static _order = "factor DESC, id";

  _unprotectedUomXmlids() {
    return [
      "productUomHour", // NOTE: this uom is protected when hr_timesheet is installed.
      "productUomDozen",
    ]
  }

  static label = Fields.Char('Unit of Measure', {required: true, translate: true});
  static categoryId = Fields.Many2one(
    'uom.category', {string: 'Category', required: true, ondelete: 'RESTRICT', help: "Conversion between Units of Measure can only occur if they belong to the same category. The conversion will be made based on the ratios."})
  static factor = Fields.Float(
    'Ratio', {default: 1.0, digits: 0, required: true,  // force NUMERIC with unlimited precision
    help: 'How much bigger or smaller this unit is compared to the reference Unit of Measure for this category: 1 * (reference unit) = ratio * (this unit)'})
  static factorInv = Fields.Float(
    'Bigger Ratio', {compute: '_computeFactorInv', digits: 0,  // force NUMERIC with unlimited precision
    readonly: true, required: true,
    help: 'How many times this Unit of Measure is bigger than the reference Unit of Measure in this category: 1 * (this unit) = ratio * (reference unit)'})
  static rounding = Fields.Float(
    'Rounding Precision', {default: 0.01, digits: 0, required: true,
    help: "The computed quantity will be a multiple of this value. Use 1.0 for a Unit of Measure that cannot be further split, such as a piece."})
  static active = Fields.Boolean('Active', {default: true, help: "Uncheck the active field to disable a unit of measure without deleting it."})
  static uomType = Fields.Selection([
    ['bigger', 'Bigger than the reference Unit of Measure'],
    ['reference', 'Reference Unit of Measure for this category'],
    ['smaller', 'Smaller than the reference Unit of Measure']], {string: 'Type', default: 'reference', required: true})
  static ratio = Fields.Float('Combined Ratio', {compute: '_computeRatio', inverse: '_setRatio', store: false})
  static color = Fields.Integer('Color', {compute: '_computeColor'})

  static _sqlConstraints = [
    ['factor_gt_zero', 'CHECK (factor!=0)', 'The conversion ratio for a unit of measure cannot be 0!'],
    ['rounding_gt_zero', 'CHECK (rounding>0)', 'The rounding precision must be strictly positive.'],
    ['factor_reference_is_one', `CHECK(("uomType" = 'reference' AND factor = 1.0) OR ("uomType" != 'reference'))`, "The reference unit must have a conversion factor equal to 1."]
  ]

  async _checkCategoryReferenceUniqueness() {
    for (const category of await (this as any).categoryId) {
      const uomIds = await category.uomIds;
      if (!uomIds.ok) {
        continue;
      }
      let referenceCount = 0;
      for (const uom of uomIds) {
        if (await uom.uomType === 'reference') {
          referenceCount++;
        }
      }
      if (referenceCount > 1) {
        throw new ValidationError(await this._t("UoM category %s should only have one reference unit of measure.", await category.label))
      }
      else if (referenceCount == 0) {
        throw new ValidationError(await this._t("UoM category %s should have a reference unit of measure.", await category.label))
      }
    }
  }

  @api.depends('factor')
  async _computeFactorInv() {
    for (const uom of this) {
      const factor = await uom.factor;
      await uom.set('factorInv', factor && (1.0 / factor) || 0.0);
    }
  }

  @api.depends('uomType', 'factor')
  async _computeRatio() {
    for (const uom of this) {
      const uomType = await uom.uomType;
      if (uomType === 'reference') {
        await uom.set('ratio', 1);
      }
      else if (uomType === 'bigger') {
        await uom.set('ratio', await uom.factorInv);
      }
      else {
        await uom.set('ratio', await uom.factor);
      }
    }
  }

  async _setRatio() {
    const self: any = this;
    if (await self.uomType === 'reference') {
      await self.set('factor', 1);
    }
    else if (await self.uomType === 'bigger') {
      await self.set('factor', 1 / await self.ratio);
    }
    else {
      await self.set('factor', await self.ratio);
    }
  }

  @api.depends('uomType')
  async _computeColor() {
    for (const uom of this) {
      if (await uom.uomType === 'reference') {
        await uom.set('color', 7);
      }
      else {
        await uom.set('color', 0);
      }
    }
  }

  @api.onchange('uomType')
  async _onchangeUomType() {
    if (await (this as any).uomType == 'reference') {
      await this.set('factor', 1);
    }
  }

  @api.onchange('factor', 'factorInv', 'uomType', 'rounding', 'categoryId')
  async _onchangeCriticalFields() {
    const self: any = this;
    if (this._filterProtectedUoms() && self.createdAt < DateTime.now().minus({days: 1}).toJSDate()) {
      return {
        'warning': {
          'title': await this._t("Warning for %s", await self.label),
          'message': await this._t(
            `Some critical fields have been modified on %s.\n
            Note that existing data WON'T be updated by this change.\n\n
            As units of measure impact the whole system, this may cause critical issues.\n
            E.g. modifying the rounding could disturb your inventory balance.\n\n
            Therefore, changing core units of measure in a running database is not recommended.`, await self.label,
          )
        }
      }
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const values of valsList) {
      if ('factorInv' in values) {
        const factorInv = pop(values, 'factorInv');
        values['factor'] = factorInv && (1.0 / factorInv) || 0.0;
      }
    }
    const res = await _super(UoM, this).create(valsList);
    await res._checkCategoryReferenceUniqueness();
    return res;
  }

  async write(values) {
    if ('factorInv' in values) {
      const factorInv = pop(values, 'factorInv');
      values['factor'] = factorInv && (1.0 / factorInv) || 0.0;
    }
    const res = await _super(UoM, this).write(values);
    if ((!('uomType' in values) || values['uomYype'] !== 'reference') && !this.env.context['allowToChangeReference']) {
      await this._checkCategoryReferenceUniqueness();
    }
    return res;
  }

  @api.ondelete(false)
  async _unlinkExceptMasterData() {
    const lockedUoms = await this._filterProtectedUoms();
    if (lockedUoms.ok) {
      throw new UserError(await this._t(
        "The following units of measure are used by the system and cannot be deleted: %s\nYou can archive them instead.", (await lockedUoms.mapped('label')).join(', '),
      ))
    }
  }

  /**
   * The UoM category and factor are required, so we'll have to add temporary values for imported UoMs
   * @param name 
   * @returns 
   */
  @api.model()
  async nameCreate(name) {
    const values = {
      [this.cls._recName]: name,
      'factor': 1
    }
    // look for the category based on the english name, i.e. no context on purpose!
    // TODO: should find a way to have it translated but not created until actually used
    if (! this._context['default_categoryId']) {
      const EnglishUoMCateg = await this.env.items('uom.category').withContext({});
      const miscCategory = await EnglishUoMCateg.search([['label', '=', 'Unsorted/Imported Units']]);
      if (miscCategory.ok) {
        values['categoryId'] = miscCategory.id;
      }
      else {
        values['categoryId'] = (await EnglishUoMCateg.nameCreate('Unsorted/Imported Units'))[0];
      }
    }
    const newUom = await this.create(values);
    return (await newUom.nameGet())[0];
  }

  /**
   * Convert the given quantity from the current UoM `self` into a given one
        :param qty: the quantity to convert
        :param to_unit: the destination UoM record (uom.uom)
        :param raise_if_failure: only if the conversion is not possible
            - if true, raise an exception if the conversion is not possible (different UoM category),
            - otherwise, return the initial quantity
   * @param qty 
   * @param toUnit 
   * @param options 
   * @returns 
   */
  async _computeQuantity(qty, toUnit, options: {round?: boolean, roundingMethod?: string, raiseIfFailure?: boolean}={}) {
    setOptions(options, {round: true, roundingMethod: 'UP', raiseIfFailure: true});
    if (!this.ok || ! qty) {
      return qty;
    }
    this.ensureOne();

    const self: any = this;
    if (!self.eq(toUnit) && (await self.categoryId).id != (await toUnit.categoryId).id) {
      if (options.raiseIfFailure) {
        throw new UserError(await this._t('The unit of measure %s defined on the order line doesn\'t belong to the same category as the unit of measure %s defined on the product. Please correct the unit of measure defined on the order line or on the product, they should belong to the same category.', await self.label, await toUnit.label));
      }
      else {
        return qty;
      }
    }

    let amount;
    if (self.eq(toUnit)) {
      amount = qty;
    }
    else {
      amount = qty / (await self.factor);
      if (toUnit.ok) {
        amount = amount * (await toUnit.factor);
      }
    }
    if (toUnit.ok && options.round) {
      amount = floatRound(amount, {precisionRounding: await toUnit.rounding, roundingMethod: options.roundingMethod});
    }

    return amount;
  }

  async _computePrice(price, toUnit) {
    const self: any= this;
    self.ensureOne();
    if (! self.ok || !price || !toUnit.ok || self.eq(toUnit)) {
      return price;
    }
    if ((await self.categoryId).id != (await toUnit.categoryId).id) {
      return price;
    }
    let amount = price * (await self.factor);
    if (toUnit.ok) {
      amount = amount / (await toUnit.factor);
    }
    return amount;
  }

  /**
   * Verifies self does not contain protected uoms.
   * @returns 
   */
  async _filterProtectedUoms() {
    const linkedModelData = await (await this.env.items('ir.model.data').sudo()).search([
      ['model', '=', this._name],
      ['resId', 'in', this.ids],
      ['module', '=', 'uom'],
      ['label', 'not in', this._unprotectedUomXmlids()],
    ])
    if (! linkedModelData.ok) {
      return this.browse();
    }
    else {
      return this.browse(await linkedModelData.mapped('resId'));
    }
  }
}