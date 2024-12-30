/** @verp-module **/

import { registry } from "@web/core/registry";
import { session } from "@web/session";

export const companyAutocompleteService = {
    dependencies: ["orm", "company"],

    start(env, { orm, company }) {
        if (session.iapCompanyEnrich) {
            const currentCompanyId = company.currentCompany.id;
            orm.silent.call("res.company", "iapEnrichAuto", [currentCompanyId], {});
        }
    },
};

registry
    .category("services")
    .add("partner_autocomplete.companyAutocomplete", companyAutocompleteService);
