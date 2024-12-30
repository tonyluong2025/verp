import { random } from "lodash";
import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { Dict, UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model, _super } from "../../../core/models";
import { expression } from "../../../core/osv";
import { bool, f, len, pop, sorted } from "../../../core/tools";

@MetaModel.define()
class ProductAttribute extends Model {
  static _module = module;
  static _name = "product.attribute";
  static _description = "Product Attribute";
  // if you change this _order, keep it in sync with the method
  // `_sortKeyAttributeValue` in `product.template`
  static _order = 'sequence, id';

  static label = Fields.Char('Attribute', {required: true, translate: true});
  static valueIds = Fields.One2many('product.attribute.value', 'attributeId', { string: 'Values', copy: true});
  static sequence = Fields.Integer('Sequence', {help: "Determine the display order", index: true});
  static attributeLineIds = Fields.One2many('product.template.attribute.line', 'attributeId', { string: 'Lines'});
  static createVariant = Fields.Selection([
    ['always', 'Instantly'],
    ['dynamic', 'Dynamically'],
    ['noVariant', 'Never (option)']],
    {default: 'always',
    string: "Variants Creation Mode",
    help: `- Instantly: All possible variants are created as soon as the attribute and its values are added to a product.
    - Dynamically: Each variant is created only when its corresponding attributes and values are added to a sales order.
    - Never: Variants are never created for the attribute.
    Note: the variants creation mode cannot be changed once the attribute is used on at least one product.`,
    required: true});
  static numberRelatedProducts = Fields.Integer({compute: '_computeNumberRelatedProducts'});
  static productTemplateIds = Fields.Many2many('product.template', {string: "Related Products", compute: '_computeProducts', store: true});
  static displayType = Fields.Selection([
    ['radio', 'Radio'],
    ['pills', 'Pills'],
    ['select', 'Select'],
    ['color', 'Color']], {default: 'radio', required: true, help: "The display type used in the Product Configurator."});

  @api.depends('productTemplateIds')
  async _computeNumberRelatedProducts() {
    for (const pa of this) {
      await pa.set('numberRelatedProducts', len(await pa.productTemplateIds));
    }
  }

  @api.depends('attributeLineIds.active', 'attributeLineIds.productTemplateId')
  async _computeProducts() {
    for (const pa of this) {
      const self = await pa.withContext({activeTest: false});
      await self.set('productTemplateIds', await (await pa.attributeLineIds).productTemplateId);
    }
  }

  async _withoutNoVariantAttributes() {
    return this.filtered(async (pa) => await pa.createVariant !== 'noVariant');
  }

  /**
   * Override to make sure attribute type can't be changed if it's used on a product template.

    This is important to prevent because changing the type would make
    existing combinations invalid without recomputing them, and recomputing them might take too long and we don't want to change products without the user knowing about it.
   * @param vals 
   * @returns 
   */
  async write(vals) {
    if ('createVariant' in vals) {
      for (const pa of this) {
        if (vals['createVariant'] != await pa.createVariant && bool(await pa.numberRelatedProducts)) {
          throw new UserError(
            await this._t("You cannot change the Variants Creation Mode of the attribute %s because it is used on the following products:\n%s", await pa.displayName, (await (await pa.productTemplateIds).mapped('displayName')).join(', '))
          )
        }
      }
    }
    let some;
    for (const record of this) {
      if (await record.sequence != vals['sequence']) {
        some = true;
        break;
      }
    }
    const invalidateCache = 'sequence' in vals && some;
    const res = await _super(ProductAttribute, this).write(vals);
    if (invalidateCache) {
      // prefetched o2m have to be resequenced
      // (eg. product.template: attributeLineIds)
      await this.flush();
      this.invalidateCache();
    }
    return res;
  }

  @api.ondelete(false)
  async _unlinkExceptUsedOnProduct() {
    for (const pa of this) {
      if (await pa.numberRelatedProducts) {
        throw new UserError(
          await this._t("You cannot delete the attribute %s because it is used on the following products:\n%s", await pa.displayName, (await (await pa.productTemplateIds).mapped('displayName')).join(', '))
        )
      }
    }
  }

  async actionOpenRelatedProducts() {
    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t("Related Products"),
      'resModel': 'product.template',
      'viewMode': 'tree,form',
      'domain': [['id', 'in', (await (this as any).productTemplateIds).ids]],
    }
  }
}

