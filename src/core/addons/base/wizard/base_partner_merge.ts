import _ from "lodash";
import { DateTime } from "luxon";
import { api } from "../../..";
import { Command, Fields } from "../../../fields";
import { DefaultDict2, Dict } from "../../../helper";
import { KeyError, UserError } from "../../../helper/errors";
import { BaseModel, MetaModel, TransientModel, _super } from "../../../models";
import { _f, bool, f, isInstance, partial, update } from "../../../tools";
import { literalEval } from "../../../tools/ast";
import { chain, len, someAsync, sum } from "../../../tools/iterable";

@MetaModel.define()
class MergePartnerLine extends TransientModel {
    static _module = module;
    static _name = 'base.partner.merge.line';
    static _description = 'Merge Partner Line';
    static _order = 'minId asc';

    static wizardId = Fields.Many2one('base.partner.merge.automatic.wizard', { string: 'Wizard' });
    static minId = Fields.Integer('MinID');
    static aggrIds = Fields.Char('Ids', { required: true });
}

@MetaModel.define()
class MergePartnerAutomatic extends TransientModel {
    static _module = module;
    static _name = 'base.partner.merge.automatic.wizard';
    static _description = 'Merge Partner Wizard';

    // Group by
    static groupbyEmail = Fields.Boolean('Email');
    static groupbyName = Fields.Boolean('Name');
    static groupbyIsCompany = Fields.Boolean('Is Company');
    static groupbyVat = Fields.Boolean('VAT');
    static groupbyParentId = Fields.Boolean('Parent Company');

    static state = Fields.Selection([
        ['option', 'Option'],
        ['selection', 'Selection'],
        ['finished', 'Finished']
    ], { readonly: true, required: true, string: 'State', default: 'option' });

    static numberGroup = Fields.Integer('Group of Contacts', { readonly: true });
    static currentLineId = Fields.Many2one('base.partner.merge.line', { string: 'Current Line' });
    static lineIds = Fields.One2many('base.partner.merge.line', 'wizardId', { string: 'Lines' });
    static partnerIds = Fields.Many2many('res.partner', { string: 'Contacts' });
    static dstPartnerId = Fields.Many2one('res.partner', { string: 'Destination Contact' });

    static excludeContact = Fields.Boolean('A user associated to the contact');
    static excludeJournalItem = Fields.Boolean('Journal Items associated to the contact');
    static maximumGroup = Fields.Integer('Maximum of Group of Contacts');

    @api.model()
    async defaultGet(fields) {
        const res = await _super(MergePartnerAutomatic, this).defaultGet(fields);
        const activeIds = this.env.context['activeIds'];
        if (this.env.context['activeModel'] === 'res.partner' && len(activeIds)) {
            if (fields.includes('state'))
                res['state'] = 'selection'
            if (fields.includes('partnerIds'))
                res['partnerIds'] = [Command.set(activeIds)];
            if (fields.includes('dstPartnerId'))
                res['dstPartnerId'] = (await this._getOrderedPartner(activeIds))([-1]).id;
        }
        return res;
    }

    /**
     * return a list of many2one relation with the given table.
        @param table the name of the sql table to return relations
        @returns a list of tuple 'table name', 'column name'.
     */
    async _getFkOn(table) {
        const query = `
                SELECT cl1.relname as table, att1.attname as column
                FROM pg_constraint as con, pg_class as cl1, pg_class as cl2, pg_attribute as att1, pg_attribute as att2
                WHERE con.conrelid = cl1.oid
                    AND con.confrelid = cl2.oid
                    AND array_lower(con.conkey, 1) = 1
                    AND con.conkey[1] = att1.attnum
                    AND att1.attrelid = cl1.oid
                    AND cl2.relname = "%s"
                    AND att2.attname = 'id'
                    AND array_lower(con.confkey, 1) = 1
                    AND con.confkey[1] = att2.attnum
                    AND att2.attrelid = cl2.oid
                    AND con.contype = 'f'
            `;
        const res = await this._cr.execute(query, [table]);
        return res;
    }

