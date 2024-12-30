/** @verp-module **/

import { afterEach, beforeEach, start } from '@mail/utils/test_utils';

import FormView from 'web.FormView';
import ListView from 'web.ListView';
import testUtils from 'web.testUtils';

QUnit.module('mail', {}, function () {
QUnit.module('Chatter', {
    beforeEach: function () {
        beforeEach(this);

        this.data['res.partner'].records.push({ id: 11, imStatus: 'online' });
        this.data['mail.activity.type'].records.push(
            { id: 1, name: "Type 1" },
            { id: 2, name: "Type 2" },
            { id: 3, name: "Type 3", category: 'upload_file' },
            { id: 4, name: "Exception", decoration_type: "warning", icon: "fa-warning" }
        );
        this.data['ir.attachment'].records.push(
            {
                id: 1,
                mimetype: 'image/png',
                name: 'filename.jpg',
                resId: 7,
                resModel: 'res.users',
                type: 'url',
            },
            {
                id: 2,
                mimetype: "application/x-msdos-program",
                name: "file2.txt",
                resId: 7,
                resModel: 'res.users',
                type: 'binary',
            },
            {
                id: 3,
                mimetype: "application/x-msdos-program",
                name: "file3.txt",
                resId: 5,
                resModel: 'res.users',
                type: 'binary',
            },
        );
        Object.assign(this.data['res.users'].fields, {
            activity_exception_decoration: {
                string: 'Decoration',
                type: 'selection',
                selection: [['warning', 'Alert'], ['danger', 'Error']],
            },
            activityExceptionIcon: {
                string: 'icon',
                type: 'char',
            },
            activityIds: {
                string: 'Activities',
                type: 'one2many',
                relation: 'mail.activity',
                relationField: 'resId',
            },
            activityState: {
                string: 'State',
                type: 'selection',
                selection: [['overdue', 'Overdue'], ['today', 'Today'], ['planned', 'Planned']],
            },
            activitySummary: {
                string: "Next Activity Summary",
                type: 'char',
            },
            activityTypeIcon: {
                string: "Activity Type Icon",
                type: 'char',
            },
            activityTypeId: {
                string: "Activity type",
                type: "many2one",
                relation: "mail.activity.type",
            },
            foo: { string: "Foo", type: "char", default: "My little Foo Value" },
            message_attachment_count: {
                string: 'Attachment count',
                type: 'integer',
            },
            messageFollowerIds: {
                string: "Followers",
                type: "one2many",
                relation: 'mail.followers',
                relationField: "resId",
            },
            messageIds: {
                string: "messages",
                type: "one2many",
                relation: 'mail.message',
                relationField: "resId",
            },
        });
    },
    afterEach() {
        afterEach(this);
    },
});

QUnit.test('list activity widget with no activity', async function (assert) {
    assert.expect(4);

    const { widget: list } = await start({
        hasView: true,
        View: ListView,
        model: 'res.users',
        data: this.data,
        arch: '<list><field name="activityIds" widget="listActivity"/></list>',
        mockRPC: function (route) {
            if (!['/mail/initMessaging', '/mail/load_message_failures'].includes(route)) {
                assert.step(route);
            }
            return this._super(...arguments);
        },
        session: { uid: 2 },
    });

    assert.containsOnce(list, '.o_mail_activity .o_activity_color_default');
    assert.strictEqual(list.$('.o_activity_summary').text(), '');

    assert.verifySteps(['/web/dataset/searchRead']);

    list.destroy();
});

QUnit.test('list activity widget with activities', async function (assert) {
    assert.expect(6);

    const currentUser = this.data['res.users'].records.find(user =>
        user.id === this.data.currentUserId
    );
    Object.assign(currentUser, {
        activityIds: [1, 4],
        activityState: 'today',
        activitySummary: 'Call with Al',
        activityTypeId: 3,
        activityTypeIcon: 'fa-phone',
    });

    this.data['res.users'].records.push({
        id: 44,
        activityIds: [2],
        activityState: 'planned',
        activitySummary: false,
        activityTypeId: 2,
    });

    const { widget: list } = await start({
        hasView: true,
        View: ListView,
        model: 'res.users',
        data: this.data,
        arch: '<list><field name="activityIds" widget="listActivity"/></list>',
        mockRPC: function (route) {
            if (!['/mail/initMessaging', '/mail/load_message_failures'].includes(route)) {
                assert.step(route);
            }
            return this._super(...arguments);
        },
    });

    const $firstRow = list.$('.o-data-row:first');
    assert.containsOnce($firstRow, '.o_mail_activity .o_activity_color_today.fa-phone');
    assert.strictEqual($firstRow.find('.o_activity_summary').text(), 'Call with Al');

    const $secondRow = list.$('.o-data-row:nth(1)');
    assert.containsOnce($secondRow, '.o_mail_activity .o_activity_color_planned.fa-clock-o');
    assert.strictEqual($secondRow.find('.o_activity_summary').text(), 'Type 2');

    assert.verifySteps(['/web/dataset/searchRead']);

    list.destroy();
});

QUnit.test('list activity widget with exception', async function (assert) {
    assert.expect(4);

    const currentUser = this.data['res.users'].records.find(user =>
        user.id === this.data.currentUserId
    );
    Object.assign(currentUser, {
        activityIds: [1],
        activityState: 'today',
        activitySummary: 'Call with Al',
        activityTypeId: 3,
        activity_exception_decoration: 'warning',
        activityExceptionIcon: 'fa-warning',
    });

    const { widget: list } = await start({
        hasView: true,
        View: ListView,
        model: 'res.users',
        data: this.data,
        arch: '<list><field name="activityIds" widget="listActivity"/></list>',
        mockRPC: function (route) {
            if (!['/mail/initMessaging', '/mail/load_message_failures'].includes(route)) {
                assert.step(route);
            }
            return this._super(...arguments);
        },
    });

    assert.containsOnce(list, '.o_activity_color_today.text-warning.fa-warning');
    assert.strictEqual(list.$('.o_activity_summary').text(), 'Warning');

    assert.verifySteps(['/web/dataset/searchRead']);

    list.destroy();
});

QUnit.test('list activity widget: open dropdown', async function (assert) {
    assert.expect(9);

    const currentUser = this.data['res.users'].records.find(user =>
        user.id === this.data.currentUserId
    );
    Object.assign(currentUser, {
        activityIds: [1, 4],
        activityState: 'today',
        activitySummary: 'Call with Al',
        activityTypeId: 3,
    });
    this.data['mail.activity'].records.push(
        {
            id: 1,
            displayName: "Call with Al",
            dateDeadline: moment().format("YYYY-MM-DD"), // now
            canWrite: true,
            state: "today",
            userId: this.data.currentUserId,
            createdUid: this.data.currentUserId,
            activityTypeId: 3,
        },
        {
            id: 4,
            displayName: "Meet FP",
            dateDeadline: moment().add(1, 'day').format("YYYY-MM-DD"), // tomorrow
            canWrite: true,
            state: "planned",
            userId: this.data.currentUserId,
            createdUid: this.data.currentUserId,
            activityTypeId: 1,
        }
    );

    const { widget: list } = await start({
        hasView: true,
        View: ListView,
        model: 'res.users',
        data: this.data,
        arch: `
            <list>
                <field name="foo"/>
                <field name="activityIds" widget="listActivity"/>
            </list>`,
        mockRPC: function (route, args) {
            if (!['/mail/initMessaging', '/mail/load_message_failures'].includes(route)) {
                assert.step(args.method || route);
            }
            if (args.method === 'actionFeedback') {
                const currentUser = this.data['res.users'].records.find(user =>
                    user.id === this.currentUserId
                );
                Object.assign(currentUser, {
                    activityIds: [4],
                    activityState: 'planned',
                    activitySummary: 'Meet FP',
                    activityTypeId: 1,
                });
                return Promise.resolve();
            }
            return this._super(route, args);
        },
        intercepts: {
            switchView: () => assert.step('switchView'),
        },
    });

    assert.strictEqual(list.$('.o_activity_summary').text(), 'Call with Al');

    // click on the first record to open it, to ensure that the 'switchView'
    // assertion is relevant (it won't be opened as there is no action manager,
    // but we'll log the 'switchView' event)
    await testUtils.dom.click(list.$('.o-data-cell:first'));

    // from this point, no 'switchView' event should be triggered, as we
    // interact with the activity widget
    assert.step('open dropdown');
    await testUtils.dom.click(list.$('.o_activity_btn span')); // open the popover
    await testUtils.dom.click(list.$('.o_mark_as_done:first')); // mark the first activity as done
    await testUtils.dom.click(list.$('.o_activity_popover_done')); // confirm

    assert.strictEqual(list.$('.o_activity_summary').text(), 'Meet FP');

    assert.verifySteps([
        '/web/dataset/searchRead',
        'switchView',
        'open dropdown',
        'activityFormat',
        'actionFeedback',
        'read',
    ]);

    list.destroy();
});

QUnit.test('list activity exception widget with activity', async function (assert) {
    assert.expect(3);

    const currentUser = this.data['res.users'].records.find(user =>
        user.id === this.data.currentUserId
    );
    currentUser.activityIds = [1];
    this.data['res.users'].records.push({
        id: 13,
        message_attachment_count: 3,
        displayName: "second partner",
        foo: "Tommy",
        messageFollowerIds: [],
        messageIds: [],
        activityIds: [2],
        activity_exception_decoration: 'warning',
        activityExceptionIcon: 'fa-warning',
    });
    this.data['mail.activity'].records.push(
        {
            id: 1,
            displayName: "An activity",
            dateDeadline: moment().format("YYYY-MM-DD"), // now
            canWrite: true,
            state: "today",
            userId: 2,
            createdUid: 2,
            activityTypeId: 1,
        },
        {
            id: 2,
            displayName: "An exception activity",
            dateDeadline: moment().format("YYYY-MM-DD"), // now
            canWrite: true,
            state: "today",
            userId: 2,
            createdUid: 2,
            activityTypeId: 4,
        }
    );

    const { widget: list } = await start({
        hasView: true,
        View: ListView,
        model: 'res.users',
        data: this.data,
        arch: '<tree>' +
                '<field name="foo"/>' +
                '<field name="activity_exception_decoration" widget="activityException"/> ' +
            '</tree>',
    });

    assert.containsN(list, '.o-data-row', 2, "should have two records");
    assert.doesNotHaveClass(list.$('.o-data-row:eq(0) .o_activity_exception_cell div'), 'fa-warning',
        "there is no any exception activity on record");
    assert.hasClass(list.$('.o-data-row:eq(1) .o_activity_exception_cell div'), 'fa-warning',
        "there is an exception on a record");

    list.destroy();
});

QUnit.module('FieldMany2ManyTagsEmail', {
    beforeEach() {
        beforeEach(this);

        Object.assign(this.data['res.users'].fields, {
            timmy: { string: "pokemon", type: "many2many", relation: 'partner_type' },
        });
        this.data['res.users'].records.push({
            id: 11,
            displayName: "first record",
            timmy: [],
        });
        Object.assign(this.data, {
            partner_type: {
                fields: {
                    name: { string: "Partner Type", type: "char" },
                    email: { string: "Email", type: "char" },
                },
                records: [],
            },
        });
        this.data['partner_type'].records.push(
            { id: 12, displayName: "gold", email: 'coucou@petite.perruche' },
            { id: 14, displayName: "silver", email: '' }
        );
    },
    afterEach() {
        afterEach(this);
    },
});

QUnit.test('fieldmany2many tags email', function (assert) {
    assert.expect(13);
    var done = assert.async();

    const user11 = this.data['res.users'].records.find(user => user.id === 11);
    user11.timmy = [12, 14];

    // the modals need to be closed before the form view rendering
    start({
        hasView: true,
        View: FormView,
        model: 'res.users',
        data: this.data,
        resId: 11,
        arch: '<form string="Partners">' +
                '<sheet>' +
                    '<field name="displayName"/>' +
                    '<field name="timmy" widget="many2many_tags_email"/>' +
                '</sheet>' +
            '</form>',
        viewOptions: {
            mode: 'edit',
        },
        mockRPC: function (route, args) {
            if (args.method === 'read' && args.model === 'partner_type') {
                assert.step(JSON.stringify(args.args[0]));
                assert.deepEqual(args.args[1], ['displayName', 'email'], "should read the email");
            }
            return this._super.apply(this, arguments);
        },
        archs: {
            'partner_type,false,form': '<form string="Types"><field name="displayName"/><field name="email"/></form>',
        },
    }).then(async function ({ widget: form }) {
        // should read it 3 times (1 with the form view, one with the form dialog and one after save)
        assert.verifySteps(['[12,14]', '[14]', '[14]']);
        await testUtils.nextTick();
        assert.containsN(form, '.o-field-many2manytags[name="timmy"] .badge.o-tag-color-0', 2,
            "two tags should be present");
        var firstTag = form.$('.o-field-many2manytags[name="timmy"] .badge.o-tag-color-0').first();
        assert.strictEqual(firstTag.find('.o-badge-text').text(), "gold",
            "tag should only show displayName");
        assert.hasAttrValue(firstTag.find('.o-badge-text'), 'title', "coucou@petite.perruche",
            "tag should show email address on mouse hover");
        form.destroy();
        done();
    });
    testUtils.nextTick().then(function () {
        assert.strictEqual($('.modal-body.o-actwindow').length, 1,
            "there should be one modal opened to edit the empty email");
        assert.strictEqual($('.modal-body.o-actwindow input[name="displayName"]').val(), "silver",
            "the opened modal should be a form view dialog with the partner_type 14");
        assert.strictEqual($('.modal-body.o-actwindow input[name="email"]').length, 1,
            "there should be an email field in the modal");

        // set the email and save the modal (will render the form view)
        testUtils.fields.editInput($('.modal-body.o-actwindow input[name="email"]'), 'coucou@petite.perruche');
        testUtils.dom.click($('.modal-footer .btn-primary'));
    });

});

QUnit.test('fieldmany2many tags email (edition)', async function (assert) {
    assert.expect(15);

    const user11 = this.data['res.users'].records.find(user => user.id === 11);
    user11.timmy = [12];

    var { widget: form } = await start({
        hasView: true,
        View: FormView,
        model: 'res.users',
        data: this.data,
        resId: 11,
        arch: '<form string="Partners">' +
                '<sheet>' +
                    '<field name="displayName"/>' +
                    '<field name="timmy" widget="many2many_tags_email"/>' +
                '</sheet>' +
            '</form>',
        viewOptions: {
            mode: 'edit',
        },
        mockRPC: function (route, args) {
            if (args.method === 'read' && args.model === 'partner_type') {
                assert.step(JSON.stringify(args.args[0]));
                assert.deepEqual(args.args[1], ['displayName', 'email'], "should read the email");
            }
            return this._super.apply(this, arguments);
        },
        archs: {
            'partner_type,false,form': '<form string="Types"><field name="displayName"/><field name="email"/></form>',
        },
    });

    assert.verifySteps(['[12]']);
    assert.containsOnce(form, '.o-field-many2manytags[name="timmy"] .badge.o-tag-color-0',
        "should contain one tag");

    // add an other existing tag
    await testUtils.fields.many2one.clickOpenDropdown('timmy');
    await testUtils.fields.many2one.clickHighlightedItem('timmy');

    assert.strictEqual($('.modal-body.o-actwindow').length, 1,
        "there should be one modal opened to edit the empty email");
    assert.strictEqual($('.modal-body.o-actwindow input[name="displayName"]').val(), "silver",
        "the opened modal in edit mode should be a form view dialog with the partner_type 14");
    assert.strictEqual($('.modal-body.o-actwindow input[name="email"]').length, 1,
        "there should be an email field in the modal");

    // set the email and save the modal (will rerender the form view)
    await testUtils.fields.editInput($('.modal-body.o-actwindow input[name="email"]'), 'coucou@petite.perruche');
    await testUtils.dom.click($('.modal-footer .btn-primary'));

    assert.containsN(form, '.o-field-many2manytags[name="timmy"] .badge.o-tag-color-0', 2,
        "should contain the second tag");
    // should have read [14] three times: when opening the dropdown, when opening the modal, and
    // after the save
    assert.verifySteps(['[14]', '[14]', '[14]']);

    form.destroy();
});

QUnit.test('many2many_tags_email widget can load more than 40 records', async function (assert) {
    assert.expect(3);

    const user11 = this.data['res.users'].records.find(user => user.id === 11);
    this.data['res.users'].fields.partnerIds = { string: "Partner", type: "many2many", relation: 'res.users' };
    user11.partnerIds = [];
    for (let i = 100; i < 200; i++) {
        this.data['res.users'].records.push({ id: i, displayName: `partner${i}` });
        user11.partnerIds.push(i);
    }

    const { widget: form } = await start({
        hasView: true,
        View: FormView,
        model: 'res.users',
        data: this.data,
        arch: '<form><field name="partnerIds" widget="many2manyTags"/></form>',
        resId: 11,
    });

    assert.strictEqual(form.$('.o-field-widget[name="partnerIds"] .badge').length, 100);

    await testUtils.form.clickEdit(form);

    assert.hasClass(form.$('.o-form-view'), 'o-form-editable');

    // add a record to the relation
    await testUtils.fields.many2one.clickOpenDropdown('partnerIds');
    await testUtils.fields.many2one.clickHighlightedItem('partnerIds');

    assert.strictEqual(form.$('.o-field-widget[name="partnerIds"] .badge').length, 101);

    form.destroy();
});

});
