import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { Dict } from "../../../core/helper/collections";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, Model, _super, isSubclass } from "../../../core/models";
import { quoteList } from "../../../core/tools";

@MetaModel.define()
class IrModel extends Model {
    static _module = module;
    static _parents = 'ir.model';
    static _order = 'isMailThread DESC, label ASC';

    static isMailThread = Fields.Boolean({
        string: "Mail Thread", default: false,
        help: "Whether this model supports messages and notifications.",
    })
    static isMailActivity = Fields.Boolean({
        string: "Mail Activity", default: false,
        help: "Whether this model supports activities.",
    })
    static isMailBlacklist = Fields.Boolean({
        string: "Mail Blacklist", default: false,
        help: "Whether this model supports blacklist.",
    })

    /**
     * Delete mail data (followers, messages, activities) associated with the models being deleted.
     * @returns 
     */
    async unlink() {
        const cr = this.env.cr;

        const mailModels = await this.search([
            ['model', 'in', ['mail.activity', 'mail.activity.type', 'mail.followers', 'mail.message']]
        ], {order: 'id'});

        if (!this.and(mailModels).ok) {
            const models = quoteList(await this.mapped('model'));
            const modelIds = this.ids;

            let query = 'DELETE FROM "mailActivity" WHERE "resModelId" IN (%s)';
            await cr.execute(query, [modelIds.join(',')]);

            query = 'DELETE FROM "mailActivityType" WHERE "resModel" IN (%s)';
            await cr.execute(query, [models]);

            query = 'DELETE FROM "mailFollowers" WHERE "resModel" IN (%s)';
            await cr.execute(query, [models]);

            query = 'DELETE FROM "mailMessage" WHERE model in (%s)'
            await cr.execute(query, [models]);
        }

        // Get files attached solely to the models being deleted (and none other)
        const models = quoteList(await this.mapped('model'));
        let query = `
            SELECT DISTINCT storefname
            FROM "irAttachment"
            WHERE "resModel" IN (%s)
            EXCEPT
            SELECT storefname
            FROM "irAttachment"
            WHERE "resModel" not IN (%s);
        `;
        const fnames = await cr.execute(query, [models, models]);

        query = 'DELETE FROM "irAttachment" WHERE "resModel" in (%s)';
        await cr.execute(query, [models]);

        for (const fname of fnames) {
            await this.env.items('ir.attachment')._fileDelete(fname['storefname']);
        }
        return _super(IrModel, this).unlink();
    }

    async write(vals) {
        let res;
        if (this.ok && ('isMailThread' in vals || 'isMailActivity' in vals || 'isMailBlacklist' in vals)) {
            if ((await this.filtered(async rec => await rec.state !== 'manual'))._length) {
                throw new UserError(await this._t('Only custom models can be modified.'));
            }
            if ('isMailThread' in vals && (await this.filtered(async rec => await rec.isMailThread > vals['isMailThread']))._length) {
                throw new UserError(await this._t('Field "Mail Thread" cannot be changed to "false".'));
            }
            if ('isMailActivity' in vals && (await this.filtered(async rec => await rec.isMailActivity > vals['isMailActivity']))._length) {
                throw new UserError(await this._t('Field "Mail Activity" cannot be changed to "false".'));
            }
            if ('isMailBlacklist' in vals && (await this.filtered(async rec => await rec.isMailBlacklist > vals['isMailBlacklist']))._length) {
                throw new UserError(await this._t('Field "Mail Blacklist" cannot be changed to "false".'));
            }
            res = await _super(IrModel, this).write(vals);
            await this.flush();
            // setup models; this reloads custom models in registry
            await this.pool.setupModels(this._cr);
            // update database schema of models
            const models = this.pool.descendants(await this.mapped('model'), '_inherits');
            await this.pool.initModels(this._cr, Array.from(models), new Dict({...this._context, updateCustomFields: true}));
        }
        else {
            res = await _super(IrModel, this).write(vals);
        }
        return res;
    }

    _reflectModelParams(cls) {
        const vals = _super(IrModel, this)._reflectModelParams(cls);
        const model = this.env.items(cls._name);
        vals['isMailThread'] = isSubclass(model, this.pool.models['mail.thread']);
        vals['isMailActivity'] = isSubclass(model, this.pool.models['mail.activity.mixin']);
        vals['isMailBlacklist'] = isSubclass(model, this.pool.models['mail.thread.blacklist']);
        return vals;
    }

    @api.model()
    async _instanciate(modelData) {
        const modelClass = await _super(IrModel, this)._instanciate(modelData);
        if (modelData['isMailThread'] && modelClass._name !== 'mail.thread') {
            let parents = modelClass._parents ?? [];
            parents = typeof(parents) === 'string' ? [parents] : parents;
            modelClass._parents = parents.concat(['mail.thread']);
        }
        if (modelData['isMailActivity'] && modelClass._name !== 'mail.activity.mixin') {
            let parents = modelClass._parents ?? [];
            parents = typeof(parents) === 'string' ? [parents] : parents;
            modelClass._parents = parents.concat(['mail.activity.mixin']);
        }
        if (modelData['isMailBlacklist'] && modelClass._name !== 'mail.thread.blacklist') {
            let parents = modelClass._parents ?? [];
            parents = typeof(parents) === 'string' ? [parents] : parents;
            modelClass._parents = parents.concat(['mail.thread.blacklist']);
        }
        return modelClass;
    }
}