    /**
     * Update all foreign key from the src_partner to dst_partner. All many2one fields will be updated.
            :param src_partners : merge source res.partner recordset (does not include destination one)
            :param dst_partner : record of destination res.partner
     * @param srcPartners 
     * @param dstPartner 
     */
    @api.model()
    async _updateForeignKeys(srcPartners, dstPartner) {
        console.debug('_updateForeignKeys for dstPartner: %s for srcPartners: %s', dstPartner.id, String(srcPartners.ids));

        // find the many2one relation to a partner
        const partner = this.env.items('res.partner');
        const relations = await this._getFkOn('resPartner');

        await this.flush();

        for (const { table, column } of relations) {
            if (table.includes('basePartnerMerge')) {  // ignore two tables
                continue;
            }

            // get list of columns of current table (exept the current fk column)
            const query = f("SELECT column_name FROM information_schema.columns WHERE table_name LIKE '%s'", table);
            const res = await this._cr.execute(query);
            const columns = [];
            for (const data of res) {
                if (data['column_name'] !== column) {
                    columns.push(data['column_name']);
                }
            }
            // do the update for the current table/column in SQL
            const queryDic = {
                'table': table,
                'column': column,
                'value': columns[0],
            }
            if (len(columns) <= 1) {
                // unique key treated
                const query = _f(`
                        UPDATE "{table}" as ___tu
                        SET "{column}" = %%s
                        WHERE
                            "{column}" = %%s AND
                            NOT EXISTS (
                                SELECT 1
                                FROM "{table}" as ___tw
                                WHERE
                                    "{column}" = %%s AND
                                    ___tu."{value}" = ___tw."{value}"
                            )`, queryDic);
                for (const partner of srcPartners) {
                    await this._cr.execute(query, [dstPartner.id, partner.id, dstPartner.id]);
                }
            }
            else {
                try {
                    // with muteLogger('verp.sql_db'), self._cr.savepoint():
                    {
                        const query = _f('UPDATE "{table}" SET "{column}" = %%s WHERE "{column}" IN (%%s)', queryDic);
                        await this._cr.execute(query, [dstPartner.id, String(srcPartners.ids) || 'NULL']);

                        // handle the recursivity with parent relation
                        if (column === partner.cls._parentName && table === 'resPartner') {
                            const query = `
                                    WITH RECURSIVE cycle(id, "parentId") AS (
                                            SELECT id, "parentId" FROM "resPartner"
                                        UNION
                                            SELECT  cycle.id, "resPartner"."parentId"
                                            FROM    "resPartner", cycle
                                            WHERE   "resPartner".id = cycle."parentId" AND
                                                    cycle.id != cycle."parentId"
                                    )
                                    SELECT id FROM cycle WHERE id = "parentId" AND id = %s
                                `;
                            await this._cr.execute(query, [dstPartner.id]);
                            // NOTE JEM : shouldn't we fetch the data ?
                        }
                    }
                } catch (e) {
                    // except psycopg2.Error:
                    // updating fails, most likely due to a violated unique constraint
                    // keeping record with nonexistent partnerId is useless, better delete it
                    const query = _f('DELETE FROM "{table}" WHERE "{column}" IN (%%s)', queryDic);
                    await this._cr.execute(query, [String(srcPartners.ids) || 'NULL']);
                }
            }
        }

        this.invalidateCache();
    }

    /**
     * Update all reference fields from the src_partner to dst_partner.
            :param srcPartners : merge source res.partner recordset (does not include destination one)
            :param dstPartner : record of destination res.partner
     * @param srcPartners 
     * @param dstPartner 
     * @returns 
     */
    @api.model()
    async _updateReferenceFields(srcPartners, dstPartner) {
        console.debug('_updateReferenceFields for dstPartner: %s for srcPartners: %r', dstPartner.id, srcPartners.ids);

        async function _updateRecords(model, src, fieldModel: string = 'model', fieldId: string = 'resId') {
            const Model = model in this.env.models ? this.env.items(model) : null;
            if (Model == null) {
                return;
            }
            const records = await (await Model.sudo()).search([[fieldModel, '=', 'res.partner'], [fieldId, '=', src.id]]);
            try {
                // with mute_logger('verp.sql_db'), self._cr.savepoint():
                await (await records.sudo()).write({ fieldId: dstPartner.id });
                await records.flush();
            } catch (e) {
                // except psycopg2.Error:
                // updating fails, most likely due to a violated unique constraint
                // keeping record with nonexistent partnerId is useless, better delete it
                await (await records.sudo()).unlink();
            }
        }

        const updateRecords = partial(_updateRecords);

        for (const partner of srcPartners) {
            updateRecords('calendar', partner, 'modelId.model');
            updateRecords('ir.attachment', partner, 'resModel');
            updateRecords('mail.followers', partner, 'resModel');
            updateRecords('mail.activity', partner, 'resModel');
            updateRecords('mail.message', partner);
            updateRecords('ir.model.data', partner);
        }

        const records = await (await this.env.items('ir.model.fields').sudo()).search([['ttype', '=', 'reference']]);
        for (const record of records) {
            let Model, field;
            try {
                Model = this.env.items(await record.model);
                if (Model == null) throw new KeyError();
                field = Model._fields[await record.label];
                if (field == null) throw new KeyError();
            } catch (e) {
                if (isInstance(e, KeyError)) {
                    // unknown model or field => skip
                    continue;
                }
                throw e;
            }

            if (Model.cls._abstract || field.compute != null) {
                continue;
            }

            for (const partner of srcPartners) {
                const label = await record.label;
                const recordsRef = await (await Model.sudo()).search([[label, '=', f('res.partner,%s', partner.id)]]);
                const values = {
                    [label]: f('res.partner,%s', dstPartner.id),
                }
                await (await recordsRef.sudo()).write(values);
            }
        }
        await this.flush();
    }