@MetaModel.define()
class ProductAttributeValue extends Model {
  static _module = module;
  static _name = "product.attribute.value";
  // if you change this _order, keep it in sync with the method
  // `_sortKeyVariant` in `product.template'
  static _order = 'attributeId, sequence, id';
  static _description = 'Attribute Value';

  _getDefaultColor() {
    return random(1, 11);
  }

  static label = Fields.Char({string: 'Value', required: true, translate: true});
  static sequence = Fields.Integer({string: 'Sequence', help: "Determine the display order", index: true})
  static attributeId = Fields.Many2one('product.attribute', {string: "Attribute", ondelete: 'CASCADE', required: true, index: true, help: "The attribute cannot be changed once the value is used on at least one product."});

  static pavAttributeLineIds = Fields.Many2many('product.template.attribute.line', {string: "Lines", relation: 'productAttributeValueProductTemplateAttributeLineRel', copy: false});
  static isUsedOnProducts = Fields.Boolean('Used on Products', {compute: '_computeIsUsedOnProducts'});

  static isCustom = Fields.Boolean('Is custom value', {help: "Allow users to input custom values for this attribute value"});
  static htmlColor = Fields.Char(
    {string: 'Color',
    help: "Here you can set a specific HTML color index (e.g. #ff0000) to display the color if the attribute type is 'Color'."});
  static displayType = Fields.Selection({related: 'attributeId.displayType', readonly: true});
  static color = Fields.Integer('Color Index', {default: self => self._getDefaultColor()});

  static _sqlConstraints = [
    ['value_company_uniq', 'unique (label, "attributeId")', "You cannot create two values with the same name for the same attribute."]
  ]

  @api.depends('pavAttributeLineIds')
  async _computeIsUsedOnProducts() {
    for (const pav of this) {
      await pav.set('isUsedOnProducts', bool(await pav.pavAttributeLineIds));
    }
  }

  /**
   * Override because in general the name of the value is confusing if it
    is displayed without the name of the corresponding attribute.
    Eg. on product list & kanban views, on BOM form view

    However during variant set up (on the product template form) the name of
    the attribute is already on each line so there is no need to repeat it
    on every value.
   * @returns 
   */
  async nameGet() {
    if (! (this._context['showAttribute'] ?? true)) {
      return _super(ProductAttributeValue, this).nameGet();
    }
    const res = [];
    for (const value of this) {
      res.push([value.id, f("%s: %s", await (await value.attributeId).label, await value.label)]);
    }
    return res;
  }

  async write(values) {
    if ('attributeId' in values) {
      for (const pav of this) {
        if ((await pav.attributeId).id != values['attributeId'] && await pav.isUsedOnProducts) {
          throw new UserError(
            await this._t("You cannot change the attribute of the value %s because it is used on the following products:%s", await pav.displayName, (await (await (await pav.pavAttributeLineIds).productTemplateId).mapped('displayName')).join(', '))
          )
        }
      }
    }

    let some;
    for (const record of this) {
      if (await record.sequence != values['sequence']) {
        some = true;
        break;
      }
    }
    const invalidateCache = 'sequence' in values && some;
    const res = await _super(ProductAttributeValue, this).write(values);
    if (invalidateCache) {
      // prefetched o2m have to be resequenced
      // (eg. product.template.attribute.line: value_ids)
      await this.flush();
      this.invalidateCache();
    }
    return res
  }

  @api.ondelete(false)
  async _unlinkExceptUsedOnProduct() {
    for (const pav of this) {
      if (await pav.isUsedOnProducts) {
        throw new UserError(
          await this._t("You cannot delete the value %s because it is used on the following products:\n%s", await pav.displayName, (await (await (await pav.pavAttributeLineIds).productTemplateId).mapped('displayName')).join(', '))
        )
      }
    }
  }

  async _withoutNoVariantAttributes() {
    return this.filtered(async (pav) => await (await pav.attributeId).createVariant !== 'noVariant')
  }
}

/**
 * Attributes available on product.template with their selected values in a m2m.
  Used as a configuration model to generate the appropriate product.template.attribute.value
 */
@MetaModel.define()
class ProductTemplateAttributeLine extends Model {
  static _module = module;
  static _name = "product.template.attribute.line";
  static _recName = 'attributeId';
  static _description = 'Product Template Attribute Line';
  static _order = 'attributeId, id';

