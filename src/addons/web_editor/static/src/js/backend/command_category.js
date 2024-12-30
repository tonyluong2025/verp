/** @verp-module **/

import { registry } from "@web/core/registry";

const commandCategoryRegistry = registry.category("commandCategories");
commandCategoryRegistry.add("shortcutConflict", {}, { sequence: 5 });