    /**
     * Returns the list of fields that should be summed when merging partners
     * @returns 
     */
    _getSummableFields() {
        return [];
    }

    /**
     * Update values of dst_partner with the ones from the src_partners.
            :param src_partners : recordset of source res.partner
            :param dst_partner : record of destination res.partner
     * @param srcPartners 
     * @param dstPartner 
     * @returns 
     */
    @api.model()
    async _updateValues(srcPartners, dstPartner) {
        console.debug('_updateValues for dstPartner: %s for srcPartners: %r', dstPartner.id, String(srcPartners.ids));

        const modelFields = (await dstPartner.fieldsGet()).keys();
        const summableFields = this._getSummableFields();

        function writeSerializer(item) {
            if (isInstance(item, BaseModel)) {
                return item.id;
            }
            else {
                return item;
            }
        }

        // get all fields that are not computed or x2many
        const values = new Dict<any>();
        const valuesByCompany = new DefaultDict2(() => new Dict<any>());   // {company: vals}
        for (const column of modelFields) {
            const field = dstPartner._fields[column];
            if (!['many2many', 'one2many'].includes(field.type) && field.compute == null) {
                for (const item of chain([...srcPartners], [dstPartner])) {
                    if (item[column]) {
                        if (summableFields.includes(column) && values.get(column)) {
                            values[column] += writeSerializer(item[column]);
                        }
                        else {
                            values[column] = writeSerializer(item[column]);
                        }
                    }
                }
            }
            else if (field.companyDependent && summableFields.includes(column)) {
                // sum the values of partners for each company; use sudo() to
                // compute the sum on all companies, including forbidden ones
                const partners = await (srcPartners.add(dstPartner)).sudo();
                for (const company of await (await this.env.items('res.company').sudo()).search([])) {
                    valuesByCompany[company][column] = sum(
                        await (await partners.withCompany(company)).mapped(column)
                    );
                }
            }
        }

        // remove fields that can not be updated (id and parentId)
        values.pop('id', null);
        const parentId = values.pop('parentId', null);
        await dstPartner.write(values);
        for (const [company, vals] of valuesByCompany.items()) {
            await (await (await dstPartner.withCompany(company)).sudo()).write(vals);
        }
        // try to update the parentId
        if (parentId && parentId != dstPartner.id) {
            try {
                await dstPartner.write({ 'parentId': parentId });
            } catch (e) {
                // except ValidationError:
                console.info('Skip recursive partner hierarchies for parentId %s of partner: %s', parentId, dstPartner.id);
            }
        }
    }

