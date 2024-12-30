/** @verp-module **/

import { insert } from '@mail/model/model_field_command';
import { afterEach, beforeEach, start } from '@mail/utils/test_utils';

QUnit.module('mail', {}, function () {
QUnit.module('models', {}, function () {
QUnit.module('thread', {}, function () {
QUnit.module('thread_tests.js', {
    beforeEach() {
        beforeEach(this);

        this.start = async params => {
            const { env, widget } = await start(Object.assign({}, params, {
                data: this.data,
            }));
            this.env = env;
            this.widget = widget;
        };
    },
    afterEach() {
        afterEach(this);
    },
});

QUnit.test('inbox & starred mailboxes', async function (assert) {
    assert.expect(10);

    await this.start();
    const mailboxInbox = this.messaging.inbox;
    const mailboxStarred = this.messaging.starred;
    assert.ok(mailboxInbox, "should have mailbox inbox");
    assert.ok(mailboxStarred, "should have mailbox starred");
    assert.strictEqual(mailboxInbox.model, 'mail.box');
    assert.strictEqual(mailboxInbox.counter, 0);
    assert.strictEqual(mailboxInbox.id, 'inbox');
    assert.strictEqual(mailboxInbox.label, "Inbox"); // language-dependent
    assert.strictEqual(mailboxStarred.model, 'mail.box');
    assert.strictEqual(mailboxStarred.counter, 0);
    assert.strictEqual(mailboxStarred.id, 'starred');
    assert.strictEqual(mailboxStarred.label, "Starred"); // language-dependent
});

QUnit.test('create (channel)', async function (assert) {
    assert.expect(23);

    await this.start();
    assert.notOk(this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 9 }));
    assert.notOk(this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 10 }));
    assert.notOk(this.messaging.models['mail.thread'].findFromIdentifyingData({
        id: 100,
        model: 'mail.channel',
    }));

    const thread = this.messaging.models['mail.thread'].create({
        channelType: 'channel',
        id: 100,
        members: insert([{
            email: "john@example.com",
            id: 9,
            label: "John",
        }, {
            email: "fred@example.com",
            id: 10,
            label: "Fred",
        }]),
        messageNeedactionCounter: 6,
        model: 'mail.channel',
        label: "General",
        isPublic: 'public',
        serverMessageUnreadCounter: 5,
    });
    assert.ok(thread);
    assert.ok(this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 9 }));
    assert.ok(this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 10 }));
    assert.ok(this.messaging.models['mail.thread'].findFromIdentifyingData({
        id: 100,
        model: 'mail.channel',
    }));
    const partner9 = this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 9 });
    const partner10 = this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 10 });
    assert.strictEqual(thread, this.messaging.models['mail.thread'].findFromIdentifyingData({
        id: 100,
        model: 'mail.channel',
    }));
    assert.strictEqual(thread.model, 'mail.channel');
    assert.strictEqual(thread.channelType, 'channel');
    assert.strictEqual(thread.id, 100);
    assert.ok(thread.members.includes(partner9));
    assert.ok(thread.members.includes(partner10));
    assert.strictEqual(thread.messageNeedactionCounter, 6);
    assert.strictEqual(thread.label, "General");
    assert.strictEqual(thread.isPublic, 'public');
    assert.strictEqual(thread.serverMessageUnreadCounter, 5);
    assert.strictEqual(partner9.email, "john@example.com");
    assert.strictEqual(partner9.id, 9);
    assert.strictEqual(partner9.label, "John");
    assert.strictEqual(partner10.email, "fred@example.com");
    assert.strictEqual(partner10.id, 10);
    assert.strictEqual(partner10.label, "Fred");
});

QUnit.test('create (chat)', async function (assert) {
    assert.expect(15);

    await this.start();
    assert.notOk(this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 5 }));
    assert.notOk(this.messaging.models['mail.thread'].findFromIdentifyingData({
        id: 200,
        model: 'mail.channel',
    }));

    const channel = this.messaging.models['mail.thread'].create({
        channelType: 'chat',
        id: 200,
        members: insert({
            email: "demo@example.com",
            id: 5,
            imStatus: 'online',
            label: "Demo",
        }),
        model: 'mail.channel',
    });
    assert.ok(channel);
    assert.ok(this.messaging.models['mail.thread'].findFromIdentifyingData({
        id: 200,
        model: 'mail.channel',
    }));
    assert.ok(this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 5 }));
    const partner = this.messaging.models['mail.partner'].findFromIdentifyingData({ id: 5 });
    assert.strictEqual(channel, this.messaging.models['mail.thread'].findFromIdentifyingData({
        id: 200,
        model: 'mail.channel',
    }));
    assert.strictEqual(channel.model, 'mail.channel');
    assert.strictEqual(channel.channelType, 'chat');
    assert.strictEqual(channel.id, 200);
    assert.ok(channel.correspondent);
    assert.strictEqual(partner, channel.correspondent);
    assert.strictEqual(partner.email, "demo@example.com");
    assert.strictEqual(partner.id, 5);
    assert.strictEqual(partner.imStatus, 'online');
    assert.strictEqual(partner.label, "Demo");
});

});
});
});
