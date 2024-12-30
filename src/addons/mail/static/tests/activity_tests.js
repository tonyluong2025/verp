/** @verp-module **/

import ActivityRenderer from '@mail/js/views/activity/activity_renderer';
import ActivityView from '@mail/js/views/activity/activity_view';
import testUtils from 'web.testUtils';
import domUtils from 'web.dom';

import { legacyExtraNextTick, patchWithCleanup } from "@web/../tests/helpers/utils";
import { createWebClient, doAction } from "@web/../tests/webclient/helpers";
import { session } from '@web/session';
import { click } from "@web/../tests/helpers/utils";

let serverData;

var createView = testUtils.createView;

QUnit.module('mail', {}, function () {
QUnit.module('activity view', {
    beforeEach: function () {
        this.data = {
            task: {
                fields: {
                    id: {string: 'ID', type: 'integer'},
                    foo: {string: "Foo", type: "char"},
                    activityIds: {
                        string: 'Activities',
                        type: 'one2many',
                        relation: 'mail.activity',
                        relationField: 'resId',
                    },
                },
                records: [
                    {id: 13, foo: 'Meeting Room Furnitures', activityIds: [1]},
                    {id: 30, foo: 'Office planning', activityIds: [2, 3]},
                ],
            },
            partner: {
                fields: {
                    displayName: { string: "Displayed name", type: "char" },
                },
                records: [{
                    id: 2,
                    displayName: "first partner",
                }]
            },
            'mail.activity': {
                fields: {
                    resId: { string: 'Related document id', type: 'integer' },
                    activityTypeId: { string: "Activity type", type: "many2one", relation: "mail.activity.type" },
                    displayName: { string: "Display name", type: "char" },
                    dateDeadline: { string: "Due Date", type: "date" },
                    canWrite: { string: "Can write", type: "boolean" },
                    state: {
                        string: 'State',
                        type: 'selection',
                        selection: [['overdue', 'Overdue'], ['today', 'Today'], ['planned', 'Planned']],
                    },
                    mailTemplateIds: { string: "Mail templates", type: "many2many", relation: "mail.template" },
                    userId: { string: "Assigned to", type: "many2one", relation: 'partner' },
                },
                records:[
                    {
                        id: 1,
                        resId: 13,
                        displayName: "An activity",
                        dateDeadline: moment().add(3, "days").format("YYYY-MM-DD"), // now
                        canWrite: true,

                        state: "planned",
                        activityTypeId: 1,
                        mailTemplateIds: [8, 9],
                        userId:2,
                    },{
                        id: 2,
                        resId: 30,
                        displayName: "An activity",
                        dateDeadline: moment().format("YYYY-MM-DD"), // now
                        canWrite: true,
                        state: "today",
                        activityTypeId: 1,
                        mailTemplateIds: [8, 9],
                        userId:2,
                    },{
                        id: 3,
                        resId: 30,
                        displayName: "An activity",
                        dateDeadline: moment().subtract(2, "days").format("YYYY-MM-DD"), // now
                        canWrite: true,
                        state: "overdue",
                        activityTypeId: 2,
                        mailTemplateIds: [],
                        userId:2,
                    }
                ],
            },
            'mail.template': {
                fields: {
                    name: { string: "Name", type: "char" },
                },
                records: [
                    { id: 8, name: "Template1" },
                    { id: 9, name: "Template2" },
                ],
            },
            'mail.activity.type': {
                fields: {
                    mailTemplateIds: { string: "Mail templates", type: "many2many", relation: "mail.template" },
                    name: { string: "Name", type: "char" },
                },
                records: [
                    { id: 1, name: "Email", mailTemplateIds: [8, 9]},
                    { id: 2, name: "Call" },
                    { id: 3, name: "Call for Demo" },
                    { id: 4, name: "To Do" },
                ],
            },
        };
        serverData = { models: this.data };
    }
});

var activityDateFormat = function (date) {
    return date.toLocaleDateString(moment().locale(), { day: 'numeric', month: 'short' });
};

QUnit.test('activity view: simple activity rendering', async function (assert) {
    assert.expect(14);
    var activity = await createView({
        View: ActivityView,
        model: 'task',
        data: this.data,
        arch: '<activity string="Task">' +
                    '<templates>' +
                        '<div t-name="activity-box">' +
                            '<field name="foo"/>' +
                        '</div>' +
                    '</templates>' +
            '</activity>',
        intercepts: {
            doAction: function (event) {
                assert.deepEqual(event.data.action, {
                    context: {
                        default_resId: 30,
                        default_resModel: "task",
                        default_activity_type_id: 3,
                    },
                    resId: false,
                    resModel: "mail.activity",
                    target: "new",
                    type: "ir.actions.actwindow",
                    viewMode: "form",
                    viewType: "form",
                    views: [[false, "form"]]
                },
                "should do a doAction with correct parameters");
                event.data.options.onClose();
            },
        },
    });

    assert.containsOnce(activity, 'table',
        'should have a table');
    var $th1 = activity.$('table thead tr:first th:nth-child(2)');
    assert.containsOnce($th1, 'span:first:contains(Email)', 'should contain "Email" in header of first column');
    assert.containsOnce($th1, '.o-kanban-counter', 'should contain a progressbar in header of first column');
    assert.hasAttrValue($th1.find('.o-kanban-counter-progress .progress-bar:first'), 'data-original-title', '1 Planned',
        'the counter progressbars should be correctly displayed');
    assert.hasAttrValue($th1.find('.o-kanban-counter-progress .progress-bar:nth-child(2)'), 'data-original-title', '1 Today',
        'the counter progressbars should be correctly displayed');
    var $th2 = activity.$('table thead tr:first th:nth-child(3)');
    assert.containsOnce($th2, 'span:first:contains(Call)', 'should contain "Call" in header of second column');
    assert.hasAttrValue($th2.find('.o-kanban-counter-progress .progress-bar:nth-child(3)'), 'data-original-title', '1 Overdue',
        'the counter progressbars should be correctly displayed');
    assert.containsNone(activity, 'table thead tr:first th:nth-child(4) .o-kanban-counter',
        'should not contain a progressbar in header of 3rd column');
    assert.ok(activity.$('table tbody tr:first td:first:contains(Office planning)').length,
        'should contain "Office planning" in first colum of first row');
    assert.ok(activity.$('table tbody tr:nth-child(2) td:first:contains(Meeting Room Furnitures)').length,
        'should contain "Meeting Room Furnitures" in first colum of second row');

    var today = activityDateFormat(new Date());

    assert.ok(activity.$('table tbody tr:first td:nth-child(2).today .o-closest-deadline:contains(' + today + ')').length,
        'should contain an activity for today in second cell of first line ' + today);
    var td = 'table tbody tr:nth-child(1) td.o-activity-empty-cell';
    assert.containsN(activity, td, 2, 'should contain an empty cell as no activity scheduled yet.');

    // schedule an activity (this triggers a doAction)
    await testUtils.fields.editAndTrigger(activity.$(td + ':first'), null, ['mouseenter', 'click']);
    assert.containsOnce(activity, 'table tfoot tr .o_record-selector',
        'should contain search more selector to choose the record to schedule an activity for it');

    activity.destroy();
});

QUnit.test('activity view: no content rendering', async function (assert) {
    assert.expect(2);

    // reset incompatible setup
    this.data['mail.activity'].records = [];
    this.data.task.records.forEach(function (task) {
        task.activityIds = false;
    });
    this.data['mail.activity.type'].records = [];

    var activity = await createView({
        View: ActivityView,
        model: 'task',
        data: this.data,
        arch: '<activity string="Task">' +
                '<templates>' +
                    '<div t-name="activity-box">' +
                        '<field name="foo"/>' +
                    '</div>' +
                '</templates>' +
            '</activity>',
    });

    assert.containsOnce(activity, '.o-view-nocontent',
        "should display the no content helper");
    assert.strictEqual(activity.$('.o-view-nocontent .o-view-nocontent-empty-folder').text().trim(),
        "No data to display",
        "should display the no content helper text");

    activity.destroy();
});

QUnit.test('activity view: batch send mail on activity', async function (assert) {
    assert.expect(6);
    var activity = await createView({
        View: ActivityView,
        model: 'task',
        data: this.data,
        arch: '<activity string="Task">' +
                '<templates>' +
                    '<div t-name="activity-box">' +
                        '<field name="foo"/>' +
                    '</div>' +
                '</templates>' +
            '</activity>',
        mockRPC: function(route, args) {
            if (args.method === 'activitySendMail'){
                assert.step(JSON.stringify(args.args));
                return Promise.resolve();
            }
            return this._super.apply(this, arguments);
        },
    });
    assert.notOk(activity.$('table thead tr:first th:nth-child(2) span:nth-child(2) .dropdown-menu.show').length,
        'dropdown shouldn\'t be displayed');

    testUtils.dom.click(activity.$('table thead tr:first th:nth-child(2) span:nth-child(2) i.fa-ellipsis-v'));
    assert.ok(activity.$('table thead tr:first th:nth-child(2) span:nth-child(2) .dropdown-menu.show').length,
        'dropdown should have appeared');

    testUtils.dom.click(activity.$('table thead tr:first th:nth-child(2) span:nth-child(2) .dropdown-menu.show .o-send-mail-template:contains(Template2)'));
    assert.notOk(activity.$('table thead tr:first th:nth-child(2) span:nth-child(2) .dropdown-menu.show').length,
        'dropdown shouldn\'t be displayed');

    testUtils.dom.click(activity.$('table thead tr:first th:nth-child(2) span:nth-child(2) i.fa-ellipsis-v'));
    testUtils.dom.click(activity.$('table thead tr:first th:nth-child(2) span:nth-child(2) .dropdown-menu.show .o-send-mail-template:contains(Template1)'));
    assert.verifySteps([
        '[[13,30],9]', // send mail template 9 on tasks 13 and 30
        '[[13,30],8]',  // send mail template 8 on tasks 13 and 30
    ]);

    activity.destroy();
});

QUnit.test('activity view: activity widget', async function (assert) {
    assert.expect(16);

    const params = {
        View: ActivityView,
        model: 'task',
        data: this.data,
        arch: '<activity string="Task">' +
                '<templates>' +
                    '<div t-name="activity-box">' +
                        '<field name="foo"/>' +
                    '</div>' +
                '</templates>'+
            '</activity>',
        mockRPC: function(route, args) {
            if (args.method === 'activitySendMail'){
                assert.deepEqual([[30],8],args.args, "Should send template 8 on record 30");
                assert.step('activitySendMail');
                return Promise.resolve();
            }
            if (args.method === 'action_feedback_schedule_next'){
                assert.deepEqual([[3]],args.args, "Should execute action_feedback_schedule_next on activity 3 only ");
                assert.equal(args.kwargs.feedback, "feedback2");
                assert.step('action_feedback_schedule_next');
                return Promise.resolve({serverGeneratedAction: true});
            }
            return this._super.apply(this, arguments);
        },
        intercepts: {
            doAction: function (ev) {
                var action = ev.data.action;
                if (action.serverGeneratedAction) {
                    assert.step('serverGeneratedAction');
                } else if (action.resModel === 'mail.compose.message') {
                    assert.deepEqual({
                        default_model: "task",
                        default_resId: 30,
                        default_template_id: 8,
                        default_use_template: true,
                        force_email: true
                        }, action.context);
                    assert.step("doActionCompose");
                } else if (action.resModel === 'mail.activity') {
                    assert.deepEqual({
                        "default_activity_type_id": 2,
                        "default_resId": 30,
                        "default_resModel": "task"
                    }, action.context);
                    assert.step("doActionActivity");
                } else {
                    assert.step("Unexpected action");
                }
            },
        },
    };

    var activity = await createView(params);
    var today = activity.$('table tbody tr:first td:nth-child(2).today');
    var dropdown = today.find('.dropdown-menu.o_activity');

    await testUtils.dom.click(today.find('.o-closest-deadline'));
    assert.hasClass(dropdown,'show', "dropdown should be displayed");
    assert.ok(dropdown.find('.o_activity_color_today:contains(Today)').length, "Title should be today");
    assert.ok(dropdown.find('.o_activity_title_entry[data-activity-id="2"]:first div:contains(template8)').length,
        "template8 should be available");
    assert.ok(dropdown.find('.o_activity_title_entry[data-activity-id="2"]:eq(1) div:contains(template9)').length,
        "template9 should be available");

    await testUtils.dom.click(dropdown.find('.o_activity_title_entry[data-activity-id="2"]:first .o_activity_template_preview'));
    await testUtils.dom.click(dropdown.find('.o_activity_title_entry[data-activity-id="2"]:first .o_activity_template_send'));
    var overdue = activity.$('table tbody tr:first td:nth-child(3).overdue');
    await testUtils.dom.click(overdue.find('.o-closest-deadline'));
    dropdown = overdue.find('.dropdown-menu.o_activity');
    assert.notOk(dropdown.find('.o_activity_title div div div:first span').length,
        "No template should be available");

    await testUtils.dom.click(dropdown.find('.o-schedule-activity'));
    await testUtils.dom.click(overdue.find('.o-closest-deadline'));
    await testUtils.dom.click(dropdown.find('.o_mark_as_done'));
    dropdown.find('#activityFeedback').val("feedback2");

    await testUtils.dom.click(dropdown.find('.o_activity_popover_done_next'));
    assert.verifySteps([
        "doActionAompose",
        "activitySendMail",
        "doActionActivity",
        "actionFeedbackScheduleNext",
        "serverGeneratedAction"
        ]);

    activity.destroy();
});

QUnit.test("activity view: no groupby_menu and no comparison_menu", async function (assert) {
    assert.expect(4);

    serverData.actions = {
        1: {
            id: 1,
            name: "Task Action",
            resModel: "task",
            type: "ir.actions.actwindow",
            views: [[false, "activity"]],
        },
    };

    serverData.views = {
        "task,false,activity":
            '<activity string="Task">' +
            "<templates>" +
            '<div t-name="activity-box">' +
            '<field name="foo"/>' +
            "</div>" +
            "</templates>" +
            "</activity>",
        "task,false,search": "<search></search>",
    };

    const mockRPC = (route, args) => {
        if (args.method === "get_activity_data") {
            assert.strictEqual(
                args.kwargs.context.lang,
                "zz_ZZ",
                "The context should have been passed"
            );
        }
    };

    patchWithCleanup(session.userContext, { lang: "zz_ZZ" });

    const webClient = await createWebClient({ serverData, mockRPC , legacyParams: {withLegacyMockServer: true}});

    await doAction(webClient, 1);

    assert.containsN(
        webClient,
        ".o-search-options .dropdown button:visible",
        2,
        "only two elements should be available in view search"
    );
    assert.isVisible(
        $(webClient.el).find(".o-search-options .dropdown.o-filter-menu > button"),
        "filter should be available in view search"
    );
    assert.isVisible(
        $(webClient.el).find(".o-search-options .dropdown.o_favorite_menu > button"),
        "favorites should be available in view search"
    );
});

QUnit.test('activity view: search more to schedule an activity for a record of a respecting model', async function (assert) {
    assert.expect(5);
    _.extend(this.data.task.fields, {
        name: { string: "Name", type: "char" },
    });
    this.data.task.records[2] = { id: 31, name: "Task 3" };
    var activity = await createView({
        View: ActivityView,
        model: 'task',
        data: this.data,
        arch: '<activity string="Task">' +
                '<templates>' +
                    '<div t-name="activity-box">' +
                        '<field name="foo"/>' +
                    '</div>' +
                '</templates>' +
            '</activity>',
        archs: {
            "task,false,list": '<tree string="Task"><field name="label"/></tree>',
            "task,false,search": '<search></search>',
        },
        mockRPC: function(route, args) {
            if (args.method === 'nameSearch') {
                args.kwargs.name = "Task";
            }
            return this._super.apply(this, arguments);
        },
        intercepts: {
            doAction: function (ev) {
                assert.step('doAction');
                var expectedAction = {
                    context: {
                        default_resId: { id: 31, displayName: undefined },
                        default_resModel: "task",
                    },
                    name: "Schedule Activity",
                    resId: false,
                    resModel: "mail.activity",
                    target: "new",
                    type: "ir.actions.actwindow",
                    viewMode: "form",
                    views: [[false, "form"]],
                };
                assert.deepEqual(ev.data.action, expectedAction,
                    "should execute an action with correct params");
                ev.data.options.onClose();
            },
        },
    });

    assert.containsOnce(activity, 'table tfoot tr .o_record-selector',
        'should contain search more selector to choose the record to schedule an activity for it');
    await testUtils.dom.click(activity.$('table tfoot tr .o_record-selector'));
    // search create dialog
    var $modal = $('.modal-lg');
    assert.strictEqual($modal.find('.o-data-row').length, 3, "all tasks should be available to select");
    // select a record to schedule an activity for it (this triggers a doAction)
    testUtils.dom.click($modal.find('.o-data-row:last'));
    assert.verifySteps(['doAction']);

    activity.destroy();
});

QUnit.test("Activity view: discard an activity creation dialog", async function (assert) {
    assert.expect(2);

    serverData.actions = {
        1: {
            id: 1,
            name: "Task Action",
            resModel: "task",
            type: "ir.actions.actwindow",
            views: [[false, "activity"]],
        },
    };

    serverData.views = {
        "task,false,activity": `
        <activity string="Task">
            <templates>
                <div t-name="activity-box">
                    <field name="foo"/>
                </div>
            </templates>
        </activity>`,
        "task,false,search": "<search></search>",
        "mail.activity,false,form": `
        <form>
            <field name="displayName"/>
            <footer>
                <button string="Discard" class="btn-secondary" special="cancel"/>
            </footer>
        </form>`,
    };

    const mockRPC = (route, args) => {
        if (args.method === "check_access_rights") {
            return true;
        }
    };

    const webClient = await createWebClient({ serverData, mockRPC, legacyParams: {withLegacyMockServer: true} });
    await doAction(webClient, 1);

    await testUtils.dom.click(
        $(webClient.el).find(".o_activity_view .o-data-row .o-activity-empty-cell")[0]
    );
    await legacyExtraNextTick();
    assert.containsOnce($, ".modal.o-technical-modal", "Activity Modal should be opened");

    await testUtils.dom.click($('.modal.o-technical-modal button[special="cancel"]'));
    await legacyExtraNextTick();
    assert.containsNone($, ".modal.o-technical-modal", "Activity Modal should be closed");
});

QUnit.test('Activity view: many2oneAvatarUser widget in activity view', async function (assert) {
    assert.expect(3);

    const taskModel = serverData.models.task;

    serverData.models['res.users'] = {
        fields: {
            displayName: { string: "Displayed name", type: "char" },
            avatar128: { string: "Image 128", type: 'image' },
        },
        records: [{
            id: 1,
            displayName: "first user",
            avatar128: "Atmaram Bhide",
        }],
    };
    taskModel.fields.userId = { string: "Related User", type: "many2one", relation: 'res.users' };
    taskModel.records[0].userId = 1;

    serverData.actions = {
        1: {
            id: 1,
            name: 'Task Action',
            resModel: 'task',
            type: 'ir.actions.actwindow',
            views: [[false, 'activity']],
        }
    };

    serverData.views = {
        'task,false,activity': `
            <activity string="Task">
                <templates>
                    <div t-name="activity-box">
                        <field name="userId" widget="many2oneAvatarUser"/>
                        <field name="foo"/>
                    </div>
                </templates>
            </activity>`,
        'task,false,search': '<search></search>'
    };

    const webClient = await createWebClient({ serverData, legacyParams: { withLegacyMockServer: true } });
    await doAction(webClient, 1);

    await legacyExtraNextTick();
    assert.containsN(webClient, '.o-m2o-avatar', 2);
    assert.containsOnce(webClient, 'tr[data-res-id=13] .o-m2o-avatar > img[src="/web/image/res.users/1/avatar128"]',
        "should have m2o avatar image");
    assert.containsNone(webClient, '.o-m2o-avatar > span',
        "should not have text on many2oneAvatarUser if onlyImage node option is passed");
});

QUnit.test("Activity view: on_destroy_callback doesn't crash", async function (assert) {
    assert.expect(3);

    const params = {
        View: ActivityView,
        model: 'task',
        data: this.data,
        arch: `<activity string="Task">
                <templates>
                    <div t-name="activity-box">
                        <field name="foo"/>
                    </div>
                </templates>
            </activity>`,
    };

    patchWithCleanup(ActivityRenderer.prototype, {
        mounted() {
            assert.step('mounted');
        },
        willUnmount() {
            assert.step('willUnmount');
        }
    });

    const activity = await createView(params);
    domUtils.detach([{ widget: activity }]);

    assert.verifySteps([
        'mounted',
        'willUnmount'
    ]);

    activity.destroy();
});

QUnit.test("Schedule activity dialog uses the same search view as activity view", async function (assert) {
    assert.expect(8);
    serverData.models.task.records = [];
    serverData.views = {
        "task,false,activity": `
            <activity string="Task">
                <templates>
                    <div t-name="activity-box">
                        <field name="foo"/>
                    </div>
                </templates>
            </activity>
        `,
        "task,false,list": `<list><field name="foo"/></list>`,
        "task,false,search": `<search/>`,
        'task,1,search': `<search/>`,
    };

    function mockRPC(route, args) {
        if (args.method === "load_views") {
            assert.step(JSON.stringify(args.kwargs.views));
        } 
    }

    const webClient = await createWebClient({ serverData, mockRPC, legacyParams: {withLegacyMockServer: true} });

    // open an activity view (with default search arch)
    await doAction(webClient, {
        name: 'Dashboard',
        resModel: 'task',
        type: 'ir.actions.actwindow',
        views: [[false, 'activity']],
    });

    assert.verifySteps([
        '[[false,"activity"],[false,"search"]]',
    ])

    // click on "Schedule activity"
    await click(webClient.el.querySelector(".o_activity_view .o_record-selector"));

    assert.verifySteps([
        '[[false,"list"],[false,"search"]]',
    ])

    // open an activity view (with search arch 1)
    await doAction(webClient, {
        name: 'Dashboard',
        resModel: 'task',
        type: 'ir.actions.actwindow',
        views: [[false, 'activity']],
        searchViewId: [1,"search"],
    });

    assert.verifySteps([
        '[[false,"activity"],[1,"search"]]',
    ])

    // click on "Schedule activity"
    await click(webClient.el.querySelector(".o_activity_view .o_record-selector"));

    assert.verifySteps([
        '[[false,"list"],[1,"search"]]',
    ])
});

QUnit.test('Activity view: apply progressbar filter', async function (assert) {
    assert.expect(9);

    serverData.actions = {
        1: {
            id: 1,
            name: 'Task Action',
            resModel: 'task',
            type: 'ir.actions.actwindow',
            views: [[false, 'activity']],
        }
    };
    serverData.views = {
        'task,false,activity':
            `<activity string="Task" >
                <templates>
                    <div t-name="activity-box">
                        <field name="foo"/>
                    </div>
                </templates>
            </activity>`,
        'task,false,search': '<search></search>',
    };

    const webClient = await createWebClient({ serverData, legacyParams: { withLegacyMockServer: true } });

    await doAction(webClient, 1);

    assert.containsNone(webClient.el.querySelector('.o_activity_view thead'),
        '.o-activity-filter-planned,.o-activity-filter-today,.o-activity-filter-overdue,.o-activity-filter-__false',
        "should not have active filter");
    assert.containsNone(webClient.el.querySelector('.o_activity_view tbody'),
        '.o-activity-filter-planned,.o-activity-filter-today,.o-activity-filter-overdue,.o-activity-filter-__false',
        "should not have active filter");
    assert.strictEqual(webClient.el.querySelector('.o_activity_view tbody .o_activity_record').textContent,
        'Office planning', "'Office planning' should be first record");
    assert.containsOnce(webClient.el.querySelector('.o_activity_view tbody'), '.planned',
        "other records should be available");

    await testUtils.dom.click(webClient.el.querySelector('.o-kanban-counter-progress .progress-bar[data-filter="planned"]'));
    assert.containsOnce(webClient.el.querySelector('.o_activity_view thead'), '.o-activity-filter-planned',
        "planned should be active filter");
    assert.containsN(webClient.el.querySelector('.o_activity_view tbody'), '.o-activity-filter-planned', 5,
        "planned should be active filter");
    assert.strictEqual(webClient.el.querySelector('.o_activity_view tbody .o_activity_record').textContent,
        'Meeting Room Furnitures', "'Office planning' should be first record");
    const tr = webClient.el.querySelectorAll('.o_activity_view tbody tr')[1];
    assert.hasClass(tr.querySelectorAll('td')[1], 'o-activity-empty-cell',
        "other records should be hidden");
    assert.containsNone(webClient.el.querySelector('.o_activity_view tbody'), 'planned',
        "other records should be hidden");
});

});