    /**
     * private implementation of merge partner
            :param partner_ids : ids of partner to merge
            :param dst_partner : record of destination res.partner
            :param extra_checks: pass false to bypass extra sanity check (e.g. email address)
     * @param partnerIds 
     * @param dstPartner 
     * @param extraChecks 
     * @returns 
     */
    async _merge(partnerIds, dstPartner?: any, extraChecks: boolean = true) {
        // super-admin can be used to bypass extra checks
        if (await this.env.isAdmin()) {
            extraChecks = false;
        }

        const partner = this.env.items('res.partner');
        partnerIds = await partner.browse(partnerIds).exists();
        if (len(partnerIds) < 2) {
            return;
        }

        if (len(partnerIds) > 3) {
            throw new UserError(await this._t("For safety reasons, you cannot merge more than 3 contacts together. You can re-open the wizard several times if needed."));
        }

        // check if the list of partners to merge contains child/parent relation
        let childIds = this.env.items('res.partner');
        for (const partnerId of partnerIds) {
            childIds = childIds.or(await partner.search([['id', 'childOf', [partnerId.id]]])).sub(partnerId);
        }
        if (partnerIds.and(childIds)) {
            throw new UserError(await this._t("You cannot merge a contact with one of his parent."));
        }

        if (extraChecks && len(new Set(await partnerIds.map(async (partner) => partner.mail))) > 1) {
            throw new UserError(await this._t("All contacts must have the same email. Only the Administrator can merge contacts with different emails."));
        }

        // remove dst_partner from partners to merge
        let srcPartners;
        if (bool(dstPartner) && partnerIds.includes(dstPartner)) {
            srcPartners = partnerIds.sub(dstPartner);
        }
        else {
            const orderedPartners = await this._getOrderedPartner(partnerIds.ids);
            dstPartner = orderedPartners[-1];
            srcPartners = orderedPartners(0, -1);
        }
        console.info("dstPartner: %s", dstPartner.id);

        // Make the company of all related users consistent with destination partner company
        const companyId = await dstPartner.companyId;
        if (companyId.ok) {
            await (await (await partnerIds.mapped('userIds')).sudo()).write({
                'companyIds': [Command.link(companyId.id)],
                'companyId': companyId.id
            });
        }

        // call sub methods to do the merge
        /*
        await this._updateForeignKeys(srcPartners, dstPartner);
        await this._updateReferenceFields(srcPartners, dstPartner);
        await this._updateValues(srcPartners, dstPartner);
    
        await this._logMergeOperation(srcPartners, dstPartner);
        */
        // delete source partner, since they are merged
        await srcPartners.unlink();
    }

    _logMergeOperation(srcPartners, dstPartner) {
        console.info('(uid = %s) merged the partners [%s] with %s', this._uid, String(srcPartners.ids), dstPartner.id);
    }
    
    // Helpers

    /**
     * Build the SQL query on res.partner table to group them according to given criteria
                 :param fields : list of column names to group by the partners
                 :param maximum_group : limit of the query
     * @param fields 
     * @param maximumGroup 
     */
    @api.model()
    async _generateQuery(fields, maximumGroup: number = 100) {
        // make the list of column to group by in sql query
        const sqlFields = [];
        for (const field of fields) {
            if (['email', 'label'].includes(field)) {
                sqlFields.push(f('lower(%s)', field));
            }
            else if (['vat'].includes(field)) {
                sqlFields.push(f("replace(%s, ' ', '')", field));
            }
            else {
                sqlFields.push(field);
            }
        }
        const groupFields = sqlFields.join(', ');

        // where clause : for given group by columns, only keep the 'not null' record
        const filters = [];
        for (const field of fields) {
            if (['email', 'label', 'vat'].includes(field)) {
                filters.push([field, 'IS NOT', 'NULL']);
            }
        }
        const criteria = filters.map(([field, operator, value]) => f('%s %s %s', field, operator, value)).join(' AND ');

        // build the query
        const text: any[] = [
            'SELECT min(id), array_agg(id)',
            'FROM "resPartner"',
        ]

        if (criteria.length) {
            text.push(f('WHERE %s', criteria));
        }

        text.push([
            f("GROUP BY %s", groupFields),
            "HAVING COUNT(*) >= 2",
            "ORDER BY min(id)",
        ])

        if (maximumGroup) {
            text.push(f("LIMIT %s", maximumGroup));
        }

        return text.join(' ');
    }
    /**
     * Returns the list of field names the partner can be grouped (as merge
        criteria) according to the option checked on the wizard
     * @returns 
     */
    @api.model()
    async _computeSelectedGroupby() {
        const groups = [];
        const groupByPrefix = 'groupby_';

        for (const fieldName of this._fields.keys()) {
            if (fieldName.startsWith(groupByPrefix)) {
                if (await this[fieldName] ?? false) {
                    groups.push(_.upperFirst(fieldName[len(groupByPrefix)]));
                }
            }
        }

        if (!groups.length) {
            throw new UserError(await this._t("You have to specify a filter for your selection."));
        }

        return groups
    }

