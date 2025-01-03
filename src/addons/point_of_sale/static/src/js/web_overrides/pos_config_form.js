verp.define('point_of_sale.posConfigForm', function (require) {
    'use strict';

    var FormController = require('web.FormController');
    var FormView = require('web.FormView');
    var viewRegistry = require('web.viewRegistry');

    var PosConfigFormController = FormController.extend({
        _enableButtons: function (changedFields) {
            let shouldReload = false;
            if (Array.isArray(changedFields)) {
                for (let field of (changedFields)) {
                    if (
                        field.startsWith('module') ||
                        field.startsWith('group') ||
                        field === 'isPosbox'
                    ) {
                        shouldReload = true;
                        break;
                    }
                }
            }
            if (shouldReload) {
                window.location.reload();
            } else {
                this._super.apply(this, arguments);
            }
        },
    });

    var PosConfigFormView = FormView.extend({
        config: _.extend({}, FormView.prototype.config, {
            Controller: PosConfigFormController,
        }),
    });

    viewRegistry.add('posConfigForm', PosConfigFormView);
    return FormView;
});
