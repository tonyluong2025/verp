/*global Backbone */
verp.define('point_of_sale.tests.PaymentScreen', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const { useListener } = require('web.customHooks');
    const testUtils = require('web.testUtils');
    const makePosTestEnv = require('point_of_sale.test_env');
    const { xml } = owl.tags;
    const { useState } = owl;

    QUnit.module('unit tests for PaymentScreen components', {});

    QUnit.test('PaymentMethodButton', async function (assert) {
        assert.expect(2);

        class Parent extends PosComponent {
            constructor() {
                super(...arguments);
                useListener('new-payment-line', this._newPaymentLine);
            }
            _newPaymentLine() {
                assert.step('new-payment-line');
            }
        }
        Parent.env = makePosTestEnv();
        Parent.template = xml/* html */ `
            <div>
                <PaymentMethodButton paymentMethod="{ name: 'Cash', id: 1 }" />
            </div>
        `;

        const parent = new Parent();
        await parent.mount(testUtils.prepareTarget());

        const button = parent.el.querySelector('.paymentmethod');
        await testUtils.dom.click(button);
        assert.verifySteps(['new-payment-line']);

        parent.unmount();
        parent.destroy();
    });

    QUnit.test('PSNumpadInputButton', async function (assert) {
        assert.expect(15);

        class Parent extends PosComponent {
            constructor({ value, text, changeClassTo }) {
                super();
                this.state = useState({ value, text, changeClassTo });
                useListener('input-from-numpad', this._inputFromNumpad);
            }
            _inputFromNumpad({ detail: { key } }) {
                assert.step(`${key}-input`);
            }
            setState(obj) {
                Object.assign(this.state, obj);
            }
        }
        Parent.env = makePosTestEnv();
        Parent.template = xml/* html */ `
            <div>
                <PSNumpadInputButton value="state.value" text="state.text" changeClassTo="state.changeClassTo" />
            </div>
        `;

        let parent = new Parent({ value: '1' });
        await parent.mount(testUtils.prepareTarget());

        let button = parent.el.querySelector('button');
        assert.ok(button.textContent.includes('1'));
        assert.ok(button.classList.contains('number-char'));
        await testUtils.dom.click(button);
        await testUtils.nextTick();
        assert.verifySteps(['1-input']);

        parent.setState({ value: '2', text: 'Two' });
        await testUtils.nextTick();
        assert.ok(button.textContent.includes('Two'));
        await testUtils.dom.click(button);
        await testUtils.nextTick();
        assert.verifySteps(['2-input']);

        parent.setState({ value: '+12', text: null, changeClassTo: 'not-number-char' });
        await testUtils.nextTick();
        assert.ok(button.textContent.includes('+12'));
        assert.ok(button.classList.contains('not-number-char'));
        // class number-char should have been replaced
        assert.notOk(button.classList.contains('number-char'));
        await testUtils.dom.click(button);
        await testUtils.nextTick();
        assert.verifySteps(['+12-input']);

        parent.unmount();
        parent.destroy();

        // using the slot should ignore value and text props of the component
        Parent.template = xml/* html */ `
            <div>
                <PSNumpadInputButton value="state.value" text="state.text" changeClassTo="state.changeClassTo">
                    <span>UseSlot</span>
                </PSNumpadInputButton>
            </div>
        `;
        parent = new Parent({ value: 'slotted', text: 'Text' });
        await parent.mount(testUtils.prepareTarget());

        button = parent.el.querySelector('button');
        assert.ok(button.textContent.includes('UseSlot'));
        await testUtils.dom.click(button);
        await testUtils.nextTick();
        assert.verifySteps(['slotted-input']);

        parent.unmount();
        parent.destroy();
    });

    QUnit.test('PaymentScreenPaymentLines', async function (assert) {
        assert.expect(12);

        class Parent extends PosComponent {
            constructor() {
                super();
                useListener('delete-payment-line', this._onDeletePaymentLine);
                useListener('select-payment-line', this._onSelectPaymentLine);
            }
            get paymentLines() {
                return this.order.getPaymentlines();
            }
            get order() {
                return this.env.pos.getOrder();
            }
            mounted() {
                this.order.paymentlines.on('change', this.render, this);
            }
            willUnmount() {
                this.order.paymentlines.off('change', null, this);
            }
            _onDeletePaymentLine() {
                assert.step('delete-click');
            }
            _onSelectPaymentLine() {
                assert.step('select-click');
            }
        }
        Parent.env = makePosTestEnv();
        Parent.template = xml/* html */ `
            <div>
                <PaymentScreenPaymentLines paymentLines="paymentLines" />
            </div>
        `;

        let parent = new Parent();
        await parent.mount(testUtils.prepareTarget());

        const order = parent.env.pos.getOrder();
        const cashPM = { id: 0, name: 'Cash', isCashCount: true, usePaymentTerminal: false };
        const bankPM = { id: 0, name: 'Bank', isCashCount: false, usePaymentTerminal: false };

        let paymentline1 = order.addPaymentline(cashPM);
        await testUtils.nextTick();

        let statusContainer = parent.el.querySelector('.payment-status-container');
        let linesEl = parent.el.querySelector('.paymentlines');
        assert.ok(linesEl, 'payment lines are shown');
        let newLine = linesEl.querySelector('.selected');
        assert.ok(newLine, 'the new line is automatically selected');

        let paymentline2 = order.addPaymentline(bankPM);
        await testUtils.nextTick();
        assert.notOk(
            linesEl.querySelector('.selected') === newLine,
            'the previously added paymentline should not be selected anymore'
        );
        assert.ok(
            linesEl.querySelectorAll('.paymentline:not(.heading)').length === 2,
            'there should be two paymentlines'
        );

        let paymentline3 = order.addPaymentline(cashPM);
        await testUtils.nextTick();
        assert.ok(
            linesEl.querySelectorAll('.paymentline:not(.heading)').length === 3,
            'there should be three paymentlines'
        );
        assert.ok(
            linesEl.querySelectorAll('.paymentline.selected').length === 1,
            'there should only be one selected paymentline'
        );

        await testUtils.dom.click(linesEl.querySelector('.paymentline.selected .delete-button'));
        await testUtils.nextTick();
        assert.verifySteps(['delete-click', 'select-click']);

        // click the 2nd payment line
        await testUtils.dom.click(linesEl.querySelectorAll('.paymentline:not(.heading)')[1]);
        await testUtils.nextTick();
        assert.verifySteps(['select-click']);

        // remove paymentline3 (the selected)
        order.removePaymentline(paymentline3);
        await testUtils.nextTick();
        assert.notOk(
            linesEl.querySelector('.paymentline.selected'),
            'no more selected payment line'
        );

        order.removePaymentline(paymentline1);
        order.removePaymentline(paymentline2);

        parent.unmount();
        parent.destroy();
    });

    QUnit.test('PaymentScreenElectronicPayment', async function (assert) {
        assert.expect(17);

        class SimulatedPaymentLine extends Backbone.Model {
            constructor() {
                super();
                this.paymentStatus = 'pending';
                this.canBeReversed = false;
            }
            canBeAdjusted() {
                return false;
            }
            setPaymentStatus(status) {
                this.paymentStatus = status;
                this.trigger('change');
            }
            toggleCanBeReversed() {
                this.canBeReversed = !this.canBeReversed;
                this.trigger('change');
            }
        }

        class Parent extends PosComponent {
            constructor() {
                super();
                this.line = new SimulatedPaymentLine();
                useListener('send-payment-request', () => assert.step('send-payment-request'));
                useListener('send-force-done', () => assert.step('send-force-done'));
                useListener('send-payment-cancel', () => assert.step('send-payment-cancel'));
                useListener('send-payment-reverse', () => assert.step('send-payment-reverse'));
            }
        }
        Parent.env = makePosTestEnv();
        Parent.template = xml/* html */ `
            <div>
                <PaymentScreenElectronicPayment line="line" />
            </div>
        `;

        let parent = new Parent();
        await parent.mount(testUtils.prepareTarget());

        assert.ok(parent.el.querySelector('.paymentline .sendPaymentRequest'));
        await testUtils.dom.click(parent.el.querySelector('.paymentline .sendPaymentRequest'));
        await testUtils.nextTick();
        assert.verifySteps(['send-payment-request']);

        parent.line.setPaymentStatus('retry');
        await testUtils.nextTick();
        await testUtils.dom.click(parent.el.querySelector('.paymentline .sendPaymentRequest'));
        await testUtils.nextTick();
        assert.verifySteps(['send-payment-request']);

        parent.line.setPaymentStatus('force_done');
        await testUtils.nextTick();
        await testUtils.dom.click(parent.el.querySelector('.paymentline .send_force_done'));
        await testUtils.nextTick();
        assert.verifySteps(['send-force-done']);

        parent.line.setPaymentStatus('waitingCard');
        await testUtils.nextTick();
        await testUtils.dom.click(parent.el.querySelector('.paymentline .setndPaymentCancel'));
        await testUtils.nextTick();
        assert.verifySteps(['send-payment-cancel']);

        parent.line.setPaymentStatus('waiting');
        await testUtils.nextTick();
        assert.ok(parent.el.querySelector('.paymentline i.fa-circle-o-notch'));

        parent.line.setPaymentStatus('waitingCancel');
        await testUtils.nextTick();
        assert.ok(parent.el.querySelector('.paymentline i.fa-circle-o-notch'));

        parent.line.setPaymentStatus('reversing');
        await testUtils.nextTick();
        assert.ok(parent.el.querySelector('.paymentline i.fa-circle-o-notch'));

        parent.line.setPaymentStatus('done');
        await testUtils.nextTick();
        assert.notOk(parent.el.querySelector('.paymentline .sendPaymentReversal'));

        parent.line.toggleCanBeReversed();
        await testUtils.nextTick();
        assert.ok(parent.el.querySelector('.paymentline .sendPaymentReversal'));
        await testUtils.dom.click(parent.el.querySelector('.paymentline .sendPaymentReversal'));
        await testUtils.nextTick();
        assert.verifySteps(['send-payment-reverse']);

        parent.line.setPaymentStatus('reversed');
        await testUtils.nextTick();
        assert.ok(parent.el.querySelector('.paymentline'));

        parent.unmount();
        parent.destroy();
    });
});
