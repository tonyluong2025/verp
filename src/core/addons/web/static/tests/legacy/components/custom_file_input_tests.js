verp.define('web.custom_file_input_tests', function (require) {
    "use strict";

    const CustomFileInput = require('web.CustomFileInput');
    const testUtils = require('web.testUtils');

    const { createComponent } = testUtils;

    QUnit.module('Components', {}, function () {

        // This module cannot be tested as thoroughly as we want it to be:
        // browsers do not let scripts programmatically assign values to inputs
        // of type file
        QUnit.module('CustomFileInput');

        QUnit.test("Upload a file: default props", async function (assert) {
            assert.expect(6);

            const customFileInput = await createComponent(CustomFileInput, {
                env: {
                    services: {
                        async httpRequest(route, params) {
                            assert.deepEqual(params, {
                                csrfToken: verp.csrfToken,
                                ufile: [],
                            });
                            assert.step(route);
                            return '[]';
                        },
                    },
                },
            });
            const input = customFileInput.el.querySelector('input');

            assert.strictEqual(customFileInput.el.innerText.trim().toUpperCase(), "CHOOSE FILE",
                "File input total text should match its given inner element's text");
            assert.strictEqual(input.accept, '*',
                "Input should accept all files by default");

            await testUtils.dom.triggerEvent(input, 'change');

            assert.notOk(input.multiple, "'multiple' attribute should not be set");
            assert.verifySteps(['/web/binary/upload']);

            customFileInput.destroy();
        });

        QUnit.test("Upload a file: custom attachment", async function (assert) {
            assert.expect(6);

            const customFileInput = await createComponent(CustomFileInput, {
                env: {
                    services: {
                        async httpRequest(route, params) {
                            assert.deepEqual(params, {
                                id: 5,
                                model: 'res.model',
                                csrfToken: verp.csrfToken,
                                ufile: [],
                            });
                            assert.step(route);
                            return '[]';
                        },
                    },
                },
                props: {
                    acceptedFileExtensions: '.png',
                    action: '/web/binary/upload_attachment',
                    id: 5,
                    model: 'res.model',
                    multiUpload: true,
                },
                intercepts: {
                    'uploaded': ev => assert.strictEqual(ev.detail.files.length, 0,
                        "'files' property should be an empty array"),
                },
            });
            const input = customFileInput.el.querySelector('input');

            assert.strictEqual(input.accept, '.png', "Input should now only accept pngs");

            await testUtils.dom.triggerEvent(input, 'change');

            assert.ok(input.multiple, "'multiple' attribute should be set");
            assert.verifySteps(['/web/binary/upload_attachment']);

            customFileInput.destroy();
        });
    });
});
