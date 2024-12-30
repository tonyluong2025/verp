verp.define('web_tour.TourManager', function(require) {
"use strict";

var core = require('web.core');
var config = require('web.config');
var localStorage = require('web.localStorage');
var mixins = require('web.mixins');
var utils = require('web_tour.utils');
var TourStepUtils = require('web_tour.TourStepUtils');
var RunningTourActionHelper = require('web_tour.RunningTourActionHelper');
var ServicesMixin = require('web.ServicesMixin');
var session = require('web.session');
var Tip = require('web_tour.Tip');
const {Markup} = require('web.utils');

var _t = core._t;

var RUNNING_TOUR_TIMEOUT = 10000;

var getStepKey = utils.getStepKey;
var getDebuggingKey = utils.getDebuggingKey;
var getRunningKey = utils.getRunningKey;
var getRunningDelayKey = utils.getRunningDelayKey;
var getFirstVisibleElement = utils.getFirstVisibleElement;
var doBeforeUnload = utils.doBeforeUnload;
var getJqueryElementFromSelector = utils.getJqueryElementFromSelector;

return core.Class.extend(mixins.EventDispatcherMixin, ServicesMixin, {
    init: function(parent, consumedTours, disabled = false) {
        mixins.EventDispatcherMixin.init.call(this);
        this.setParent(parent);

        this.$body = $('body');
        this.activeTooltips = {};
        this.tours = {};
        // remove the tours being debug from the list of consumed tours
        this.consumedTours = (consumedTours || []).filter(tourName => {
            return !localStorage.getItem(getDebuggingKey(tourName));
        });
        this.disabled = disabled;
        this.runningTour = localStorage.getItem(getRunningKey());
        this.runningStepDelay = parseInt(localStorage.getItem(getRunningDelayKey()), 10) || 0;
        this.edition = (_.last(session.serverVersionInfo) === 'e') ? 'enterprise' : 'community';
        this._log = [];
        console.log('Tour Manager is ready.  runningTour=' + this.runningTour);
    },
    /**
     * Registers a tour described by the following arguments *in order*
     *
     * @param {string} name - tour's name
     * @param {Object} [options] - options (optional), available options are:
     * @param {boolean} [options.test=false] - true if this is only for tests
     * @param {boolean} [options.skipEnabled=false]
     *        true to add a link in its tips to consume the whole tour
     * @param {string} [options.url]
     *        the url to load when manually running the tour
     * @param {boolean} [options.rainbowMan=true]
     *        whether or not the rainbowman must be shown at the end of the tour
     * @param {string} [options.fadeout]
     *        Delay for rainbowman to disappear. 'fast' will make rainbowman dissapear, quickly,
     *        'medium', 'slow' and 'verySlow' will wait little longer before disappearing, no
     *        will keep rainbowman on screen until user clicks anywhere outside rainbowman
     * @param {boolean} [options.sequence=1000]
     *        priority sequence of the tour (lowest is first, tours with the same
     *        sequence will be executed in a non deterministic order).
     * @param {Promise} [options.waitFor]
     *        indicates when the tour can be started
     * @param {string|function} [options.rainbowManMessage]
              text or function returning the text displayed under the rainbowman
              at the end of the tour.
     * @param {Object[]} steps - steps' descriptions, each step being an object
     *                     containing a tip description
     */
    register: function() {
        var args = Array.prototype.slice.call(arguments);
        var lastArg = args[args.length - 1];
        var name = args[0];
        if (this.tours[name]) {
            console.warn(_.str.sprintf("Tour %s is already defined", name));
            return;
        }
        var options = args.length === 2 ? {} : args[1];
        var steps = lastArg instanceof Array ? lastArg : [lastArg];
        var tour = {
            label: options.saveAs || name,
            steps: steps,
            url: options.url,
            rainbowMan: options.rainbowMan === undefined ? true : !!options.rainbowMan,
            rainbowManMessage: options.rainbowManMessage,
            fadeout: options.fadeout || 'medium',
            sequence: options.sequence || 1000,
            test: options.test,
            waitFor: options.waitFor || Promise.resolve(),
        };
        if (options.skipEnabled) {
            tour.skipLink = Markup`<p><span class="o-skip-tour">${_t('Skip tour')}</span></p>`;
            tour.skipHandler = function (tip) {
                this._deactivateTip(tip);
                this._consumeTour(name);
            };
        }
        this.tours[tour.label] = tour;
    },
    /**
     * Returns a promise which is resolved once the tour can be started. This
     * is when the DOM is ready and at the end of the execution stack so that
     * all tours have potentially been extended by all apps.
     *
     * @private
     * @returns {Promise}
     */
    _waitBeforeTourStart: function () {
        return new Promise(function (resolve) {
            $(function () {
                setTimeout(resolve);
            });
        });
    },
    _registerAll: function (doUpdate) {
        var self = this;
        if (this._allRegistered) {
            return Promise.resolve();
        }
        this._allRegistered = true;
        return self._waitBeforeTourStart().then(function () {
            return Promise.all(_.map(self.tours, function (tour, name) {
                return self._register(doUpdate, tour, name);
            })).then(() => self.update());
        });
    },
    _register: function (doUpdate, tour, name) {
        const debuggingTour = localStorage.getItem(getDebuggingKey(name));
        if (this.disabled && !this.runningTour && !debuggingTour) {
            this.consumedTours.push(name);
        }

        if (tour.ready) return Promise.resolve();

        const tourIsConsumed = this._isTourConsumed(name);

        return tour.waitFor.then((function () {
            tour.currentStep = parseInt(localStorage.getItem(getStepKey(name))) || 0;
            tour.steps = _.filter(tour.steps, (function (step) {
                return (!step.edition || step.edition === this.edition) &&
                    (step.mobile === undefined || step.mobile === config.device.isMobile);
            }).bind(this));

            if (tourIsConsumed || tour.currentStep >= tour.steps.length) {
                localStorage.removeItem(getStepKey(name));
                tour.currentStep = 0;
            }

            tour.ready = true;

            if (debuggingTour ||
                (doUpdate && (this.runningTour === name ||
                              (!this.runningTour && !tour.test && !tourIsConsumed)))) {
                this._toNextStep(name, 0);
            }
        }).bind(this));
    },
    /**
     * Resets the given tour to its initial step, and prevent it from being
     * marked as consumed at reload.
     *
     * @param {string} tourName
     */
    reset: function (tourName) {
        // remove it from the list of consumed tours
        const index = this.consumedTours.indexOf(tourName);
        if (index >= 0) {
            this.consumedTours.splice(index, 1);
        }
        // mark it as being debugged
        localStorage.setItem(getDebuggingKey(tourName), true);
        // reset it to the first step
        const tour = this.tours[tourName];
        tour.currentStep = 0;
        localStorage.removeItem(getStepKey(tourName));
        this._toNextStep(tourName, 0);
        // redirect to its starting point (or /web by default)
        window.location.href = window.location.origin + (tour.url || '/web');
    },
    run: function (tourName, stepDelay) {
        console.log(_.str.sprintf("Preparing tour %s", tourName));
        if (this.runningTour) {
            this._deactivateTip(this.activeTooltips[this.runningTour]);
            this._consumeTour(this.runningTour, _.str.sprintf("Killing tour %s", this.runningTour));
            return;
        }
        var tour = this.tours[tourName];
        if (!tour) {
            console.warn(_.str.sprintf("Unknown Tour %s", name));
            return;
        }
        console.log(_.str.sprintf("Running tour %s", tourName));
        this.runningTour = tourName;
        this.runningStepDelay = stepDelay || this.runningStepDelay;
        localStorage.setItem(getRunningKey(), this.runningTour);
        localStorage.setItem(getRunningDelayKey(), this.runningStepDelay);

        this._deactivateTip(this.activeTooltips[tourName]);

        tour.currentStep = 0;
        this._toNextStep(tourName, 0);
        localStorage.setItem(getStepKey(tourName), tour.currentStep);

        if (tour.url) {
            this.pause();
            doBeforeUnload(null, (function () {
                this.play();
                this.update();
            }).bind(this));

            window.location.href = window.location.origin + tour.url;
        } else {
            this.update();
        }
    },
    pause: function () {
        this.paused = true;
    },
    play: function () {
        this.paused = false;
    },
    /**
     * Checks for tooltips to activate (only from the running tour or specified tour if there
     * is one, from all active tours otherwise). Should be called each time the DOM changes.
     */
    update: function (tourName) {
        if (this.paused) return;

        this.$modalDisplayed = $('.modal:visible').last();

        tourName = this.runningTour || tourName;
        if (tourName) {
            var tour = this.tours[tourName];
            if (!tour || !tour.ready) return;

            if (this.runningTour && this.runningTourTimeout === undefined) {
                this._setRunningTourTimeout(this.runningTour, this.activeTooltips[this.runningTour]);
            }
            var self = this;
            setTimeout(function () {
                self._checkForTooltip(self.activeTooltips[tourName], tourName);
            });
        } else {
            const sortedTooltips = Object.keys(this.activeTooltips).sort(
                (a, b) => this.tours[a].sequence - this.tours[b].sequence
            );
            let visibleTip = false;
            for (const tourName of sortedTooltips) {
                var tip = this.activeTooltips[tourName];
                tip.hidden = visibleTip;
                visibleTip = this._checkForTooltip(tip, tourName) || visibleTip;
            }
        }
    },
    /**
     *  Check (and activate or update) a help tooltip for a tour.
     *
     * @param {Object} tip
     * @param {string} tourName
     * @returns {boolean} true if a tip was found and activated/updated
     */
    _checkForTooltip: function (tip, tourName) {
        if (tip === undefined) {
            return true;
        }
        if ($('body').hasClass('o-ui-blocked')) {
            this._deactivateTip(tip);
            this._log.push("blockUI is preventing the tip to be consumed");
            return false;
        }

        var $trigger;
        if (tip.inModal !== false && this.$modalDisplayed.length) {
            $trigger = this.$modalDisplayed.find(tip.trigger);
        } else {
            $trigger = getJqueryElementFromSelector(tip.trigger);
        }
        var $visibleTrigger = getFirstVisibleElement($trigger);

        var extraTrigger = true;
        var $extraTrigger;
        if (tip.extraTrigger) {
            $extraTrigger = getJqueryElementFromSelector(tip.extraTrigger);
            extraTrigger = getFirstVisibleElement($extraTrigger).length;
        }

        var $visibleAltTrigger = $();
        if (tip.altTrigger) {
            var $altTrigger;
            if (tip.inModal !== false && this.$modalDisplayed.length) {
                $altTrigger = this.$modalDisplayed.find(tip.altTrigger);
            } else {
                $altTrigger = getJqueryElementFromSelector(tip.altTrigger);
            }
            $visibleAltTrigger = getFirstVisibleElement($altTrigger);
        }

        var triggered = $visibleTrigger.length && extraTrigger;
        if (triggered) {
            if (!tip.widget) {
                this._activateTip(tip, tourName, $visibleTrigger, $visibleAltTrigger);
            } else {
                tip.widget.update($visibleTrigger, $visibleAltTrigger);
            }
        } else {
            if ($trigger.iframeContainer || ($extraTrigger && $extraTrigger.iframeContainer)) {
                var $el = $();
                if ($trigger.iframeContainer) {
                    $el = $el.add($trigger.iframeContainer);
                }
                if (($extraTrigger && $extraTrigger.iframeContainer) && $trigger.iframeContainer !== $extraTrigger.iframeContainer) {
                    $el = $el.add($extraTrigger.iframeContainer);
                }
                var self = this;
                $el.off('load').one('load', function () {
                    $el.off('load');
                    if (self.activeTooltips[tourName] === tip) {
                        self.update(tourName);
                    }
                });
            }
            this._deactivateTip(tip);

            if (this.runningTour === tourName) {
                this._log.push("_checkForTooltip");
                this._log.push("- modalDisplayed: " + this.$modalDisplayed.length);
                this._log.push("- trigger '" + tip.trigger + "': " + $trigger.length);
                this._log.push("- visible trigger '" + tip.trigger + "': " + $visibleTrigger.length);
                if ($extraTrigger !== undefined) {
                    this._log.push("- extraTrigger '" + tip.extraTrigger + "': " + $extraTrigger.length);
                    this._log.push("- visible extraTrigger '" + tip.extraTrigger + "': " + extraTrigger);
                }
            }
        }
        return !!triggered;
    },
    /**
     * Activates the provided tip for the provided tour, $anchor and $altTrigger.
     * $altTrigger is an alternative trigger that can consume the step. The tip is
     * however only displayed on the $anchor.
     *
     * @param {Object} tip
     * @param {String} tourName
     * @param {jQuery} $anchor
     * @param {jQuery} $altTrigger
     * @private
     */
    _activateTip: function(tip, tourName, $anchor, $altTrigger) {
        var tour = this.tours[tourName];
        var tipInfo = tip;
        if (tour.skipLink) {
            tipInfo = _.extend(_.omit(tipInfo, 'content'), {
                content: Markup`${tip.content}${tour.skipLink}`,
                eventHandlers: [{
                    event: 'click',
                    selector: '.o-skip-tour',
                    handler: tour.skipHandler.bind(this, tip),
                }],
            });
        }
        tip.widget = new Tip(this, tipInfo);
        if (this.runningTour !== tourName) {
            tip.widget.on('tipConsumed', this, this._consumeTip.bind(this, tip, tourName));
        }
        tip.widget.attachTo($anchor, $altTrigger).then(this._toNextRunningStep.bind(this, tip, tourName));
    },
    _deactivateTip: function(tip) {
        if (tip && tip.widget) {
            tip.widget.destroy();
            delete tip.widget;
        }
    },
    _describeTip: function(tip) {
        return tip.content ? tip.content + ' (trigger: ' + tip.trigger + ')' : tip.trigger;
    },
    _consumeTip: function(tip, tourName) {
        this._deactivateTip(tip);
        this._toNextStep(tourName);

        var isRunning = (this.runningTour === tourName);
        if (isRunning) {
            var stepDescription = this._describeTip(tip);
            console.log(_.str.sprintf("Tour %s: step '%s' succeeded", tourName, stepDescription));
        }

        if (this.activeTooltips[tourName]) {
            localStorage.setItem(getStepKey(tourName), this.tours[tourName].currentStep);
            if (isRunning) {
                this._log = [];
                this._setRunningTourTimeout(tourName, this.activeTooltips[tourName]);
            }
            this.update(tourName);
        } else {
            this._consumeTour(tourName);
        }
    },
    _toNextStep: function (tourName, inc) {
        var tour = this.tours[tourName];
        tour.currentStep += (inc !== undefined ? inc : 1);
        if (this.runningTour !== tourName) {
            var index = _.findIndex(tour.steps.slice(tour.currentStep), function (tip) {
                return !tip.auto;
            });
            if (index >= 0) {
                tour.currentStep += index;
            } else {
                tour.currentStep = tour.steps.length;
            }
        }
        this.activeTooltips[tourName] = tour.steps[tour.currentStep];
    },
    /**
     * @private
     * @param {string} tourName
     * @returns {boolean}
     */
    _isTourConsumed(tourName) {
        return this.consumedTours.includes(tourName);
    },
    _consumeTour: function (tourName, error) {
        delete this.activeTooltips[tourName];
        //display rainbow at the end of any tour
        if (this.tours[tourName].rainbowMan && this.runningTour !== tourName &&
            this.tours[tourName].currentStep === this.tours[tourName].steps.length) {
            let message = this.tours[tourName].rainbowManMessage;
            if (message) {
                message = typeof message === 'function' ? message() : message;
            } else {
                message = _t('<strong><b>Good job!</b> You went through all steps of this tour.</strong>');
            }
            const fadeout = this.tours[tourName].fadeout;
            core.bus.trigger('show-effect', {
                type: "rainbowMan",
                message,
                fadeout,
                messageIsHtml: true,
            });
        }
        this.tours[tourName].currentStep = 0;
        localStorage.removeItem(getStepKey(tourName));
        localStorage.removeItem(getDebuggingKey(tourName));
        if (this.runningTour === tourName) {
            this._stopRunningTourTimeout();
            localStorage.removeItem(getRunningKey());
            localStorage.removeItem(getRunningDelayKey());
            this.runningTour = undefined;
            this.runningStepDelay = undefined;
            if (error) {
                _.each(this._log, function (log) {
                    console.log(log);
                });
                console.log(document.body.parentElement.outerHTML);
                console.error(error); // will be displayed as error info
            } else {
                console.log(_.str.sprintf("Tour %s succeeded", tourName));
                console.log("test successful"); // browserJs wait for message "test successful"
            }
            this._log = [];
        } else {
            var self = this;
            this._rpc({
                    model: 'web.tour.tour',
                    method: 'consume',
                    args: [[tourName]],
                })
                .then(function () {
                    self.consumedTours.push(tourName);
                });
        }
    },
    _setRunningTourTimeout: function (tourName, step) {
        this._stopRunningTourTimeout();
        this.runningTourTimeout = setTimeout((function() {
            var descr = this._describeTip(step);
            this._consumeTour(tourName, _.str.sprintf("Tour %s failed at step %s", tourName, descr));
        }).bind(this), (step.timeout || RUNNING_TOUR_TIMEOUT) + this.runningStepDelay);
    },
    _stopRunningTourTimeout: function () {
        clearTimeout(this.runningTourTimeout);
        this.runningTourTimeout = undefined;
    },
    _toNextRunningStep: function (tip, tourName) {
        if (this.runningTour !== tourName) return;
        var self = this;
        this._stopRunningTourTimeout();
        if (this.runningStepDelay) {
            // warning: due to the delay, it may happen that the $anchor isn't
            // in the DOM anymore when exec is called, either because:
            // - it has been removed from the DOM meanwhile and the tip's
            //   selector doesn't match anything anymore
            // - it has been re-rendered and thus the selector still has a match
            //   in the DOM, but executing the step with that $anchor won't work
            _.delay(exec, this.runningStepDelay);
        } else {
            exec();
        }

        function exec() {
            const anchorIsInDocument = tip.widget.$anchor[0].ownerDocument.contains(tip.widget.$anchor[0]);
            const uiIsBlocked = $('body').hasClass('o-ui-blocked');
            if (!anchorIsInDocument || uiIsBlocked) {
                // trigger is no longer in the DOM, or UI is now blocked, so run the same step again
                self._deactivateTip(self.activeTooltips[tourName]);
                self._toNextStep(tourName, 0);
                self.update();
                return;
            }
            var actionHelper = new RunningTourActionHelper(tip.widget);
            doBeforeUnload(self._consumeTip.bind(self, tip, tourName));

            var tour = self.tours[tourName];
            if (typeof tip.run === "function") {
                tip.run.call(tip.widget, actionHelper);
            } else if (tip.run !== undefined) {
                var m = tip.run.match(/^([a-zA-Z0-9_]+) *(?:\(? *(.+?) *\)?)?$/);
                actionHelper[m[1]](m[2]);
            } else if (tour.currentStep === tour.steps.length - 1) {
                console.log('Tour %s: ignoring action (auto) of last step', tourName);
            } else {
                actionHelper.auto();
            }
        }
    },
    stepUtils: new TourStepUtils(this)
});
});
