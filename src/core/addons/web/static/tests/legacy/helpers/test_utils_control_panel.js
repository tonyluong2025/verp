verp.define('web.test_utils_control_panel', function (require) {
    "use strict";

    const { click, findItem, getNode, triggerEvent } = require('web.test_utils_dom');
    const { editInput, editSelect, editAndTrigger } = require('web.test_utils_fields');

    //-------------------------------------------------------------------------
    // Exported functions
    //-------------------------------------------------------------------------

    /**
     * @param {EventTarget} el
     * @param {(number|string)} menuFinder
     * @returns {Promise}
     */
    async function toggleMenu(el, menuFinder) {
        const menu = findItem(el, `.dropdown > button`, menuFinder);
        await click(menu);
    }

    /**
     * @param {EventTarget} el
     * @param {(number|string)} itemFinder
     * @returns {Promise}
     */
    async function toggleMenuItem(el, itemFinder) {
        const item = findItem(el, `.o-menu-item > a`, itemFinder);
        await click(item);
    }

    /**
     * @param {EventTarget} el
     * @param {(number|string)} itemFinder
     * @param {(number|string)} optionFinder
     * @returns {Promise}
     */
    async function toggleMenuItemOption(el, itemFinder, optionFinder) {
        const item = findItem(el, `.o-menu-item > a`, itemFinder);
        const option = findItem(item.parentNode, '.o_item_option > a', optionFinder);
        await click(option);
    }

    /**
     * @param {EventTarget} el
     * @param {(number|string)} itemFinder
     * @returns {boolean}
     */
    function isItemSelected(el, itemFinder) {
        const item = findItem(el, `.o-menu-item > a`, itemFinder);
        return item.classList.contains('selected');
    }

    /**
     * @param {EventTarget} el
     * @param {(number|string)} itemuFinder
     * @param {(number|string)} optionFinder
     * @returns {boolean}
     */
    function isOptionSelected(el, itemFinder, optionFinder) {
        const item = findItem(el, `.o-menu-item > a`, itemFinder);
        const option = findItem(item.parentNode, '.o_item_option > a', optionFinder);
        return option.classList.contains('selected');
    }

    /**
     * @param {EventTarget} el
     * @returns {string[]}
     */
    function getMenuItemTexts(el) {
        return [...getNode(el).querySelectorAll(`.dropdown ul .o-menu-item`)].map(
            e => e.innerText.trim()
        );
    }

    /**
     * @param {EventTarget} el
     * @returns {HTMLButtonElement[]}
     */
    function getButtons(el) {
        return [...getNode(el).querySelector((`div.o-cp-bottom div.o-cp-buttons`)).children];
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function toggleFilterMenu(el) {
        await click(getNode(el).querySelector(`.o-filter-menu button`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function toggleAddCustomFilter(el) {
        await click(getNode(el).querySelector(`button.o-add-custom_filter`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function applyFilter(el) {
        await click(getNode(el).querySelector(`div.o-add-filter_menu > button.o_apply_filter`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function addCondition(el) {
        await click(getNode(el).querySelector(`div.o-add-filter_menu > button.o-add-condition`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function toggleGroupByMenu(el) {
        await click(getNode(el).querySelector(`.o-groupby-menu button`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function toggleAddCustomGroup(el) {
        await click(getNode(el).querySelector(`span.o-add-custom-groupby`));
    }

    /**
     * @param {EventTarget} el
     * @param {string} fieldName
     * @returns {Promise}
     */
    async function selectGroup(el, fieldName) {
        await editSelect(
            getNode(el).querySelector(`select.o-group-by-selector`),
            fieldName
        );
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function applyGroup(el) {
        await click(getNode(el).querySelector(`div.o-add-groupby-menu > button.o-apply-groupby`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function toggleFavoriteMenu(el) {
        await click(getNode(el).querySelector(`.o_favorite_menu button`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function toggleSaveFavorite(el) {
        await click(getNode(el).querySelector(`.o_favorite_menu .o-add-favorite .dropdown-item`));
    }

    /**
     * @param {EventTarget} el
     * @param {string} name
     * @returns {Promise}
     */
    async function editFavoriteName(el, name) {
        await editInput(getNode(el).querySelector(`.o_favorite_menu .o-add-favorite input[type="text"]`), name);
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function saveFavorite(el) {
        await click(getNode(el).querySelector(`.o_favorite_menu .o-add-favorite button.o_save_favorite`));
    }

    /**
     * @param {EventTarget} el
     * @param {(string|number)} favoriteFinder
     * @returns {Promise}
     */
    async function deleteFavorite(el, favoriteFinder) {
        const favorite = findItem(el, `.o_favorite_menu .o-menu-item`, favoriteFinder);
        await click(favorite.querySelector('i.fa-trash'));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function toggleComparisonMenu(el) {
        await click(getNode(el).querySelector(`div.o-comparison-menu > button`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    function getFacetTexts(el) {
        return [...getNode(el).querySelectorAll(`.o-searchview .o-searchview-facet`)].map(
            facet => facet.innerText.trim()
        );
    }

    /**
     * @param {EventTarget} el
     * @param {(string|number)} facetFinder
     * @returns {Promise}
     */
    async function removeFacet(el, facetFinder = 0) {
        const facet = findItem(el, `.o-searchview .o-searchview-facet`, facetFinder);
        await click(facet.querySelector('.o-facet-remove'));
    }

    /**
     * @param {EventTarget} el
     * @param {string} value
     * @returns {Promise}
     */
    async function editSearch(el, value) {
        await editInput(getNode(el).querySelector(`.o-searchview-input`), value);
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function validateSearch(el) {
        await triggerEvent(
            getNode(el).querySelector(`.o-searchview-input`),
            'keydown', { key: 'Enter' }
        );
    }

    /**
     * @param {EventTarget} el
     * @param {string} [menuFinder="Action"]
     * @returns {Promise}
     */
    async function toggleActionMenu(el, menuFinder = "Action") {
        const dropdown = findItem(el, `.o-cp-action-menus button`, menuFinder);
        await click(dropdown);
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function pagerPrevious(el) {
        await click(getNode(el).querySelector(`.o-pager button.o-pager-previous`));
    }

    /**
     * @param {EventTarget} el
     * @returns {Promise}
     */
    async function pagerNext(el) {
        await click(getNode(el).querySelector(`.o-pager button.o-pager-next`));
    }

    /**
     * @param {EventTarget} el
     * @returns {string}
     */
    function getPagerValue(el) {
        const pagerValue = getNode(el).querySelector(`.o-pager-counter .o-pager-value`);
        switch (pagerValue.tagName) {
            case 'INPUT':
                return pagerValue.value;
            case 'SPAN':
                return pagerValue.innerText.trim();
        }
    }

    /**
     * @param {EventTarget} el
     * @returns {string}
     */
    function getPagerSize(el) {
        return getNode(el).querySelector(`.o-pager-counter span.o-pager-limit`).innerText.trim();
    }

    /**
     * @param {EventTarget} el
     * @param {string} value
     * @returns {Promise}
     */
    async function setPagerValue(el, value) {
        let pagerValue = getNode(el).querySelector(`.o-pager-counter .o-pager-value`);
        if (pagerValue.tagName === 'SPAN') {
            await click(pagerValue);
        }
        pagerValue = getNode(el).querySelector(`.o-pager-counter input.o-pager-value`);
        if (!pagerValue) {
            throw new Error("Pager value is being edited and cannot be changed.");
        }
        await editAndTrigger(pagerValue, value, ['change', 'blur']);
    }

    /**
     * @param {EventTarget} el
     * @param {string} viewType
     * @returns {Promise}
     */
    async function switchView(el, viewType) {
        await click(getNode(el).querySelector(`button.o-switch-view.o-${viewType}`));
    }

    return {
        // Generic interactions
        toggleMenu,
        toggleMenuItem,
        toggleMenuItemOption,
        isItemSelected,
        isOptionSelected,
        getMenuItemTexts,
        // Button interactions
        getButtons,
        // FilterMenu interactions
        toggleFilterMenu,
        toggleAddCustomFilter,
        applyFilter,
        addCondition,
        // GroupByMenu interactions
        toggleGroupByMenu,
        toggleAddCustomGroup,
        selectGroup,
        applyGroup,
        // FavoriteMenu interactions
        toggleFavoriteMenu,
        toggleSaveFavorite,
        editFavoriteName,
        saveFavorite,
        deleteFavorite,
        // ComparisonMenu interactions
        toggleComparisonMenu,
        // SearchBar interactions
        getFacetTexts,
        removeFacet,
        editSearch,
        validateSearch,
        // Action menus interactions
        toggleActionMenu,
        // Pager interactions
        pagerPrevious,
        pagerNext,
        getPagerValue,
        getPagerSize,
        setPagerValue,
        // View switcher
        switchView,
    };
});
