/** @verp-module **/

import { _t } from 'web.core';
import { Markup } from 'web.utils';
import tour from 'web_tour.tour';

tour.register('crmTour', {
    url: "/web",
    rainbowManMessage: _t("Congrats, best of luck catching such big fish! :)"),
    sequence: 10,
}, [tour.stepUtils.showAppsMenuItem(), {
    trigger: '.o-app[data-menu-xmlid="crm.crmMenuRoot"]',
    content: Markup(_t('Ready to boost your sales? Let\'s have a look at your <b>Pipeline</b>.')),
    position: 'bottom',
    edition: 'community',
}, {
    trigger: '.o-app[data-menu-xmlid="crm.crmMenuRoot"]',
    content: Markup(_t('Ready to boost your sales? Let\'s have a look at your <b>Pipeline</b>.')),
    position: 'bottom',
    edition: 'enterprise',
}, {
    trigger: '.o-kanban-button-new',
    extraTrigger: '.o-opportunity-kanban',
    content: Markup(_t("<b>Create your first opportunity.</b>")),
    position: 'bottom',
}, {
    trigger: ".o-kanban-quick-create .o-field-widget[name='partnerId']",
    content: Markup(_t('<b>Write a few letters</b> to look for a company, or create a new one.')),
    position: "top",
    run: function (actions) {
        actions.text("Brandon Freeman", this.$anchor.find("input"));
    },
}, {
    trigger: ".ui-menu-item > a",
    auto: true,
    inModal: false,
}, {
    trigger: ".o-kanban-quick-create .o-kanban-add",
    content: Markup(_t("Now, <b>add your Opportunity</b> to your Pipeline.")),
    position: "bottom",
}, {
    trigger: ".o-opportunity-kanban .o-kanban-group:first-child .o-kanban-record:last-child .oe-kanban-content",
    extraTrigger: ".o-opportunity-kanban",
    content: Markup(_t("<b>Drag &amp; drop opportunities</b> between columns as you progress in your sales cycle.")),
    position: "right",
    run: "dragAndDrop .o-opportunity-kanban .o-kanban-group:eq(2) ",
}, {
    trigger: ".o-kanban-record:not(.o-updating) .o-activity-color-default",
    extraTrigger: ".o-opportunity-kanban",
    content: Markup(_t("Looks like nothing is planned. :(<br><br><i>Tip : Schedule activities to keep track of everything you have to do!</i>")),
    position: "bottom",
}, {
    trigger: ".o-schedule-activity",
    extraTrigger: ".o-opportunity-kanban",
    content: Markup(_t("Let's <b>Schedule an Activity.</b>")),
    position: "bottom",
    width: 200,
}, {
    trigger: '.modal-footer button[name="actionCloseDialog"]',
    content: Markup(_t("All set. Let’s <b>Schedule</b> it.")),
    position: "top",  // dot NOT move to bottom, it would cause a resize flicker, see task-2476595
    run: function (actions) {
        actions.auto('.modal-footer button[special=cancel]');
    },
}, {
    id: "dragOpportunityToWonStep",
    trigger: ".o-opportunity-kanban .o-kanban-record:last-child",
    content: Markup(_t("Drag your opportunity to <b>Won</b> when you get the deal. Congrats !")),
    position: "bottom",
    run: "dragAndDrop .o-opportunity-kanban .o-kanban-group:eq(3) ",
},  {
    trigger: ".o-kanban-record",
    extraTrigger: ".o-opportunity-kanban",
    content: _t("Let’s have a look at an Opportunity."),
    position: "right",
    run: function (actions) {
        actions.auto(".o-kanban-record");
    },
}, {
    trigger: ".o-lead-opportunity-form .o-statusbar-status",
    content: _t("This bar also allows you to switch stage."),
    position: "bottom"
}, {
    trigger: ".breadcrumb-item:not(.active):first",
    content: _t("Click on the breadcrumb to go back to the Pipeline."),
    position: "bottom",
    run: function (actions) {
        actions.auto(".breadcrumb-item:not(.active):last");
    }
}]);
