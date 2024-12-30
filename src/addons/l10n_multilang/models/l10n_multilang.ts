import _ from "lodash";
import { DefaultDict2, Dict } from "../../../core/helper/collections";
import { MetaModel, Model, TransientModel, _super } from "../../../core/models";
import { bool, stringPart } from "../../../core/tools";

@MetaModel.define()
class AccountChartTemplate extends Model {
    static _module = module;
    static _parents = 'account.chart.template';

    async _load(saleTaxRate, purchaseTaxRate, company) {
        const res = await _super(AccountChartTemplate, this)._load(saleTaxRate, purchaseTaxRate, company);
        // Copy chart of account translations when loading chart of account
        for (const chartTemplate of await this.filtered('spokenLanguages')) {
            const externalId = await this.env.items('ir.model.data').search([
                ['model', '=', 'account.chart.template'],
                ['resId', '=', chartTemplate.id],
            ], {order: 'id', limit: 1});
            const mod = externalId.ok && await this.env.ref('base.module_' + await externalId.module);
            if (mod.ok && await mod.state === 'installed') {
                const langs = await chartTemplate._getLangs();
                if (bool(langs)) {
                    await chartTemplate._processSingleCompanyCoaTranslations(company.id, langs);
                }
            }
        }
        return res;
    }

    /**
     * This method copies translations values of templates into new Accounts/Taxes/Journals for languages selected

        :param langs: List of languages to load for new records
        :param in_field: Name of the translatable field of source templates
        :param in_ids: Recordset of ids of source object
        :param out_ids: Recordset of ids of destination object

        :return: true
     * @param langs 
     * @param inField 
     * @param inIds 
     * @param outIds 
     */
    async processTranslations(langs, inField, inIds, outIds) {
        const xlatObj = this.env.items('ir.translation');
        //find the source from Account Template
        for (const lang of langs) {
            //find the value from Translation
            const value = await xlatObj._getIds(inIds._name + ',' + inField, 'model', lang, inIds.ids);
            let counter = 0;
            for (const element of await inIds.withContext({lang: null})) {
                if (bool(value[element.id])) {
                    //copy Translation from Source to Destination object
                    await xlatObj._setIds(
                        outIds._name + ',' + inField,
                        'model',
                        lang,
                        (await outIds[counter]).ids,
                        value[element.id],
                        await element[inField]
                    )
                }
                else {
                    console.info('Language: %s. Translation from template: there is no translation available for %s!', lang, await element[inField]);
                }
                counter += 1
            }
        }
        return true;
    }

    async processCoaTranslations() {
        const companyObj = this.env.items('res.company');
        for (const chartTemplateId of this) {
            const langs = await chartTemplateId._getLangs();
            if (bool(langs)) {
                const companyIds = await companyObj.search([['chartTemplateId', '=', chartTemplateId.id]]);
                for (const company of companyIds) {
                    await chartTemplateId._processSingleCompanyCoaTranslations(company.id, langs);
                }
            }
        }
        return true;
    }

    async _processSingleCompanyCoaTranslations(companyId, langs) {
        // write account.account translations in the real COA
        await this._processAccountsTranslations(companyId, langs, 'label');
        // write account.group translations
        await this._processAccountGroupTranslations(companyId, langs, 'label');
        // copy account.tax name translations
        await this._processTaxesTranslations(companyId, langs, 'label');
        // copy account.tax description translations
        await this._processTaxesTranslations(companyId, langs, 'description');
        // copy account.fiscal.position translations
        await this._processFiscalPosTranslations(companyId, langs, 'label');
    }

    async _getLangs() {
        const spokenLanguages = await this['spokenLanguages'];
        if (! spokenLanguages) {
            return [];
        }

        const installedLangs = new Dict(await this.env.items('res.lang').getInstalled());
        const langs = [];
        for (const lang of spokenLanguages.split(';')) {
            if (!(lang in installedLangs)) {
                // the language is not installed, so we don't need to load its translations
                continue;
            }
            else {
                langs.push(lang);
            }
        }
        return langs;
    }

