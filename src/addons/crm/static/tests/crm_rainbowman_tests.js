verp.define('crm.form_rainbowman_tests', function (require) {
    "use strict";

    var CrmFormView = require('@crm/js/crm_form')[Symbol.for("default")].CrmFormView;
    var CrmKanbanView = require('@crm/js/crm_kanban')[Symbol.for("default")].CrmKanbanView;
    var testUtils = require('web.testUtils');
    var createView = testUtils.createView;

    QUnit.module('Crm Rainbowman Triggers', {
        beforeEach: function () {
            const format = "YYYY-MM-DD HH:mm:ss";
            this.data = {
                'res.users': {
                    fields: {
                        displayName: { string: 'Name', type: 'char' },
                    },
                    records: [
                        { id: 1, name: 'Mario' },
                        { id: 2, name: 'Luigi' },
                        { id: 3, name: 'Link' },
                        { id: 4, name: 'Zelda' },
                    ],
                },
                'crm.team': {
                    fields: {
                        displayName: { string: 'Name', type: 'char' },
                        member_ids: { string: 'Members', type: 'many2many', relation: 'res.users' },
                    },
                    records: [
                        { id: 1, name: 'Mushroom Kingdom', member_ids: [1, 2] },
                        { id: 2, name: 'Hyrule', member_ids: [3, 4] },
                    ],
                },
                'crm.stage': {
                    fields: {
                        displayName: { string: 'Name', type: 'char' },
                        is_won: { string: 'Is won', type: 'boolean' },
                    },
                    records: [
                        { id: 1, name: 'Start' },
                        { id: 2, name: 'Middle' },
                        { id: 3, name: 'Won', is_won: true},
                    ],
                },
                'crm.lead': {
                    fields: {
                        displayName: { string: 'Name', type: 'char' },
                        planned_revenue: { string: 'Revenue', type: 'float' },
                        stageId: { string: 'Stage', type: 'many2one', relation: 'crm.stage' },
                        teamId: { string: 'Sales Team', type: 'many2one', relation: 'crm.team' },
                        userId: { string: 'Salesperson', type: 'many2one', relation: 'res.users' },
                        date_closed: { string: 'Date closed', type: 'datetime' },
                    },
                    records : [
                        { id: 1, name: 'Lead 1', planned_revenue: 5.0, stageId: 1, teamId: 1, userId: 1 },
                        { id: 2, name: 'Lead 2', planned_revenue: 5.0, stageId: 2, teamId: 2, userId: 4 },
                        { id: 3, name: 'Lead 3', planned_revenue: 3.0, stageId: 3, teamId: 1, userId: 1, date_closed: moment().subtract(5, 'days').format(format) },
                        { id: 4, name: 'Lead 4', planned_revenue: 4.0, stageId: 3, teamId: 2, userId: 4, date_closed: moment().subtract(23, 'days').format(format) },
                        { id: 5, name: 'Lead 5', planned_revenue: 7.0, stageId: 3, teamId: 1, userId: 1, date_closed: moment().subtract(20, 'days').format(format) },
                        { id: 6, name: 'Lead 6', planned_revenue: 4.0, stageId: 2, teamId: 1, userId: 2 },
                        { id: 7, name: 'Lead 7', planned_revenue: 1.8, stageId: 3, teamId: 2, userId: 3, date_closed: moment().subtract(23, 'days').format(format) },
                        { id: 8, name: 'Lead 8', planned_revenue: 1.9, stageId: 1, teamId: 2, userId: 3 },
                        { id: 9, name: 'Lead 9', planned_revenue: 1.5, stageId: 3, teamId: 2, userId: 3, date_closed: moment().subtract(5, 'days').format(format) },
                        { id: 10, name: 'Lead 10', planned_revenue: 1.7, stageId: 2, teamId: 2, userId: 3 },
                        { id: 11, name: 'Lead 11', planned_revenue: 2.0, stageId: 3, teamId: 2, userId: 4, date_closed: moment().subtract(5, 'days').format(format) },
                    ],
                },
            };
            this.testFormView = {
                arch: `
                    <form jsClass="crm_form">
                        <header><field name="stageId" widget="statusbar" options="{'clickable': '1'}"/></header>
                        <field name="label"/>
                        <field name="planned_revenue"/>
                        <field name="teamId"/>
                        <field name="userId"/>
                    </form>`,
                data: this.data,
                model: 'crm.lead',
                View: CrmFormView,
            };
            this.testKanbanView = {
                arch: `
                    <kanban jsClass="crm_kanban">
                        <templates>
                            <t t-name="kanban-box">
                                <div><field name="label"/></div>
                            </t>
                        </templates>
                    </kanban>`,
                data: this.data,
                model: 'crm.lead',
                View: CrmKanbanView,
                groupBy: ['stageId'],
            };
        },
    }, function () {
        QUnit.test("first lead won, click on statusbar", async function (assert) {
            assert.expect(2);

            this.testFormView.resId = 6;
            this.testFormView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const form = await createView(this.testFormView);

            await testUtils.dom.click(form.$(".o-statusbar-status button[data-value='3']"));
            assert.verifySteps(['Go, go, go! Congrats for your first deal.']);

            form.destroy();
        });

        QUnit.test("first lead won, click on statusbar in edit mode then save", async function (assert) {
            assert.expect(3);

            const form = await createView(_.extend(this.testFormView, {
                resId: 6,
                mockRPC: async function (route, args) {
                    const result = await this._super(...arguments);
                    if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                        assert.step(result || "no rainbowman");
                    }
                    return result;
                },
                viewOptions: {mode: 'edit'}
            }));

            await testUtils.dom.click(form.$(".o-statusbar-status button[data-value='3']"));
            assert.verifySteps([]); // no message displayed yet

            await testUtils.form.clickSave(form);
            assert.verifySteps(['Go, go, go! Congrats for your first deal.']);

            form.destroy();
        });

        QUnit.test("team record 30 days, click on statusbar", async function (assert) {
            assert.expect(2);

            this.testFormView.resId = 2;
            this.testFormView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const form = await createView(this.testFormView);

            await testUtils.dom.click(form.$(".o-statusbar-status button[data-value='3']"));
            assert.verifySteps(['Boom! Team record for the past 30 days.']);

            form.destroy();
        });

        QUnit.test("team record 7 days, click on statusbar", async function (assert) {
            assert.expect(2);

            this.testFormView.resId = 1;
            this.testFormView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const form = await createView(this.testFormView);

            await testUtils.dom.click(form.$(".o-statusbar-status button[data-value='3']"));
            assert.verifySteps(['Yeah! Deal of the last 7 days for the team.']);

            form.destroy();
        });

        QUnit.test("user record 30 days, click on statusbar", async function (assert) {
            assert.expect(2);

            this.testFormView.resId = 8;
            this.testFormView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const form = await createView(this.testFormView);

            await testUtils.dom.click(form.$(".o-statusbar-status button[data-value='3']"));
            assert.verifySteps(['You just beat your personal record for the past 30 days.']);

            form.destroy();
        });

        QUnit.test("user record 7 days, click on statusbar", async function (assert) {
            assert.expect(2);

            this.testFormView.resId = 10;
            this.testFormView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const form = await createView(this.testFormView);

            await testUtils.dom.click(form.$(".o-statusbar-status button[data-value='3']"));
            assert.verifySteps(['You just beat your personal record for the past 7 days.']);

            form.destroy();
        });

        QUnit.test("click on stage (not won) on statusbar", async function (assert) {
            assert.expect(2);

            this.testFormView.resId = 1;
            this.testFormView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const form = await createView(this.testFormView);

            await testUtils.dom.click(form.$(".o-statusbar-status button[data-value='2']"));
            assert.verifySteps(['no rainbowman']);

            form.destroy();
        });

        QUnit.test("first lead won, drag & drop kanban", async function (assert) {
            assert.expect(2);

            this.testKanbanView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const kanban = await createView(this.testKanbanView);

            kanban.model.defaultGroupedBy = ['stageId'];
            await kanban.reload();

            await testUtils.dom.dragAndDrop(kanban.$('.o-kanban-record:contains("Lead 6")'), kanban.$('.o-kanban-group:eq(2)'));
            assert.verifySteps(['Go, go, go! Congrats for your first deal.']);

            kanban.destroy();
        });

        QUnit.test("team record 30 days, drag & drop kanban", async function (assert) {
            assert.expect(2);

            this.testKanbanView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const kanban = await createView(this.testKanbanView);

            kanban.model.defaultGroupedBy = ['stageId'];
            await kanban.reload();

            await testUtils.dom.dragAndDrop(kanban.$('.o-kanban-record:contains("Lead 2")'), kanban.$('.o-kanban-group:eq(2)'));
            assert.verifySteps(['Boom! Team record for the past 30 days.']);

            kanban.destroy();
        });

        QUnit.test("team record 7 days, drag & drop kanban", async function (assert) {
            assert.expect(2);

            this.testKanbanView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const kanban = await createView(this.testKanbanView);

            kanban.model.defaultGroupedBy = ['stageId'];
            await kanban.reload();

            await testUtils.dom.dragAndDrop(kanban.$('.o-kanban-group:eq(0) .o-kanban-record:contains("Lead 1")'), kanban.$('.o-kanban-group:eq(2)'));
            assert.verifySteps(['Yeah! Deal of the last 7 days for the team.']);

            kanban.destroy();
        });

        QUnit.test("user record 30 days, drag & drop kanban", async function (assert) {
            assert.expect(2);

            this.testKanbanView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const kanban = await createView(this.testKanbanView);

            kanban.model.defaultGroupedBy = ['stageId'];
            await kanban.reload();

            await testUtils.dom.dragAndDrop(kanban.$('.o-kanban-record:contains("Lead 8")'), kanban.$('.o-kanban-group:eq(2)'));
            assert.verifySteps(['You just beat your personal record for the past 30 days.']);

            kanban.destroy();
        });

        QUnit.test("user record 7 days, drag & drop kanban", async function (assert) {
            assert.expect(2);

            this.testKanbanView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const kanban = await createView(this.testKanbanView);

            kanban.model.defaultGroupedBy = ['stageId'];
            await kanban.reload();

            await testUtils.dom.dragAndDrop(kanban.$('.o-kanban-record:contains("Lead 10")'), kanban.$('.o-kanban-group:eq(2)'));
            assert.verifySteps(['You just beat your personal record for the past 7 days.']);

            kanban.destroy();
        });

        QUnit.test("drag & drop record kanban in stage not won", async function (assert) {
            assert.expect(2);

            this.testKanbanView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            const kanban = await createView(this.testKanbanView);

            kanban.model.defaultGroupedBy = ['stageId'];
            await kanban.reload();

            await testUtils.dom.dragAndDrop(kanban.$('.o-kanban-record:contains("Lead 8")'), kanban.$('.o-kanban-group:eq(1)'));
            assert.verifySteps(["no rainbowman"]);

            kanban.destroy();
        });

        QUnit.test("drag & drop record in kanban not grouped by stageId", async function (assert) {
            assert.expect(1);

            this.testKanbanView.mockRPC = async function (route, args) {
                const result = await this._super(...arguments);
                if (args.model === 'crm.lead' && args.method === 'get_rainbowman_message') {
                    assert.step(result || "no rainbowman");
                }
                return result;
            };
            this.testKanbanView.groupBy = ['userId'];
            const kanban = await createView(this.testKanbanView);

            kanban.model.defaultGroupedBy = ['stageId'];
            await kanban.reload();

            await testUtils.dom.dragAndDrop(kanban.$('.o-kanban-group:eq(0) .o-kanban-record:first'), kanban.$('.o-kanban-group:eq(1)'));
            assert.verifySteps([]); // Should never pass by the rpc

            kanban.destroy();
        });
    });
});
