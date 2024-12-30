
verp.define('web_tour.RunningTourActionHelper', function (require) {
"use strict";

var core = require('web.core');
var utils = require('web_tour.utils');
var Tip = require('web_tour.Tip');

var getFirstVisibleElement = utils.getFirstVisibleElement;
var getJqueryElementFromSelector = utils.getJqueryElementFromSelector;

var RunningTourActionHelper = core.Class.extend({
    init: function (tipWidget) {
        this.tipWidget = tipWidget;
    },
    click: function (element) {
        this._click(this._getActionValues(element));
    },
    dblclick: function (element) {
        this._click(this._getActionValues(element), 2);
    },
    tripleclick: function (element) {
        this._click(this._getActionValues(element), 3);
    },
    clicknoleave: function (element) {
        this._click(this._getActionValues(element), 1, false);
    },
    text: function (text, element) {
        this._text(this._getActionValues(element), text);
    },
    removeText(text, element) {
        this._text(this._getActionValues(element), '\n');
    },
    textBlur: function (text, element) {
        this._textBlur(this._getActionValues(element), text);
    },
    dragAndDrop: function (to, element) {
        this._dragAndDrop(this._getActionValues(element), to);
    },
    keydown: function (keyCodes, element) {
        this._keydown(this._getActionValues(element), keyCodes.split(/[,\s]+/));
    },
    auto: function (element) {
        var values = this._getActionValues(element);
        if (values.consumeEvent === "input") {
            this._text(values);
        } else {
            this._click(values);
        }
    },
    _getActionValues: function (element) {
        var $e = getJqueryElementFromSelector(element);
        var $element = element ? getFirstVisibleElement($e) : this.tipWidget.$anchor;
        if ($element.length === 0) {
            $element = $e.first();
        }
        var consumeEvent = element ? Tip.getConsumeEventType($element) : this.tipWidget.consumeEvent;
        return {
            $element: $element,
            consumeEvent: consumeEvent,
        };
    },
    _click: function (values, nb, leave) {
        triggerMouseEvent(values.$element, "mouseover");
        values.$element.trigger("mouseenter");
        for (var i = 1 ; i <= (nb || 1) ; i++) {
            triggerMouseEvent(values.$element, "mousedown");
            triggerMouseEvent(values.$element, "mouseup");
            triggerMouseEvent(values.$element, "click", i);
            if (i % 2 === 0) {
                triggerMouseEvent(values.$element, "dblclick");
            }
        }
        if (leave !== false) {
            triggerMouseEvent(values.$element, "mouseout");
            values.$element.trigger("mouseleave");
        }

        function triggerMouseEvent($element, type, count) {
            var e = document.createEvent("MouseEvents");
            e.initMouseEvent(type, true, true, window, count || 0, 0, 0, 0, 0, false, false, false, false, 0, $element[0]);
            $element[0].dispatchEvent(e);
        }
    },
    _text: function (values, text) {
        this._click(values);

        text = text || "Test";
        if (values.consumeEvent === "input") {
            values.$element
                .trigger({ type: 'keydown', key: text[text.length - 1] })
                .val(text)
                .trigger({ type: 'keyup', key: text[text.length - 1] });
            values.$element[0].dispatchEvent(new InputEvent('input', {
                bubbles: true,
            }));
        } else if (values.$element.is("select")) {
            var $options = values.$element.children("option");
            $options.prop("selected", false).removeProp("selected");
            var $selectedOption = $options.filter(function () { return $(this).val() === text; });
            if ($selectedOption.length === 0) {
                $selectedOption = $options.filter(function () { return $(this).text().trim() === text; });
            }
            $selectedOption.prop("selected", true);
            this._click(values);
        } else {
            values.$element.focusIn();
            values.$element.trigger($.Event( "keydown", {key: '_', keyCode: 95}));
            values.$element.text(text).trigger("input");
            values.$element.focusInEnd();
            values.$element.trigger($.Event( "keyup", {key: '_', keyCode: 95}));
        }
        values.$element.trigger("change");
    },
    _textBlur: function (values, text) {
        this._text(values, text);
        values.$element.trigger('focusout');
        values.$element.trigger('blur');
    },
    _dragAndDrop: function (values, to) {
        var $to;
        var elementCenter = values.
        $element.offset();
        elementCenter.left += values.$element.outerWidth() / 2;
        elementCenter.top += values.$element.outerHeight() / 2;
        if (to) {
            $to = getJqueryElementFromSelector(to);
        } else {
            $to = $(document.body);
        }

        const calculateCenter = () => {
            const toCenter = $to.offset();

            if (to && to.indexOf('iframe') !== -1) {
                const iFrameOffset = $('iframe').offset();
                toCenter.left += iFrameOffset.left;
                toCenter.top += iFrameOffset.top;
            }
            toCenter.left += $to.outerWidth() / 2;
            toCenter.top += $to.outerHeight() / 2;
            return toCenter;
        };

        values.$element.trigger($.Event("mouseenter"));
        values.$element.trigger($.Event("mousedown", {which: 1, pageX: elementCenter.left, pageY: elementCenter.top}));
        // Some tests depends on elements present only when the element to drag
        // start to move while some other tests break while moving.
        if (!$to.length) {
            values.$element.trigger($.Event("mousemove", {which: 1, pageX: elementCenter.left + 1, pageY: elementCenter.top}));
            $to = getJqueryElementFromSelector(to);
        }

        let toCenter = calculateCenter();
        values.$element.trigger($.Event("mousemove", {which: 1, pageX: toCenter.left, pageY: toCenter.top}));
        // Recalculate the center as the mousemove might have made the element bigger.
        toCenter = calculateCenter();
        values.$element.trigger($.Event("mouseup", {which: 1, pageX: toCenter.left, pageY: toCenter.top}));
     },
    _keydown: function (values, keyCodes) {
        while (keyCodes.length) {
            const eventOptions = {};
            const keyCode = keyCodes.shift();
            let insertedText = null;
            if (isNaN(keyCode)) {
                eventOptions.key = keyCode;
            } else {
                const code = parseInt(keyCode, 10);
                eventOptions.keyCode = code;
                eventOptions.which = code;
                if (
                    code === 32 || // spacebar
                    (code > 47 && code < 58) || // number keys
                    (code > 64 && code < 91) || // letter keys
                    (code > 95 && code < 112) || // numpad keys
                    (code > 185 && code < 193) || // ;=,-./` (in order)
                    (code > 218 && code < 223) // [\]' (in order))
                ) {
                    insertedText = String.fromCharCode(code);
                }
            }
            values.$element.trigger(Object.assign({ type: "keydown" }, eventOptions));
            if (insertedText) {
                document.execCommand("insertText", 0, insertedText);
            }
            values.$element.trigger(Object.assign({ type: "keyup" }, eventOptions));
        }
    },
});

return RunningTourActionHelper;
});