  static active = Fields.Boolean({default: true});
  static productTemplateId = Fields.Many2one('product.template', {string: "Product Template", ondelete: 'CASCADE', required: true, index: true});
  static attributeId = Fields.Many2one('product.attribute', {string: "Attribute", ondelete: 'RESTRICT', required: true, index: true});
  static valueIds = Fields.Many2many('product.attribute.value', {string: "Values", domain: "[['attributeId', '=', attributeId]]", relation: 'productAttributeValueProductTemplateAttributeLineRel', ondelete: 'RESTRICT'});
  static valueCount = Fields.Integer({compute: '_computeValueCount', store: true, readonly: true});
  static productTemplateValueIds = Fields.One2many('product.template.attribute.value', 'attributeLineId', { string: "Product Attribute Values" });

  @api.depends('valueIds')
  async _computeValueCount() {
    for (const record of this) {
      await record.set('valueCount', len(await record.valueIds));
    }
  }

  @api.onchange('attributeId')
  async _onchangeAttributeId() {
    await this.set('valueIds', await (await (this as any).valueIds).filtered(async (pav) => await pav.attributeId === await (this as any).attributeId));
  }

  @api.constrains('active', 'valueIds', 'attributeId')
  async _checkValidValues() {
    for (const ptal of this) {
      const [active, valueIds, attribute, productTemplate] = await ptal('active', 'valueIds', 'attributeId', 'productTemplateId');
      if (active && ! bool(valueIds)) {
        throw new ValidationError(
          await this._t("The attribute %s must have at least one value for the product %s.", await attribute.displayName, await productTemplate.displayName)
        )
      }
      for (const pav of valueIds) {
        if (!(await pav.attributeId ).eq(attribute)) {
          throw new ValidationError(
            await this._t("On the product %s you cannot associate the value %s with the attribute %s because they do not match.", await productTemplate.displayName, await pav.displayName, await attribute.displayName)
          )
        }
      }
    }
    return true;
  }

  /**
   * Override to:
    - Activate archived lines having the same configuration (if they exist) instead of creating new lines.
    - Set up related values and related variants.

    Reactivating existing lines allows to re-use existing variants when
    possible, keeping their configuration and avoiding duplication.
   * @param valsList 
   */
  @api.modelCreateMulti()
  async create(valsList) {
    const createValues = [];
    let activatedLines = this.env.items('product.template.attribute.line');
    for (const value of valsList) {
      const vals = new Dict({...value, active: value['active'] ?? true});
      // While not ideal for peformance, this search has to be done at each step to exclude the lines that might have been activated at a previous step. Since `vals_list` will likely be a small list in all use cases, this is an acceptable trade-off.
      const archivedPtal = await this.search([
        ['active', '=', false],
        ['productTemplateId', '=', pop(vals, 'productTemplateId', 0)],
        ['attributeId', '=', pop(vals, 'attributeId', 0)],
      ], {limit: 1});
      if (bool(archivedPtal)) {
        // Write given `vals` in addition of `active` to ensure
        // `value_ids` or other fields passed to `create` are saved too,
        // but change the context to avoid updating the values and the
        // variants until all the expected lines are created/updated.
        await (await archivedPtal.withContext({updateProductTemplateAttributeValues: false})).write(vals);
        activatedLines = activatedLines.add(archivedPtal);
      }
      else {
        createValues.push(value);
      }
    }
    const res = activatedLines.add(await _super(ProductTemplateAttributeLine, this).create(createValues));
    await res._updateProductTemplateAttributeValues();
    return res;
  }

