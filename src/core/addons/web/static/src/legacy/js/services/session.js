verp.define('web.session', function (require) {
"use strict";

var Session = require('web.Session');

var session = new Session(undefined, undefined, {useCors: false});
session.isBound = session.sessionBind();

return session;

});
