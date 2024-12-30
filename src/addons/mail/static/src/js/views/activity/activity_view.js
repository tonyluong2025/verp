/** @verp-module **/;

import ActivityController from '@mail/js/views/activity/activity_controller';
import ActivityModel from '@mail/js/views/activity/activity_model';
import ActivityRenderer from '@mail/js/views/activity/activity_renderer';

import BasicView from 'web.BasicView';
import core from 'web.core';
import RendererWrapper from 'web.RendererWrapper';
import viewRegistry from 'web.viewRegistry';

const _lt = core._lt;

const ActivityView = BasicView.extend({
    accesskey: "a",
    displayName: _lt('Activity'),
    icon: 'fa-clock-o',
    config: _.extend({}, BasicView.prototype.config, {
        Controller: ActivityController,
        Model: ActivityModel,
        Renderer: ActivityRenderer,
    }),
    viewType: 'activity',
    searchMenuTypes: ['filter', 'favorite'],

    /**
     * @override
     */
    init: function (viewInfo, params) {
        this._super.apply(this, arguments);

        const { searchViewId } = params.action || {};
        this.controllerParams.searchViewId = searchViewId ? searchViewId[0] : false;
        this.loadParams.type = 'list';
        // limit makes no sense in this view as we display all records having activities
        this.loadParams.limit = false;

        this.rendererParams.templates = _.findWhere(this.arch.children, { 'tag': 'templates' });
        this.controllerParams.title = this.arch.attrs.string;
    },
    /**
     *
     * @override
     */
    getRenderer(parent, state) {
        state = Object.assign({}, state, this.rendererParams);
        return new RendererWrapper(null, this.config.Renderer, state);
    },
});

viewRegistry.add('activity', ActivityView);

export default ActivityView;
