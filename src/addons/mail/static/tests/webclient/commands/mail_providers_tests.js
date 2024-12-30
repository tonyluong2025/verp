/** @verp-module **/

import { afterEach, afterNextRender, beforeEach, start } from '@mail/utils/test_utils';
import { editSearchBar } from '@web/../tests/core/commands/command_service_tests';
import { click, nextTick, patchWithCleanup, triggerHotkey } from "@web/../tests/helpers/utils";
import { browser } from '@web/core/browser/browser';
import { commandService } from "@web/core/commands/command_service";
import { registry } from "@web/core/registry";

const serviceRegistry = registry.category("services");

QUnit.module('mail', {}, function () {
    QUnit.module('Command Palette', {
        beforeEach() {
            serviceRegistry.add("command", commandService);
            beforeEach(this);
            patchWithCleanup(browser, {
                clearTimeout() {},
                setTimeout(later, wait) {
                    later();
                },
            });
            registry.category("commandCategories").add("default", { label: ("default") });
        },
        afterEach() {
            afterEach(this);
        },
    });

    QUnit.test('open the chatWindow of a user from the command palette', async function (assert) {
        assert.expect(3);

        this.data['res.partner'].records.push(
            { id: 11, name: "Partner 1", email: "p1@theverp.com" },
            { id: 12, name: "Partner 2", email: "p2@theverp.com" },
            { id: 13, name: "Partner 3", email: "p3@theverp.com" },
        );
        this.data['res.users'].records.push(
            { id: 11, name: "User 1", partnerId: 11 },
            { id: 7, name: "User 2", partnerId: 12 },
            { id: 23, name: "User 3", partnerId: 13 },
        );

        const { widget: webClient } = await start({
                data: this.data,
                hasChatWindow: true,
                hasWebClient: true,
            });
        triggerHotkey("control+k");
        await nextTick();

        // Switch to partners
        await editSearchBar("@");
        assert.deepEqual(
            [...webClient.el.querySelectorAll(".o-command-palette .o-command")].map((el) => el.textContent),
            [
                "Partner 1p1@theverp.com",
                "Partner 2p2@theverp.com",
                "Partner 3p3@theverp.com",
            ]
        );

        await afterNextRender(() => click(document.body, ".o-command.focused"));
        assert.containsOnce(document.body, ".o_ChatWindow");
        assert.strictEqual(document.querySelector(".o_ChatWindow .o_ChatWindowHeader_name").textContent, "Partner 1");

        webClient.destroy();
    });

    QUnit.test('open the chatWindow of a channel from the command palette', async function (assert) {
        assert.expect(3);

        this.data['mail.channel'].records.push({
            id: 100,
            name: "general",
            members: [this.data.currentPartnerId],
        });
        this.data['mail.channel'].records.push({
            id: 101,
            name: "project",
            members: [this.data.currentPartnerId],
        });
        const { widget: webClient } = await start({
                data: this.data,
                hasChatWindow: true,
                hasWebClient: true,
            });
        triggerHotkey("control+k");
        await nextTick();

        // Switch to channels
        await editSearchBar("#");
        assert.deepEqual(
            [...webClient.el.querySelectorAll(".o-command-palette .o-command")].map((el) => el.textContent),
            [
                "general",
                "project"
            ],
        );

        await afterNextRender(() => click(document.body, ".o-command.focused"));
        assert.containsOnce(document.body, ".o_ChatWindow");
        assert.strictEqual(document.querySelector(".o_ChatWindow .o_ChatWindowHeader_name").textContent, "general");

        webClient.destroy();
    });
});
