verp.define('board.BoardView', function (require) {
    "use strict";

    var Context = require('web.Context');
    var config = require('web.config');
    var core = require('web.core');
    var dataManager = require('web.dataManager');
    var Dialog = require('web.Dialog');
    var Domain = require('web.Domain');
    var FormController = require('web.FormController');
    var FormRenderer = require('web.FormRenderer');
    var FormView = require('web.FormView');
    var vjUtils = require('web.vjUtils');
    var session  = require('web.session');
    var viewRegistry = require('web.viewRegistry');
    const { loadLegacyViews } = require("@web/legacy/legacy_views");

    var _t = core._t;
    var _lt = core._lt;
    var QWeb = core.qweb;

    var BoardController = FormController.extend({
        customEvents: _.extend({}, FormController.prototype.customEvents, {
            changeLayout: '_onChangeLayout',
            enableDashboard: '_onEnableDashboard',
            saveDashboard: '_saveDashboard',
            switchView: '_onSwitchView',
        }),

        /**
         * @override
         */
        init: function (parent, model, renderer, params) {
            this._super.apply(this, arguments);
            this.customViewID = params.customViewID;
        },

        async willStart() {
            const _super = this._super.bind(this, ...arguments);
            await loadLegacyViews({ rpc: this._rpc.bind(this) });
            return _super();
        },

        //--------------------------------------------------------------------------
        // Public
        //--------------------------------------------------------------------------

        /**
         * @override
         */
        getTitle: function () {
            return _t("My Dashboard");
        },

        //--------------------------------------------------------------------------
        // Private
        //--------------------------------------------------------------------------

        /**
         * Actually save a dashboard
         *
         * @returns {Promise}
         */
        _saveDashboard: function () {
            var board = this.renderer.getBoard();
            var arch = QWeb.render('DashBoard.xml', _.extend({}, board));
            return this._rpc({
                    route: '/web/view/editCustom',
                    params: {
                        customId: this.customViewID,
                        arch: arch,
                    }
                }).then(dataManager.invalidate.bind(dataManager));
        },

        //--------------------------------------------------------------------------
        // Handlers
        //--------------------------------------------------------------------------

        /**
         * @private
         * @param {VerpEvent} event
         */
        _onChangeLayout: function (event) {
            var self = this;
            var dialog = new Dialog(this, {
                title: _t("Edit Layout"),
                $content: QWeb.render('DashBoard.layouts', _.clone(event.data))
            });
            dialog.opened().then(function () {
                dialog.$('li').click(function () {
                    var layout = $(this).attr('data-layout');
                    self.renderer.changeLayout(layout);
                    self._saveDashboard();
                    dialog.close();
                });
            });
            dialog.open();
        },
        /**
         * We need to intercept switchView event coming from sub views, because we
         * don't actually want to switch view in dashboard, we want to do a
         * doAction (which will open the record in a different breadcrumb).
         *
         * @private
         * @param {VerpEvent} event
         */
        _onSwitchView: function (event) {
            event.stopPropagation();
            this.doAction({
                type: 'ir.actions.actwindow',
                resModel: event.data.model,
                views: [[event.data.formViewID || false, 'form']],
                resId: event.data.resId,
            });
        },
    });

    var BoardRenderer = FormRenderer.extend({
        customEvents: _.extend({}, FormRenderer.prototype.customEvents, {
            updateFilters: '_onUpdateFilters',
            switchView: '_onSwitchView',
        }),
        events: _.extend({}, FormRenderer.prototype.events, {
            'click .oe-dashboard-column .oe-fold': '_onFoldClick',
            'click .oe-dashboard-link-change-layout': '_onChangeLayout',
            'click .oe-dashboard-column .oe-close': '_onCloseAction',
        }),

        /**
         * @override
         */
        init: function (parent, state, params) {
            this._super.apply(this, arguments);
            this.noContentHelp = params.noContentHelp;
            this.actionsDescr = {};
            this._boardSubcontrollers = []; // for board: controllers of subviews
            this._boardFormViewIDs = {}; // for board: mapping subview controller to form view id
        },
        /**
         * @override
         * @return {Promise<void>}
         */
        async start() {
            await this._super.apply(this, arguments);
            if (config.device.isMobile) {
                this.changeLayout("1");
            }
        },
        /**
         * Call `onAttachCallback` for each subview
         *
         * @override
         */
        onAttachCallback: function () {
            _.each(this._boardSubcontrollers, function (controller) {
                if ('onAttachCallback' in controller) {
                    controller.onAttachCallback();
                }
            });
        },
        /**
         * Call `onDetachCallback` for each subview
         *
         * @override
         */
        onDetachCallback: function () {
            _.each(this._boardSubcontrollers, function (controller) {
                if ('onDetachCallback' in controller) {
                    controller.onDetachCallback();
                }
            });
        },

        //--------------------------------------------------------------------------
        // Public
        //--------------------------------------------------------------------------

        /**
         * @param {string} layout
         */
        changeLayout: function (layout) {
            var $dashboard = this.$('.oe-dashboard');
            if (!$dashboard.length) {
                return;
            }
            var currentLayout = $dashboard.attr('data-layout');
            if (currentLayout !== layout) {
                var clayout = currentLayout.split('-').length,
                    nlayout = layout.split('-').length,
                    columnDiff = clayout - nlayout;
                if (columnDiff > 0) {
                    var $lastColumn = $();
                    $dashboard.find('.oe-dashboard-column').each(function (k, v) {
                        if (k >= nlayout) {
                            $(v).find('.oe-action').appendTo($lastColumn);
                        } else {
                            $lastColumn = $(v);
                        }
                    });
                }
                $dashboard.toggleClass('oe-dashboard-layout-' + currentLayout + ' oe-dashboard-layout-' + layout);
                $dashboard.attr('data-layout', layout);
            }
        },
        /**
         * Returns a representation of the current dashboard
         *
         * @returns {Object}
         */
        getBoard: function () {
            var self = this;
            var board = {
                formTitle : this.arch.attrs.string,
                style : this.$('.oe-dashboard').attr('data-layout'),
                columns : [],
            };
            this.$('.oe-dashboard-column').each(function () {
                var actions = [];
                $(this).find('.oe-action').each(function () {
                    var actionID = $(this).attr('data-id');
                    var newAttrs = _.clone(self.actionsDescr[actionID]);

                    /* prepare attributes as they should be saved */
                    if (newAttrs.modifiers) {
                        newAttrs.modifiers = JSON.stringify(newAttrs.modifiers);
                    }
                    actions.push(newAttrs);
                });
                board.columns.push(actions);
            });
            return board;
        },

        //--------------------------------------------------------------------------
        // Private
        //--------------------------------------------------------------------------

        /**
         * @private
         * @param {Object} params
         * @param {jQueryElement} params.$node
         * @param {integer} params.actionID
         * @param {Object} params.context
         * @param {any[]} params.domain
         * @param {string} params.viewType
         * @returns {Promise}
         */
        _createController: function (params) {
            var self = this;
            return this._rpc({
                    route: '/web/action/load',
                    params: {actionId: params.actionID}
                })
                .then(function (action) {
                    if (!action) {
                        // the action does not exist anymore
                        return Promise.resolve();
                    }
                    var evalContext = new Context(session.userContext, params.context).eval();
                    if (evalContext.groupby && evalContext.groupby.length === 0) {
                        delete evalContext.groupby;
                    }
                    // tz and lang are saved in the custom view
                    // override the language to take the current one
                    var rawContext = new Context(action.context, evalContext, {lang: session.userContext.lang});
                    var context = vjUtils.eval('context', rawContext, evalContext);
                    var domain = params.domain || vjUtils.eval('domain', action.domain || '[]', action.context);

                    action.context = context;
                    action.domain = domain;

                    // When creating a view, `action.views` is expected to be an array of dicts, while
                    // '/web/action/load' returns an array of arrays.
                    action._views = action.views;
                    action.views = $.map(action.views, function (view) { return {viewID: view[0], type: view[1]}});

                    var viewType = params.viewType || action._views[0][1];
                    var view = _.find(action._views, function (descr) {
                        return descr[1] === viewType;
                    }) || [false, viewType];
                    return self.loadViews(action.resModel, context, [view])
                            .then(function (viewsInfo) {
                        var viewInfo = viewsInfo[viewType];
                        var xml = new DOMParser().parseFromString(viewInfo.arch, "text/xml")
                        var key = xml.documentElement.getAttribute("jsClass");
                        var View = viewRegistry.get(key || viewType);

                        const searchQuery = {
                            context: context,
                            domain: domain,
                            groupby: typeof context.groupby === 'string' && context.groupby ?
                                        [context.groupby] :
                                        context.groupby || [],
                            orderedBy: context.orderedBy || [],
                        };

                        if (View.prototype.searchMenuTypes.includes('comparison')) {
                            searchQuery.timeRanges = context.comparison || {};
                        }

                        var view = new View(viewInfo, {
                            action: action,
                            hasSelectors: false,
                            modelName: action.resModel,
                            searchQuery,
                            withControlPanel: false,
                            withSearchPanel: false,
                        });
                        return view.getController(self).then(function (controller) {
                            self._boardFormViewIDs[controller.handle] = _.first(
                                _.find(action._views, function (descr) {
                                    return descr[1] === 'form';
                                })
                            );
                            self._boardSubcontrollers.push(controller);
                            return controller.appendTo(params.$node);
                        });
                    });
                });
        },

        /**
         * @private
         * @param {Object} node
         * @returns {jQueryElement}
         */
        _renderTagBoard: function (node) {
            var self = this;
            // we add the o-dashboard class to the renderer's $el. This means that
            // this function has a side effect.  This is ok because we assume that
            // once we have a '<board>' tag, we are in a special dashboard mode.
            this.$el.addClass('o-dashboard');

            var hasAction = _.detect(node.children, function (column) {
                return _.detect(column.children,function (element){
                    return element.tag === "action"? element: false;
                });
            });
            if (!hasAction) {
                return $(QWeb.render('DashBoard.NoContent'));
            }

            // We should start with three columns available
            node = $.extend(true, {}, node);

            // no idea why master works without this, but whatever
            if (!('layout' in node.attrs)) {
                node.attrs.layout = node.attrs.style;
            }
            for (var i = node.children.length; i < 3; i++) {
                node.children.push({
                    tag: 'column',
                    attrs: {},
                    children: []
                });
            }

            // register actions, alongside a generated unique ID
            _.each(node.children, function (column, columnIndex) {
                _.each(column.children, function (action, actionIndex) {
                    action.attrs.id = 'action_' + columnIndex + '_' + actionIndex;
                    self.actionsDescr[action.attrs.id] = action.attrs;
                });
            });

            var $html = $('<div>').append($(QWeb.render('DashBoard', {node: node, isMobile: config.device.isMobile})));
            this._boardSubcontrollers = []; // dashboard controllers are reset on re-render

            // render each view
            _.each(this.actionsDescr, function (action) {
                self.defs.push(self._createController({
                    $node: $html.find('.oe-action[data-id=' + action.id + '] .oe-content'),
                    actionID: _.str.toNumber(action.label),
                    context: action.context,
                    domain: Domain.prototype.stringToArray(action.domain, {}),
                    viewType: action.viewMode,
                }));
            });
            $html.find('.oe-dashboard-column').sortable({
                connectWith: '.oe-dashboard-column',
                handle: '.oe-header',
                scroll: false
            }).bind('sortstop', function () {
                self.triggerUp('saveDashboard');
            });

            return $html;
        },

        //--------------------------------------------------------------------------
        // Handlers
        //--------------------------------------------------------------------------

        /**
         * @private
         */
        _onChangeLayout: function () {
            var currentLayout = this.$('.oe-dashboard').attr('data-layout');
            this.triggerUp('changeLayout', {currentLayout: currentLayout});
        },
        /**
         * @private
         * @param {MouseEvent} event
         */
        _onCloseAction: function (event) {
            var self = this;
            var $container = $(event.currentTarget).parents('.oe-action:first');
            Dialog.confirm(this, (_t("Are you sure you want to remove this item?")), {
                confirmCallback: function () {
                    $container.remove();
                    if (!config.device.isMobile) {
                        self.triggerUp('saveDashboard');
                    }
                },
            });
        },
        /**
         * @private
         * @param {MouseEvent} event
         */
        _onFoldClick: function (event) {
            var $e = $(event.currentTarget);
            var $action = $e.closest('.oe-action');
            var id = $action.data('id');
            var actionAttrs = this.actionsDescr[id];

            if ($e.is('.oe-minimize')) {
                actionAttrs.fold = '1';
            } else {
                delete(actionAttrs.fold);
            }
            $e.toggleClass('oe-minimize oe-maximize');
            $action.find('.oe-content').toggle();
            if (!config.device.isMobile) {
                this.triggerUp('saveDashboard');
            }
        },
        /**
         * Let FormController know which form view it should display based on the
         * window action of the sub controller that is switching view
         *
         * @private
         * @param {VerpEvent} event
         */
        _onSwitchView: function (event) {
            event.data.formViewID = this._boardFormViewIDs[event.target.handle];
        },
        /**
         * Stops the propagation of 'updateFilters' events triggered by the
         * controllers instantiated by the dashboard to prevent them from
         * interfering with the ActionManager.
         *
         * @private
         * @param {VerpEvent} event
         */
        _onUpdateFilters: function (event) {
            event.stopPropagation();
        },
    });

    var BoardView = FormView.extend({
        config: _.extend({}, FormView.prototype.config, {
            Controller: BoardController,
            Renderer: BoardRenderer,
        }),
        displayName: _lt('Board'),

        /**
         * @override
         */
        init: function (viewInfo) {
            this._super.apply(this, arguments);
            this.controllerParams.customViewID = viewInfo.customViewId;
        },
        /**
         * @override
         */
        _extractParamsFromAction(action) {
            action.target = "inline";
            action.flags = action.flags || {};
            Object.assign(action.flags, {
                hasActionMenus: false,
                hasSearchView: false,
                headless: true,
            });
            return this._super.apply(this, arguments);
        },
    });

    return BoardView;

});


verp.define('board.viewRegistry', function (require) {
    "use strict";

    var BoardView = require('board.BoardView');

    var viewRegistry = require('web.viewRegistry');

    viewRegistry.add('board', BoardView);
});