  /**
   * Override to:
    - Add constraints to prevent doing changes that are not supported such as modifying the template or the attribute of existing lines.
    - Clean up related values and related variants when archiving or when updating `value_ids`.
   * @param values 
   * @returns 
   */
  async write(values) {
    if ('productTemplateId' in values) {
      for (const ptal of this) {
        const productTemplateId = await ptal.productTemplateId;
        if (productTemplateId.id != values['productTemplateId']) {
          throw new UserError(
            await this._t("You cannot move the attribute %s from the product %s to the product %s.", await (await ptal.attributeId).displayName, await productTemplateId.displayName, values['productTemplateId'])
          )
        }
      }
    }

    if ('attributeId' in values) {
      for (const ptal of this) {
        const attributeId = await ptal.attributeId;
        if (attributeId.id != values['attributeId']) {
          throw new UserError(
            await this._t("On the product %s you cannot transform the attribute %s into the attribute %s.", await (await ptal.productTemplateId).displayName, await attributeId.displayName, values['attributeId'])
          )
        }
      }
    }
    // Remove all values while archiving to make sure the line is clean if it  is ever activated again.
    if (! (values['active'] ?? true)) {
      values['valueIds'] = [[5, 0, 0]];
    }
    const res = await _super(ProductTemplateAttributeLine, this).write(values);
    if ('active' in values) {
      await this.flush();
      this.env.items('product.template').invalidateCache(['attributeLineIds']);
    }
    // If coming from `create`, no need to update the values and the variants before all lines are created.
    if (this.env.context['updateProductTemplateAttributeValues'] ?? true) {
      await this._updateProductTemplateAttributeValues();
    }
    return res;
  }

  /**
   * Override to:
    - Archive the line if unlink is not possible.
    - Clean up related values and related variants.

    Archiving is typically needed when the line has values that can't be deleted because they are referenced elsewhere (on a variant that can't be deleted, on a sales order line, ...).
   * @returns 
   */
  async unlink() {
    // Try to remove the values first to remove some potentially blocking  references, which typically works:
    // - For single value lines because the values are directly removed from
    //   the variants.
    // - For values that are present on variants that can be deleted.
    const self: any = this;
    await (await (await self.productTemplateValueIds)._onlyActive()).unlink();
    // Keep a reference to the related templates before the deletion.
    const templates = await self.productTemplateId;
    // Now delete or archive the lines.
    let ptalToArchive = self.env.items('product.template.attribute.line');
    for (const ptal of self) {
      try {
        // with self.env.cr.savepoint(), tools.mute_logger('core.sql_db'):
        await _super(ProductTemplateAttributeLine, ptal).unlink();
      } catch(e) {
        // We catch all kind of exceptions to be sure that the operation doesn't fail.
        ptalToArchive = ptalToArchive.add(ptal);
      }
    }
    await ptalToArchive.write({'active': false});
    // For archived lines `_update_product_template_attribute_values` is implicitly called during the `write` above, but for products that used unlinked lines `_create_variant_ids` has to be called manually.
    await templates.sub(await ptalToArchive.productTemplateId)._createVariantIds();
    return true;
  }

  /**
   * Create or unlink `product.template.attribute.value` for each line in
    `self` based on `value_ids`.

    The goal is to delete all values that are not in `value_ids`, to
    activate those in `value_ids` that are currently archived, and to create
    those in `value_ids` that didn't exist.

    This is a trick for the form view and for performance in general,
    because we don't want to generate in advance all possible values for all
    templates, but only those that will be selected.
   */
  async _updateProductTemplateAttributeValues() {
    const ProductTemplateAttributeValue = this.env.items('product.template.attribute.value');
    const ptavToCreate = [];
    let ptavToUnlink = ProductTemplateAttributeValue;
    for (const ptal of this) {
      let ptavToActivate = ProductTemplateAttributeValue;
      let remainingPav = await ptal.valueIds;
      for (const ptav of await ptal.productTemplateValueIds) {
        if (! remainingPav.includes(await ptav.productAttributeValueId)) {
          // Remove values that existed but don't exist anymore, but
          // ignore those that are already archived because if they are
          // archived it means they could not be deleted previously.
          if (await ptav.ptavActive) {
            ptavToUnlink = ptavToUnlink.add(ptav);
          }
        }
        else {
          // Activate corresponding values that are currently archived.
          remainingPav = remainingPav.sub(await ptav.productAttributeValueId);
          if (! await ptav.ptavActive) {
            ptavToActivate = ptavToUnlink.add(ptav);
          }
        }
      }
      for (const pav of remainingPav) {
        // The previous loop searched for archived values that belonged to the current line, but if the line was deleted and another line  was recreated for the same attribute, we need to expand the  search to those with matching `attributeId`.
        // While not ideal for peformance, this search has to be done at each step to exclude the values that might have been activated at a previous step. Since `remaining_pav` will likely be a  small list in all use cases, this is an acceptable trade-off.
        const ptav = await ProductTemplateAttributeValue.search([
          ['ptavActive', '=', false],
          ['productTemplateId', '=', (await ptal.productTemplateId).id],
          ['attributeId', '=', (await ptal.attributeId).id],
          ['productAttributeValueId', '=', pav.id],
        ], {limit: 1});
        if (bool(ptav)) {
          await ptav.write({'ptavActive': true, 'attributeLineId': ptal.id});
          // If the value was marked for deletion, now keep it.
          ptavToUnlink = ptavToUnlink.sub(ptav);
        }
        else {
          // create values that didn't exist yet
          ptavToCreate.push({
            'productAttributeValueId': pav.id,
            'attributeLineId': ptal.id
          });
        }
      }
      // Handle active at each step in case a following line might want to  re-use a value that was archived at a previous step.

      await ptavToActivate.write({'ptavActive': true});
      await ptavToUnlink.write({'ptavActive': false});

    }
    if (bool(ptavToUnlink)) {
      await ptavToUnlink.unlink();
    }
    await ProductTemplateAttributeValue.create(ptavToCreate);
    await (await (this as any).productTemplateId)._createVariantIds();
  }

