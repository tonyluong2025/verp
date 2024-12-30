verp.define('web.viewRegistry', function (require) {
"use strict";

/**
 * This module defines the viewRegistry. Web views are added to the registry
 * in the 'web._viewRegistry' module to avoid cyclic dependencies.
 * Views defined in other addons should be added in this registry as well,
 * ideally in another module than the one defining the view, in order to
 * separate the declarative part of a module (the view definition) from its
 * 'side-effects' part.
 */

var Registry = require('web.Registry');

return new Registry();

});

verp.define('web._viewRegistry', function (require) {
"use strict";

/**
 * The purpose of this module is to add the web views in the viewRegistry.
 * This can't be done directly in the module defining the viewRegistry as it
 * would produce cyclic dependencies.
 */

var FormView = require('web.FormView');
var KanbanView = require('web.KanbanView');
var ListView = require('web.ListView');
var CalendarView = require('web.CalendarView');
var viewRegistry = require('web.viewRegistry');

viewRegistry
    .add('form', FormView)
    .add('list', ListView)
    .add('kanban', KanbanView)
    .add('calendar', CalendarView);
});
