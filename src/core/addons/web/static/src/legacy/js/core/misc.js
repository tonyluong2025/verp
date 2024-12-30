verp.define('web.framework', function (require) {
"use strict";

var core = require('web.core');
var ajax = require('web.ajax');
var Widget = require('web.Widget');
const {sprintf} = require('web.utils')

var _t = core._t;

var messagesBySeconds = function() {
    return [
        [0, _t("Loading...")],
        [20, _t("Still loading...")],
        [60, _t("Still loading...<br />Please be patient.")],
        [120, _t("Don't leave yet,<br />it's still loading...")],
        [300, _t("You may not believe it,<br />but the application is actually loading...")],
        [420, _t("Take a minute to get a coffee,<br />because it's loading...")],
        [3600, _t("Maybe you should consider reloading the application by pressing F5...")]
    ];
};

var Throbber = Widget.extend({
    template: "Throbber",
    start: function() {
        this.startTime = new Date().getTime();
        this.actMessage();
    },
    actMessage: function() {
        var self = this;
        setTimeout(function() {
            if (self.isDestroyed())
                return;
            var seconds = (new Date().getTime() - self.startTime) / 1000;
            var mes;
            _.each(messagesBySeconds(), function(el) {
                if (seconds >= el[0])
                    mes = el[1];
            });
            self.$(".oe-throbber-message").html(mes);
            self.actMessage();
        }, 1000);
    },
});

/** Setup blockui */
if ($.blockUI) {
    $.blockUI.defaults.baseZ = 1100;
    $.blockUI.defaults.message = '<div class="verp oe-blockui-spin-container" style="background-color: transparent;">';
    $.blockUI.defaults.css.border = '0';
    $.blockUI.defaults.css["background-color"] = '';
}


/**
 * Remove the "accesskey" attributes to avoid the use of the access keys
 * while the blockUI is enable.
 */

function blockAccessKeys() {
    var elementWithAccessKey = [];
    elementWithAccessKey = document.querySelectorAll('[accesskey]');
    _.each(elementWithAccessKey, function (elem) {
        elem.setAttribute("data-accesskey",elem.getAttribute('accesskey'));
        elem.removeAttribute('accesskey');
    });
}

function unblockAccessKeys() {
    var elementWithDataAccessKey = [];
    elementWithDataAccessKey = document.querySelectorAll('[data-accesskey]');
    _.each(elementWithDataAccessKey, function (elem) {
        elem.setAttribute('accesskey', elem.getAttribute('data-accesskey'));
        elem.removeAttribute('data-accesskey');
    });
}

var throbbers = [];

function blockUI() {
    var tmp = $.blockUI.apply($, arguments);
    var throbber = new Throbber();
    throbbers.push(throbber);
    throbber.appendTo($(".oe-blockui-spin-container"));
    $(document.body).addClass('o-ui-blocked');
    blockAccessKeys();
    return tmp;
}

function unblockUI() {
    _.invoke(throbbers, 'destroy');
    throbbers = [];
    $(document.body).removeClass('o-ui-blocked');
    unblockAccessKeys();
    return $.unblockUI.apply($, arguments);
}

/**
 * Redirect to url by replacing window.location
 * If wait is true, sleep 1s and wait for the server i.e. after a restart.
 */
function redirect (url, wait) {
    var load = function() {
        var old = "" + window.location;
        var oldNoHash = old.split("#")[0];
        var urlNoHash = url.split("#")[0];
        location.assign(url);
        if (oldNoHash === urlNoHash) {
            location.reload(true);
        }
    };

    var waitServer = function() {
        ajax.rpc("/web/webclient/versionInfo", {}).then(load).guardedCatch(function () {
            setTimeout(waitServer, 250);
        });
    };

    if (wait) {
        setTimeout(waitServer, 1000);
    } else {
        load();
    }
}

//  * Client action to reload the whole interface.
//  * If params.menuId, it opens the given menu entry.
//  * If params.wait, reload will wait the verp server to be reachable before reloading

function Reload(parent, action) {
    var params = action.params || {};
    var menuId = params.menuId || false;
    var l = window.location;

    var sobj = $.deparam(l.search.substr(1));
    if (params.urlSearch) {
        sobj = _.extend(sobj, params.urlSearch);
    }
    var search = '?' + $.param(sobj);

    var hash = l.hash;
    if (menuId) {
        hash = "#menuId=" + menuId;
    }
    var url = l.protocol + "//" + l.host + l.pathname + search + hash;

    // Clear cache
    core.bus.trigger('clearCache');

    redirect(url, params.wait);
}

core.actionRegistry.add("reload", Reload);


/**
 * Client action to go back home.
 */
function Home (parent, action) {
    var url = '/' + (window.location.search || '');
    redirect(url, action && action.params && action.params.wait);
}
core.actionRegistry.add("home", Home);

function login() {
    redirect('/web/login');
}
core.actionRegistry.add("login", login);

function logout() {
    redirect('/web/session/logout');
}
core.actionRegistry.add("logout", logout);

/**
 * @param {ActionManager} parent
 * @param {Object} action
 * @param {Object} action.params notification params
 * @see ServiceMixin.displayNotification
 */
function displayNotification(parent, action) {
    let {title='', message='', links=[], type='info', sticky=false, next} = action.params || {};
    links = links.map(({url, label}) => `<a href="${_.escape(url)}" target="_blank">${_.escape(label)}</a>`)
    parent.displayNotification({
        title, // no escape for the title because it is done in the template
        message: sprintf(_.escape(message), ...links),
        type,
        sticky,
        messageIsHtml: true, // dynamic parts of the message are escaped above
    });
    return next;
}
core.actionRegistry.add("displayNotification", displayNotification);

/**
 * Client action to refresh the session context (making sure
 * HTTP requests will have the right one) then reload the
 * whole interface.
 */
function ReloadContext (parent, action) {
    // side-effect of getSessionInfo is to refresh the session context
    ajax.rpc("/web/session/getSessionInfo", {}).then(function() {
        Reload(parent, action);
    });
}
core.actionRegistry.add("reloadContext", ReloadContext);

// In Internet Explorer, document doesn't have the contains method, so we make a
// polyfill for the method in order to be compatible.
if (!document.contains) {
    document.contains = function contains (node) {
        if (!(0 in arguments)) {
            throw new TypeError('1 argument is required');
        }

        do {
            if (this === node) {
                return true;
            }
        } while (node = node && node.parentNode);

        return false;
    };
}

return {
    blockUI: blockUI,
    unblockUI: unblockUI,
    redirect: redirect,
};

});
