/** @verp-module **/

import { hotkeyService } from "@web/core/hotkeys/hotkey_service";
import { notificationService } from "@web/core/notifications/notification_service";
import { ormService } from "@web/core/orm_service";
import { registry } from "@web/core/registry";
import { CustomFavoriteItem } from "@web/search/favorite_menu/custom_favorite_item";
import { WithSearch } from "@web/search/with_search/with_search";
import { viewService } from "@web/views/view_service";
import { actionService } from "@web/webclient/actions/action_service";
import { registerCleanup } from "../helpers/cleanup";
import { makeTestEnv } from "../helpers/mock_env";
import { click, getFixture, mouseEnter, triggerEvent } from "../helpers/utils";

const serviceRegistry = registry.category("services");
const favoriteMenuRegistry = registry.category("favoriteMenu");

const { Component, mount } = owl;

export const setupControlPanelServiceRegistry = () => {
    serviceRegistry.add("action", actionService);
    serviceRegistry.add("hotkey", hotkeyService);
    serviceRegistry.add("notification", notificationService);
    serviceRegistry.add("orm", ormService);
    serviceRegistry.add("view", viewService);
};

export const setupControlPanelFavoriteMenuRegistry = () => {
    favoriteMenuRegistry.add(
        "custom-favorite-item",
        { Component: CustomFavoriteItem, groupNumber: 3 },
        { sequence: 0 }
    );
};

export const makeWithSearch = async (params) => {
    const props = { ...params };

    const serverData = props.serverData || undefined;
    const mockRPC = props.mockRPC || undefined;
    const config = props.config || {};

    delete props.serverData;
    delete props.mockRPC;
    delete props.config;

    const env = await makeTestEnv({ serverData, mockRPC, config });

    const target = getFixture();
    const withSearch = await mount(WithSearch, { env, props, target });

    registerCleanup(() => withSearch.destroy());

    const component = Object.values(withSearch.__owl__.children)[0];

    return component;
};

const getNode = (target) => {
    return target instanceof Component ? target.el : target;
};

const findItem = (target, selector, finder = 0) => {
    const el = getNode(target);
    const elems = [...el.querySelectorAll(selector)];
    if (Number.isInteger(finder)) {
        return elems[finder];
    }
    return elems.find((el) => el.innerText.trim().toLowerCase() === finder.toLowerCase());
};

/** Menu (generic) */

export const toggleMenu = async (el, menuFinder) => {
    const menu = findItem(el, `.dropdown button.dropdown-toggle`, menuFinder);
    await click(menu);
};

export const toggleMenuItem = async (el, itemFinder) => {
    const item = findItem(el, `.o-menu-item`, itemFinder);
    if (item.classList.contains("dropdown-toggle")) {
        await mouseEnter(item);
    } else {
        await click(item);
    }
};
export const toggleMenuItemOption = async (el, itemFinder, optionFinder) => {
    const item = findItem(el, `.o-menu-item`, itemFinder);
    const option = findItem(item.parentNode, ".o-item-option", optionFinder);
    if (option.classList.contains("dropdown-toggle")) {
        await mouseEnter(option);
    } else {
        await click(option);
    }
};
export const isItemSelected = (el, itemFinder) => {
    const item = findItem(el, `.o-menu-item`, itemFinder);
    return item.classList.contains("selected");
};
export const isOptionSelected = (el, itemFinder, optionFinder) => {
    const item = findItem(el, `.o-menu-item`, itemFinder);
    const option = findItem(item.parentNode, ".o-item-option", optionFinder);
    return option.classList.contains("selected");
};
export const getMenuItemTexts = (target) => {
    const el = getNode(target);
    return [...el.querySelectorAll(`.dropdown ul .o-menu-item`)].map((e) => e.innerText.trim());
};

/** Filter menu */

export const toggleFilterMenu = async (el) => {
    await click(findItem(el, `.o-filter-menu button.dropdown-toggle`));
};

export const toggleAddCustomFilter = async (el) => {
    await mouseEnter(findItem(el, `.o-add-custom-filter-menu .dropdown-toggle`));
};

export const editConditionField = async (el, index, fieldName) => {
    const condition = findItem(el, `.o-filter-condition`, index);
    const select = findItem(condition, "select", 0);
    select.value = fieldName;
    await triggerEvent(select, null, "change");
};

export const editConditionOperator = async (el, index, operator) => {
    const condition = findItem(el, `.o-filter-condition`, index);
    const select = findItem(condition, "select", 1);
    select.value = operator;
    await triggerEvent(select, null, "change");
};

export const editConditionValue = async (el, index, value, valueIndex = 0) => {
    const condition = findItem(el, `.o-filter-condition`, index);
    const target = findItem(
        condition,
        ".o-generator-menu-value input,.o-generator-menu-value select",
        valueIndex
    );
    target.value = value;
    await triggerEvent(target, null, "change");
};

export const applyFilter = async (el) => {
    await click(findItem(el, `.o-add-custom-filter-menu .dropdown-menu button.o-apply-filter`));
};

