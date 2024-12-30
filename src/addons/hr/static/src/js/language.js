/** @verp-module **/

import FormController from 'web.FormController';
import FormView from 'web.FormView';
import viewRegistry from 'web.viewRegistry';

var EmployeeFormController = FormController.extend({
    saveRecord: function () {
        var self = this;
        return this._super.apply(this, arguments).then(function () {
            if (arguments[0].indexOf('lang') >= 0) {
                self.doAction('reloadContext');
            }
        });
    },
});

var EmployeeProfileFormView = FormView.extend({
    config: _.extend({}, FormView.prototype.config, {
        Controller: EmployeeFormController,
    }),
});

viewRegistry.add('hrEmployeeProfileForm', EmployeeProfileFormView);
export default EmployeeProfileFormView;
