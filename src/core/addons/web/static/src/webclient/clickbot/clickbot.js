/**
 * The purpose of this test is to click on every installed App and then open each
 * view. On each view, click on each filter.
 */

(function (exports) {
    "use strict";

    const MOUSE_EVENTS = ["mouseover", "mouseenter", "mousedown", "mouseup", "click"];
    const BLACKLISTED_MENUS = [
        "base.menuThemeStore",
        "base.menuThirdParty",
        "account.menuActionAccountBankJournalForm",
        "pos_adyen.menuPosAdyenAccount",
        "payment_verp.menuAdyenAccount",
        "payment_verp.rootAdyenMenu",
    ];

    const { isEnterprise } = verp.info;
    let appsMenusOnly = false;
    let actionCount = 0;
    let viewUpdateCount = 0;

    let appIndex;
    let menuIndex;
    let subMenuIndex;
    let testedApps;
    let testedMenus;

    /**
     * Hook on specific activities of the webclient to detect when to move forward.
     * This should be done only once.
     */
    let setupDone = false;
    function ensureSetup() {
        if (setupDone) {
            return;
        }
        setupDone = true;
        const env = verp.__WOWL_DEBUG__.root.env;
        env.bus.on("ACTION_MANAGER:UI-UPDATED", null, () => {
            actionCount++;
        });

        const AbstractController = verp.__DEBUG__.services["web.AbstractController"];
        AbstractController.include({
            start() {
                this.$el.attr("data-view-type", this.viewType);
                return this._super.apply(this, arguments);
            },
            async update() {
                await this._super(...arguments);
                viewUpdateCount++;
            },
        });

        const { patch } = verp.__DEBUG__.services["@web/core/utils/patch"];
        const { WithSearch } = verp.__DEBUG__.services["@web/search/with_search/with_search"];

        patch(WithSearch.prototype, "PatchedWithSearch", {
            async willStart() {
                await this._super(...arguments);
                viewUpdateCount++;
            },
            async render() {
                await this._super(...arguments);
                viewUpdateCount++;
            },
        });

        // This test file is not respecting Verp module dependencies.
        // The following module might not be loaded (eg. if mail is not installed).
        const DiscussWidgetModule = verp.__DEBUG__.services["@mail/widgets/discuss/discuss"];
        const DiscussWidget = DiscussWidgetModule && DiscussWidgetModule[Symbol.for("default")];
        if (DiscussWidget) {
            DiscussWidget.include({
                /**
                 * Overriding a method that is called every time the discuss
                 * component is updated.
                 */
                _updateControlPanel: async function () {
                    await this._super(...arguments);
                    viewUpdateCount++;
                },
            });
        }
    }

    /**
     * Returns a promise that resolves after the next animation frame.
     *
     * @returns {Promise}
     */
    async function waitForNextAnimationFrame() {
        await new Promise(setTimeout);
        await new Promise((r) => requestAnimationFrame(r));
    }

    /**
     * Simulate all of the mouse events triggered during a click action.
     *
     * @param {EventTarget} target the element on which to perform the click
     * @param {string} elDescription description of the item
     * @returns {Promise} resolved after next animation frame
     */
    async function triggerClick(target, elDescription) {
        if (target) {
            console.log("Clicking on", elDescription);
        } else {
            throw new Error(`No element "${elDescription}" found.`);
        }
        MOUSE_EVENTS.forEach((type) => {
            const event = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
            target.dispatchEvent(event);
        });
        await waitForNextAnimationFrame();
    }

    /**
     * Wait a certain amount of time for a condition to occur
     *
     * @param {function} stopCondition a function that returns a boolean
     * @returns {Promise} that is rejected if the timeout is exceeded
     */
    function waitForCondition(stopCondition, tl = 30000) {
        return new Promise(function (resolve, reject) {
            const interval = 250;
            let timeLimit = tl;

            function checkCondition() {
                if (stopCondition()) {
                    resolve();
                } else {
                    timeLimit -= interval;
                    if (timeLimit > 0) {
                        // recursive call until the resolve or the timeout
                        setTimeout(checkCondition, interval);
                    } else {
                        console.error(
                            "Timeout, the clicked element took more than",
                            tl / 1000,
                            "seconds to load"
                        );
                        reject();
                    }
                }
            }
            setTimeout(checkCondition, interval);
        });
    }

    /**
     * Make sure the home menu is open (enterprise only)
     */
    async function ensureHomeMenu() {
        const homeMenu = document.querySelector(".o-home-menu");
        if (!homeMenu) {
            const menuToggle = document.querySelector("nav.o-main-navbar > a.o-menu-toggle.fa-th");
            await triggerClick(menuToggle, "home menu toggle button");
            await waitForCondition(() => document.querySelector(".o-home-menu"));
        }
    }

    /**
     * Make sure the apps menu is open (community only)
     */
    async function ensureAppsMenu() {
        const appsMenu = document.querySelector(".o-navbar-apps-menu .dropdown-menu");
        if (!appsMenu) {
            const toggler = document.querySelector(".o-navbar-apps-menu .dropdown-toggle");
            await triggerClick(toggler, "apps menu toggle button");
            await waitForCondition(() =>
                document.querySelector(".o-navbar-apps-menu .dropdown-menu")
            );
        }
    }

    /**
     * Return the next menu to test, and update the internal counters.
     *
     * @returns {DomElement}
     */
    async function getNextMenu() {
        const menus = document.querySelectorAll(
            ".o-menu-sections > .dropdown > .dropdown-toggle, .o-menu-sections > .dropdown-item"
        );
        if (menuIndex === menus.length) {
            menuIndex = 0;
            return; // all menus done
        }
        let menu = menus[menuIndex];
        if (menu.classList.contains("dropdown-toggle")) {
            // the current menu is a dropdown toggler -> open it and pick a menu inside the dropdown
            if (!menu.nextSibling) {
                // might already be opened if the last menu was blacklisted
                await triggerClick(menu, "menu toggler");
            }
            const dropdown = menu.nextSibling;
            if (!dropdown) {
                menuIndex = 0; // empty More menu has no dropdown (FIXME?)
                return;
            }
            const items = dropdown.querySelectorAll(".dropdown-item");
            menu = items[subMenuIndex];
            if (subMenuIndex === items.length - 1) {
                // this is the last item, so go to the next menu
                menuIndex++;
                subMenuIndex = 0;
            } else {
                // this isn't the last item, so increment the index inside this dropdown
                subMenuIndex++;
            }
        } else {
            // the current menu isn't a dropdown, so go to the next menu
            menuIndex++;
        }
        return menu;
    }

    /**
     * Return the next app to test, and update the internal counter.
     *
     * @returns {DomElement}
     */
    async function getNextApp() {
        let apps;
        if (isEnterprise) {
            await ensureHomeMenu();
            apps = document.querySelectorAll(".o-apps .o-app");
        } else {
            await ensureAppsMenu();
            apps = document.querySelectorAll(".o-navbar-apps-menu .dropdown-item");
        }
        const app = apps[appIndex];
        appIndex++;
        return app;
    }

    /**
     * Test filters
     * Click on each filter in the control pannel
     */
    async function testFilters() {
        if (appsMenusOnly === true) {
            return;
        }
        const filterMenuButton = document.querySelector(".o-control-panel .o-filter-menu > button");
        if (!filterMenuButton) {
            return;
        }
        // Open the filter menu dropdown
        await triggerClick(
            filterMenuButton,
            `toggling menu "${filterMenuButton.innerText.trim()}"`
        );

        const simpleFilterSel = ".o-control-panel .o-filter-menu > .dropdown-menu > .dropdown-item";
        const dateFilterSel = ".o-control-panel .o-filter-menu > .dropdown-menu > .dropdown";
        const filterMenuItems = document.querySelectorAll(`${simpleFilterSel},${dateFilterSel}`);
        console.log("Testing", filterMenuItems.length, "filters");
        for (const filter of filterMenuItems) {
            const currentViewCount = viewUpdateCount;
            if (filter.classList.contains("dropdown")) {
                await triggerClick(
                    filter.querySelector(".dropdown-toggle"),
                    `filter "${filter.innerText.trim()}"`
                );
                // the sub-dropdown opens 200ms after the mousenter, so we trigger an ArrayRight
                // keydown s.t. it opens directly
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
                await waitForNextAnimationFrame();

                // If a fitler has options, it will simply unfold and show all options.
                // We then click on the first one.
                const firstOption = filter.querySelector(".dropdown-menu > .dropdown-item");
                if (firstOption) {
                    await triggerClick(
                        firstOption,
                        `filter option "${firstOption.innerText.trim()}"`
                    );
                    await waitForCondition(() => currentViewCount !== viewUpdateCount);
                }
            } else {
                await triggerClick(filter, `filter "${filter.innerText.trim()}"`);
                await waitForCondition(() => currentViewCount !== viewUpdateCount);
            }
        }
    }

    /**
     * Orchestrate the test of views
     * This function finds the buttons that permit to switch views and orchestrate
     * the click on each of them
     * @returns {Promise}
     */
    async function testViews() {
        if (appsMenusOnly === true) {
            return;
        }
        const switchButtons = document.querySelectorAll(
            "nav.o-cp-switch-buttons > button.o-switch-view:not(.active):not(.o-map)"
        );
        const convert = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/_/g, '-').toLowerCase()
        for (const switchButton of switchButtons) {
            // Only way to get the viewType from the switchButton
            const viewType = [...switchButton.classList]
                .find((cls) => cls !== "o-switch-view" && cls.startsWith("o-"))
                .slice(2);
            console.log("Testing view switch:", viewType);
            // timeout to avoid click debounce
            setTimeout(function () {
                const target = document.querySelector(
                    `nav.o-cp-switch-buttons > button.o-switch-view.o-${convert(viewType)}`
                );
                if (target) {
                    triggerClick(target, `${viewType} view switcher`);
                }
            }, 250);
            await waitForCondition(() => {
                return document.querySelector(`.o-switch-view.o-${viewType}.active`) !== null;
            });
            await testFilters();
        }
    }

    /**
     * Test a menu item by:
     *  1 - clikcing on the menuItem
     *  2 - Orchestrate the view switch
     *
     *  @param {DomElement} element: the menu item
     *  @returns {Promise}
     */
    async function testMenuItem(element) {
        const menuDescription = element.innerText.trim() + " " + element.dataset.menuXmlid;
        console.log("Testing menu", menuDescription);
        testedMenus.push(element.dataset.menuXmlid);
        if (BLACKLISTED_MENUS.includes(element.dataset.menuXmlid)) {
            return Promise.resolve(); // Skip black listed menus
        }
        const startActionCount = actionCount;
        await triggerClick(element, `menu item "${element.innerText.trim()}"`);
        let isModal = false;
        return waitForCondition(function () {
            // sometimes, the app is just a modal that needs to be closed
            const $modal = $('.modal[role="dialog"]');
            if ($modal.length > 0) {
                const closeButton = document.querySelector("header > button.close");
                if (closeButton) {
                    closeButton.focus();
                    triggerClick(closeButton, "modal close button");
                } else {
                    $modal.modal("hide");
                }
                isModal = true;
                return true;
            }
            return startActionCount !== actionCount;
        })
            .then(() => {
                if (!isModal) {
                    return testFilters();
                }
            })
            .then(() => {
                if (!isModal) {
                    return testViews();
                }
            })
            .catch((err) => {
                console.error("Error while testing", menuDescription);
                return Promise.reject(err);
            });
    }

    /**
     * Test an "App" menu item by orchestrating the following actions:
     *  1 - clicking on its menuItem
     *  2 - clicking on each view
     *  3 - clicking on each menu
     *  3.1  - clicking on each view
     * @param {DomElement} element: the App menu item
     * @returns {Promise}
     */
    async function testApp(element) {
        console.log("Testing app menu:", element.dataset.menuXmlid);
        testedApps.push(element.dataset.menuXmlid);
        await testMenuItem(element);
        if (appsMenusOnly === true) {
            return;
        }
        menuIndex = 0;
        subMenuIndex = 0;
        let menu = await getNextMenu();
        while (menu) {
            await testMenuItem(menu);
            menu = await getNextMenu();
        }
    }

    /**
     * Main function that starts orchestration of tests
     */
    async function _clickEverywhere(xmlid) {
        ensureSetup();
        console.log("Starting ClickEverywhere test");
        console.log(`Verp flavor: ${isEnterprise ? "Enterprise" : "Community"}`);
        const startTime = performance.now();
        testedApps = [];
        testedMenus = [];
        appIndex = 0;
        menuIndex = 0;
        subMenuIndex = 0;
        try {
            let app;
            if (xmlid) {
                if (isEnterprise) {
                    app = document.querySelector(`a.o-app.o-menuitem[data-menu-xmlid="${xmlid}"]`);
                } else {
                    await triggerClick(
                        document.querySelector(".o-navbar-apps-menu .dropdown-toggle")
                    );
                    app = document.querySelector(
                        `.o-navbar-apps-menu .dropdown-item[data-menu-xmlid="${xmlid}"]`
                    );
                }
                if (!app) {
                    throw new Error(`No app found for xmlid ${xmlid}`);
                }
                await testApp(app);
            } else {
                app = await getNextApp();
                while (app) {
                    await testApp(app);
                    app = await getNextApp();
                }
            }
            console.log("Test took", (performance.now() - startTime) / 1000, "seconds");
            console.log("Successfully tested", testedApps.length, " apps");
            console.log("Successfully tested", testedMenus.length - testedApps.length, "menus");
            console.log("test successful");
        } catch (err) {
            console.log("Test took", (performance.now() - startTime) / 1000, "seconds");
            console.error(err || "test failed");
        }
        console.log(testedApps);
        console.log(testedMenus);
    }

    function clickEverywhere(xmlid, light) {
        appsMenusOnly = light;
        setTimeout(_clickEverywhere, 1000, xmlid);
    }

    exports.clickEverywhere = clickEverywhere;
})(window);
