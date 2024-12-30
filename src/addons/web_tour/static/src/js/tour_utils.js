verp.define('web_tour.utils', function(require) {
"use strict";

function getStepKey(name) {
    return 'tour_' + name + '_step';
}

function getRunningKey() {
    return 'runningTour';
}

function getDebuggingKey(name) {
    return `debuggingTour_${name}`;
}

function getRunningDelayKey() {
    return getRunningKey() + "_delay";
}

function getFirstVisibleElement($elements) {
    for (var i = 0 ; i < $elements.length ; i++) {
        var $i = $elements.eq(i);
        if ($i.is(':visible:hasVisibility')) {
            return $i;
        }
    }
    return $();
}

function doBeforeUnload(ifUnloadCallback, ifNotUnloadCallback) {
    ifUnloadCallback = ifUnloadCallback || function () {};
    ifNotUnloadCallback = ifNotUnloadCallback || ifUnloadCallback;

    var oldBefore = window.onbeforeunload;
    var reloadTimeout;
    window.onbeforeunload = function () {
        clearTimeout(reloadTimeout);
        window.onbeforeunload = oldBefore;
        ifUnloadCallback();
        if (oldBefore) return oldBefore.apply(this, arguments);
    };
    reloadTimeout = _.defer(function () {
        window.onbeforeunload = oldBefore;
        ifNotUnloadCallback();
    });
}

function getJqueryElementFromSelector(selector) {
    if (_.isString(selector) && selector.indexOf('iframe') !== -1) {
        var $iframe = $(selector.split('iframe')[0] + ' iframe');
        var $el = $iframe.contents()
            .find(selector.split('iframe')[1]);
        $el.iframeContainer = $iframe[0];
        return $el;
    } else {
        return $(selector);
    }
}


return {
    getDebuggingKey: getDebuggingKey,
    'getStepKey': getStepKey,
    'getRunningKey': getRunningKey,
    'getRunningDelayKey': getRunningDelayKey,
    'getFirstVisibleElement': getFirstVisibleElement,
    'doBeforeUnload': doBeforeUnload,
    'getJqueryElementFromSelector' : getJqueryElementFromSelector,
};

});

