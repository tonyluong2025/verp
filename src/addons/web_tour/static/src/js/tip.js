verp.define('web_tour.Tip', function (require) {
"use strict";

var config = require('web.config');
var core = require('web.core');
var Widget = require('web.Widget');
var _t = core._t;

var Tip = Widget.extend({
    template: "Tip",
    xmlDependencies: ['/web_tour/static/src/xml/tip.xml'],
    events: {
        click: '_onTipClicked',
        mouseenter: '_onMouseEnter',
        mouseleave: '_onMouseLeave',
        transitionend: '_onTransitionEnd',
    },
    CENTER_ON_TEXT_TAGS: ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'],

    /**
     * @param {Widget} parent
     * @param {Object} [info] description of the tip, containing the following keys:
     *  - content [String] the html content of the tip
     *  - eventHandlers [Object] description of optional event handlers to bind to the tip:
     *    - event [String] the event name
     *    - selector [String] the jQuery selector on which the event should be bound
     *    - handler [function] the handler
     *  - position [String] tip's position ('top', 'right', 'left' or 'bottom'), default 'right'
     *  - width [int] the width in px of the tip when opened, default 270
     *  - space [int] space in px between anchor and tip, default to 0, added to
     *    the natural space chosen in css
     *  - hidden [boolean] if true, the tip won't be visible (but the handlers will still be
     *    bound on the anchor, so that the tip is consumed if the user clicks on it)
     *  - overlay [Object] x and y values for the number of pixels the mouseout detection area
     *    overlaps the opened tip, default {x: 50, y: 50}
     */
    init: function(parent, info) {
        this._super(parent);
        this.info = _.defaults(info, {
            position: "right",
            width: 270,
            space: 0,
            overlay: {
                x: 50,
                y: 50,
            },
            content: _t("Click here to go to the next step."),
            scrollContent: _t("Scroll to reach the next step."),
        });
        this.position = {
            top: "50%",
            left: "50%",
        };
        this.initialPosition = this.info.position;
        this.viewPortState = 'in';
        this._onAncestorScroll = _.throttle(this._onAncestorScroll, 0.1);
    },
    /**
     * Attaches the tip to the provided $anchor and $altAnchor.
     * $altAnchor is an alternative trigger that can consume the step. The tip is
     * however only displayed on the $anchor.
     *
     * Note that the returned promise stays pending if the Tip widget was
     * destroyed in the meantime.
     *
     * @param {jQuery} $anchor the node on which the tip should be placed
     * @param {jQuery} $altAnchor an alternative node that can consume the step
     * @return {Promise}
     */
    attachTo: async function ($anchor, $altAnchor) {
        this._setupAnchor($anchor, $altAnchor);

        this.isAnchorFixedPosition = this.$anchor.css("position") === "fixed";

        // The body never needs to have the o-tooltip-parent class. It is a
        // safe place to put the tip in the DOM at initialization and be able
        // to compute its dimensions and reposition it if required.
        await this.appendTo(document.body);
        if (this.isDestroyed()) {
            return new Promise(() => {});
        }
    },
    start() {
        this.$tooltipOverlay = this.$(".o-tooltip-overlay");
        this.$tooltipContent = this.$(".o-tooltip-content");
        this.initWidth = this.$el.outerWidth();
        this.initHeight = this.$el.outerHeight();
        this.$el.addClass('active');
        this.el.style.setProperty('width', `${this.info.width}px`, 'important');
        this.el.style.setProperty('height', 'auto', 'important');
        this.el.style.setProperty('transition', 'none', 'important');
        this.contentWidth = this.$el.outerWidth(true);
        this.contentHeight = this.$el.outerHeight(true);
        this.$tooltipContent.html(this.info.scrollContent);
        this.scrollContentWidth = this.$el.outerWidth(true);
        this.scrollContentHeight = this.$el.outerHeight(true);
        this.$el.removeClass('active');
        this.el.style.removeProperty('width');
        this.el.style.removeProperty('height');
        this.el.style.removeProperty('transition');
        this.$tooltipContent.html(this.info.content);
        this.$window = $(window);

        this.$tooltipContent.css({
            width: "100%",
            height: "100%",
        });

        _.each(this.info.eventHandlers, data => {
            this.$tooltipContent.on(data.event, data.selector, data.handler);
        });

        this._bindAnchorEvents();
        this._updatePosition(true);

        this.$el.toggleClass('d-none', !!this.info.hidden);
        this.el.classList.add('o-tooltip-visible');
        core.bus.on("resize", this, _.debounce(function () {
            if (this.isDestroyed()) {
                // Because of the debounce, destroy() might have been called in the meantime.
                return;
            }
            if (this.tipOpened) {
                this._toBubbleMode(true);
            } else {
                this._reposition();
            }
        }, 500));

        return this._super.apply(this, arguments);
    },
    destroy: function () {
        this._unbindAnchorEvents();
        clearTimeout(this.timerIn);
        clearTimeout(this.timerOut);
        // clear this timeout so that we won't call _updatePosition after we
        // destroy the widget and leave an undesired bubble.
        clearTimeout(this._transitionEndTimer);

        // Do not remove the parent class if it contains other tooltips
        const _removeParentClass = $el => {
            if ($el.children(".o-tooltip").not(this.$el[0]).length === 0) {
                $el.removeClass("o-tooltip-parent");
            }
        };
        if (this.$el && this.$idealLocation) {
            _removeParentClass(this.$idealLocation);
        }
        if (this.$el && this.$furtherIdealLocation) {
            _removeParentClass(this.$furtherIdealLocation);
        }

        return this._super.apply(this, arguments);
    },
    /**
     * Updates the $anchor and $altAnchor the tip is attached to.
     * $altAnchor is an alternative trigger that can consume the step. The tip is
     * however only displayed on the $anchor.
     *
     * @param {jQuery} $anchor the node on which the tip should be placed
     * @param {jQuery} $altAnchor an alternative node that can consume the step
     */
    update: function ($anchor, $altAnchor) {
        // We unbind/rebind events on each update because we support widgets
        // detaching and re-attaching nodes to their DOM element without keeping
        // the initial event handlers, with said node being potential tip
        // anchors (e.g. FieldMonetary > input element).
        this._unbindAnchorEvents();
        if (!$anchor.is(this.$anchor)) {
            this._setupAnchor($anchor, $altAnchor);
        }
        this._bindAnchorEvents();
        if (!this.$el) {
            // Ideally this case should not happen but this is still possible,
            // as update may be called before the `start` method is called.
            // The `start` method is calling _updatePosition too anyway.
            return;
        }
        this._delegateEvents();
        this._updatePosition(true);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @return {boolean} true if tip is visible
     */
    isShown() {
        return this.el && !this.info.hidden;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Sets the $anchor and $altAnchor the tip is attached to.
     * $altAnchor is an alternative trigger that can consume the step. The tip is
     * however only displayed on the $anchor.
     *
     * @param {jQuery} $anchor the node on which the tip should be placed
     * @param {jQuery} $altAnchor an alternative node that can consume the step
     */
    _setupAnchor: function ($anchor, $altAnchor) {
        this.$anchor = $anchor;
        this.$altAnchor = $altAnchor;
        this.$idealLocation = this._getIdealLocation();
        this.$furtherIdealLocation = this._getIdealLocation(this.$idealLocation);
    },
    /**
     * Figures out which direction the tip should take and if it is at the
     * bottom or the top of the targeted element or if it's an indicator to
     * scroll. Relocates and repositions if necessary.
     *
     * @private
     * @param {boolean} [forceReposition=false]
     */
    _updatePosition: function (forceReposition = false) {
        if (this.info.hidden) {
            return;
        }
        if (this.isDestroyed()) {
            // TODO This should not be needed if the chain of events leading
            // here was fully cancelled by destroy().
            return;
        }
        let halfHeight = 0;
        if (this.initialPosition === 'right' || this.initialPosition === 'left') {
            halfHeight = this.$anchor.innerHeight() / 2;
        }

        const paddingTop = parseInt(this.$idealLocation.css('padding-top'));
        const topViewport = window.pageYOffset + paddingTop;
        const botViewport = window.pageYOffset + window.innerHeight;
        const topOffset = this.$anchor.offset().top;
        const botOffset = topOffset + this.$anchor.innerHeight();

        // Check if the viewport state change to know if we need to move the anchor of the tip.
        // up : the target element is above the current viewport
        // down : the target element is below the current viewport
        // in : the target element is in the current viewport
        let viewPortState = 'in';
        let position = this.info.position;
        if (botOffset - halfHeight < topViewport) {
            viewPortState = 'up';
            position = 'bottom';
        } else if (topOffset + halfHeight > botViewport) {
            viewPortState = 'down';
            position = 'top';
        } else {
            // Adjust the placement of the tip regarding its anchor depending
            // if we came from the bottom or the top.
            if (topOffset < topViewport + this.$el.innerHeight()) {
                position = halfHeight ? this.initialPosition : "bottom";
            } else if (botOffset > botViewport - this.$el.innerHeight()) {
                position = halfHeight ? this.initialPosition : "top";
            }
        }

        // If the direction or the anchor change : The tip position is updated.
        if (forceReposition || this.info.position !== position || this.viewPortState !== viewPortState) {
            this.$el.removeClass('top right bottom left').addClass(position);
            this.viewPortState = viewPortState;
            this.info.position = position;
            let $location;
            if (this.viewPortState === 'in') {
                this.$tooltipContent.html(this.info.content);
                $location = this.$idealLocation;
            } else {
                this.$tooltipContent.html(this.info.scrollContent);
                $location = this.$furtherIdealLocation;
            }
            // Update o-tooltip-parent class and tip DOM location. Note:
            // important to only remove/add the class when necessary to not
            // notify a DOM mutation which could retrigger this function.
            const $oldLocation = this.$el.parent();
            if (!this.tipOpened) {
                if (!$location.is($oldLocation)) {
                    $oldLocation.removeClass('o-tooltip-parent');
                    const cssPosition = $location.css("position");
                    if (cssPosition === "static" || cssPosition === "relative") {
                        $location.addClass("o-tooltip-parent");
                    }
                    this.$el.appendTo($location);
                }
                this._reposition();
            }
        }
    },
    _getIdealLocation: function ($anchor = this.$anchor) {
        var $location = this.info.location ? $(this.info.location) : $anchor;
        if ($location.is("html,body")) {
            return $(document.body);
        }

        var o;
        var p;
        do {
            $location = $location.parent();
            o = $location.css("overflow");
            p = $location.css("position");
        } while (
            $location.hasClass('dropdown-menu') ||
            $location.hasClass('o-notebook-headers') ||
            $location.hasClass('o-forbidden-tooltip-parent') ||
            (
                (o === "visible" || o.includes("hidden")) && // Possible case where the overflow = "hidden auto"
                p !== "fixed" &&
                $location[0].tagName.toUpperCase() !== 'BODY'
            )
        );

        return $location;
    },
    _reposition: function () {
        this.$el.removeClass("o-animated");

        // Reverse left/right position if direction is right to left
        var appendAt = this.info.position;
        var rtlMap = {left: 'right', right: 'left'};
        if (rtlMap[appendAt] && _t.database.parameters.direction === 'rtl') {
            appendAt = rtlMap[appendAt];
        }

        // Get the correct tip's position depending of the tip's state
        let $parent = this.$idealLocation;
        if ($parent.is('html,body') && this.viewPortState !== "in") {
            this.el.style.setProperty('position', 'fixed', 'important');
        } else {
            this.el.style.removeProperty('position');
        }

        if (this.viewPortState === 'in') {
            this.$el.position({
                my: this._getSpacedInvertedPosition(appendAt),
                at: appendAt,
                of: this.$anchor,
                collision: "none",
                using: props => {
                    const {top} = props;
                    let {left} = props;
                    const anchorEl = this.$anchor[0];
                    if (this.CENTER_ON_TEXT_TAGS.includes(anchorEl.nodeName) && anchorEl.hasChildNodes()) {
                        const textContainerWidth = anchorEl.getBoundingClientRect().width;
                        const textNode = anchorEl.firstChild;
                        const range = document.createRange();
                        range.selectNodeContents(textNode);
                        const textWidth = range.getBoundingClientRect().width;

                        const alignment = window.getComputedStyle(anchorEl).getPropertyValue('text-align');
                        const posVertical = (this.info.position === 'top' || this.info.position === 'bottom');
                        if (alignment === 'left') {
                            if (posVertical) {
                                left = left - textContainerWidth / 2 + textWidth / 2;
                            } else if (this.info.position === 'right') {
                                left = left - textContainerWidth + textWidth;
                            }
                        } else if (alignment === 'right') {
                            if (posVertical) {
                                left = left + textContainerWidth / 2 - textWidth / 2;
                            } else if (this.info.position === 'left') {
                                left = left + textContainerWidth - textWidth;
                            }
                        } else if (alignment === 'center') {
                            if (this.info.position === 'left') {
                                left = left + textContainerWidth / 2 - textWidth / 2;
                            } else if (this.info.position === 'right') {
                                left = left - textContainerWidth / 2 + textWidth / 2;
                            }
                        }
                    }
                    this.el.style.setProperty('top', `${top}px`, 'important');
                    this.el.style.setProperty('left', `${left}px`, 'important');
                },
            });
        } else {
            const paddingTop = parseInt($parent.css('padding-top'));
            const paddingLeft = parseInt($parent.css('padding-left'));
            const paddingRight = parseInt($parent.css('padding-right'));
            const topPosition = $parent[0].offsetTop;
            const center = (paddingLeft + paddingRight) + ((($parent[0].clientWidth - (paddingLeft + paddingRight)) / 2) - this.$el[0].offsetWidth / 2);
            let top;
            if (this.viewPortState === 'up') {
                top = topPosition + this.$el.innerHeight() + paddingTop;
            } else {
                top = topPosition + $parent.innerHeight() - this.$el.innerHeight() * 2;
            }
            this.el.style.setProperty('top', `${top}px`, 'important');
            this.el.style.setProperty('left', `${center}px`, 'important');
        }

        // Reverse overlay if direction is right to left
        var positionRight = _t.database.parameters.direction === 'rtl' ? "right" : "left";
        var positionLeft = _t.database.parameters.direction === 'rtl' ? "left" : "right";

        // get the offset position of this.$el
        // Couldn't use offset() or position() because their values are not the desired ones in all cases
        const offset = {top: this.$el[0].offsetTop, left: this.$el[0].offsetLeft};
        this.$tooltipOverlay.css({
            top: -Math.min((this.info.position === "bottom" ? this.info.space : this.info.overlay.y), offset.top),
            right: -Math.min((this.info.position === positionRight ? this.info.space : this.info.overlay.x), this.$window.width() - (offset.left + this.initWidth)),
            bottom: -Math.min((this.info.position === "top" ? this.info.space : this.info.overlay.y), this.$window.height() - (offset.top + this.initHeight)),
            left: -Math.min((this.info.position === positionLeft ? this.info.space : this.info.overlay.x), offset.left),
        });
        this.position = offset;

        this.$el.addClass("o-animated");
    },
    _bindAnchorEvents: function () {
        // The consumeEvent taken for RunningTourActionHelper is the one of $anchor and not $altAnchor.
        this.consumeEvent = this.info.consumeEvent || Tip.getConsumeEventType(this.$anchor, this.info.run);
        this.$consumeEventAnchors = this._getAnchorAndCreateEvent(this.consumeEvent, this.$anchor);
        if (this.$altAnchor.length) {
            const consumeEvent  = this.info.consumeEvent || Tip.getConsumeEventType(this.$altAnchor, this.info.run);
            this.$consumeEventAnchors = this.$consumeEventAnchors.add(
                this._getAnchorAndCreateEvent(consumeEvent, this.$altAnchor)
            );
        }
        this.$anchor.on('mouseenter.anchor', () => this._toInfoMode());
        this.$anchor.on('mouseleave.anchor', () => this._toBubbleMode());

        this.$scrolableElement = this.$idealLocation.is('html,body') ? $(window) : this.$idealLocation;
        this.$scrolableElement.on('scroll.Tip', () => this._onAncestorScroll());
    },
    /**
     * Gets the anchor corresponding to the provided arguments and attaches the
     * event to the $anchor in order to consume the step accordingly.
     *
     * @private
     * @param {String} consumeEvent
     * @param {jQuery} $anchor the node on which the tip should be placed
     * @return {jQuery}
     */
    _getAnchorAndCreateEvent: function(consumeEvent, $anchor) {
        let $consumeEventAnchors = $anchor;
        if (consumeEvent === "drag") {
            // jQuery-ui draggable triggers 'drag' events on the .ui-draggable element,
            // but the tip is attached to the .ui-draggable-handle element which may
            // be one of its children (or the element itself)
            $consumeEventAnchors = $anchor.closest('.ui-draggable');
        } else if (consumeEvent === "input" && !$anchor.is('textarea, input')) {
            $consumeEventAnchors = $anchor.closest("[contenteditable='true']");
        } else if (consumeEvent.includes('apply.daterangepicker')) {
            $consumeEventAnchors = $anchor.parent().children('.o-field-date-range');
        } else if (consumeEvent === "sort") {
            // when an element is dragged inside a sortable container (with classname
            // 'ui-sortable'), jQuery triggers the 'sort' event on the container
            $consumeEventAnchors = $anchor.closest('.ui-sortable');
        }
        $consumeEventAnchors.on(consumeEvent + ".anchor", (function (e) {
            if (e.type !== "mousedown" || e.which === 1) { // only left click
                if (this.info.consumeVisibleOnly && !this.isShown()) {
                    // Do not consume non-displayed tips.
                    return;
                }
                this.trigger("tipConsumed");
                this._unbindAnchorEvents();
            }
        }).bind(this));
        return $consumeEventAnchors;
    },
    _unbindAnchorEvents: function () {
        if (this.$anchor) {
            this.$anchor.off(".anchor");
        }
        if (this.$consumeEventAnchors) {
            this.$consumeEventAnchors.off(".anchor");
        }
        if (this.$scrolableElement) {
            this.$scrolableElement.off('.Tip');
        }
    },
    _getSpacedInvertedPosition: function (position) {
        if (position === "right") return "left+" + this.info.space;
        if (position === "left") return "right-" + this.info.space;
        if (position === "bottom") return "top+" + this.info.space;
        return "bottom-" + this.info.space;
    },
    _toInfoMode: function (force) {
        if (this.timerOut !== undefined) {
            clearTimeout(this.timerOut);
            this.timerOut = undefined;
            return;
        }
        if (this.tipOpened) {
            return;
        }

        if (force === true) {
            this._buildInfoMode();
        } else {
            this.timerIn = setTimeout(this._buildInfoMode.bind(this), 100);
        }
    },
    _buildInfoMode: function () {
        clearTimeout(this.timerIn);
        this.timerIn = undefined;

        this.tipOpened = true;

        var offset = this.$el.offset();

        // When this.$el doesn't have any parents, it means that the tip is no
        // longer in the DOM and so, it shouldn't be open. It happens when the
        // tip is opened after being destroyed.
        if (!this.$el.parent().length) {
            return;
        }

        if (this.$el.parent()[0] !== this.$el[0].ownerDocument.body) {
            this.$el.detach();
            this.el.style.setProperty('top', `${offset.top}px`, 'important');
            this.el.style.setProperty('left', `${offset.left}px`, 'important');
            this.$el.appendTo(this.$el[0].ownerDocument.body);
        }

        var mbLeft = 0;
        var mbTop = 0;
        var overflow = false;
        var posVertical = (this.info.position === "top" || this.info.position === "bottom");
        if (posVertical) {
            overflow = (offset.left + this.contentWidth + this.info.overlay.x > this.$window.width());
        } else {
            overflow = (offset.top + this.contentHeight + this.info.overlay.y > this.$window.height());
        }
        if (posVertical && overflow || this.info.position === "left" || (_t.database.parameters.direction === 'rtl' && this.info.position == "right")) {
            mbLeft -= (this.contentWidth - this.initWidth);
        }
        if (!posVertical && overflow || this.info.position === "top") {
            mbTop -= (this.viewPortState === 'down') ? this.initHeight - 5 : (this.contentHeight - this.initHeight);
        }


        const [contentWidth, contentHeight] = this.viewPortState === 'in'
            ? [this.contentWidth, this.contentHeight]
            : [this.scrollContentWidth, this.scrollContentHeight];
        this.$el.toggleClass("inverse", overflow);
        this.$el.removeClass("o-animated").addClass("active");
        this.el.style.setProperty('width', `${contentWidth}px`, 'important');
        this.el.style.setProperty('height', `${contentHeight}px`, 'important');
        this.el.style.setProperty('margin-left', `${mbLeft}px`, 'important');
        this.el.style.setProperty('margin-top', `${mbTop}px`, 'important');

        this._transitionEndTimer = setTimeout(() => this._onTransitionEnd(), 400);
    },
    _toBubbleMode: function (force) {
        if (this.timerIn !== undefined) {
            clearTimeout(this.timerIn);
            this.timerIn = undefined;
            return;
        }
        if (!this.tipOpened) {
            return;
        }

        if (force === true) {
            this._buildBubbleMode();
        } else {
            this.timerOut = setTimeout(this._buildBubbleMode.bind(this), 300);
        }
    },
    _buildBubbleMode: function () {
        clearTimeout(this.timerOut);
        this.timerOut = undefined;

        this.tipOpened = false;
        this.$el.removeClass("active").addClass("o-animated");
        this.el.style.setProperty('width', `${this.initWidth}px`, 'important');
        this.el.style.setProperty('height', `${this.initHeight}px`, 'important');
        this.el.style.setProperty('margin', '0', 'important');

        this._transitionEndTimer = setTimeout(() => this._onTransitionEnd(), 400);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onAncestorScroll: function () {
        if (this.tipOpened) {
            this._toBubbleMode(true);
        } else {
            this._updatePosition(true);
        }
    },
    /**
     * @private
     */
    _onMouseEnter: function () {
        this._toInfoMode();
    },
    /**
     * @private
     */
    _onMouseLeave: function () {
        this._toBubbleMode();
    },
    /**
     * On touch devices, closes the tip when clicked.
     *
     * Also stop propagation to avoid undesired behavior, such as the kanban
     * quick create closing when the user clicks on the tooltip.
     *
     * @private
     * @param {MouseEvent} ev
     */
    _onTipClicked: function (ev) {
        if (config.device.touch && this.tipOpened) {
            this._toBubbleMode();
        }

        ev.stopPropagation();
    },
    /**
     * @private
     */
    _onTransitionEnd: function () {
        if (this._transitionEndTimer) {
            clearTimeout(this._transitionEndTimer);
            this._transitionEndTimer = undefined;
            if (!this.tipOpened) {
                this._updatePosition(true);
            }
        }
    },
});

/**
 * @static
 * @param {jQuery} $element
 * @param {string} [run] the run parameter of the tip (only strings are useful)
 */
Tip.getConsumeEventType = function ($element, run) {
    if ($element.hasClass('o-field-many2one') || $element.hasClass('o-field-many2manytags')) {
        return 'autocompleteselect';
    } else if ($element.is("textarea") || $element.filter("input").is(function () {
        var type = $(this).attr("type");
        return !type || !!type.match(/^(email|number|password|search|tel|text|url)$/);
    })) {
        // FieldDaterange triggers a special event when using the widget
        if ($element.hasClass("o-field-date-range")) {
            return "apply.daterangepicker input";
        }
        if (config.device.isMobile &&
            $element.closest('.o-field-widget').is('.o-field-many2one, .o-field-many2many')) {
            return "click";
        }
        return "input";
    } else if ($element.hasClass('ui-draggable-handle')) {
        return "drag";
    } else if (typeof run === 'string' && run.indexOf('dragAndDrop') === 0) {
        // this is a heuristic: the element has to be dragged and dropped but it
        // doesn't have class 'ui-draggable-handle', so we check if it has an
        // ui-sortable parent, and if so, we conclude that its event type is 'sort'
        if ($element.closest('.ui-sortable').length) {
            return 'sort';
        }
    }
    return "click";
};

return Tip;

});
