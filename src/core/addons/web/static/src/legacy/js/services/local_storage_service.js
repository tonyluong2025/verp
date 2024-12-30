verp.define('web.LocalStorageService', function (require) {
'use strict';

/**
 * This module defines a service to access the localStorage object.
 */

var AbstractStorageService = require('web.AbstractStorageService');
var core = require('web.core');
var localStorage = require('web.localStorage');

var LocalStorageService = AbstractStorageService.extend({
    storage: localStorage,
});

core.serviceRegistry.add('localStorage', LocalStorageService);

return LocalStorageService;

});
