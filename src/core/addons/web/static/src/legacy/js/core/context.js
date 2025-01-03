verp.define('web.Context', function (require) {
"use strict";

var Class = require('web.Class');
var vjUtils = require('web.vjUtils');

var Context = Class.extend({
    init: function () {
        this.__ref = "compoundContext";
        this.__contexts = [];
        this.__evalContext = null;
        var self = this;
        _.each(arguments, function (x) {
            self.add(x);
        });
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    add: function (context) {
        this.__contexts.push(context);
        return this;
    },
    eval: function () {
        return vjUtils.eval('context', this);
    },
    /**
     * Set the evaluation context to be used when we actually eval.
     *
     * @param {Object} evalContext
     * @returns {Context}
     */
    setEvalContext: function (evalContext) {
        // a special case needs to be done for moment objects.  Dates are
        // internally represented by a moment object, but they need to be
        // converted to the server format before being sent. We call the toJSON
        // method, because it returns the date with the format required by the
        // server
        for (var key in evalContext) {
            if (evalContext[key] instanceof moment) {
                evalContext[key] = evalContext[key].toJSON();
            }
        }
        this.__evalContext = evalContext;
        return this;
    },
});

return Context;

});
