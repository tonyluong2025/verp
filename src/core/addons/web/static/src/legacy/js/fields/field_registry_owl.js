verp.define('web.fieldRegistryOwl', function (require) {
    "use strict";

    const Registry = require('web.Registry');

    return new Registry(
        null,
        (value) => value.prototype instanceof owl.Component
    );
});

verp.define('web._fieldRegistryOwl', function (require) {
    "use strict";

    /**
     * This module registers field components (specifications of the AbstractField Component)
     */

    const basicFields = require('web.basicFieldsOwl');
    const registry = require('web.fieldRegistryOwl');

    // Basic fields
    registry
        .add('badge', basicFields.FieldBadge)
        .add('boolean', basicFields.FieldBoolean);
});
