verp.define('web.core', function (require) {
"use strict";

var Bus = require('web.Bus');
var config = require('web.config');
var Class = require('web.Class');
var QWeb = require('web.QWeb');
var Registry = require('web.Registry');
var translation = require('web.translation');

/**
 * Whether the client is currently in "debug" mode
 *
 * @type Boolean
 */
var bus = new Bus();

_.each('click,dblclick,keydown,keypress,keyup'.split(','), function (evtype) {
    $('html').on(evtype, function (ev) {
        bus.trigger(evtype, ev);
    });
});
_.each('resize,scroll'.split(','), function (evtype) {
    $(window).on(evtype, function (ev) {
        bus.trigger(evtype, ev);
    });
});

return {
    qweb: new QWeb(config.isDebug()),

    // core classes and functions
    Class: Class,
    bus: bus,
    mainBus: new Bus(),
    _t: translation._t,
    _lt: translation._lt,

    // registries
    actionRegistry: new Registry(),
    crashRegistry: new Registry(),
    serviceRegistry: new Registry(),
    /**
     * @type {String}
     */
    csrfToken: verp.csrfToken,
};

});
