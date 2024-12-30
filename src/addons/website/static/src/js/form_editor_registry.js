verp.define('website.formEditorRegistry', function (require) {
'use strict';

var Registry = require('web.Registry');

return new Registry();

});

verp.define('website.sendMailForm', function (require) {
'use strict';

var core = require('web.core');
var FormEditorRegistry = require('website.formEditorRegistry');

var _t = core._t;

FormEditorRegistry.add('sendMail', {
    formFields: [{
        type: 'char',
        custom: true,
        required: true,
        fillWith: 'label',
        name: 'label',
        string: 'Your Name',
    }, {
        type: 'tel',
        custom: true,
        fillWith: 'phone',
        name: 'phone',
        string: 'Phone Number',
    }, {
        type: 'email',
        modelRequired: true,
        fillWith: 'email',
        name: 'emailFrom',
        string: 'Your Email',
    }, {
        type: 'char',
        custom: true,
        fillWith: 'commercialCompanyName',
        name: 'company',
        string: 'Your Company',
    }, {
        type: 'char',
        modelRequired: true,
        name: 'subject',
        string: 'Subject',
    }, {
        type: 'text',
        custom: true,
        required: true,
        name: 'description',
        string: 'Your Question',
    }],
    fields: [{
        name: 'emailTo',
        type: 'char',
        required: true,
        string: _t('Recipient Email'),
        defaultValue: 'info@yourcompany.example.com',
    }],
});

});
