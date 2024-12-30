verp.define('web.KanbanView', function (require) {
"use strict";

var BasicView = require('web.BasicView');
var core = require('web.core');
var KanbanController = require('web.KanbanController');
var kanbanExamplesRegistry = require('web.kanbanExamplesRegistry');
var KanbanModel = require('web.KanbanModel');
var KanbanRenderer = require('web.KanbanRenderer');
var utils = require('web.utils');

var _lt = core._lt;

var KanbanView = BasicView.extend({
    accesskey: "k",
    displayName: _lt("Kanban"),
    icon: 'fa-th-large',
    mobileFriendly: true,
    config: _.extend({}, BasicView.prototype.config, {
        Model: KanbanModel,
        Controller: KanbanController,
        Renderer: KanbanRenderer,
    }),
    jsLibs: [],
    viewType: 'kanban',

    /**
     * @constructor
     */
    init: function (viewInfo, params) {
        this._super.apply(this, arguments);

        this.loadParams.limit = this.loadParams.limit || 40;
        this.loadParams.openGroupByDefault = true;
        this.loadParams.type = 'list';
        this.noDefaultGroupby = params.noDefaultGroupby;
        var progressBar;
        utils.traverse(this.arch, function (n) {
            var isProgressBar = (n.tag === 'progressbar');
            if (isProgressBar) {
                progressBar = _.clone(n.attrs);
                progressBar.colors = JSON.parse(progressBar.colors);
                progressBar.sumField = progressBar.sumField || false;
            }
            return !isProgressBar;
        });
        if (progressBar) {
            this.loadParams.progressBar = progressBar;
        }

        var activeActions = this.controllerParams.activeActions;
        var archAttrs = this.arch.attrs;
        activeActions = _.extend(activeActions, {
            groupCreate: this.arch.attrs.groupCreate ? !!JSON.parse(archAttrs.groupCreate) : true,
            groupEdit: archAttrs.groupEdit ? !!JSON.parse(archAttrs.groupEdit) : true,
            groupDelete: archAttrs.groupDelete ? !!JSON.parse(archAttrs.groupDelete) : true,
        });

        this.rendererParams.columnOptions = {
            editable: activeActions.groupEdit,
            deletable: activeActions.groupDelete,
            archivable: archAttrs.archivable ? !!JSON.parse(archAttrs.archivable) : true,
            groupCreatable: activeActions.groupCreate,
            quickCreateView: archAttrs.quickCreateView || null,
            recordsDraggable: archAttrs.recordsDraggable ? !!JSON.parse(archAttrs.recordsDraggable) : true,
            hasProgressBar: !!progressBar,
        };
        this.rendererParams.recordOptions = {
            editable: activeActions.edit,
            deletable: activeActions.delete,
            readOnlyMode: params.readOnlyMode,
            selectionMode: params.selectionMode,
        };
        this.rendererParams.quickCreateEnabled = this._isQuickCreateEnabled();
        this.rendererParams.readOnlyMode = params.readOnlyMode;
        var examples = archAttrs.examples;
        if (examples) {
            this.rendererParams.examples = kanbanExamplesRegistry.get(examples);
        }

        this.controllerParams.onCreate = archAttrs.onCreate;
        this.controllerParams.hasButtons = !params.selectionMode ? true : false;
        this.controllerParams.quickCreateEnabled = this.rendererParams.quickCreateEnabled;
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Object} viewInfo
     * @returns {boolean} true iff the quick create feature is not explicitely
     *   disabled (with create="false" or quickCreate="false" in the arch)
     */
    _isQuickCreateEnabled: function () {
        if (!this.controllerParams.activeActions.create) {
            return false;
        }
        if (this.arch.attrs.quickCreate !== undefined) {
            return !!JSON.parse(this.arch.attrs.quickCreate);
        }
        return true;
    },
    /**
     * Handles the <field> attribute allowGroupRangeValue,
     * used to configure, for a date(time) field, whether we want to use the front-end
     * logic to get the group value. (i.e. with drag&drop and quickCreate features)
     * if false, those features will be disabled for the current field.
     * Only handles the following types: date / datetime
     * if undefined the default is false
     *
     * @override
     */
    _processField(viewType, field, attrs) {
        if (['date', 'datetime'].includes(field.type) && 'allowGroupRangeValue' in attrs) {
            attrs.allowGroupRangeValue = !!JSON.parse(attrs.allowGroupRangeValue);
            delete attrs.allowGroupRangeValue;
        }
        return this._super(...arguments);
    },
    /**
     * Detect <img t-att-src="kanbanImage(...)"/> nodes to automatically add the
     * '__lastUpdate' field in the fieldsInfo to ensure that the images is
     * properly reloaded when necessary.
     *
     * @override
     */
    _processNode(node, fv) {
        const isKanbanImage = node.tag === 'img' &&
                              node.attrs['t-att-src'] &&
                              node.attrs['t-att-src'].includes('kanbanImage');
        if (isKanbanImage && !fv.fieldsInfo.kanban.__lastUpdate) {
            fv.fieldsInfo.kanban.__lastUpdate = { type: 'datetime' };
        }
        return this._super(...arguments);
    },
    /**
     * @override
     * @private
     */
    _updateMVCParams: function () {
        this._super.apply(this, arguments);
        if (this.searchMenuTypes.includes('groupby') && !this.noDefaultGroupby && this.arch.attrs.defaultGroupby) {
            this.loadParams.groupby = [this.arch.attrs.defaultGroupby];
        }
    },
});

return KanbanView;

});
