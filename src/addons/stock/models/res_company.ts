import { Fields, api } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class Company extends Model {
    static _module = module;
    static _parents = "res.company";
    static _checkCompanyAuto = true;

    async _defaultConfirmationMailTemplate() {
        try {
            return (await this.env.ref('stock.mailTemplateDataDeliveryConfirmation')).id;
        } catch (e) {
            // except ValueError:
            return false;
        }
    }

    static internalTransitLocationId = Fields.Many2one(
        'stock.location', {
        string: 'Internal Transit Location', ondelete: "RESTRICT", checkCompany: true,
        help: "Technical field used for resupply routes between warehouses that belong to this company"
    });
    static stockMoveEmailValidation = Fields.Boolean("Email Confirmation picking", { default: false });
    static stockMailConfirmationTemplateId = Fields.Many2one('mail.template', {
        string: "Email Template confirmation picking",
        domain: "[['model', '=', 'stock.picking']]",
        default: (s) => s._defaultConfirmationMailTemplate(),
        help: "Email sent to the customer once the order is done."
    });
    static annualInventoryMonth = Fields.Selection([
        ['1', 'January'],
        ['2', 'February'],
        ['3', 'March'],
        ['4', 'April'],
        ['5', 'May'],
        ['6', 'June'],
        ['7', 'July'],
        ['8', 'August'],
        ['9', 'September'],
        ['10', 'October'],
        ['11', 'November'],
        ['12', 'December'],
    ], {
        string: 'Annual Inventory Month',
        default: '12',
        help: "Annual inventory month for products not in a location with a cyclic inventory date. Set to no month if no automatic annual inventory."
    });
    static annualInventoryDay = Fields.Integer(
        {
            string: 'Day of the month', default: 31,
            help: `Day of the month when the annual inventory should occur. If zero or negative, then the first day of the month will be selected instead.
        If greater than the last day of a month, then the last day of the month will be selected instead.`});

    /**
     * Create a transit location with companyId being the given companyId. This is needed in case of resuply routes between warehouses belonging to the same company, because we don't want to create accounting entries at that time.
     */
    async _createTransitLocation() {
        const parentLocation = await this.env.ref('stock.stockLocationLocations', false);
        for (const company of this) {
            const location = await this.env.items('stock.location').create({
                'label': await this._t('Inter-warehouse transit'),
                'usage': 'transit',
                'locationId': bool(parentLocation) && bool(parentLocation.id) && parentLocation.id || false,
                'companyId': company.id,
                'active': false
            });

            await company.write({ 'internalTransitLocationId': location.id });

            await (await (await company.partnerId).withCompany(company)).write({
                'propertyStockCustomer': location.id,
                'propertyStockSupplier': location.id,
            });
        }
    }

    async _createInventoryLossLocation() {
        const parentLocation = await this.env.ref('stock.stockLocationLocationsVirtual', false);
        for (const company of this) {
            const inventoryLossLocation = await this.env.items('stock.location').create({
                'label': 'Inventory adjustment',
                'usage': 'inventory',
                'locationId': parentLocation.id,
                'companyId': company.id,
            });
            await this.env.items('ir.property')._setDefault(
                "propertyStockInventory",
                "product.template",
                inventoryLossLocation,
                company,
            );
        }
    }

    async _createProductionLocation() {
        const parentLocation = await this.env.ref('stock.stockLocationLocationsVirtual', false);
        for (const company of this) {
            const productionLocation = await this.env.items('stock.location').create({
                'label': 'Production',
                'usage': 'production',
                'locationId': parentLocation.id,
                'companyId': company.id,
            });
            await this.env.items('ir.property')._setDefault(
                "propertyStockProduction",
                "product.template",
                productionLocation,
                company,
            );
        }
    }

    async _createScrapLocation() {
        const parentLocation = await this.env.ref('stock.stockLocationLocationsVirtual', false);
        for (const company of this) {
            await this.env.items('stock.location').create({
                'label': 'Scrap',
                'usage': 'inventory',
                'locationId': parentLocation.id,
                'companyId': company.id,
                'scrapLocation': true,
            });
        }
    }

    async _createScrapSequence() {
        const scrapVals = [];
        for (const company of this) {
            scrapVals.push({
                'label': f('%s Sequence scrap', await company.label),
                'code': 'stock.scrap',
                'companyId': company.id,
                'prefix': 'SP/',
                'padding': 5,
                'numberNext': 1,
                'numberIncrement': 1
            });
        }
        if (scrapVals.length) {
            await this.env.items('ir.sequence').create(scrapVals);
        }
    }

    /**
     * This hook is used to add a warehouse on existing companies
        when module stock is installed.
     */
    @api.model()
    async createMissingWarehouse() {
        const companyIds = await this.env.items('res.company').search([]);
        const companyWithWarehouse = await (await (await this.env.items('stock.warehouse').withContext({ activeTest: false })).search([])).mapped('companyId');
        const companyWithoutWarehouse = companyIds.sub(companyWithWarehouse);
        for (const company of companyWithoutWarehouse) {
            const [label, partnerId] = await company('label', 'partnerId');
            await this.env.items('stock.warehouse').create({
                'label': label,
                'code': label.slice(0, 5),
                'companyId': company.id,
                'partnerId': partnerId.id,
            });
        }
    }

    @api.model()
    async createMissingTransitLocation() {
        const companyWithoutTransit = await this.env.items('res.company').search([['internalTransitLocationId', '=', false]]);
        await companyWithoutTransit._createTransitLocation();
    }

    @api.model()
    async createMissingInventoryLossLocation() {
        const companyIds = await this.env.items('res.company').search([]);
        const inventoryLossProductTemplateField = await this.env.items('ir.model.fields')._get('product.template', 'propertyStockInventory');
        const companiesHavingProperty = await (await (await this.env.items('ir.property').sudo()).search([['fieldsId', '=', inventoryLossProductTemplateField.id]])).mapped('companyId');
        const companyWithoutProperty = companyIds.sub(companiesHavingProperty);
        await companyWithoutProperty._createInventoryLossLocation();
    }

    @api.model()
    async createMissingProductionLocation() {
        const companyIds = await this.env.items('res.company').search([]);
        const productionProductTemplateField = await this.env.items('ir.model.fields')._get('product.template', 'propertyStockProduction');
        const companiesHavingProperty = await (await (await this.env.items('ir.property').sudo()).search([['fieldsId', '=', productionProductTemplateField.id]])).mapped('companyId');
        const companyWithoutProperty = companyIds.sub(companiesHavingProperty);
        await companyWithoutProperty._createProductionLocation();
    }

    @api.model()
    async createMissingScrapLocation() {
        const companyIds = await this.env.items('res.company').search([]);
        const companiesHavingScrapLoc = await (await this.env.items('stock.location').search([['scrapLocation', '=', true]])).mapped('companyId');
        const companyWithoutProperty = companyIds.sub(companiesHavingScrapLoc);
        await companyWithoutProperty._createScrapLocation();
    }

    @api.model()
    async createMissingScrapSequence() {
        const companyIds = await this.env.items('res.company').search([]);
        const companyHasScrapSeq = await (await this.env.items('ir.sequence').search([['code', '=', 'stock.scrap']])).mapped('companyId');
        const companyTodoSequence = companyIds.sub(companyHasScrapSeq);
        await companyTodoSequence._createScrapSequence();
    }

    async _createPerCompanyLocations() {
        this.ensureOne();
        await this._createTransitLocation(),
        await this._createInventoryLossLocation(),
        await this._createProductionLocation(),
        await this._createScrapLocation()
    }

    async _createPerCompanySequences() {
        this.ensureOne();
        await this._createScrapSequence();
    }

    async _createPerCompanyPickingTypes() {
        this.ensureOne();
    }

    async _createPerCompanyRules() {
        this.ensureOne();
    }

    @api.model()
    async create(vals) {
        const company = await _super(Company, this).create(vals);
        const companySudo = await company.sudo();
        await companySudo._createPerCompanyLocations(),
        await companySudo._createPerCompanySequences(),
        await companySudo._createPerCompanyPickingTypes(),
        await companySudo._createPerCompanyRules()
        const label = await company.label;
        await (await this.env.items('stock.warehouse').sudo()).create({
            'label': label,
            'code': this.env.context['default_code'] ?? label.slice(0, 5),
            'companyId': company.id,
            'partnerId': (await company.partnerId).id
        })
        return company;
    }
}