export const addCondition = async (el) => {
    await click(findItem(el, `.o-add-custom-filter-menu .dropdown-menu button.o-add-condition`));
};

export async function removeCondition(el, index) {
    const condition = findItem(el, `.o-filter-condition`, index);
    await click(findItem(condition, ".o-generator-menu-delete"));
}

/** Group by menu */

export const toggleGroupByMenu = async (el) => {
    await click(findItem(el, `.o-group-by-menu .dropdown-toggle`));
};

export const toggleAddCustomGroup = async (el) => {
    await mouseEnter(findItem(el, `.o-add-custom-group-menu .dropdown-toggle`));
};

export const selectGroup = async (el, fieldName) => {
    const select = findItem(el, `.o-add-custom-group-menu .dropdown-menu select`);
    select.value = fieldName;
    await triggerEvent(select, null, "change");
};

export const applyGroup = async (el) => {
    await click(findItem(el, `.o-add-custom-group-menu .dropdown-menu .btn`));
};

/** Favorite menu */

export const toggleFavoriteMenu = async (el) => {
    await click(findItem(el, `.o-favorite-menu .dropdown-toggle`));
};

export const deleteFavorite = async (el, favoriteFinder) => {
    const favorite = findItem(el, `.o-favorite-menu .o-menu-item`, favoriteFinder);
    await click(findItem(favorite, "i.fa-trash-o"));
};

export const toggleSaveFavorite = async (el) => {
    await mouseEnter(findItem(el, `.o-favorite-menu .o-add-favorite .dropdown-toggle`));
};

export const editFavoriteName = async (el, name) => {
    const input = findItem(
        el,
        `.o-favorite-menu .o-add-favorite .dropdown-menu input[type="text"]`
    );
    input.value = name;
    await triggerEvent(input, null, "input");
};

export const saveFavorite = async (el) => {
    await click(findItem(el, `.o-favorite-menu .o-add-favorite .dropdown-menu button`));
};

/** Comparison menu */

export const toggleComparisonMenu = async (el) => {
    await click(findItem(el, `.o-comparison-menu button.dropdown-toggle`));
};

/** Search bar */

export const getFacetTexts = (target) => {
    const el = getNode(target);
    return [...el.querySelectorAll(`div.o-searchview-facet`)].map((facet) =>
        facet.innerText.trim()
    );
};

export const removeFacet = async (el, facetFinder = 0) => {
    const facet = findItem(el, `div.o-searchview-facet`, facetFinder);
    await click(facet.querySelector("i.o-facet-remove"));
};

export const editSearch = async (el, value) => {
    const input = findItem(el, `.o-searchview input`);
    input.value = value;
    await triggerEvent(input, null, "input");
};

export const validateSearch = async (el) => {
    const input = findItem(el, `.o-searchview input`);
    await triggerEvent(input, null, "keydown", { key: "Enter" });
};

/** Switch View */

export const switchView = async (el, viewType) => {
    await click(findItem(el, `button.o-switch-view.o-${viewType}`));
};

/////////////////////////////////////
// Action Menu
/////////////////////////////////////
// /**
//  * @param {EventTarget} el
//  * @param {string} [menuFinder="Action"]
//  * @returns {Promise}
//  */
// export async function toggleActionMenu(el, menuFinder = "Action") {
//     const dropdown = findItem(el, `.o-cp-action-menus button`, menuFinder);
//     await click(dropdown);
// }
/////////////////////////////////////
// Pager
/////////////////////////////////////
// /**
//  * @param {EventTarget} el
//  * @returns {Promise}
//  */
// export async function pagerPrevious(el) {
//     await click(getNode(el).querySelector(`.o-pager button.o-pager-previous`));
// }
// /**
//  * @param {EventTarget} el
//  * @returns {Promise}
//  */
// export async function pagerNext(el) {
//     await click(getNode(el).querySelector(`.o-pager button.o-pager-next`));
// }
// /**
//  * @param {EventTarget} el
//  * @returns {string}
//  */
// export function getPagerValue(el) {
//     const pagerValue = getNode(el).querySelector(`.o-pager-counter .o-pager-value`);
//     switch (pagerValue.tagName) {
//         case 'INPUT':
//             return pagerValue.value;
//         case 'SPAN':
//             return pagerValue.innerText.trim();
//     }
// }
// /**
//  * @param {EventTarget} el
//  * @returns {string}
//  */
// export function getPagerSize(el) {
//     return getNode(el).querySelector(`.o-pager-counter span.o-pager-limit`).innerText.trim();
// }
// /**
//  * @param {EventTarget} el
//  * @param {string} value
//  * @returns {Promise}
//  */
// export async function setPagerValue(el, value) {
//     let pagerValue = getNode(el).querySelector(`.o-pager-counter .o-pager-value`);
//     if (pagerValue.tagName === 'SPAN') {
//         await click(pagerValue);
//     }
//     pagerValue = getNode(el).querySelector(`.o-pager-counter input.o-pager-value`);
//     if (!pagerValue) {
//         throw new Error("Pager value is being edited and cannot be changed.");
//     }
//     await editAndTrigger(pagerValue, value, ['change', 'blur']);
// }
