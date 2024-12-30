verp.define('product.pricelist.report.tests', function (require) {
"use strict";
const GeneratePriceList = require('product.generatePricelist').GeneratePriceList;
const testUtils = require('web.testUtils');

const { createWebClient, doAction } = require('@web/../tests/webclient/helpers');

let serverData;

QUnit.module('Product Pricelist', {
    beforeEach: function () {
            this.data = {
                'product.product': {
                    fields: {
                        id: {type: 'integer'}
                    },
                    records: [{
                        id: 42,
                        displayName: "Customizable Desk"
                    }]
                },
                'product.pricelist': {
                    fields: {
                        id: {type: 'integer'}
                    },
                    records: [{
                        id: 1,
                        displayName: "Public Pricelist"
                    }, {
                        id: 2,
                        displayName: "Test"
                    }]
                }
            };
            serverData = { models: this.data };
        },
}, function () {
    QUnit.test('Pricelist Client Action', async function (assert) {
        assert.expect(21);

        const self = this;
        let Qty = [1, 5, 10]; // default quantities
        testUtils.mock.patch(GeneratePriceList, {
            _onFieldChanged: function (event) {
                assert.step('fieldChanged');
                return this._super.apply(this, arguments);
            },
            _onQtyChanged: function (event) {
                assert.deepEqual(event.data.quantities, Qty.sort((a, b) => a - b), "changed quantity should be same.");
                assert.step('qtyChanged');
                return this._super.apply(this, arguments);
            },
        });
        const mockRPC = (route, args) => {
            if (route === '/web/dataset/callKw/report.product.report.pricelist/getHtml') {
                return Promise.resolve("");
            }
        };

        const webClient = await createWebClient({ serverData, mockRPC });
        await doAction(webClient, {
            id: 1,
            label: 'Generate Pricelist',
            tag: 'generatePricelist',
            type: 'ir.actions.client',
            context: {
                'default_pricelist': 1,
                'activeIds': [42],
                'activeId': 42,
                'activeModel': 'product.product'
            }
        });

        // checking default pricelist
        assert.strictEqual($(webClient.el).find('.o-field-many2one input').val(), "Public Pricelist",
            "should have default pricelist");

        // changing pricelist
        await testUtils.fields.many2one.clickOpenDropdown("pricelistId");
        await testUtils.fields.many2one.clickItem("pricelistId", "Test");

        // check wherther pricelist value has been updated or not. along with that check default quantities should be there.
        assert.strictEqual($(webClient.el).find('.o-field-many2one input').val(), "Test",
            "After pricelist change, the pricelistId field should be updated");
        assert.strictEqual($(webClient.el).find('.o_badges > .badge').length, 3,
            "There should be 3 default Quantities");

        // existing quantity can not be added.
        await testUtils.dom.click($(webClient.el).find('.o-add-qty'));
        let notificationElement = document.body.querySelector('.o-notification-manager .o-notification.bg-info');
        assert.strictEqual(notificationElement.querySelector('.o-notification-content').textContent,
            "Quantity already present (1).", "Existing Quantity can not be added");

        // adding few more quantities to check.
        $(webClient.el).find('.o_product_qty').val(2);
        Qty.push(2);
        await testUtils.dom.click($(webClient.el).find('.o-add-qty'));
        $(webClient.el).find('.o_product_qty').val(3);
        Qty.push(3);
        await testUtils.dom.click($(webClient.el).find('.o-add-qty'));

        // should not be added more then 5 quantities.
        $(webClient.el).find('.o_product_qty').val(4);
        await testUtils.dom.click($(webClient.el).find('.o-add-qty'));

        notificationElement = document.body.querySelector('.o-notification-manager .o-notification.bg-warning');
        assert.strictEqual(notificationElement.querySelector('.o-notification-content').textContent,
            "At most 5 quantities can be displayed simultaneously. Remove a selected quantity to add others.",
            "Can not add more then 5 quantities");

        // removing all the quantities should work
        Qty.pop(10);
        await testUtils.dom.click($(webClient.el).find('.o_badges .badge:contains("10") .o_remove_qty'));
        Qty.pop(5);
        await testUtils.dom.click($(webClient.el).find('.o_badges .badge:contains("5") .o_remove_qty'));
        Qty.pop(3);
        await testUtils.dom.click($(webClient.el).find('.o_badges .badge:contains("3") .o_remove_qty'));
        Qty.pop(2);
        await testUtils.dom.click($(webClient.el).find('.o_badges .badge:contains("2") .o_remove_qty'));
        Qty.pop(1);
        await testUtils.dom.click($(webClient.el).find('.o_badges .badge:contains("1") .o_remove_qty'));

        assert.verifySteps([
            'fieldChanged',
            'qtyChanged',
            'qtyChanged',
            'qtyChanged',
            'qtyChanged',
            'qtyChanged',
            'qtyChanged',
            'qtyChanged'
        ]);

        testUtils.mock.unpatch(GeneratePriceList);
    });
}

);
});
