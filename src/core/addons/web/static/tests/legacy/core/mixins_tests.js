verp.define('web.mixins_tests', function (require) {
"use strict";

const  AbstractAction = require("web.AbstractAction");
const  core = require("web.core");
var testUtils = require('web.testUtils');
var Widget = require('web.Widget');

const { dialogService } = require('@web/core/dialog/dialog_service');
const { errorService } = require("@web/core/errors/error_service");
const { registry } = require('@web/core/registry');
const { nextTick, patchWithCleanup } = require('@web/../tests/helpers/utils');
const { createWebClient, doAction } = require('@web/../tests/webclient/helpers');

QUnit.module('core', {}, function () {

    QUnit.module('mixins');

    QUnit.test('perform a doAction properly', function (assert) {
        assert.expect(3);
        var done = assert.async();

        var widget = new Widget();

        testUtils.mock.intercept(widget, 'doAction', function (event) {
            assert.strictEqual(event.data.action, 'test.some_action_id',
                "should have sent proper action name");
            assert.deepEqual(event.data.options, {clear_breadcrumbs: true},
                "should have sent proper options");
            event.data.onSuccess();
        });

        widget.doAction('test.some_action_id', {clear_breadcrumbs: true}).then(function () {
            assert.ok(true, 'deferred should have been resolved');
            widget.destroy();
            done();
        });
    });

    QUnit.test('checks that the error generated by a doAction opens one dialog', async function (assert) {
        assert.expect(1);

        window.addEventListener("unhandledrejection", async (ev) => {
            ev.preventDefault();
        });
        patchWithCleanup(QUnit, {
            onUnhandledRejection: () => {},
        });

        const serviceRegistry = registry.category("services");
        serviceRegistry.add("dialog", dialogService);
        serviceRegistry.add("error", errorService);

        const TestAction = AbstractAction.extend({
            onAttachCallback() {
                this.doAction({
                    id: 1,
                    type: "ir.actions.server",
                })
            },
        });
        core.actionRegistry.add("TestAction", TestAction);

        const mockRPC = (route) => {
            if (route === "/web/action/run") {
                throw new Error("This error should be throw only once");
            }
        };
        const webClient = await createWebClient({mockRPC});
        await doAction(webClient, "TestAction");
        await nextTick();
        assert.containsOnce(webClient, ".o-dialog");
    });
});

});
