verp.define('web_tour.tour', function (require) {
"use strict";

var rootWidget = require('root.widget');
var rpc = require('web.rpc');
var session = require('web.session');
var TourManager = require('web_tour.TourManager');
const { device } = require('web.config');

const untrackedClassnames = ["o-tooltip", "o-tooltip-content", "o-tooltip-overlay"];

/**
 * @namespace
 * @property {Object} activeTooltips
 * @property {Object} tours
 * @property {Array} consumedTours
 * @property {String} runningTour
 * @property {Number} runningStepDelay
 * @property {'community' | 'enterprise'} edition
 * @property {Array} _log
 */
return session.isBound.then(function () {
    var defs = [];
    // Load the list of consumed tours and the tip template only if we are admin, in the frontend,
    // tours being only available for the admin. For the backend, the list of consumed is directly
    // in the page source.
    if (session.isFrontend && session.isAdmin) {
        var def = rpc.query({
                model: 'web.tour.tour',
                method: 'getConsumedTours',
            });
        defs.push(def);
    }
    return Promise.all(defs).then(function (results) {
        var consumedTours = session.isFrontend ? results[0] : session.webTours;
        const disabled = session.tourDisable || device.isMobile;
        var tourManager = new TourManager(rootWidget, consumedTours, disabled);

        function _isTrackedNode(node) {
            if (node.classList) {
                return !untrackedClassnames
                    .some(className => node.classList.contains(className));
            }
            return true;
        }

        const classSplitRegex = /\s+/g;
        const tooltipParentRegex = /\bo-tooltip-parent\b/;
        let currentMutations = [];
        function _processMutations() {
            const hasTrackedMutation = currentMutations.some(mutation => {
                // First check if the mutation applied on an element we do not
                // track (like the tour tips themself).
                if (!_isTrackedNode(mutation.target)) {
                    return false;
                }

                if (mutation.type === 'characterData') {
                    return true;
                }

                if (mutation.type === 'childList') {
                    // If it is a modification to the DOM hierarchy, only
                    // consider the addition/removal of tracked nodes.
                    for (const nodes of [mutation.addedNodes, mutation.removedNodes]) {
                        for (const node of nodes) {
                            if (_isTrackedNode(node)) {
                                return true;
                            }
                        }
                    }
                    return false;
                } else if (mutation.type === 'attributes') {
                    // Get old and new value of the attribute. Note: as we
                    // compute the new value after a setTimeout, this might not
                    // actually be the new value for that particular mutation
                    // record but this is the one after all mutations. This is
                    // normally not an issue: e.g. "a" -> "a b" -> "a" will be
                    // seen as "a" -> "a" (not "a b") + "a b" -> "a" but we
                    // only need to detect *one* tracked mutation to know we
                    // have to update tips anyway.
                    const oldV = mutation.oldValue ? mutation.oldValue.trim() : '';
                    const newV = (mutation.target.getAttribute(mutation.attributeName) || '').trim();

                    // Not sure why but this occurs, especially on ID change
                    // (probably some strange jQuery behavior, see below).
                    // Also sometimes, a class is just considered changed while
                    // it just loses the spaces around the class names.
                    if (oldV === newV) {
                        return false;
                    }

                    if (mutation.attributeName === 'id') {
                        // Check if this is not an ID change done by jQuery for
                        // performance reasons.
                        return !(oldV.includes('sizzle') || newV.includes('sizzle'));
                    } else if (mutation.attributeName === 'class') {
                        // Check if the change is *only* about receiving or
                        // losing the 'o-tooltip-parent' class, which is linked
                        // to the tour service system. We have to check the
                        // potential addition of another class as we compute
                        // the new value after a setTimeout. So this case:
                        // 'a' -> 'a b' -> 'a b o-tooltip-parent' produces 2
                        // mutation records but will be seen here as
                        // 1) 'a' -> 'a b o-tooltip-parent'
                        // 2) 'a b' -> 'a b o-tooltip-parent'
                        const hadClass = tooltipParentRegex.test(oldV);
                        const newClasses = mutation.target.classList;
                        const hasClass = newClasses.contains('o-tooltip-parent');
                        return !(hadClass !== hasClass
                            && Math.abs(oldV.split(classSplitRegex).length - newClasses.length) === 1);
                    }
                }

                return true;
            });

            // Either all the mutations have been ignored or one was detected as
            // tracked and will trigger a tour manager update.
            currentMutations = [];

            // Update the tour manager if required.
            if (hasTrackedMutation) {
                tourManager.update();
            }
        }

        // Use a MutationObserver to detect DOM changes. When a mutation occurs,
        // only add it to the list of mutations to process and delay the
        // mutation processing. We have to record them all and not in a
        // debounced way otherwise we may ignore tracked ones in a serie of
        // 10 tracked mutations followed by an untracked one. Most of them
        // will trigger a tip check anyway so, most of the time, processing the
        // first ones will be enough to ensure that a tip update has to be done.
        let mutationTimer;
        const observer = new MutationObserver(mutations => {
            clearTimeout(mutationTimer);
            currentMutations = currentMutations.concat(mutations);
            mutationTimer = setTimeout(() => _processMutations(), 750);
        });

        // Now that the observer is configured, we have to start it when needed.
        var startService = (function () {
            return function (observe) {
                return new Promise(function (resolve, reject) {
                    tourManager._registerAll(observe).then(function () {
                        if (observe) {
                            observer.observe(document.body, {
                                attributes: true,
                                childList: true,
                                subtree: true,
                                attributeOldValue: true,
                                characterData: true,
                            });
                        }
                        resolve();
                    });
                });
            };
        })();

        // Enable the MutationObserver for the admin or if a tour is running, when the DOM is ready
        startService(session.isAdmin || tourManager.runningTour);

        // Override the TourManager so that it enables/disables the observer when necessary
        if (!session.isAdmin) {
            var run = tourManager.run;
            tourManager.run = function () {
                var self = this;
                var args = arguments;

                startService(true).then(function () {
                    run.apply(self, args);
                    if (!self.runningTour) {
                        observer.disconnect();
                    }
                });
            };
            var _consumeTour = tourManager._consumeTour;
            tourManager._consumeTour = function () {
                _consumeTour.apply(this, arguments);
                observer.disconnect();
            };
        }
        // helper to start a tour manually (or from a javascript test with its counterpart startTour function)
        verp.startTour = tourManager.run.bind(tourManager);
        return tourManager;
    });
});

});
