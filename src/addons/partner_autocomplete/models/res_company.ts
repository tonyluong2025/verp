import { Fields, api } from "../../../core";
import { getattr } from "../../../core/api/func";
import { Dict } from "../../../core/helper/collections";
import { MetaModel, Model, _super } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { isInstance } from "../../../core/tools/func";
import { isList } from "../../../core/tools/iterable";
import { emailDomainExtract, urlDomainExtract } from "../../../core/tools/mail";
import { pop, update } from "../../../core/tools/misc";
import { _MAIL_DOMAIN_BLACKLIST } from "../../iap/tools/iap_tools";

const COMPANY_AC_TIMEOUT = 5

@MetaModel.define()
class ResCompany extends Model {
    static _module = module;
    static _name = 'res.company';
    static _parents = 'res.company';

    static partnerGid = Fields.Integer('Company database ID', { related: "partnerId.partnerGid", inverse: "_inversePartnerGid", store: true });
    static iapEnrichAutoDone = Fields.Boolean('Enrich Done');

    async _inversePartnerGid() {
        for (const company of this) {
            await (await company.partnerId).set('partnerGid', await company.partnerGid);
        }
    }

    @api.modelCreateMulti()
    async create(valsList) {
        const res = await _super(ResCompany, this).create(valsList);
        if (!getattr(this.env, 'testing', false)) {
            await res.iapEnrichAuto();
        }
        return res;
    }

    /**
     * Enrich company. This method should be called by automatic processes
        and a protection is added to avoid doing enrich in a loop.
     * @returns 
     */
    async iapEnrichAuto() {
        if (await (await this.env.user())._isSystem()) {
            for (const company of await this.filtered(async (company) => ! await company.iapEnrichAutoDone)) {
                await company._enrich();
            }
            await this.set('iapEnrichAutoDone', true);
        }
        return true;
    }

    /**
     * This method calls the partner autocomplete service from IAP to enrich
        partner related fields of the company.

        :return bool: either done, either failed
     * @returns 
     */
    async _enrich() {
        this.ensureOne();
        console.info("Starting enrich of company %s (%s)", await this['label'], this.id);

        const companyDomain = await this._getCompanyDomain();
        if (!companyDomain) {
            return false;
        }

        let companyData = await this.env.items('res.partner').enrichCompany(companyDomain, false, await this['vat'], COMPANY_AC_TIMEOUT);
        if (companyData['error']) {
            return false;
        }
        const additionalData = pop(companyData, 'additionalInfo', false);

        // Keep only truthy values that are not already set on the target partner
        // Erase image1920 even if something is in it. Indeed as partner_autocomplete is probably installed as a
        // core app (mail -> iap -> partner_autocomplete auto install chain) it is unlikely that people already
        // updated their company logo.
        await this.env.items('res.partner')._iapReplaceLogo(companyData);
        const partnerId = await this['partnerId'];
        companyData = new Dict();
        for (const [field, value] of Object.entries(companyData)) {
            if (field in partnerId._fields && bool(value) && (field === 'image1920' || !bool(await (partnerId[field])))) {
                companyData[field] = value;
            }
        }

        // for company and childs: from stateId / countryId nameGet like to IDs
        update(companyData, await this._enrichExtractM2oId(companyData, ['stateId', 'countryId']));
        if (companyData['childIds']) {
            companyData['childIds'] = await Promise.all(companyData['childIds'].map(async (childData) => Object.assign({}, childData, ...(await this._enrichExtractM2oId(childData, ['stateId', 'countryId'])))));
        }

        // handle o2m values, e.g. {'bankIds': ['accNumber': 'BE012012012', 'accHolderName': 'MyWebsite']}
        await this._enrichReplaceO2mCreation(companyData);

        await partnerId.write(companyData);

        if (bool(additionalData)) {
            const templateValues = JSON.parse(additionalData);
            templateValues['flavorText'] = await this._t("Company auto-completed by Verp Partner Autocomplete Service");
            await partnerId.messagePostWithView(
                'iap_mail.enrichCompany', {
                values: templateValues,
                subtypeId: (await this.env.ref('mail.mtNote')).id,
            });
        }
        return true;
    }

    /**
     * Extract m2O ids from data (because of res.partner._formatDataCompany)
     * @param iapData 
     * @param m2oFields 
     * @returns 
     */
    async _enrichExtractM2oId(iapData, m2oFields) {
        const extractedData = new Dict();
        for (const m2oField of m2oFields) {
            const relationData = iapData[m2oField];
            if (bool(relationData) && isInstance(relationData, Dict)) {
                extractedData[m2oField] = relationData['id'] || false;
            }
        }
        return extractedData;
    }

    async _enrichReplaceO2mCreation(iapData) {
        for (const [o2mField, values] of Object.entries<any>(iapData)) {
            if (isList(values)) {
                const commands = values.filter(createValue => isInstance(createValue, Dict)).map(createValue => [0, 0, createValue]);
                if (commands.length) {
                    iapData[o2mField] = commands;
                }
                else {
                    pop(iapData, o2mField, null);
                }
            }
        }
        return iapData;
    }

    /**
     * Extract the company domain to be used by IAP services.
        The domain is extracted from the website or the email information.
        e.g:
            - www.info.proximus.be -> proximus.be
            - info@proximus.be -> proximus.be
     */
    async _getCompanyDomain() {
        this.ensureOne();

        const email = await this['email'];
        let companyDomain = email ? emailDomainExtract(email) : false;
        if (companyDomain && !_MAIL_DOMAIN_BLACKLIST.has(companyDomain)) {
            return companyDomain;
        }

        const website = await this['website'];
        companyDomain = website ? urlDomainExtract(website) : false;
        if (!companyDomain || ['localhost', 'example.com'].includes(companyDomain)) {
            return false;
        }

        return companyDomain;
    }
}