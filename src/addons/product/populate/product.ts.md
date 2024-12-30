import { DefaultDict, Dict } from "../../../verp/helper/collections";
import { MetaModel, Model, _super } from "../../../verp/models"
import { choice, enumerate, len } from "../../../verp/tools/iterable";
import { constant } from "../../../verp/tools/populate";

@MetaModel.define()
class ProductCategory extends Model {
    static _module = module;
    static _parents = "product.category";
    
    get _populateSizes() {
        return {"small": 50, "medium": 500, "large": 5000};
    }

    async _populateFactories() {
        return [["label", constant('PC_{counter}')]];
    }

    async _populate(size) {
        const categories = await _super(ProductCategory, this)._populate(size);
        // Set parent/child relation
        this._populateSetParents(categories, size);
        return categories;
    }

    async _populateSetParents(categories, size) {
        console.info('Set parent/child relation of product categories');
        const parentIds = [];
        // const rand = Random('product.category+parent_generator');

        for (const category of categories) {
            if (Math.random() < 0.25) {
                parentIds.push(category.id);
            }
        }
        categories.sub(this.browse(parentIds));  // Avoid recursion in parent-child relations.
        const parentChilds = new DefaultDict2(() => this.env.items('product.category'))
        for (const category of categories) {
            if (Math.random() < 0.25) { // 1/4 of remaining categories have a parent.
                const key = choice(parentIds);
                parentChilds[key] = parentChilds[key].or(category);
            }
        }
        for (const [count, [parent, children]] of enumerate(parentChilds.items())) {
            if ((count + 1) % 1000 == 0) {
                console.info('Setting parent: %s/%s', count + 1, len(parentChilds))
            }
            await children.write({'parentId': parent})
        }
    }
}

class ProductProduct extends Model {
    static _parents = "product.product"
    
    static get _populateSizes() {
        return {"small": 150, "medium": 5000, "large": 50000}
    }

    static get _populateDependencies() {
        return ['product.category'];
    }

    static get _populateGetTypes() {
        return [["consu", "service"], [2, 1]];
    }

    _populateGetProductFactories() {
        const categoryIds = this.env.registry.populatedModels["product.category"];
        types, types_distribution = self._populate_get_types()

        def get_rand_float(values, counter, random):
            return random.randrange(0, 1500) * random.random()

        # TODO sale & purchase uoms

        return [
            ("sequence", populate.randomize([false] + [i for i in range(1, 101)])),
            ("active", populate.randomize([true, false], [0.8, 0.2])),
            ("type", populate.randomize(types, types_distribution)),
            ("categId", populate.randomize(categoryIds)),
            ("listPrice", populate.compute(get_rand_float)),
            ("standardPrice", populate.compute(get_rand_float)),
        ]
    }

    def _populate_factories() {
        return [
            ("name", populate.constant('product_product_name_{counter}')),
            ("description", populate.constant('product_product_description_{counter}')),
            ("default_code", populate.constant('PP-{counter}')),
            ("barcode", populate.constant('BARCODE-PP-{counter}')),
        ] + self._populate_get_product_factories()
}

class SupplierInfo extends Model {
    _parents = 'product.supplierinfo'

    _populate_sizes = {'small': 450, 'medium': 15_000, 'large': 180_000}
    _populate_dependencies = ['res.partner', 'product.product', 'product.template']

    def _populate_factories() {
        random = populate.Random('product_with_supplierinfo')
        companyIds = self.env.registry.populated_models['res.company'][:COMPANY_NB_WITH_STOCK] + [false]
        partnerIds = self.env.registry.populated_models['res.partner']
        product_templates_ids = self.env.items('product.product'].browse(self.env.registry.populated_models['product.product']).productTemplateId.ids
        product_templates_ids += self.env.registry.populated_models['product.template']
        product_templates_ids = random.sample(product_templates_ids, int(len(product_templates_ids) * 0.95))

        def get_company_id(values, counter, random):
            partner = self.env.items('res.partner'].browse(values['name'])
            if partner.companyId :
                return partner.companyId.id
            return random.choice(companyIds)

        def get_delay(values, counter, random):
            # 5 % with huge delay (between 5 month and 6 month), otherwise between 1 and 10 days
            if random.random() > 0.95:
                return random.randint(150, 210)
            return random.randint(1, 10)

        return [
            ('name', populate.randomize(partnerIds)),
            ('companyId', populate.compute(get_company_id)),
            ('productTemplateId', populate.iterate(product_templates_ids)),
            ('productName', populate.constant("SI-{counter}")),
            ('sequence', populate.randint(1, 10)),
            ('min_qty', populate.randint(0, 10)),
            ('price', populate.randint(10, 100)),
            ('delay', populate.compute(get_delay)),
        ]
    }