    /**
     * Check if there is no occurence of this group of partner in the selected model
            :param aggrIds : stringified list of partner ids separated with a comma (sql arrayAgg)
            :param models : dict mapping a model name with its foreign key with resPartner table
     * @param aggrIds 
     * @param models 
     * @returns 
     */
    @api.model()
    async _partnerUseIn(aggrIds, models) {
        return someAsync(Object.entries(models), ([model, field]) => this.env.items(model).searchCount([[field, 'in', aggrIds]]));
    }

    /**
     * Helper : returns a `res.partner` recordset ordered by createdAt/active fields
      :param partnerIds : list of partner ids to sort
     * @param partnerIds 
     * @returns 
     */
    @api.model()
    async _getOrderedPartner(partnerIds) {
        const start = DateTime.fromISO('1970-01-01').toJSDate();
        const partner = this.env.items('res.partner').browse(partnerIds)
        return partner.sorted(
            async (p) => {
                let [active, date] = await p(['active', 'date']);
                date = date ?? start;
                const strDate = date.toISOString();
                return `${active}${strDate}`;
            }, true,
        );
    }

    /**
     * Compute the different models needed by the system if you want to exclude some partners.
     * @returns 
     */
    async _computeModels() {
        const modelMapping = {};
        if (await this['excludeContact']) {
            modelMapping['res.users'] = 'partnerId';
        }
        if ('account.move.line' in this.env.models && await this['excludeJournalItem']) {
            modelMapping['account.move.line'] = 'partnerId';
        }
        return modelMapping;
    }

    // Actions

    /**
     * Skip this wizard line. Don't compute any thing, and simply redirect to the new step.
     * @returns 
     */
    async actionSkip() {
        const currentLineId = await this['currentLineId'];
        if (currentLineId.ok) {
            await currentLineId.unlink();
        }
        return this._actionNextScreen();
    }

    /**
     * return the action of the next screen ; this means the wizard is set to treat the
            next wizard line. Each line is a subset of partner that can be merged together.
            If no line left, the end screen will be displayed (but an action is still returned).
     */
    async _actionNextScreen() {
        this.invalidateCache() // FIXME: is this still necessary?
        const values = {};
        const lineIds = await this['lineIds'];
        if (lineIds.ok) {
            // in this case, we try to find the next record.
            const currentLine = lineIds[0];
            const currentPartnerIds = literalEval(await currentLine.aggrIds);
            update(values, {
                'currentLineId': currentLine.id,
                'partnerIds': [Command.set(currentPartnerIds)],
                'dstPartnerId': (await this._getOrderedPartner(currentPartnerIds))[-1].id,
                'state': 'selection',
            });
        }
        else {
            update(values, {
                'currentLineId': false,
                'partnerIds': [],
                'state': 'finished',
            });
        }
        await this.write(values);

        return {
            'type': 'ir.actions.actwindow',
            'resModel': this._name,
            'resId': this.id,
            'viewMode': 'form',
            'target': 'new',
        }
    }


    /**
     * Execute the select request and write the result in this wizard
                :param query : the SQL query used to fill the wizard line
     * @param query 
     */
    async _processQuery(query) {
        this.ensureOne();
        const modelMapping = await this._computeModels();

        // group partner query
        const res = await this._cr.execute(query); // pylint: disable=sql-injection

        let counter = 0;
        for (const { minId, aggrIds } of res) {
            // To ensure that the used partners are accessible by the user
            const partners = await this.env.items('res.partner').search([['id', 'in', aggrIds]]);
            if (len(partners) < 2) {
                continue;
            }

            // exclude partner according to options
            if (bool(modelMapping) && await this._partnerUseIn(partners.ids, modelMapping)) {
                continue;
            }

            await this.env.items('base.partner.merge.line').create({
                'wizardId': this.id,
                'minId': minId,
                'aggrIds': partners.ids,
            })
            counter += 1;
        }

        await this.write({
            'state': 'selection',
            'numberGroup': counter,
        })

        console.info("counter: %s", counter);
    }
    /**
     * Start the process 'Merge with Manual Check'. Fill the wizard according to the groupby and exclude
        options, and redirect to the first step (treatment of first wizard line). After, for each subset of
        partner to merge, the wizard will be actualized.
            - Compute the selected groups (with duplication)
            - If the user has selected the 'exclude_xxx' fields, avoid the partners
     * @returns 
     */
    async actionStartManualProcess() {
        this.ensureOne();
        const groups = await this._computeSelectedGroupby();
        const query = this._generateQuery(groups, await this['maximumGroup']);
        this._processQuery(query);
        return this._actionNextScreen();
    }

