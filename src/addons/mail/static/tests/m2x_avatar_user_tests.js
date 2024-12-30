/** @verp-module **/

import { Many2OneAvatarUser } from '@mail/js/m2x_avatar_user';
import { afterEach, beforeEach, start } from '@mail/utils/test_utils';
import { click, legacyExtraNextTick, patchWithCleanup, triggerHotkey } from "@web/../tests/helpers/utils";
import { createWebClient, doAction } from '@web/../tests/webclient/helpers';
import { registry } from "@web/core/registry";
import { makeLegacyCommandService } from "@web/legacy/utils";
import core from 'web.core';
import FormView from 'web.FormView';
import KanbanView from 'web.KanbanView';
import ListView from 'web.ListView';
import session from 'web.session';
import makeTestEnvironment from "web.test_env";
import { dom, mock, nextTick } from 'web.testUtils';


QUnit.module('mail', {}, function () {
    QUnit.module('M2XAvatarUser', {
        beforeEach() {
            beforeEach(this);

            // reset the cache before each test
            Many2OneAvatarUser.prototype.partnerIds = {};

            Object.assign(this.data, {
                'foo': {
                    fields: {
                        userId: { string: "User", type: 'many2one', relation: 'res.users' },
                        user_ids: { string: "Users", type: "many2many", relation: 'res.users',  default:[] },
                    },
                    records: [
                        { id: 1, userId: 11, user_ids: [11, 23], },
                        { id: 2, userId: 7 },
                        { id: 3, userId: 11 },
                        { id: 4, userId: 23 },
                    ],
                },
            });

            this.data['res.partner'].records.push(
                { id: 11, displayName: "Partner 1" },
                { id: 12, displayName: "Partner 2" },
                { id: 13, displayName: "Partner 3" }
            );
            this.data['res.users'].records.push(
                { id: 11, name: "Mario", partnerId: 11 },
                { id: 7, name: "Luigi", partnerId: 12 },
                { id: 23, name: "Yoshi", partnerId: 13 }
            );
        },
        afterEach() {
            afterEach(this);
        },
    });

    QUnit.test('many2oneAvatarUser widget in list view', async function (assert) {
        assert.expect(5);

        const { widget: list } = await start({
            hasView: true,
            View: ListView,
            model: 'foo',
            data: this.data,
            arch: '<tree><field name="userId" widget="many2oneAvatarUser"/></tree>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
        });

        mock.intercept(list, 'open_record', () => {
            assert.step('open record');
        });

        assert.strictEqual(list.$('.o-data-cell span').text(), 'MarioLuigiMarioYoshi');

        // sanity check: later on, we'll check that clicking on the avatar doesn't open the record
        await dom.click(list.$('.o-data-row:first span'));

        await dom.click(list.$('.o-data-cell:nth(0) .o-m2o-avatar > img'));
        await dom.click(list.$('.o-data-cell:nth(1) .o-m2o-avatar > img'));
        await dom.click(list.$('.o-data-cell:nth(2) .o-m2o-avatar > img'));


        assert.verifySteps([
            'open record',
            'read res.users 11',
            // 'call service openDMChatWindow 1',
            'read res.users 7',
            // 'call service openDMChatWindow 2',
            // 'call service openDMChatWindow 1',
        ]);

        list.destroy();
    });

    QUnit.test('many2oneAvatarUser widget in kanban view', async function (assert) {
        assert.expect(6);

        const { widget: kanban } = await start({
            hasView: true,
            View: KanbanView,
            model: 'foo',
            data: this.data,
            arch: `
                <kanban>
                    <templates>
                        <t t-name="kanban-box">
                            <div>
                                <field name="userId" widget="many2oneAvatarUser"/>
                            </div>
                        </t>
                    </templates>
                </kanban>`,
        });

        assert.strictEqual(kanban.$('.o-kanban-record').text().trim(), '');
        assert.containsN(kanban, '.o-m2o-avatar', 4);
        assert.strictEqual(kanban.$('.o-m2o-avatar:nth(0) > img').data('src'), '/web/image/res.users/11/avatar128');
        assert.strictEqual(kanban.$('.o-m2o-avatar:nth(1) > img').data('src'), '/web/image/res.users/7/avatar128');
        assert.strictEqual(kanban.$('.o-m2o-avatar:nth(2) > img').data('src'), '/web/image/res.users/11/avatar128');
        assert.strictEqual(kanban.$('.o-m2o-avatar:nth(3) > img').data('src'), '/web/image/res.users/23/avatar128');

        kanban.destroy();
    });

    QUnit.test('many2manyAvatarUser widget in form view', async function (assert) {
        assert.expect(7);

        const { widget: form } = await start({
            hasView: true,
            View: FormView,
            model: 'foo',
            data: this.data,
            arch: '<form><field name="user_ids" widget="many2manyAvatarUser"/></form>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
            resId: 1,
        });

        assert.containsN(form, '.o-field-many2manytags.avatar.o-field-widget .badge', 2,
            "should have 2 records");
        assert.strictEqual(form.$('.o-field-many2manytags.avatar.o-field-widget .badge:first img').data('src'), '/web/image/res.users/11/avatar128',
            "should have correct avatar image");

        await dom.click(form.$('.o-field-many2manytags.avatar .badge:first .o-m2m-avatar'));
        await dom.click(form.$('.o-field-many2manytags.avatar .badge:nth(1) .o-m2m-avatar'));

        assert.verifySteps([
            "read foo 1",
            'read res.users 11,23',
            "read res.users 11",
            "read res.users 23",
        ]);

        form.destroy();
    });

    QUnit.test('many2manyAvatarUser widget with single record in list view', async function (assert) {
        assert.expect(4);

        this.data.foo.records[1].user_ids = [11];

        const { widget: list } = await start({
            hasView: true,
            View: ListView,
            model: 'foo',
            data: this.data,
            arch: '<tree editable="top"><field name="user_ids" widget="many2manyAvatarUser"/></tree>',
            resId: 1,
        });

        assert.containsN(list, '.o-data-row:eq(0) .o-field-many2manytags.avatar.o-field-widget .o-m2m-avatar', 2,
            "should have 2 records");
        assert.containsN(list, '.o-data-row:eq(1) .o-field-many2manytags.avatar.o-field-widget > div > span', 1,
            "should have 1 record in second row");
        assert.containsN(list, '.o-data-row:eq(1) .o-field-many2manytags.avatar.o-field-widget > div > span', 1,
            "should have img and span in second record");

        await dom.click(list.$('.o-data-row:eq(1) .o-field-many2manytags.avatar:first > div > span'));
        assert.containsOnce(list, '.o-selected-row');

        list.destroy();
    });

    QUnit.test('many2manyAvatarUser widget in list view', async function (assert) {
        assert.expect(8);

        const { widget: list } = await start({
            hasView: true,
            View: ListView,
            model: 'foo',
            data: this.data,
            arch: '<tree><field name="user_ids" widget="many2manyAvatarUser"/></tree>',
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
        });

        mock.intercept(list, 'open_record', () => {
            assert.step('open record');
        });

        assert.containsN(list.$(".o-data-cell:first"), '.o-field-many2manytags.avatar.o-field-widget span', 2,
            "should have 2 records");
        assert.strictEqual(list.$(".o-data-cell:first .o-field-many2manytags.avatar img.o-m2m-avatar:first").data('src'),
            "/web/image/res.users/11/avatar128",
            "should have right image");
        assert.strictEqual(list.$(".o-data-cell:eq(0) .o-field-many2manytags.avatar img.o-m2m-avatar:eq(1)").data('src'),
            "/web/image/res.users/23/avatar128",
            "should have right image");

        // sanity check: later on, we'll check that clicking on the avatar doesn't open the record
        await dom.click(list.$('.o-data-row:first .o-field-many2manytags'));

        await dom.click(list.$('.o-data-cell:nth(0) .o-m2m-avatar:nth(0)'));
        await dom.click(list.$('.o-data-cell:nth(0) .o-m2m-avatar:nth(1)'));

        assert.verifySteps([
            'read res.users 11,23',
            "open record",
            "read res.users 11",
            "read res.users 23",
        ]);

        list.destroy();
    });

    QUnit.test('many2manyAvatarUser in kanban view', async function (assert) {
        assert.expect(11);

        this.data['res.users'].records.push({ id: 15, name: "Tapu", partnerId: 11 },);
        this.data.foo.records[2].user_ids = [11, 23, 7, 15];

        const { widget: kanban } = await start({
            hasView: true,
            View: KanbanView,
            model: 'foo',
            data: this.data,
            arch: `
                <kanban>
                    <templates>
                        <t t-name="kanban-box">
                            <div>
                                <field name="userId"/>
                                <div class="oe-kanban-footer">
                                    <div class="o-kanban-record-bottom">
                                        <div class="oe-kanban-bottom-right">
                                            <field name="user_ids" widget="many2manyAvatarUser"/>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </t>
                    </templates>
                </kanban>`,
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
        });

        mock.intercept(kanban, 'open_record', () => {
            assert.step('open record');
        });

        assert.strictEqual(kanban.$('.o-kanban-record:first .o-field-many2manytags img.o-m2m-avatar:first').data('src'),
            "/web/image/res.users/11/avatar128",
            "should have correct avatar image");
        assert.strictEqual(kanban.$('.o-kanban-record:first .o-field-many2manytags img.o-m2m-avatar:eq(1)').data('src'),
            "/web/image/res.users/23/avatar128",
            "should have correct avatar image");

        assert.containsN(kanban, '.o-kanban-record:eq(2) .o-field-many2manytags > span:not(.o-m2m-avatar-empty)', 2,
            "should have 2 records");
        assert.strictEqual(kanban.$('.o-kanban-record:eq(2) .o-field-many2manytags img.o-m2m-avatar:first').data('src'),
            "/web/image/res.users/11/avatar128",
            "should have correct avatar image");
        assert.strictEqual(kanban.$('.o-kanban-record:eq(2) .o-field-many2manytags img.o-m2m-avatar:eq(1)').data('src'),
            "/web/image/res.users/23/avatar128",
            "should have correct avatar image");
        assert.containsOnce(kanban, '.o-kanban-record:eq(2) .o-field-many2manytags .o-m2m-avatar-empty',
            "should have o-m2m-avatar-empty span");
        assert.strictEqual(kanban.$('.o-kanban-record:eq(2) .o-field-many2manytags .o-m2m-avatar-empty').text().trim(), "+2",
            "should have +2 in o-m2m-avatar-empty");

        kanban.$('.o-kanban-record:eq(2) .o-field-many2manytags .o-m2m-avatar-empty').trigger($.Event('mouseenter'));
        await nextTick();
        assert.containsOnce(kanban, '.popover',
            "should open a popover hover on o-m2m-avatar-empty");
        assert.strictEqual(kanban.$('.popover .popover-body > div').text().trim(), "LuigiTapu",
            "should have a right text in popover");

        assert.verifySteps([
            "read res.users 7,11,15,23",
        ]);

        kanban.destroy();
    });

    QUnit.test('many2oneAvatarUser widget in list view with noOpenChat set to true', async function (assert) {
        assert.expect(3);

        const { widget: list } = await start({
            hasView: true,
            View: ListView,
            model: 'foo',
            data: this.data,
            arch: `<tree><field name="userId" widget="many2oneAvatarUser" options="{'noOpenChat': 1}"/></tree>`,
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
        });

        mock.intercept(list, 'open_record', () => {
            assert.step('open record');
        });

        assert.strictEqual(list.$('.o-data-cell span').text(), 'MarioLuigiMarioYoshi');

        // sanity check: later on, we'll check that clicking on the avatar doesn't open the record
        await dom.click(list.$('.o-data-row:first span'));

        await dom.click(list.$('.o-data-cell:nth(0) .o-m2o-avatar > img'));
        await dom.click(list.$('.o-data-cell:nth(1) .o-m2o-avatar > img'));
        await dom.click(list.$('.o-data-cell:nth(2) .o-m2o-avatar > img'));


        assert.verifySteps([
            'open record',
        ]);

        list.destroy();
    });

    QUnit.test('many2oneAvatarUser widget in kanban view', async function (assert) {
        assert.expect(3);

        const { widget: kanban } = await start({
            hasView: true,
            View: KanbanView,
            model: 'foo',
            data: this.data,
            arch: `
                <kanban>
                    <templates>
                        <t t-name="kanban-box">
                            <div>
                                <field name="userId" widget="many2oneAvatarUser" options="{'noOpenChat': 1}"/>
                            </div>
                        </t>
                    </templates>
                </kanban>`,
        });

        assert.strictEqual(kanban.$('.o-kanban-record').text().trim(), '');
        assert.containsN(kanban, '.o-m2o-avatar', 4);
        dom.click(kanban.$('.o-m2o-avatar:nth(0) > img'));
        dom.click(kanban.$('.o-m2o-avatar:nth(1) > img'));
        dom.click(kanban.$('.o-m2o-avatar:nth(2) > img'));
        dom.click(kanban.$('.o-m2o-avatar:nth(3) > img'));

        assert.verifySteps([], "no read res.user should be done since we don't want to open chat when the user clicks on avatar.");

        kanban.destroy();
    });

    QUnit.test('many2manyAvatarUser widget in form view', async function (assert) {
        assert.expect(5);

        const { widget: form } = await start({
            hasView: true,
            View: FormView,
            model: 'foo',
            data: this.data,
            arch: `<form><field name="user_ids" widget="many2manyAvatarUser" options="{'noOpenChat': 1}"/></form>`,
            mockRPC(route, args) {
                if (args.method === 'read') {
                    assert.step(`read ${args.model} ${args.args[0]}`);
                }
                return this._super(...arguments);
            },
            resId: 1,
        });

        assert.containsN(form, '.o-field-many2manytags.avatar.o-field-widget .badge', 2,
            "should have 2 records");
        assert.strictEqual(form.$('.o-field-many2manytags.avatar.o-field-widget .badge:first img').data('src'), '/web/image/res.users/11/avatar128',
            "should have correct avatar image");

        await dom.click(form.$('.o-field-many2manytags.avatar .badge:first .o-m2m-avatar'));
        await dom.click(form.$('.o-field-many2manytags.avatar .badge:nth(1) .o-m2m-avatar'));

        assert.verifySteps([
            "read foo 1",
            'read res.users 11,23',
        ]);

        form.destroy();
    });

    QUnit.test('many2oneAvatarUser widget edited by the smart action "Assign to..."', async function (assert) {
        assert.expect(4);

        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacyCommand", makeLegacyCommandService(legacyEnv));

        const views = {
            'foo,false,form': '<form><field name="userId" widget="many2oneAvatarUser"/></form>',
            'foo,false,search': '<search></search>',
        };
        const models = {
            'foo': this.data.foo,
            'res.partner': this.data['res.partner'],
            'res.users': this.data['res.users'],
        }
        const serverData = { models, views}
        const webClient = await createWebClient({serverData});
        await doAction(webClient, {
            resId: 1,
            type: 'ir.actions.actwindow',
            target: 'current',
            resModel: 'foo',
            'viewMode': 'form',
            'views': [[false, 'form']],
        });
        assert.strictEqual(webClient.el.querySelector(".o-m2o-avatar > span").textContent, "Mario")

        triggerHotkey("control+k")
        await nextTick();
        const idx = [...webClient.el.querySelectorAll(".o-command")].map(el => el.textContent).indexOf("Assign to ...ALT + I")
        assert.ok(idx >= 0);

        await click([...webClient.el.querySelectorAll(".o-command")][idx])
        await nextTick();
        assert.deepEqual([...webClient.el.querySelectorAll(".o-command")].map(el => el.textContent), [
            "Your Company, Mitchell Admin",
            "Public user",
            "Mario",
            "Luigi",
            "Yoshi",
          ])
        await click(webClient.el, "#o-command-3")
        await legacyExtraNextTick();
        assert.strictEqual(webClient.el.querySelector(".o-m2o-avatar > span").textContent, "Luigi")
    });

    QUnit.test('many2oneAvatarUser widget edited by the smart action "Assign to me"', async function (assert) {
        assert.expect(4);

        patchWithCleanup(session, { userId: [7] })
        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacyCommand", makeLegacyCommandService(legacyEnv));

        const views = {
            'foo,false,form': '<form><field name="userId" widget="many2oneAvatarUser"/></form>',
            'foo,false,search': '<search></search>',
        };
        const models = {
            'foo': this.data.foo,
            'res.partner': this.data['res.partner'],
            'res.users': this.data['res.users'],
        }
        const serverData = { models, views}
        const webClient = await createWebClient({serverData});
        await doAction(webClient, {
            resId: 1,
            type: 'ir.actions.actwindow',
            target: 'current',
            resModel: 'foo',
            'viewMode': 'form',
            'views': [[false, 'form']],
        });
        assert.strictEqual(webClient.el.querySelector(".o-m2o-avatar > span").textContent, "Mario")
        triggerHotkey("control+k")
        await nextTick();
        const idx = [...webClient.el.querySelectorAll(".o-command")].map(el => el.textContent).indexOf("Assign/unassign to meALT + SHIFT + I")
        assert.ok(idx >= 0);

        // Assign me (Luigi)
        triggerHotkey("alt+shift+i")
        await legacyExtraNextTick();
        assert.strictEqual(webClient.el.querySelector(".o-m2o-avatar > span").textContent, "Luigi")

        // Unassign me
        triggerHotkey("control+k");
        await nextTick();
        await click([...webClient.el.querySelectorAll(".o-command")][idx])
        await legacyExtraNextTick();
        assert.strictEqual(webClient.el.querySelector(".o-m2o-avatar > span").textContent, "")
    });

    QUnit.test('many2manyAvatarUser widget edited by the smart action "Assign to..."', async function (assert) {
        assert.expect(4);

        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacyCommand", makeLegacyCommandService(legacyEnv));

        const views = {
            'foo,false,form': '<form><field name="user_ids" widget="many2manyAvatarUser"/></form>',
            'foo,false,search': '<search></search>',
        };
        const models = {
            'foo': this.data.foo,
            'res.partner': this.data['res.partner'],
            'res.users': this.data['res.users'],
        }
        const serverData = { models, views}
        const webClient = await createWebClient({serverData});
        await doAction(webClient, {
            resId: 1,
            type: 'ir.actions.actwindow',
            target: 'current',
            resModel: 'foo',
            'viewMode': 'form',
            'views': [[false, 'form']],
        });
        let userNames = [...webClient.el.querySelectorAll(".o-tag-badge-text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi"]);

        triggerHotkey("control+k")
        await nextTick();
        const idx = [...webClient.el.querySelectorAll(".o-command")].map(el => el.textContent).indexOf("Assign to ...ALT + I")
        assert.ok(idx >= 0);

        await click([...webClient.el.querySelectorAll(".o-command")][idx])
        await nextTick();
        assert.deepEqual([...webClient.el.querySelectorAll(".o-command")].map(el => el.textContent), [
            "Your Company, Mitchell Admin",
            "Public user",
            "Luigi"
          ]);

        await click(webClient.el, "#o-command-2");
        await legacyExtraNextTick();
        userNames = [...webClient.el.querySelectorAll(".o-tag-badge-text")].map(el => el.textContent);
        assert.deepEqual(userNames, ["Mario", "Yoshi", "Luigi"]);
    });

    QUnit.test('many2manyAvatarUser widget edited by the smart action "Assign to me"', async function (assert) {
        assert.expect(4);

        patchWithCleanup(session, { userId: [7] })
        const legacyEnv = makeTestEnvironment({ bus: core.bus });
        const serviceRegistry = registry.category("services");
        serviceRegistry.add("legacyCommand", makeLegacyCommandService(legacyEnv));

        const views = {
            'foo,false,form': '<form><field name="user_ids" widget="many2manyAvatarUser"/></form>',
            'foo,false,search': '<search></search>',
        };
        const models = {
            'foo': this.data.foo,
            'res.partner': this.data['res.partner'],
            'res.users': this.data['res.users'],
        }
        const serverData = { models, views}
        const webClient = await createWebClient({serverData});
        await doAction(webClient, {
            resId: 1,
            type: 'ir.actions.actwindow',
            target: 'current',
            resModel: 'foo',
            'viewMode': 'form',
            'views': [[false, 'form']],
        });
        let userNames = [...webClient.el.querySelectorAll(".o-tag-badge-text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi"]);

        triggerHotkey("control+k");
        await nextTick();
        const idx = [...webClient.el.querySelectorAll(".o-command")].map(el => el.textContent).indexOf("Assign/unassign to meALT + SHIFT + I");
        assert.ok(idx >= 0);

        // Assign me (Luigi)
        triggerHotkey("alt+shift+i");
        await legacyExtraNextTick();
        userNames = [...webClient.el.querySelectorAll(".o-tag-badge-text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi", "Luigi"]);

        // Unassign me
        triggerHotkey("control+k");
        await nextTick();
        await click([...webClient.el.querySelectorAll(".o-command")][idx]);
        await legacyExtraNextTick();
        userNames = [...webClient.el.querySelectorAll(".o-tag-badge-text")].map((el => el.textContent));
        assert.deepEqual(userNames, ["Mario", "Yoshi"]);
    });

});
