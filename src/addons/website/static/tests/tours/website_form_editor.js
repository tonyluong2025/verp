verp.define('website.tour.form_editor', function (require) {
    'use strict';

    const rpc = require('web.rpc');
    const tour = require("web_tour.tour");

    // Visibility possible values:
    const VISIBLE = 'Always Visible';
    const HIDDEN = 'Hidden';
    const CONDITIONALVISIBILITY = 'Visible only if';

    const selectButtonByText = function (text) {
        return [{
            content: "Open the select",
            trigger: `we-select:has(we-button:contains("${text}")) we-toggler`,
        },
        {
            content: "Click on the option",
            trigger: `we-select we-button:contains("${text}")`,
        }];
    };
    const selectButtonByData = function (data) {
        return [{
            content: "Open the select",
            trigger: `we-select:has(we-button[${data}]) we-toggler`,
        }, {
            content: "Click on the option",
            trigger: `we-select we-button[${data}]`,
        }];
    };
    const addField = function (data, name, type, label, required, display = {visibility: VISIBLE, condition: ''}) {
        const ret = [{
            content: "Select form",
            extraTrigger: '.s-website-form-field',
            trigger: 'section.s-website-form',
        }, {
            content: "Add field",
            trigger: 'we-button[data-add-field]',
        },
        ...selectButtonByData(data),
        {
            content: "Wait for field to load",
            trigger: `.s-website-form-field[data-type="${name}"], .s-website-form-input[name="${name}"]`, //custom or existing field
            run: function () {},
        },
        ...selectButtonByText(display.visibility),
    ];
        let testText = '.s-website-form-field';
        if (display.condition) {
            ret.push({
                content: "Set the visibility condition",
                trigger: 'we-input[data-attribute-name="visibilityCondition"] input',
                run: `text ${display.condition}`,
            });
        }
        if (required) {
            testText += '.s-website-form-required';
            ret.push({
                content: "Mark the field as required",
                trigger: 'we-button[data-name="required_opt"] we-checkbox',
            });
        }
        if (label) {
            testText += `:has(label:contains("${label}"))`;
            ret.push({
                content: "Change the label text",
                trigger: 'we-input[data-set-label-text] input',
                run: `text ${label}`,
            });
        }
        if (type !== 'checkbox' && type !== 'radio' && type !== 'select') {
            let inputType = type === 'textarea' ? type : `input[type="${type}"]`;
            testText += `:has(${inputType}[name="${name}"]${required ? '[required]' : ''})`;
        }
        ret.push({
            content: "Check the resulting field",
            trigger: testText,
            run: function () {},
        });
        return ret;
    };
    const addCustomField = function (name, type, label, required, display) {
        return addField(`data-custom-field="${name}"`, name, type, label, required, display);
    };
    const addExistingField = function (name, type, label, required, display) {
        return addField(`data-existing-field="${name}"`, name, type, label, required, display);
    };

    tour.register("website_form_editor_tour", {
        test: true,
    }, [
        // Drop a form builder snippet and configure it
        {
            content: "Enter edit mode",
            trigger: 'a[data-action=edit]',
        }, {
            content: "Drop the form snippet",
            trigger: '#oeSnippets .oe-snippet:has(.s-website-form) .oe-snippet-thumbnail',
            run: 'dragAndDrop #wrap',
        }, {
            content: "Select form by clicking on an input field",
            extraTrigger: '.s-website-form-field',
            trigger: 'section.s-website-form input',
        }, {
            content: "Verify that the form editor appeared",
            trigger: '.o-we-customize-panel .snippet-option-WebsiteFormEditor',
            run: () => null,
        }, {
            content: "Go back to blocks to unselect form",
            trigger: '.o-we-add_snippet_btn',
        }, {
            content: "Select form by clicking on a text area",
            extraTrigger: '.s-website-form-field',
            trigger: 'section.s-website-form textarea',
        }, {
            content: "Verify that the form editor appeared",
            trigger: '.o-we-customize-panel .snippet-option-WebsiteFormEditor',
            run: () => null,
        }, {
            content: "Rename the field label",
            trigger: 'we-input[data-set-label-text] input',
            run: "text Renamed",
        }, {
            content: "Leave the rename options",
            trigger: 'we-input[data-set-label-text] input',
            run: "textBlur",
        }, {
            content: "Go back to blocks to unselect form",
            trigger: '.o-we-add_snippet_btn',
        }, {
            content: "Select form itself (not a specific field)",
            extraTrigger: '.s-website-form-field',
            trigger: 'section.s-website-form',
        },
        ...selectButtonByText('Send an E-mail'),
        {
            content: "Form has a model name",
            trigger: 'section.s-website-form form[data-modelName="mail.mail"]',
        }, {
            content: 'Edit the Phone Number field',
            trigger: 'input[name="phone"]',
        }, {
            content: 'Change the label position of the phone field',
            trigger: 'we-button[data-select-label-position="right"]',
        },
        ...addExistingField('emailCc', 'text', 'Test conditional visibility', false, {visibility: CONDITIONALVISIBILITY, condition: 'verp'}),

        ...addExistingField('date', 'text', 'Test Date', true),

        ...addExistingField('record_name', 'text', 'Awesome Label', false, {visibility: HIDDEN}),

        ...addExistingField('body_html', 'textarea', 'Your Message', true),

        ...addExistingField('recipient_ids', 'checkbox'),

        ...addCustomField('one2many', 'checkbox', 'Products', true),
        {
            content: "Change Option 1 label",
            trigger: 'we-list table input:eq(0)',
            run: 'text Iphone',
        }, {
            content: "Change Option 2 label",
            trigger: 'we-list table input:eq(1)',
            run: 'text Galaxy S',
        }, {
            content: "Change first Option 3 label",
            trigger: 'we-list table input:eq(2)',
            run: 'text Xperia',
        }, {
            content: "Click on Add new Checkbox",
            trigger: 'we-list we-button.o-we-list_add_optional',
        }, {
            content: "Change added Option label",
            trigger: 'we-list table input:eq(3)',
            run: 'text Wiko Stairway',
        }, {
            content: "Check the resulting field",
            trigger: ".s-website-form-field.s-website-form-custom.s-website-form-required" +
                        ":has(.s-website-form-multiple[data-display='horizontal'])" +
                        ":has(.checkbox:has(label:contains('Iphone')):has(input[type='checkbox'][required]))" +
                        ":has(.checkbox:has(label:contains('Galaxy S')):has(input[type='checkbox'][required]))" +
                        ":has(.checkbox:has(label:contains('Xperia')):has(input[type='checkbox'][required]))" +
                        ":has(.checkbox:has(label:contains('Wiko Stairway')):has(input[type='checkbox'][required]))",
            run: function () {},
        },
        ...selectButtonByData('data-multi-checkbox-display="vertical"'),
        {
            content: "Check the resulting field",
            trigger: ".s-website-form-field.s-website-form-custom.s-website-form-required" +
                        ":has(.s-website-form-multiple[data-display='vertical'])" +
                        ":has(.checkbox:has(label:contains('Iphone')):has(input[type='checkbox'][required]))" +
                        ":has(.checkbox:has(label:contains('Galaxy S')):has(input[type='checkbox'][required]))" +
                        ":has(.checkbox:has(label:contains('Xperia')):has(input[type='checkbox'][required]))" +
                        ":has(.checkbox:has(label:contains('Wiko Stairway')):has(input[type='checkbox'][required]))",
            run: function () {},
        },

        ...addCustomField('selection', 'radio', 'Service', true),
        {
            content: "Change Option 1 label",
            trigger: 'we-list table input:eq(0)',
            run: 'text After-sales Service',
        }, {
            content: "Change Option 2 label",
            trigger: 'we-list table input:eq(1)',
            run: 'text Invoicing Service',
        }, {
            content: "Change first Option 3 label",
            trigger: 'we-list table input:eq(2)',
            run: 'text Development Service',
        }, {
            content: "Click on Add new Checkbox",
            trigger: 'we-list we-button.o-we-list_add_optional',
        }, {
            content: "Change last Option label",
            trigger: 'we-list table input:eq(3)',
            run: 'text Management Service',
        }, {
            content: "Mark the field as not required",
            trigger: 'we-button[data-name="required_opt"] we-checkbox',
        }, {
            content: "Check the resulting field",
            trigger: ".s-website-form-field.s-website-form-custom:not(.s-website-form-required)" +
                        ":has(.radio:has(label:contains('After-sales Service')):has(input[type='radio']:not([required])))" +
                        ":has(.radio:has(label:contains('Invoicing Service')):has(input[type='radio']:not([required])))" +
                        ":has(.radio:has(label:contains('Development Service')):has(input[type='radio']:not([required])))" +
                        ":has(.radio:has(label:contains('Management Service')):has(input[type='radio']:not([required])))",
            run: function () {},
        },

        ...addCustomField('many2one', 'select', 'State', true),

        // Customize custom selection field
        {
            content: "Change Option 1 Label",
            trigger: 'we-list table input:eq(0)',
            run: 'text Germany',
        }, {
            content: "Change Option 2 Label",
            trigger: 'we-list table input:eq(1)',
            run: 'text Belgium',
        }, {
            content: "Change first Option 3 label",
            trigger: 'we-list table input:eq(2)',
            run: 'text France',
        }, {
            content: "Click on Add new Checkbox",
            trigger: 'we-list we-button.o-we-list_add_optional',
        }, {
            content: "Change last Option label",
            trigger: 'we-list table input:eq(3)',
            run: 'text Canada',
        }, {
            content: "Remove Germany Option",
            trigger: '.o-we-select_remove_option:eq(0)',
        }, {
            content: "Check the resulting snippet",
            trigger: ".s-website-form-field.s-website-form-custom.s-website-form-required" +
                        ":has(label:contains('State'))" +
                        ":has(select[required]:hidden)" +
                        ":has(.s-website-form-select-item:contains('Belgium'))" +
                        ":has(.s-website-form-select-item:contains('France'))" +
                        ":has(.s-website-form-select-item:contains('Canada'))" +
                        ":not(:has(.s-website-form-select-item:contains('Germany')))",
            run: function () {},
        },

        ...addExistingField('attachmentIds', 'file', 'Invoice Scan'),

        {
            content: "Insure the history step of the editor is not checking for unbreakable",
            trigger: '#wrapwrap',
            run: () => {
                const wysiwyg = $('#wrapwrap').data('wysiwyg');
                wysiwyg.verpEditor.historyStep(true);
            },
        },
        // Edit the submit button using linkDialog.
        {
            content: "Click submit button to show edit popover",
            trigger: '.s-website-form-send',
        }, {
            content: "Click on Edit Link in Popover",
            trigger: '.o-edit-menu-popover .o-we-edit-link',
        }, {
            content: "Check that no URL field is suggested",
            trigger: '#toolbar:has(#urlRow:hidden)',
            run: () => null,
        }, {
            content: "Change button's style",
            trigger: '.dropdown-toggle[data-original-title="Link Style"]',
            run: () => {
                $('.dropdown-toggle[data-original-title="Link Style"]').click();
                $('[data-value="secondary"]').click();
                $('[data-original-title="Link Shape"]').click();
                $('[data-value="rounded-circle"]').click();
                $('[data-original-title="Link Size"]').click();
                $('[data-value="sm"]').click();
            },
        }, {
            content: "Check the resulting button",
            trigger: '.s-website-form-send.btn.btn-sm.btn-secondary.rounded-circle',
            run: () => null,
        },
        // Add a default value to a auto-fillable field.
        {
            content: 'Select the name field',
            trigger: '.s-website-form-field:eq(0)',
        }, {
            content: 'Set a default value to the name field',
            trigger: 'we-input[data-attribute-name="value"] input',
            run: 'text John Smith',
        },
        {
            content:  "Save the page",
            trigger:  "button[data-action=save]",
        },
        {
            content: 'Verify value attribute and property',
            trigger: '.s-website-form-field:eq(0) input[value="John Smith"]:propValue("Mitchell Admin")',
        },
        {
            content: 'Verify that phone field is still auto-fillable',
            trigger: '.s-website-form-field input[data-fill-with="phone"]:propValue("+1 555-555-5555")',
        },
        // Check that if we edit again and save again the default value is not deleted.
        {
            content: 'Enter in edit mode again',
            trigger: 'a[data-action="edit"]',
            run: 'click',
        },
        {
            content: 'Edit the form',
            trigger: '.s-website-form-field:eq(0) input',
            extraTrigger: 'button[data-action="save"]',
            run: 'click',
        },
        ...addCustomField('many2one', 'select', 'Select Field', true),
        {
            content: 'Save the page',
            trigger: 'button[data-action=save]',
            run: 'click',
        },
        {
            content: 'Verify that the value has not been deleted',
            trigger: '.s-website-form-field:eq(0) input[value="John Smith"]',
        },
        {
            content: 'Enter in edit mode again',
            trigger: 'a[data-action="edit"]',
            run: 'click',
        },
        {
            content: 'Click on the submit button',
            trigger: '.s-website-form-send',
            extraTrigger: 'button[data-action="save"]',
            run: 'click',
        },
        {
            content: 'Change the Recipient Email',
            trigger: '[data-field-name="emailTo"] input',
            run: 'text test@test.test',
        },
        {
            content: 'Save the page',
            trigger: 'button[data-action=save]',
            run: 'click',
        },
        {
            content: 'Verify that the recipient email has been saved',
            trigger: 'body:not(.editor-enable)',
            // We have to this that way because the input type = hidden.
            extraTrigger: 'form:has(input[name="emailTo"][value="test@test.test"])',
        },
    ]);

    tour.register("website_form_editor_tour_submit", {
        test: true,
    },[
        {
            content:  "Try to send the form with some required fields not filled in",
            extraTrigger:  "form[data-modelName='mail.mail']" +
                            "[data-success-page='/contactus-thank-you']" +
                            ":has(.s-website-form-field:has(label:contains('Your Name')):has(input[type='text'][name='name'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Your Email')):has(input[type='email'][name='email_from'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Your Question')):has(textarea[name='description'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Subject')):has(input[type='text'][name='subject'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Test Date')):has(input[type='text'][name='date'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Awesome Label')):hidden)" +
                            ":has(.s-website-form-field:has(label:contains('Your Message')):has(textarea[name='body_html'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Products')):has(input[type='checkbox'][name='Products'][value='Iphone'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Products')):has(input[type='checkbox'][name='Products'][value='Galaxy S'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Products')):has(input[type='checkbox'][name='Products'][value='Xperia'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Products')):has(input[type='checkbox'][name='Products'][value='Wiko Stairway'][required]))" +
                            ":has(.s-website-form-field:has(label:contains('Service')):has(input[type='radio'][name='Service'][value='After-sales Service']:not([required])))" +
                            ":has(.s-website-form-field:has(label:contains('Service')):has(input[type='radio'][name='Service'][value='Invoicing Service']:not([required])))" +
                            ":has(.s-website-form-field:has(label:contains('Service')):has(input[type='radio'][name='Service'][value='Development Service']:not([required])))" +
                            ":has(.s-website-form-field:has(label:contains('Service')):has(input[type='radio'][name='Service'][value='Management Service']:not([required])))" +
                            ":has(.s-website-form-field:has(label:contains('State')):has(select[name='State'][required]:has(option[value='Belgium'])))" +
                            ":has(.s-website-form-field.s-website-form-required:has(label:contains('State')):has(select[name='State'][required]:has(option[value='France'])))" +
                            ":has(.s-website-form-field:has(label:contains('State')):has(select[name='State'][required]:has(option[value='Canada'])))" +
                            ":has(.s-website-form-field:has(label:contains('Invoice Scan')))" +
                            ":has(.s-website-form-field:has(input[name='emailTo'][value='test@test.test']))",
            trigger:  ".s-website-form-send"
        },
        {
            content:  "Check if required fields were detected and complete the Subject field",
            extraTrigger:  "form:has(#sWebsiteFormResult.text-danger)" +
                            ":has(.s-website-form-field:has(label:contains('Your Name')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Email')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Your Question')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Subject')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Test Date')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Your Message')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Products')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Service')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('State')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Invoice Scan')):not(.o-has-error))",
            trigger:  "input[name=subject]",
            run:      "text Jane Smith"
        },
        {
            content:  "Update required field status by trying to Send again",
            trigger:  ".s-website-form-send"
        },
        {
            content:  "Check if required fields were detected and complete the Message field",
            extraTrigger:  "form:has(#sWebsiteFormResult.text-danger)" +
                            ":has(.s-website-form-field:has(label:contains('Your Name')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Email')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Your Question')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Subject')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Test Date')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Your Message')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Products')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Service')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('State')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Invoice Scan')):not(.o-has-error))",
            trigger:  "textarea[name=body_html]",
            run:      "text A useless message"
        },
        {
            content:  "Update required field status by trying to Send again",
            trigger:  ".s-website-form-send"
        },
        {
            content:  "Check if required fields was detected and check a product. If this fails, you probably broke the cleanForSave.",
            extraTrigger:  "form:has(#sWebsiteFormResult.text-danger)" +
                            ":has(.s-website-form-field:has(label:contains('Your Name')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Email')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Your Question')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Subject')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Test Date')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Your Message')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Products')).o-has-error)" +
                            ":has(.s-website-form-field:has(label:contains('Service')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('State')):not(.o-has-error))" +
                            ":has(.s-website-form-field:has(label:contains('Invoice Scan')):not(.o-has-error))",
            trigger:  "input[name=Products][value='Wiko Stairway']"
        },
        {
            content:  "Complete Date field",
            trigger:  ".s-website-form-datetime [data-toggle='datetimepicker']",
        },
        {
            content:  "Check another product",
            trigger:  "input[name='Products'][value='Xperia']"
        },
        {
            content:  "Check a service",
            trigger:  "input[name='Service'][value='Development Service']"
        },
        {
            content:  "Complete Your Name field",
            trigger:  "input[name='name']",
            run:      "text chhagan"
        },
        {
            content:  "Complete Email field",
            trigger:  "input[name=email_from]",
            run:      "text test@mail.com"
        },
        {
            content: "Complete Subject field",
            trigger: 'input[name="subject"]',
            run: 'text subject',
        },
        {
            content:  "Complete Your Question field",
            trigger:  "textarea[name='description']",
            run:      "text magan"
        },
        {
            content: "Check if conditional field is visible, it shouldn't.",
            trigger: "body",
            run: function () {
                const style = window.getComputedStyle(this.$anchor[0].getElementsByClassName('s-website-form-field-hidden-if')[0]);
                if (style.display !== 'none') {
                    console.error('error This field should be invisible when the name is not verp');
                }
            }
        },
        {
            content: "Change name input",
            trigger: "input[name='name']",
            run: "text verp",
        },
        {
            content: "Check if conditional field is visible, it should.",
            trigger: "input[name='emailCc']",
        },
        {
            content:  "Send the form",
            trigger:  ".s-website-form-send"
        },
        {
            content:  "Check form is submitted without errors",
            trigger:  "#wrap:has(h1:contains('Thank You!'))"
        }
    ]);

    tour.register("website_form_editor_tour_results", {
        test: true,
    }, [
        {
            content: "Check mail.mail records have been created",
            trigger: "body",
            run: function () {
                var mailDef = rpc.query({
                        model: 'mail.mail',
                        method: 'search_count',
                        args: [[
                            ['emailTo', '=', 'test@test.test'],
                            ['body_html', 'like', 'A useless message'],
                            ['body_html', 'like', 'Service : Development Service'],
                            ['body_html', 'like', 'State : Belgium'],
                            ['body_html', 'like', 'Products : Xperia,Wiko Stairway']
                        ]],
                    });
                var success = function(model, count) {
                    if (count > 0) {
                        $('body').append('<div id="website_form_editor_success_test_tour_'+model+'"></div>');
                    }
                };
                mailDef.then(_.bind(success, this, 'mail_mail'));
            }
        },
        {
            content:  "Check mail.mail records have been created",
            trigger:  "#website_form_editor_success_test_tour_mail_mail"
        }
    ]);

    function editContactUs(steps) {
        return [
            {
                content: "Enter edit mode",
                trigger: 'a[data-action=edit]',
            }, {
                content: "Select the contact us form by clicking on an input field",
                trigger: '.s-website-form input',
                extraTrigger: '#oeSnippets .oe-snippet-thumbnail',
                run: 'click',
            },
            ...steps,
            {
                content: 'Save the page',
                trigger: 'button[data-action=save]',
            },
            {
                content: 'Wait for reload',
                trigger: 'body:not(.editor-enable)',
            },
        ];
    }

    tour.register('website_form_contactus_edition_with_email', {
        test: true,
        url: '/contactus',
    }, editContactUs([
        {
            content: 'Change the Recipient Email',
            trigger: '[data-field-name="emailTo"] input',
            run: 'text test@test.test',
        },
    ]));
    tour.register('website_form_contactus_edition_no_email', {
        test: true,
        url: '/contactus',
    }, editContactUs([
        {
            content: "Change a random option",
            trigger: '[data-set-mark] input',
            run: 'textBlur **',
        },
    ]));
    tour.register('website_form_contactus_submit', {
        test: true,
        url: '/contactus',
    }, [
        // As the demo portal user, only two inputs needs to be filled to send
        // the email
        {
            content: "Fill in the subject",
            trigger: 'input[name="subject"]',
        },
        {
            content: 'Fill in the message',
            trigger: 'textarea[name="description"]',
        },
        {
            content: 'Send the form',
            trigger: '.s-website-form-send',
        },
        {
            content: 'Check form is submitted without errors',
            trigger: '#wrap:has(h1:contains("Thank You!"))',
        },
    ]);

    return {};
});