    /**
     * Start the process 'Merge Automatically'. This will fill the wizard with the same mechanism as 'Merge
                  with Manual Check', but instead of refreshing wizard with the current line, it will automatically process
                  all lines by merging partner grouped according to the checked options.
     * @returns 
     */
    async actionStartAutomaticProcess() {
        this.ensureOne();
        await this.actionStartManualProcess();  // here we don't redirect to the next screen, since it is automatic process
        this.invalidateCache(); // FIXME: is this still necessary?

        for (const line of await this['lineIds']) {
            const partnerIds = literalEval(await line.aggrIds);
            await this._merge(partnerIds);
            await line.unlink();
            await this._cr.commit();//  # TODO JEM : explain why
            await this._cr.reset();
        }
        await this.write({ 'state': 'finished' });
        return {
            'type': 'ir.actions.actwindow',
            'resModel': this._name,
            'resId': this.id,
            'viewMode': 'form',
            'target': 'new',
        }
    }

    async parentMigrationProcessCb() {
        this.ensureOne();

        const query = `
                SELECT
                    min(p1.id),
                    array_agg(DISTINCT p1.id)
                FROM
                    "resPartner" as p1
                INNER join
                    "resPartner" as p2
                ON
                    p1.email = p2.email AND
                    p1.label = p2.label AND
                    (p1."parentId" = p2.id OR p1.id = p2."parentId")
                WHERE
                    p2.id IS NOT NULL
                GROUP BY
                    p1.email,
                    p1.label,
                    CASE WHEN p1."parentId" = p2.id THEN p2.id
                        ELSE p1.id
                    END
                HAVING COUNT(*) >= 2
                ORDER BY
                    min(p1.id)
            `;

        await this._processQuery(query);

        for (const line of await this['lineIds']) {
            const partnerIds = literalEval(await line.aggrIds);
            await this._merge(partnerIds);
            await line.unlink();
            await this._cr.commit();
            await this._cr.reset();
        }

        await this.write({ 'state': 'finished' });

        await this._cr.execute(`
                UPDATE
                    "resPartner"
                SET
                    "isCompany" = NULL,
                    "parentId" = NULL
                WHERE
                    "parentId" = id
            `);

        return {
            'type': 'ir.actions.actwindow',
            'resModel': this._name,
            'resId': this.id,
            'viewMode': 'form',
            'target': 'new',
        }
    }

    async actionUpdateAllProcess() {
        this.ensureOne()
        await this.parentMigrationProcessCb();

        // NOTE JEM : seems louche to create a new wizard instead of reuse the current one with updated options.
        // since it is like this from the initial commit of this wizard, I don't change it. yet ...
        const wizard = await this.create({ 'groupbyVat': true, 'groupbyEmail': true, 'groupbyName': true });
        await wizard.actionStartAutomaticProcess();

        // NOTE JEM : no idea if this query is usefull
        await this._cr.execute(`
                UPDATE
                    "resPartner"
                SET
                    "isCompany" = NULL
                WHERE
                    "parentId" IS NOT NULL AND
                    "isCompany" IS NOT NULL
            `);

        return this._actionNextScreen();
    }


    /**
     * Merge Contact button. Merge the selected partners, and redirect to the end screen (since there is no other wizard line to process.
     * @returns 
     */
    async actionMerge() {
        const partnerIds = await this['partnerIds'];
        if (!partnerIds.ok) {
            await this.write({ 'state': 'finished' });
            return {
                'type': 'ir.actions.actwindow',
                'resModel': this._name,
                'resId': this.id,
                'viewMode': 'form',
                'target': 'new',
            }
        }
        const [dstPartnerId, currentLineId] = await this('dstPartnerId', 'currentLineId');

        this._merge(partnerIds.ids, dstPartnerId);

        if (currentLineId.ok) {
            await currentLineId.unlink();
        }

        return this._actionNextScreen();
    }
}