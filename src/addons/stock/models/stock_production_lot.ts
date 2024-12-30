import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { UserError, ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { extend, len, range, sum } from "../../../core/tools/iterable";
import { update } from "../../../core/tools/misc";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class ProductionLot extends Model {
    static _module = module;
    static _name = 'stock.production.lot';
    static _parents = ['mail.thread', 'mail.activity.mixin'];
    static _description = 'Lot/Serial';
    static _checkCompanyAuto = true;

    static label = Fields.Char(
        'Lot/Serial Number', {
            default: self => self.env.items('ir.sequence').nextByCode('stock.lot.serial'),
        required: true, help: "Unique Lot/Serial Number"
    });
    static ref = Fields.Char('Internal Reference', { help: "Internal reference number in case it differs from the manufacturer's lot/serial number" });
    static productId = Fields.Many2one(
        'product.product', {
            string: 'Product', index: true,
        domain: (self) => self._domainProductId(), required: true, checkCompany: true
    });
    static productUomId = Fields.Many2one(
        'uom.uom', {
            string: 'Unit of Measure',
        related: 'productId.uomId', store: true
    });
    static quantIds = Fields.One2many('stock.quant', 'lotId', { string: 'Quants', readonly: true });
    static productQty = Fields.Float('Quantity', { compute: '_productQty' });
    static note = Fields.Html({ string: 'Description' });
    static displayComplete = Fields.Boolean({ compute: '_computeDisplayComplete' });
    static companyId = Fields.Many2one('res.company', { string: 'Company', required: true, store: true, index: true });
    static deliveryIds = Fields.Many2many('stock.picking', { compute: '_computeDeliveryIds', string: 'Transfers' });
    static deliveryCount = Fields.Integer('Delivery order count', { compute: '_computeDeliveryIds' });
    static lastDeliveryPartnerId = Fields.Many2one('res.partner', { compute: '_computeDeliveryIds' });

    /**
     * Generate `lotNames` from a string.
     * @param firstLot 
     * @param count 
     * @returns 
     */
    @api.model()
    async generateLotNames(firstLot: string, count) {
        // We look if the first lot contains at least one digit.
        const caughtInitialNumber: any = firstLot.match(/\d+/g);

        if (!caughtInitialNumber) {
            throw new UserError(await this._t('The lot name must contain at least one digit.'));
        }
        // We base the serie on the last number found in the base lot.
        let initialNumber = caughtInitialNumber.slice(-1)[0];
        const padding = initialNumber.length;
        // We split the lot name to get the prefix and suffix.
        const splitted = firstLot.split(initialNumber);
        // initialNumber could appear several times, e.g. BAV023B00001S00001
        const prefix = splitted.slice(0, -1).join(initialNumber);
        const suffix = splitted[splitted.length - 1];
        initialNumber = parseInt(initialNumber);

        const lotNames = [];
        for (const i of range(0, count)) {
            lotNames.push(f('%s%s%s',
                prefix,
                String(initialNumber + i).padStart(padding, '0'),
                suffix
            ))
        }
        return lotNames;
    }

    /**
     * Return the next serial number to be attributed to the product.
     * @param company 
     * @param product 
     * @returns 
     */
    @api.model()
    async getNextSerial(company, product) {
        if (await product.tracking === "serial") {
            const lastSerial = await this.env.items('stock.production.lot').search(
                [['companyId', '=', company.id], ['productId', '=', product.id]],
                { limit: 1, order: 'id DESC' });
            if (lastSerial) {
                return (await this.env.items('stock.production.lot').generateLotNames(await lastSerial.label, 2))[1];
            }
        }
        return false;
    }

    @api.constrains('label', 'productId', 'companyId')
    async _checkUniqueLot() {
        const domain = [['productId', 'in', (await this['productId']).ids],
        ['companyId', 'in', (await this['companyId']).ids],
        ['label', 'in', await this.mapped('label')]];
        const fields = ['companyId', 'productId', 'label'];
        const groupby = ['companyId', 'productId', 'label'];
        const records = await this.readGroup(domain, fields, groupby, { lazy: false });
        const errorMessageLines = [];
        for (const rec of records) {
            if (rec['__count'] != 1) {
                const productName = await this.env.items('product.product').browse(rec['productId'][0]).displayName;
                errorMessageLines.push(await this._t(" - Product: %s, Serial Number: %s", productName, rec['label']));
            }
        }
        if (errorMessageLines.length) {
            throw new ValidationError(await this._t('The combination of serial number and product must be unique across a company.\nFollowing combination contains duplicates:\n') + errorMessageLines.join('\n'));
        }
    }

    async _domainProductId() {
        const domain = [
            "['tracking', '!=', 'none']",
            "['type', '=', 'product']",
            "'|'",
            "['companyId', '=', false]",
            "['companyId', '=', companyId]"
        ];
        if (this.env.context['default_productTemplateId']) {
            domain.unshift(f("['productTemplateId', '=', %s]", this.env.context['default_productTemplateId']));
        }
        return '[' + domain.join(', ') + ']';
    }

    async _checkCreate() {
        const activePickingId = this.env.context['activePickingId'] ?? false;
        if (activePickingId) {
            const pickingId = this.env.items('stock.picking').browse(activePickingId);
            if (pickingId.ok && ! await (await pickingId.pickingTypeId).useCreateLots) {
                throw new UserError(await this._t('You are not allowed to create a lot or serial number with this operation type. To change this, go on the operation type and tick the box "Create New Lots/Serial Numbers".'));
            }
        }
    }

    /**
     * Defines if we want to display all fields in the stock.production.lot form view.
        It will if the record exists (`id` set) or if we precised it into the context.
        This compute depends on field `name` because as it has always a default value, it'll be
        always triggered.
     */
    @api.depends('label')
    async _computeDisplayComplete() {
        for (const prodLot of this) {
            await prodLot.set('displayComplete', bool(prodLot.id) ? prodLot.id : this._context['displayComplete']);
        }
    }

    async _computeDeliveryIds() {
        const deliveryIdsByLot = await this._findDeliveryIdsByLot();
        for (const lot of this) {
            // await Promise.all([
            await lot.set('deliveryIds', await deliveryIdsByLot[lot.id]),
                await lot.set('deliveryCount', len(await lot.deliveryIds)),
                await lot.set('lastDeliveryPartnerId', false)
            // ]);
            // If lot is serial, keep track of the latest delivery's partner
            if (await (await lot.productId).tracking === 'serial' && await lot.deliveryCount > 0) {
                await lot.lot.set('lastDeliveryPartnerId', await (await (await lot.deliveryIds).sorted((item) => item['dateDone'], true))[0].partnerId);
            }
        }
    }

    @api.modelCreateMulti()
    async create(valsList) {
        this._checkCreate();
        return _super(ProductionLot, this).create(valsList);
    }

    async write(vals) {
        if ('companyId' in vals) {
            for (const lot of this) {
                if ((await lot.companyId).id != vals['companyId']) {
                    throw new UserError(await this._t("Changing the company of this record is forbidden at this point, you should rather archive it and create a new one."));
                }
            }
        }
        if ('productId' in vals && await this.some(async (lot) => vals['productId'] != (await lot.productId).id)) {
            const moveLines = await this.env.items('stock.move.line').search([['lotId', 'in', this.ids], ['productId', '!=', vals['productId']]]);
            if (moveLines.ok) {
                throw new UserError(await this._t(
                    'You are not allowed to change the product linked to a serial or lot number if some stock moves have already been created with that number. This would lead to inconsistencies in your stock.'
                ));
            }
        }
        return _super(ProductionLot, this).write(vals);
    }

    async copy(defaultValue?: any) {
        if (defaultValue == null) {
            defaultValue = {};
        }
        if (!('label' in defaultValue)) {
            defaultValue['label'] = await this._t("(copy of) %s", await this['label']);
        }
        return _super(ProductionLot, this).copy(defaultValue);
    }

    @api.depends('quantIds', 'quantIds.quantity')
    async _productQty() {
        for (const lot of this) {
            // We only care for the quants in internal or transit locations.
            const quants = await (await lot.quantIds).filtered(async (q) => {
                const locationId = await q.locationId;
                const [usage, companyId] = await locationId('usage', 'companyId');
                return usage === 'internal' || usage === 'transit' && bool(companyId);
            });
            await lot.set('productQty', sum(await quants.mapped('quantity')));
        }
    }

    async actionLotOpenQuants() {
        let self = await this.withContext({ searchDefault_lotId: this.id, create: false });
        if (await self.userHasGroups('stock.groupStockManager')) {
            self = await self.withContext({ inventoryMode: true });
        }
        return self.env.items('stock.quant')._getQuantsAction();
    }

    async actionLotOpenTransfers() {
        this.ensureOne();

        const action = {
            'resModel': 'stock.picking',
            'type': 'ir.actions.actwindow'
        }
        const [deliveryIds, displayName] = await this('deliveryIds', 'displayName');
        if (deliveryIds._length == 1) {
            update(action, {
                'viewMode': 'form',
                'resId': deliveryIds[0].id
            });
        }
        else {
            update(action, {
                'label': await this._t("Delivery orders of %s", displayName),
                'domain': [['id', 'in', deliveryIds.ids]],
                'viewMode': 'tree,form'
            });
        }
        return action;
    }

    async _findDeliveryIdsByLot() {
        const domain = [
            ['lotId', 'in', this.ids],
            ['state', '=', 'done'],
            '|', ['pickingCode', '=', 'outgoing'], ['produceLineIds', '!=', false]
        ];
        const moveLines = await this.env.items('stock.move.line').search(domain);
        const deliveryByLot = new Dict<any>();
        for (const lot of this) {
            const deliveryIds = [];
            for (const line of await moveLines.filtered(async (ml) => (await ml.lotId).id == lot.id)) {
                const [produceLineIds, pickingId] = await line('produceLineIds', 'pickingId');
                if (produceLineIds.ok) {
                    // Do the same process for lot_id contained in produce_line_ids, to fetch the end product deliveries
                    for (const deliveryIdsSet of Object.values<any>(await (await produceLineIds.lotId)._findDeliveryIdsByLot())) {
                        extend(deliveryIds, deliveryIdsSet);
                    }
                }
                else {
                    deliveryIds.push(pickingId.id);
                }
            }
            deliveryByLot[lot.id] = deliveryIds;
        }
        return deliveryByLot;
    }
}