  @api.model()
  async _nameSearch(name: string, args: any[]=[], operator='ilike', {limit=100, nameGetUid=false}={}) {
    // TDE FIXME: currently overriding the domain; however as it includes a search on a m2o and one on a m2m, probably this will quickly become difficult to compute - check if performance optimization is required
    if (name && ['=', 'ilike', '=ilike', 'like', '=like'].includes(operator)) {
      const domain = ['|', ['attributeId', operator, name], ['valueIds', operator, name]];
      return this._search(expression.AND([domain, args]), {limit, accessRightsUid: nameGetUid});
    }
    return _super(ProductTemplateAttributeLine, self)._nameSearch(name, args, operator, {limit, nameGetUid});
  }

  async _withoutNoVariantAttributes() {
    return this.filtered(async (ptal) => await (await ptal.attributeId).createVariant !== 'noVariant');
  }

  async actionOpenAttributeValues() {  
    return {
      'type': 'ir.actions.actwindow',
      'label': await this._t("Product Variant Values"),
      'resModel': 'product.template.attribute.value',
      'viewMode': 'tree,form',
      'domain': [['id', 'in', (await (this as any).productTemplateValueIds).ids]],
      'views': [
        [(await this.env.ref('product.productTemplateAttributeValueViewTree')).id, 'list'],
        [(await this.env.ref('product.productTemplateAttributeValueViewForm')).id, 'form'],
      ],
      'context': {
        'searchDefault_active': 1,
      },
    }
  }
}

/**
 * Materialized relationship between attribute values
  and product template generated by the product.template.attribute.line
 */
@MetaModel.define()
class ProductTemplateAttributeValue extends Model {
  static _module = module;
  static _name = "product.template.attribute.value";
  static _description = "Product Template Attribute Value";
  static _order = 'attributeLineId, productAttributeValueId, id';

  _getDefaultColor() {
    return random(1, 11);
  }

  // Not just `active` because we always want to show the values except in specific case, as opposed to `activeTest`.
  static ptavActive = Fields.Boolean("Active", {default: true});
  static label = Fields.Char('Value', {related: "productAttributeValueId.label"});

  // defining fields: the product template attribute line and the product attribute value
  static productAttributeValueId = Fields.Many2one(
      'product.attribute.value', {string: 'Attribute Value',
      required: true, ondelete: 'CASCADE', index: true});
  static attributeLineId = Fields.Many2one('product.template.attribute.line', {required: true, ondelete: 'CASCADE', index: true});
  // configuration fields: the priceExtra and the exclusion rules
  static priceExtra = Fields.Float(
    {string: "Value Price Extra",
    default: 0.0,
    digits: 'Product Price',
    help: "Extra price for the variant with this attribute value on sale price. eg. 200 price extra, 1000 + 200 = 1200."});
  static currencyId = Fields.Many2one({related: 'attributeLineId.productTemplateId.currencyId'});

  static excludeFor = Fields.One2many(
    'product.template.attribute.exclusion',
    'productTemplateAttributeValueId', {
    string: "Exclude for",
    help: "Make this attribute value not compatible with other values of the product or some attribute values of optional and accessory products." });

