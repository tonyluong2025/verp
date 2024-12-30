/** @verp-module **/

    /**
     * This Kanban Model make sure we display a rainbowman
     * message when a lead is won after we moved it in the
     * correct column and when it's grouped by stageId (default).
     */

    import KanbanModel from 'web.KanbanModel';
    import KanbanView from 'web.KanbanView';
    import viewRegistry from 'web.viewRegistry';

    var CrmKanbanModel = KanbanModel.extend({
        /**
         * Check if the kanban view is grouped by "stageId" before checking if the lead is won
         * and displaying a possible rainbowman message.
         * @override
         */
        moveRecord: async function (recordID, groupID, parentID) {
            var result = await this._super(...arguments);
            if (this.localData[parentID].groupedBy[0] === this.defaultGroupedBy[0]) {
                const message = await this._rpc({
                    model: 'crm.lead',
                    method : 'getRainbowmanMessage',
                    args: [[parseInt(this.localData[recordID].resId)]],
                });
                if (message) {
                    this.triggerUp('showEffect', {
                        message: message,
                        type: 'rainbowMan',
                    });
                }
            }
            return result;
        },
    });

    var CrmKanbanView = KanbanView.extend({
        config: _.extend({}, KanbanView.prototype.config, {
            Model: CrmKanbanModel,
        }),
    });

    viewRegistry.add('crmKanban', CrmKanbanView);

    export default {
        CrmKanbanModel: CrmKanbanModel,
        CrmKanbanView: CrmKanbanView,
    };
