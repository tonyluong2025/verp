/** @verp-module **/

import BasicModel from 'web.BasicModel';
import session from 'web.session';

const ActivityModel = BasicModel.extend({

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------
    /**
     * Add the following (activity specific) keys when performing a `get` on the
     * main list datapoint:
     * - activityTypes
     * - activityResIds
     * - groupedActivities
     *
     * @override
     */
    __get: function () {
        var result = this._super.apply(this, arguments);
        if (result && result.model === this.modelName && result.type === 'list') {
            _.extend(result, this.additionalData, {getKanbanActivityData: this.getKanbanActivityData});
        }
        return result;
    },
    /**
     * @param {Object} activityGroup
     * @param {integer} resId
     * @returns {Object}
     */
    getKanbanActivityData(activityGroup, resId) {
        return {
            data: {
                activityIds: {
                    model: 'mail.activity',
                    resIds: activityGroup.ids,
                },
                activityState: activityGroup.state,
                closestDeadline: activityGroup.o-closest-deadline,
            },
            fields: {
                activityIds: {},
                activityState: {
                    selection: [
                        ['overdue', "Overdue"],
                        ['today', "Today"],
                        ['planned', "Planned"],
                    ],
                },
            },
            fieldsInfo: {},
            model: this.model,
            type: 'record',
            resId: resId,
            getContext: function () {
                return {};
            },
        };
    },
    /**
     * @override
     * @param {Array[]} params.domain
     */
    __load: function (params) {
        this.originalDomain = _.extend([], params.domain);
        params.domain.push(['activityIds', '!=', false]);
        this.domain = params.domain;
        this.modelName = params.modelName;
        params.groupedBy = [];
        var def = this._super.apply(this, arguments);
        return Promise.all([def, this._fetchData()]).then(function (result) {
            return result[0];
        });
    },
    /**
     * @override
     * @param {Array[]} [params.domain]
     */
    __reload: function (handle, params) {
        if (params && 'domain' in params) {
            this.originalDomain = _.extend([], params.domain);
            params.domain.push(['activityIds', '!=', false]);
            this.domain = params.domain;
        }
        if (params && 'groupby' in params) {
            params.groupby = [];
        }
        var def = this._super.apply(this, arguments);
        return Promise.all([def, this._fetchData()]).then(function (result) {
            return result[0];
        });
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Fetch activity data.
     *
     * @private
     * @returns {Promise}
     */
    _fetchData: function () {
        var self = this;
        return this._rpc({
            model: "mail.activity",
            method: 'getActivityData',
            kwargs: {
                resModel: this.modelName,
                domain: this.domain,
                context: session.userContext,
            }
        }).then(function (result) {
            self.additionalData = result;
        });
    },
});

export default ActivityModel;