  // related fields: product template and product attribute
  static productTemplateId = Fields.Many2one('product.template', {string: "Product Template", related: 'attributeLineId.productTemplateId', store: true, index: true});
  static attributeId = Fields.Many2one('product.attribute', {string: "Attribute", related: 'attributeLineId.attributeId', store: true, index: true});
  static ptavProductVariantIds = Fields.Many2many('product.product', {relation: 'productVariantCombination', string: "Related Variants", readonly: true});

  static htmlColor = Fields.Char('HTML Color Index', {related: "productAttributeValueId.htmlColor"});
  static isCustom = Fields.Boolean('Is custom value', {related: "productAttributeValueId.isCustom"});
  static displayType = Fields.Selection({related: 'productAttributeValueId.displayType', readonly: true});
  static color = Fields.Integer('Color', {default: self => self._getDefaultColor()});

  static _sqlConstraints = [
    ['attribute_value_unique', 'unique("attributeLineId", "productAttributeValueId")', "Each value should be defined only once per attribute per product."],
  ]

  @api.constrains('attributeLineId', 'productAttributeValueId')
  async _checkValidValues() {
    for (const ptav of this) {
      if (!(await (await ptav.attributeLineId).valueIds).includes(await ptav.productAttributeValueId)) {
        throw new ValidationError(
          await this._t("The value %s is not defined for the attribute %s on the product %s.", await (await ptav.productAttributeValueId).displayName, await (await ptav.attributeId).displayName, await (await ptav.productTemplateId).displayName)
        )
      }
    }
  }

  @api.modelCreateMulti()
  async create(valsList) {
    for (const v of valsList) {
      if ('ptavProductVariantIds' in v) {
        // Force write on this relation from `product.product` to properly trigger `_computeCombinationIndices`.
        throw new UserError(await this._t("You cannot update related variants from the values. Please update related values from the variants."))
      }
    }
    return _super(ProductTemplateAttributeValue, this).create(valsList);
  }

  async write(values) {
    if ('ptavProductVariantIds' in values) {
      // Force write on this relation from `product.product` to properly trigger `_computeCombinationIndices`.
      throw new UserError(await this._t("You cannot update related variants from the values. Please update related values from the variants."));
    }
    const pavInValues = 'productAttributeValueId' in values;
    const productInValues = 'productTemplateId' in values;
    if (pavInValues || productInValues) {
      for (const ptav of this) {
        if (pavInValues && (await ptav.productAttributeValueId).id != values['productAttributeValueId']) {
          throw new UserError(
            await this._t("You cannot change the value of the value %s set on product %s.", await ptav.displayName, await (await ptav.productTemplateId).displayName)
          )
        }
        if (productInValues && (await ptav.productTemplateId).id != values['productTemplateId']) {
          throw new UserError(
            await this._t("You cannot change the product of the value %s set on product %s.", await ptav.displayName, await (await ptav.productTemplateId).displayName)
          )
        }
      }
    }
    const res = await _super(ProductTemplateAttributeValue, this).write(values);
    if ('excludeFor' in values) {
      await (await (this as any).productTemplateId)._createVariantIds();
    }
    return res;
  }

  /**
   * Override to:
    - Clean up the variants that use any of the values of this) {
        - Remove the value from the variant if the value belonged to an
            attribute line with only one value.
        - Unlink or archive all related variants.
    - Archive the value if unlink is not possible.

    Archiving is typically needed when the value is referenced elsewhere
    (on a variant that can't be deleted, on a sales order line, ...).
   * @returns 
   */
  async unlink() {
    // Directly remove the values from the variants for lines that had single value (counting also the values that are archived).
    const singleValues = await this.filtered(async (ptav) => len(await (await ptav.attributeLineId).productTemplateValueIds) == 1);
    for (const ptav of singleValues) {
      await (await ptav.ptavProductVariantIds).write({'product_template_attribute_value_ids': [[3, ptav.id, 0]]});
    }
    // Try to remove the variants before deleting to potentially remove some blocking references.
    await (await (this as any).ptavProductVariantIds)._unlinkOrArchive();
    // Now delete or archive the values.
    let ptavToArchive = this.env.items('product.template.attribute.value');
    for (const ptav of this) {
      try {
        // with self.env.cr.savepoint(), tools.mute_logger('core.sql_db'):
        await this.env.cr.savepoint(async () => {
          await _super(ProductTemplateAttributeValue, ptav).unlink();
        });
      } catch(e) {
        // We catch all kind of exceptions to be sure that the operation doesn't fail.
        ptavToArchive = ptavToArchive.add(ptav);
      }
    }
    await ptavToArchive.write({'ptavActive': false});
    return true;
  }

