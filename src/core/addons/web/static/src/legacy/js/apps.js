verp.define('web.Apps', function (require) {
"use strict";

var AbstractAction = require('web.AbstractAction');
var config = require('web.config');
var core = require('web.core');
var framework = require('web.framework');
var session = require('web.session');

var _t = core._t;

var appsClient = null;

var Apps = AbstractAction.extend({
    contentTemplate: 'EmptyComponent',
    remoteActionTag: 'loempia.embed',
    failbackActionId: 'base.openModuleTree',

    init: function(parent, action) {
        this._super(parent, action);
        var options = action.params || {};
        this.params = options;  // NOTE forwarded to embedded client action
    },

    getClient: function() {
        // return the client via a promise, resolved or rejected depending if
        // the remote host is available or not.
        var checkClientAvailable = function(client) {
            var i = new Image();
            var def = new Promise(function (resolve, reject) {
                i.onerror = function() {
                    reject(client);
                };
                i.onload = function() {
                    resolve(client);
                };
            });
            var ts = new Date().getTime();
            i.src = _.str.sprintf('%s/web/static/src/img/sep-a.gif?%s', client.origin, ts);
            return def;
        };
        if (appsClient) {
            return checkClientAvailable(appsClient);
        } else {
            return this._rpc({model: 'ir.module.module', method: 'getAppsServer'})
                .then(function(u) {
                    var link = $(_.str.sprintf('<a href="%s"></a>', u))[0];
                    var host = _.str.sprintf('%s//%s', link.protocol, link.host);
                    var dbname = link.pathname;
                    if (dbname[0] === '/') {
                        dbname = dbname.substr(1);
                    }
                    var client = {
                        origin: host,
                        dbname: dbname
                    };
                    appsClient = client;
                    return checkClientAvailable(client);
                });
        }
    },

    destroy: function() {
        $(window).off("message." + this.uniq);
        if (this.$ifr) {
            this.$ifr.remove();
            this.$ifr = null;
        }
        return this._super();
    },

    _onMessage: function($e) {
        var self = this, client = this.client, e = $e.originalEvent;

        if (e.origin !== client.origin) {
            return;
        }

        var dispatcher = {
            'event': function(m) { self.trigger('message:' + m.event, m); },
            'action': function(m) {
                self.doAction(m.action).then(function(r) {
                    var w = self.$ifr[0].contentWindow;
                    w.postMessage({id: m.id, result: r}, client.origin);
                });
            },
            'rpc': function(m) {
                return self._rpc({route: m.args[0], params: m.args[1]}).then(function(r) {
                    var w = self.$ifr[0].contentWindow;
                    w.postMessage({id: m.id, result: r}, client.origin);
                });
            },
            'Model': function(m) {
                return self._rpc({model: m.model, method: m.args[0], args: m.args[1]})
                    .then(function(r) {
                        var w = self.$ifr[0].contentWindow;
                        w.postMessage({id: m.id, result: r}, client.origin);
                    });
            },
        };
        // console.log(e.data);
        if (!_.isObject(e.data)) { return; }
        if (dispatcher[e.data.type]) {
            dispatcher[e.data.type](e.data);
        }
    },

    start: function() {
        var self = this;
        return new Promise(function (resolve, reject) {
            self.getClient().then(function (client) {
                self.client = client;

                var qs = {db: client.dbname};
                if (config.isDebug()) {
                    qs.debug = verp.debug;
                }
                var u = $.param.querystring(client.origin + "/apps/embed/client", qs);
                var css = {width: '100%', height: '750px'};
                self.$ifr = $('<iframe>').attr('src', u);

                self.uniq = _.uniqueId('apps');
                $(window).on("message." + self.uniq, self.proxy('_onMessage'));

                self.on('message:ready', self, function(m) {
                    var w = this.$ifr[0].contentWindow;
                    var act = {
                        type: 'ir.actions.client',
                        tag: this.remoteActionTag,
                        params: _.extend({}, this.params, {
                            db: session.db,
                            origin: session.origin,
                        })
                    };
                    w.postMessage({type:'action', action: act}, client.origin);
                });

                self.on('message:setHeight', self, function(m) {
                    this.$ifr.height(m.height);
                });

                self.on('message:blockUI', self, function() { framework.blockUI(); });
                self.on('message:unblockUI', self, function() { framework.unblockUI(); });
                self.on('message:warn', self, function(m) {self.displayNotification({ title: m.title, message: m.message, sticky: m.sticky, type: 'danger' }); });

                self.$ifr.appendTo(self.$('.o-content')).css(css).addClass('apps-client');

                resolve();
            }, function() {
                self.displayNotification({ title: _t('Verp Apps will be available soon'), message: _t('Showing locally available modules'), sticky: true, type: 'danger' });
                return self._rpc({
                    route: '/web/action/load',
                    params: {actionId: self.failbackActionId},
                }).then(function(action) {
                    return self.doAction(action, {clearBreadcrumbs: true});
                }).then(reject, reject);
            });
        });
    }
});

var AppsUpdates = Apps.extend({
    remoteActionTag: 'loempia.embed.updates',
});

core.actionRegistry.add("apps", Apps);
core.actionRegistry.add("apps.updates", AppsUpdates);

return Apps;

});
