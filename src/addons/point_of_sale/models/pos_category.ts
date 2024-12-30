import { Fields, api } from "../../../core";
import { UserError, ValidationError } from "../../../core/helper";
import { MetaModel, Model } from "../../../core/models"
import { bool } from "../../../core/tools";

@MetaModel.define()
class PosCategory extends Model {
    static _module = module;
    static _name = "pos.category";
    static _description = "Point of Sale Category";
    static _order = "sequence, label";

    @api.constrains('parentId')
    async _checkCategoryRecursion() {
        if (! await this._checkRecursion()) {
            throw new ValidationError(await this._t('Error ! You cannot create recursive categories.'));
        }
    }

    static label = Fields.Char({string: 'Category Name', required: true, translate: true});
    static parentId = Fields.Many2one('pos.category', {string: 'Parent Category', index: true});
    static childId = Fields.One2many('pos.category', 'parentId', {string: 'Children Categories'});
    static sequence = Fields.Integer({help: "Gives the sequence order when displaying a list of product categories."});
    static image128 = Fields.Image("Image", {maxWidth: 128, maxHeight: 128});

    async nameGet() {
        async function getNames(cat) {
            const res = [];
            while (bool(cat)) {
                res.push(await cat.label);
                cat = await cat.parentId;
            }
            return res;
        }
        const res = [];
        for (const cat of this) {
            res.push([cat.id, (await getNames(cat)).reverse().join(' / ')]);
        }
        return res;
    }

    @api.ondelete(false)
    async _unlinkExceptSessionOpen() {
        if (await this.searchCount([['id', 'in', this.ids]])) {
            if (await (await this.env.items('pos.session').sudo()).searchCount([['state', '!=', 'closed']])) {
                throw new UserError(await this._t('You cannot delete a point of sale category while a session is still opened.'));
            }
        }
    }
}