  /**
   * Override because in general the name of the value is confusing if it is displayed without the name of the corresponding attribute.
    Eg. on exclusion rules form
   * @returns 
   */
  async nameGet() {
    const res = [];
    for (const value of this) {
      res.push([value.id, f("%s: %s", await (await value.attributeId).label, await value.label)]);
    }
    return res;
  }

  async _onlyActive() {
    return this.filtered(async (ptav) => ptav.ptavActive);
  }

  async _withoutNoVariantAttributes() {
    return this.filtered(async (ptav) => await (await ptav.attributeId).createVariant != 'noVariant');
  }

  _ids2str() {
    return sorted(this.ids).map(i => String(i)).join(',');
  }

  /**
   * Exclude values from single value lines or from noVariant attributes.
   * @param self 
   */
  async _getCombinationName() {
    let ptavs = (await this._withoutNoVariantAttributes()).withPrefetch(this._prefetchIds);
    ptavs = (await ptavs._filterSingleValueLines()).withPrefetch(this._prefetchIds);
    const res = [];
    for (const ptav of ptavs) {
      res.push(await ptav.label);
    }
    return (await ptavs.mapped('label')).join(', ');
  }

  /**
   * Return `self` with values from single value lines filtered out
    depending on the active state of all the values in `self`.

    If any value in `self` is archived, archived values are also taken into account when checking for single values.
    This allows to display the correct name for archived variants.

    If all values in `self` are active, only active values are taken into account when checking for single values.
    This allows to display the correct name for active combinations.
   * @returns 
   */
  async _filterSingleValueLines() {
    let onlyActive = true;
    for (const ptav of this) {
      if (await ptav.ptavActive) {
        onlyActive = false;
      }
    }
    return this.filtered(async (ptav) => ! await ptav._isFromSingleValueLine(onlyActive));
  }

  /**
   * Return whether `self` is from a single value line, counting also
    archived values if `only_active` is false.
   * @param onlyActive 
   * @returns 
   */
  async _isFromSingleValueLine(onlyActive=true) {
    this.ensureOne();
    let allValues = await (await (this as any).attributeLineId).productTemplateValueIds;
    if (onlyActive) {
      allValues = await allValues._onlyActive();
    }
    return len(allValues) == 1
  }
}

@MetaModel.define()
class ProductTemplateAttributeExclusion extends Model {
  static _module = module;
  static _name = "product.template.attribute.exclusion";
  static _description = 'Product Template Attribute Exclusion';
  static _order = 'productTemplateId, id';

  static productTemplateAttributeValueId = Fields.Many2one(
      'product.template.attribute.value', {string: "Attribute Value", ondelete: 'CASCADE', index: true});
  static productTemplateId = Fields.Many2one(
      'product.template', {string: 'Product Template', ondelete: 'CASCADE', required: true, index: true});
  static valueIds = Fields.Many2many(
      'product.template.attribute.value', {relation: "productAttrExclusionValueIdsRel",
      string: 'Attribute Values', domain: "[['productTemplateId', '=', productTemplateId], ['ptavActive', '=', true]]"});
}

@MetaModel.define()
class ProductAttributeCustomValue extends Model {
  static _module = module;
  static _name = "product.attribute.custom.value";
  static _description = 'Product Attribute Custom Value';
  static _order = 'customProductTemplateAttributeValueId, id';

  static label = Fields.Char("Name", {compute: '_computeName'})
  static customProductTemplateAttributeValueId = Fields.Many2one('product.template.attribute.value', {string: "Attribute Value", required: true, ondelete: 'RESTRICT'});
  static customValue = Fields.Char("Custom Value");

  @api.depends('customProductTemplateAttributeValueId.label', 'customValue')
  async _computeName() {
    for (const record of this) {
      const customProductTemplateAttributeValueId = await record.customProductTemplateAttributeValueId;
      const displayName = await customProductTemplateAttributeValueId.displayName;
      let name = (await record.customValue || '').trim();
      if (displayName) {
        name = f("%s: %s", displayName, name);
      }
      await record.set('label', name);
    }
  }
}