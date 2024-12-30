/** @verp-module **/

import { registry } from "@web/core/registry";
import { _lt } from "@web/core/l10n/translation";

const commandCategoryRegistry = registry.category("commandCategories");
commandCategoryRegistry.add("mail", {}, { sequence: 20 });
