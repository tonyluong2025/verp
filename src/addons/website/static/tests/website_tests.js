verp.define('website.tests', function (require) {
"use strict";

var FormView = require('web.FormView');
var testUtils = require("web.testUtils");

var createView = testUtils.createView;

QUnit.module('website', {
    before: function () {
        this.data = {
            blog_post: {
                fields: {
                    websitePublished: {string: "Available on the Website", type: "boolean"},
                },
                records: [{
                    id: 1,
                    websitePublished: false,
                }, {
                    id: 2,
                    websitePublished: true,
                }]
            }
        };
    },
}, function () {
    QUnit.test("widget website button: display false value", async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'blog_post',
            data: this.data,
            arch: '<form>' +
                    '<sheet>' +
                        '<div class="oe-button-box" name="buttonBox">' +
                            '<field name="websitePublished" widget="website_redirect_button"/>' +
                        '</div>' +
                    '</sheet>' +
                '</form>',
            resId: 1,
        });
        var selector = '.oe-button-box .oe-stat-button[name="websitePublished"] .o-stat-text';
        assert.containsN(form, selector, 1, "there should be one text displayed");
        selector = '.oe-button-box .oe-stat-button[name="websitePublished"] .o-button-icon.fa-globe.text-danger';
        assert.containsOnce(form, selector, "there should be one icon in red");
        form.destroy();
    });
    QUnit.test("widget website button: display true value", async function (assert) {
        assert.expect(2);

        var form = await createView({
            View: FormView,
            model: 'blog_post',
            data: this.data,
            arch: '<form>' +
                    '<sheet>' +
                        '<div class="oe-button-box" name="buttonBox">' +
                            '<field name="websitePublished" widget="website_redirect_button"/>' +
                        '</div>' +
                    '</sheet>' +
                '</form>',
            resId: 2,
        });
        var selector = '.oe-button-box .oe-stat-button[name="websitePublished"] .o-stat-text';
        assert.containsN(form, selector, 1, "should be one text displayed");
        selector = '.oe-button-box .oe-stat-button[name="websitePublished"] .o-button-icon.fa-globe.text-success';
        assert.containsOnce(form, selector, "there should be one text in green");
        form.destroy();
    });
});

});
