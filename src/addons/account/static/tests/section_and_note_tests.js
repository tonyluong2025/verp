verp.define('account.section_and_note_tests', function (require) {
"use strict";

var FormView = require('web.FormView');
var testUtils = require('web.testUtils');
var createView = testUtils.createView;

QUnit.module('section_and_note', {
    beforeEach: function () {
        this.data = {
            invoice: {
                fields: {
                    invoiceLineIds: {
                        string: "Lines",
                        type: 'one2many',
                        relation: 'invoiceLine',
                        relationField: 'invoiceId'
                    },
                },
                records: [
                    {id: 1, invoiceLineIds: [1, 2]},
                ],
            },
            invoice_line: {
                fields: {
                    displayType: {
                        string: 'Type',
                        type: 'selection',
                        selection: [['lineSection', "Section"], ['lineNote', "Note"]]
                    },
                    invoiceId: {
                        string: "Invoice",
                        type: 'many2one',
                        relation: 'invoice'
                    },
                    name: {
                        string: "Name",
                        type: 'text'
                    },
                },
                records: [
                    {id: 1, displayType: false, invoiceId: 1, name: 'product\n2 lines'},
                    {id: 2, displayType: 'lineSection', invoiceId: 1, name: 'section'},
                ]
            },
        };
    },
}, function () {
    QUnit.test('correct display of section and note fields', async function (assert) {
        assert.expect(5);
        var form = await createView({
            View: FormView,
            model: 'invoice',
            data: this.data,
            arch: '<form>' +
                    '<field name="invoiceLineIds" widget="sectionAndNoteOne2many"/>' +
                '</form>',
            archs: {
                'invoice_line,false,list': '<tree editable="bottom">' +
                    '<field name="displayType" invisible="1"/>' +
                    '<field name="label" widget="sectionAndNoteText"/>' +
                '</tree>',
            },
            resId: 1,
        });

        assert.hasClass(form.$('[name="invoiceLineIds"] table'), 'o-section-and-note-list-view');

        // section should be displayed correctly
        var $tr0 = form.$('tr.o-data-row:eq(0)');

        assert.doesNotHaveClass($tr0, 'o-is-line-section',
            "should not have a section class");

        var $tr1 = form.$('tr.o-data-row:eq(1)');

        assert.hasClass($tr1, 'o-is-line-section',
            "should have a section class");

        // enter edit mode
        await testUtils.form.clickEdit(form);

        // editing line should be textarea
        $tr0 = form.$('tr.o-data-row:eq(0)');
        await testUtils.dom.click($tr0.find('td.o-data-cell'));
        assert.containsOnce($tr0, 'td.o-data-cell textarea[name="label"]',
            "editing line should be textarea");

        // editing section should be input
        $tr1 = form.$('tr.o-data-row:eq(1)');
        await testUtils.dom.click($tr1.find('td.o-data-cell'));
        assert.containsOnce($tr1, 'td.o-data-cell input[name="label"]',
            "editing section should be input");

        form.destroy();
    });
});
});
