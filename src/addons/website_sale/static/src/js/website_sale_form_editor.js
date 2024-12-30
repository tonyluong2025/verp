verp.define('website_sale.form', function (require) {
'use strict';

const core = require('web.core');
var FormEditorRegistry = require('website.formEditorRegistry');

const _lt = core._lt;

FormEditorRegistry.add('createCustomer', {
    formFields: [{
        type: 'char',
        modelRequired: true,
        name: 'label',
        fillWith: 'label',
        string: _lt('Your Name'),
    }, {
        type: 'email',
        required: true,
        fillWith: 'email',
        name: 'email',
        string: _lt('Your Email'),
    }, {
        type: 'tel',
        fillWith: 'phone',
        name: 'phone',
        string: _lt('Phone Number'),
    }, {
        type: 'char',
        name: 'companyName',
        fillWith: 'commercialCompanyName',
        string: _lt('Company Name'),
    }],
});

});
