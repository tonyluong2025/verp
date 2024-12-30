verp.define('crm.crm_email_and_phone_propagation', function (require) {
    'use strict';

    const tour = require('web_tour.tour');

    tour.register('crm_email_and_phone_propagation_edit_save', {
        test: true,
        url: '/web',
    }, [
        tour.stepUtils.showAppsMenuItem(),
        {
            trigger: '.o-app[data-menu-xmlid="crm.crmMenuRoot"]',
            content: 'open crm app',
        }, {
            trigger: '.o-kanban-record .o_kanban_record_title span:contains(Test Lead Propagation)',
            content: 'Open the first lead',
            run: 'click',
        }, {
            trigger: '.o_form_button_edit',
            extraTrigger: '.o-lead-opportunity-form.o_form_readonly',
            content: 'Edit the lead',
            run: 'click',
        }, {
            trigger: '.o_form_button_save',
            extraTrigger: '.o-form-editable input[name="emailFrom"]',
            content: 'Save the lead',
            run: 'click',
        }, {
            trigger: '.o_form_readonly',
        },
    ]);

    tour.register('crm_email_and_phone_propagation_remove_email_and_phone', {
        test: true,
        url: '/web',
    }, [
        tour.stepUtils.showAppsMenuItem(),
        {
            trigger: '.o-app[data-menu-xmlid="crm.crmMenuRoot"]',
            content: 'open crm app',
        }, {
            trigger: '.o-kanban-record .o_kanban_record_title span:contains(Test Lead Propagation)',
            content: 'Open the first lead',
            run: 'click',
        }, {
            trigger: '.o_form_button_edit',
            content: 'Edit the lead',
            run: 'click',
        }, {
            trigger: '.o-form-editable input[name="emailFrom"]',
            extraTrigger: '.o-form-editable input[name="phone"]',
            content: 'Remove the email and the phone',
            run: function () {
                $('input[name="emailFrom"]').val('').trigger("change");
                $('input[name="phone"]').val('').trigger("change");
            },
        }, {
            trigger: '.o_form_button_save',
            // wait the the warning message to be visible
            extraTrigger: '.o_form_sheet_bg .fa-exclamation-triangle:not(.o_invisible_modifier)',
            content: 'Save the lead',
            run: 'click',
        }, {
            trigger: '.o_form_readonly',
        },
    ]);

});