    async _processAccountsTranslations(companyId, langs, field) {
        const [inIds, outIds] = await this._getTemplateFromModel(companyId, 'account.account');
        return this.processTranslations(langs, field, inIds, outIds);
    }

    async _processAccountGroupTranslations(companyId, langs, field) {
        const [inIds, outIds] = await this._getTemplateFromModel(companyId, 'account.group');
        return this.processTranslations(langs, field, inIds, outIds);
    }

    async _processTaxesTranslations(companyId, langs, field) {
        const [inIds, outIds] = await this._getTemplateFromModel(companyId, 'account.tax');
        return this.processTranslations(langs, field, inIds, outIds);
    }

    async _processFiscalPosTranslations(companyId, langs, field) {
        const [inIds, outIds] = await this._getTemplateFromModel(companyId, 'account.fiscal.position');
        return this.processTranslations(langs, field, inIds, outIds);
    }

    /**
     * Find the records and their matching template
     * @param companyId 
     * @param model 
     * @returns 
     */
    async _getTemplateFromModel(companyId, model) {
        // generated records have an external id with the format <company id>_<template xml id>
        const groupedOutData = new DefaultDict2(() => this.env.items('ir.model.data'));
        for (const imd of await this.env.items('ir.model.data').search([
                ['model', '=', model],
                ['label', '=like', String(companyId) + '_%']
            ])) {
            const mod = await imd.module;
            groupedOutData[mod] = groupedOutData[mod].add(imd);
        }

        let inRecords = this.env.items(model + '.template');
        let outRecords = this.env.items(model);
        for (const [module, outData] of groupedOutData) {
            // templates and records may have been created in a different order
            // reorder them based on external id names
            const expectedInXmlidNames = Object.fromEntries(await outData.map(async (xmlid) => [stringPart(await xmlid.label, String(companyId) + '_').slice(-1)[0], xmlid]));

            let inXmlids = await this.env.items('ir.model.data').search([
                ['model', '=', model + '.template'],
                ['module', '=', module],
                ['label', 'in', Object.keys(expectedInXmlidNames)]
            ]);
            inXmlids = Object.fromEntries(await inXmlids.map(async (xmlid) => [await xmlid.label, xmlid]));

            for (const [label, xmlid] of Object.entries(expectedInXmlidNames)) {
                // ignore nonconforming customized data
                if (!(label in inXmlids)) {
                    continue;
                }
                inRecords = inRecords.add(this.env.items(model + '.template').browse(await inXmlids[label].resId));
                outRecords = outRecords.add(this.env.items(model).browse(await xmlid.resId));
            }
        }

        return [inRecords, outRecords];
    }
}

/**
 * Install Language
 */
@MetaModel.define()
class BaseLanguageInstall extends TransientModel {
    static _module = module;
    static _parents = "base.language.install";

    async langInstall() {
        this.ensureOne();
        const alreadyInstalled = (await this.env.items('res.lang').getInstalled()).map(([code]) => code).includes(await this['lang']);
        const res = await _super(BaseLanguageInstall, this).langInstall();
        if (alreadyInstalled) {
            // update of translations instead of new installation
            // skip to avoid duplicating the translations
            return res;
        }

        // CoA in multilang mode
        for (const coa of await this.env.items('account.chart.template').search([['spokenLanguages', '!=', false]])) {
            const lang = await this['lang'];
            if ((await coa.spokenLanguages).split(';').includes(lang)) {
                // companies on which it is installed
                for (const company of await this.env.items('res.company').search([['chartTemplateId', '=', coa.id]])) {
                    // write account.account translations in the real COA
                    await coa._processAccountsTranslations(company.id, [lang], 'label');
                    // write account.group translations
                    await coa._processAccountGroupTranslations(company.id, [lang], 'label');
                    // copy account.tax name translations
                    await coa._processTaxesTranslations(company.id, [lang], 'label');
                    // copy account.tax description translations
                    await coa._processTaxesTranslations(company.id, [lang], 'description');
                    // copy account.fiscal.position translations
                    await coa._processFiscalPosTranslations(company.id, [lang], 'label');
                }
            }
        }
        return res;
    }
}