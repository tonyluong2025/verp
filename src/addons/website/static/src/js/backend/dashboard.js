/* global google, gapi */
verp.define('website.backend.dashboard', function (require) {
'use strict';

var AbstractAction = require('web.AbstractAction');
var ajax = require('web.ajax');
var core = require('web.core');
var Dialog = require('web.Dialog');
var fieldUtils = require('web.fieldUtils');
var vjUtils = require('web.vjUtils');
var session = require('web.session');
var time = require('web.time');
var webClient = require('web.webClient');

var _t = core._t;
var QWeb = core.qweb;

var COLORS = ["#1f77b4", "#aec7e8"];
var FORMAT_OPTIONS = {
    // allow to decide if utils.humanNumber should be used
    humanReadable: function (value) {
        return Math.abs(value) >= 1000;
    },
    // with the choices below, 1236 is represented by 1.24k
    minDigits: 1,
    decimals: 2,
    // avoid comma separators for thousands in numbers when humanNumber is used
    formatterCallback: function (str) {
        return str;
    },
};

var Dashboard = AbstractAction.extend({
    hasControlPanel: true,
    contentTemplate: 'website.WebsiteDashboardMain',
    jsLibs: [
        '/web/static/lib/Chart/Chart.js',
    ],
    events: {
        'click .js-link-analytics-settings': 'onLinkAnalyticsSettings',
        'click .o-dashboard-action': 'onDashboardAction',
        'click .o-dashboard-action-form': 'onDashboardActionForm',
    },

    init: function(parent, context) {
        this._super(parent, context);

        this.DATE_FORMAT = time.getLangDateFormat();
        this.daterange = 'week';  // possible values : 'week', 'month', year'
        this.dateFrom = moment.utc().subtract(1, 'week');
        this.dateTo = moment.utc();

        this.dashboardsTemplates = ['website.dashboardHeader', 'website.dashboardContent'];
        this.graphs = [];
        this.chartIds = {};
    },

    willStart: function() {
        var self = this;
        return Promise.all([ajax.loadLibs(this), this._super()]).then(function() {
            return self.fetchData();
        }).then(function(){
            var website = _.findWhere(self.websites, {selected: true});
            self.websiteId = website ? website.id : false;
        });
    },

    start: function() {
        var self = this;
        this._computeControlPanelProps();
        return this._super().then(function() {
            self.renderGraphs();
        });
    },

    onAttachCallback: function () {
        this._isInDom = true;
        this.renderGraphs();
        this._super.apply(this, arguments);
    },
    onDetachCallback: function () {
        this._isInDom = false;
        this._super.apply(this, arguments);
    },
    /**
     * Fetches dashboard data
     */
    fetchData: function() {
        var self = this;
        var prom = this._rpc({
            route: '/website/fetchDashboardData',
            params: {
                websiteId: this.websiteId || false,
                dateFrom: this.dateFrom.year()+'-'+(this.dateFrom.month()+1)+'-'+this.dateFrom.date(),
                dateTo: this.dateTo.year()+'-'+(this.dateTo.month()+1)+'-'+this.dateTo.date(),
            },
        });
        prom.then(function (result) {
            self.data = result;
            self.dashboardsData = result.dashboards;
            self.currencyId = result.currencyId;
            self.groups = result.groups;
            self.websites = result.websites;
        });
        return prom;
    },

    onLinkAnalyticsSettings: function(ev) {
        ev.preventDefault();

        var self = this;
        var dialog = new Dialog(this, {
            size: 'medium',
            title: _t('Connect Google Analytics'),
            $content: QWeb.render('website.gaDialogContent', {
                gaKey: this.dashboardsData.visits.gaClientId,
                gaAnalyticsKey: this.dashboardsData.visits.gaAnalyticsKey,
            }),
            buttons: [
                {
                    text: _t("Save"),
                    classes: 'btn-primary',
                    close: true,
                    click: function() {
                        var gaClientId = dialog.$el.find('input[name="gaClientId"]').val();
                        var gaAnalyticsKey = dialog.$el.find('input[name="gaAnalyticsKey"]').val();
                        self.onSaveGaClientId(gaClientId, gaAnalyticsKey);
                    },
                },
                {
                    text: _t("Cancel"),
                    close: true,
                },
            ],
        }).open();
    },

    onGoToWebsite: function (ev) {
        ev.preventDefault();
        var website = _.findWhere(this.websites, {selected: true});
        window.location.href = `/website/force/${website.id}`;
    },

    onSaveGaClientId: function(gaClientId, gaAnalyticsKey) {
        var self = this;
        return this._rpc({
            route: '/website/dashboard/setGaData',
            params: {
                'websiteId': self.websiteId,
                'gaClientId': gaClientId,
                'gaAnalyticsKey': gaAnalyticsKey,
            },
        }).then(function (result) {
            if (result.error) {
                self.displayNotification({ title: result.error.title, message: result.error.message, type: 'danger' });
                return;
            }
            self.onDaterangeButton('week');
        });
    },

    renderDashboards: function() {
        var self = this;
        _.each(this.dashboardsTemplates, function(template) {
            self.$('.o-website-dashboard').append(QWeb.render(template, {widget: self}));
        });
    },

    renderGraph: function(divToDisplay, chartValues, chartId) {
        var self = this;

        this.$(divToDisplay).empty();
        var $canvasContainer = $('<div/>', {class: 'o-graph-canvas-container'});
        this.$canvas = $('<canvas/>').attr('id', chartId);
        $canvasContainer.append(this.$canvas);
        this.$(divToDisplay).append($canvasContainer);

        var labels = chartValues[0].values.map(function (date) {
            return moment(date[0], "YYYY-MM-DD", 'en');
        });

        var datasets = chartValues.map(function (group, index) {
            return {
                label: group.key,
                data: group.values.map(function (value) {
                    return value[1];
                }),
                dates: group.values.map(function (value) {
                    return value[0];
                }),
                fill: false,
                borderColor: COLORS[index],
            };
        });

        var ctx = this.$canvas[0];
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets,
            },
            options: {
                legend: {
                    display: false,
                },
                maintainAspectRatio: false,
                scales: {
                    yAxes: [{
                        type: 'linear',
                        ticks: {
                            beginAtZero: true,
                            callback: this.formatValue.bind(this),
                        },
                    }],
                    xAxes: [{
                        ticks: {
                            callback: function (moment) {
                                return moment.format(self.DATE_FORMAT);
                            },
                        }
                    }],
                },
                tooltips: {
                    mode: 'index',
                    intersect: false,
                    bodyFontColor: 'rgba(0,0,0,1)',
                    titleFontSize: 13,
                    titleFontColor: 'rgba(0,0,0,1)',
                    backgroundColor: 'rgba(255,255,255,0.6)',
                    borderColor: 'rgba(0,0,0,0.2)',
                    borderWidth: 2,
                    callbacks: {
                        title: function (tooltipItems, data) {
                            return data.datasets[0].label;
                        },
                        label: function (tooltipItem, data) {
                            var moment = data.labels[tooltipItem.index];
                            var date = tooltipItem.datasetIndex === 0 ?
                                        moment :
                                        moment.subtract(1, self.daterange);
                            return date.format(self.DATE_FORMAT) + ': ' + self.formatValue(tooltipItem.yLabel);
                        },
                        labelColor: function (tooltipItem, chart) {
                            var dataset = chart.data.datasets[tooltipItem.datasetIndex];
                            return {
                                borderColor: dataset.borderColor,
                                backgroundColor: dataset.borderColor,
                            };
                        },
                    }
                }
            }
        });
    },

    renderGraphs: function() {
        var self = this;
        if (this._isInDom) {
            _.each(this.graphs, function(e) {
                var renderGraph = self.groups[e.group] &&
                                    self.dashboardsData[e.label].summary.order_count;
                if (!self.chartIds[e.label]) {
                    self.chartIds[e.label] = _.uniqueId('chart_' + e.label);
                }
                var chartId = self.chartIds[e.label];
                if (renderGraph) {
                    self.renderGraph('.o-graph-' + e.label, self.dashboardsData[e.label].graph, chartId);
                }
            });
            this.renderGraphAnalytics(this.dashboardsData.visits.gaClientId);
        }
    },

    renderGraphAnalytics: function(clientId) {
        if (!this.dashboardsData.visits || !this.dashboardsData.visits.gaClientId) {
          return;
        }

        this.loadAnalyticsApi();

        var $analyticsComponents = this.$('.js-analytics-components');
        this.addLoader($analyticsComponents);

        var self = this;
        gapi.analytics.ready(function() {

            $analyticsComponents.empty();
            // 1. Authorize component
            var $analyticsAuth = $('<div>').addClass('col-lg-12');
            window.onOriginError = function () {
                $analyticsComponents.find('.js-unauthorized-message').remove();
                self.displayUnauthorizedMessage($analyticsComponents, 'notInitialized');
            };
            gapi.analytics.auth.authorize({
                container: $analyticsAuth[0],
                clientid: clientId
            });

            $analyticsAuth.appendTo($analyticsComponents);

            self.handleAnalyticsAuth($analyticsComponents);
            gapi.analytics.auth.on('signIn', function() {
                delete window.onOriginError;
                self.handleAnalyticsAuth($analyticsComponents);
            });

        });
    },

    onDaterangeButton: function(daterange) {
        if (daterange === 'week') {
            this.daterange = 'week';
            this.dateFrom = moment.utc().subtract(1, 'weeks');
        } else if (daterange === 'month') {
            this.daterange = 'month';
            this.dateFrom = moment.utc().subtract(1, 'months');
        } else if (daterange === 'year') {
            this.daterange = 'year';
            this.dateFrom = moment.utc().subtract(1, 'years');
        } else {
            console.log('Unknown date range. Choose between [week, month, year]');
            return;
        }

        var self = this;
        Promise.resolve(this.fetchData()).then(function () {
            self.$('.o-website-dashboard').empty();
            self.renderDashboards();
            self.renderGraphs();
        });

    },

    onWebsiteButton: function(websiteId) {
        var self = this;
        this.websiteId = websiteId;
        Promise.resolve(this.fetchData()).then(function () {
            self.$('.o-website-dashboard').empty();
            self.renderDashboards();
            self.renderGraphs();
        });
    },

    onReverseBreadcrumb: function() {
        var self = this;
        webClient.doPushState({});
        this.fetchData().then(function() {
            self.$('.o-website-dashboard').empty();
            self.renderDashboards();
            self.renderGraphs();
        });
    },

    onDashboardAction: function (ev) {
        ev.preventDefault();
        var self = this
        var $action = $(ev.currentTarget);
        var additionalContext = {};
        if (this.daterange === 'week') {
            additionalContext = {searchDefault_week: true};
        } else if (this.daterange === 'month') {
            additionalContext = {searchDefault_month: true};
        } else if (this.daterange === 'year') {
            additionalContext = {searchDefault_year: true};
        }
        this._rpc({
            route: '/web/action/load',
            params: {
                'actionId': $action.attr('label'),
            },
        })
        .then(function (action) {
            action.domain = vjUtils.assembleDomains([action.domain, `[('websiteId', '=', ${self.websiteId})]`]);
            return self.doAction(action, {
                'additionalContext': additionalContext,
                'onReverseBreadcrumb': self.onReverseBreadcrumb
            });
        });
    },

    onDashboardActionForm: function (ev) {
        ev.preventDefault();
        var $action = $(ev.currentTarget);
        this.doAction({
            label: $action.attr('label'),
            resModel: $action.data('resModel'),
            resId: $action.data('resId'),
            views: [[false, 'form']],
            type: 'ir.actions.actwindow',
        }, {
            onReverseBreadcrumb: this.onReverseBreadcrumb
        });
    },

    /**
     * @private
     */
    _computeControlPanelProps() {
        const $searchView = $(QWeb.render("website.DaterangeButtons", {
            widget: this,
        }));
        $searchView.find('button.js-date-range').click((ev) => {
            $searchView.find('button.js-date-range.active').removeClass('active');
            $(ev.target).addClass('active');
            this.onDaterangeButton($(ev.target).data('date'));
        });
        $searchView.find('button.js-website').click((ev) => {
            $searchView.find('button.js-website.active').removeClass('active');
            $(ev.target).addClass('active');
            this.onWebsiteButton($(ev.target).data('website-id'));
        });

        const $buttons = $(QWeb.render("website.GoToButtons"));
        $buttons.on('click', this.onGoToWebsite.bind(this));

        this.controlPanelProps.cpContent = { $searchView, $buttons };
    },

    // Loads Analytics API
    loadAnalyticsApi: function() {
        var self = this;
        if (!("gapi" in window)) {
            (function(w,d,s,g,js,fjs){
                g=w.gapi||(w.gapi={});g.analytics={q:[],ready:function(cb){this.q.push(cb);}};
                js=d.createElement(s);fjs=d.getElementsByTagName(s)[0];
                js.src='https://apis.google.com/js/platform.js';
                fjs.parentNode.insertBefore(js,fjs);js.onload=function(){g.load('analytics');};
            }(window,document,'script'));
            gapi.analytics.ready(function() {
                self.analyticsCreateComponents();
            });
        }
    },

    handleAnalyticsAuth: function($analyticsComponents) {
        $analyticsComponents.find('.js-unauthorized-message').remove();

        // Check if the user is authenticated and has the right to make API calls
        if (!gapi.analytics.auth.getAuthResponse()) {
            this.displayUnauthorizedMessage($analyticsComponents, 'notConnected');
        } else if (gapi.analytics.auth.getAuthResponse() && gapi.analytics.auth.getAuthResponse().scope.indexOf('https://www.googleapis.com/auth/analytics') === -1) {
            this.displayUnauthorizedMessage($analyticsComponents, 'noRight');
        } else {
            this.makeAnalyticsCalls($analyticsComponents);
        }
    },

    displayUnauthorizedMessage: function($analyticsComponents, reason) {
        $analyticsComponents.prepend($(QWeb.render('website.unauthorizedAnalytics', {reason: reason})));
    },

    makeAnalyticsCalls: function($analyticsComponents) {
        // 2. ActiveUsers component
        var $analyticsUsers = $('<div>');
        var activeUsers = new gapi.analytics.ext.ActiveUsers({
            container: $analyticsUsers[0],
            pollingInterval: 10,
        });
        $analyticsUsers.appendTo($analyticsComponents);

        // 3. View Selector
        var $analyticsViewSelector = $('<div>').addClass('col-lg-12 o-properties-selection');
        var viewSelector = new gapi.analytics.ViewSelector({
            container: $analyticsViewSelector[0],
        });
        viewSelector.execute();
        $analyticsViewSelector.appendTo($analyticsComponents);

        // 4. Chart graph
        var startDate = '7daysAgo';
        if (this.daterange === 'month') {
            startDate = '30daysAgo';
        } else if (this.daterange === 'year') {
            startDate = '365daysAgo';
        }
        var $analyticsChart2 = $('<div>').addClass('col-lg-6 col-12');
        var breakdownChart = new gapi.analytics.googleCharts.DataChart({
            query: {
                'dimensions': 'ga:date',
                'metrics': 'ga:sessions',
                'start-date': startDate,
                'end-date': 'yesterday'
            },
            chart: {
                type: 'LINE',
                container: $analyticsChart2[0],
                options: {
                    title: 'All',
                    width: '100%',
                    tooltip: {isHtml: true},
                }
            }
        });
        $analyticsChart2.appendTo($analyticsComponents);

        // 5. Chart table
        var $analyticsChart1 = $('<div>').addClass('col-lg-6 col-12');
        var mainChart = new gapi.analytics.googleCharts.DataChart({
            query: {
                'dimensions': 'ga:medium',
                'metrics': 'ga:sessions',
                'sort': '-ga:sessions',
                'max-results': '6'
            },
            chart: {
                type: 'TABLE',
                container: $analyticsChart1[0],
                options: {
                    width: '100%'
                }
            }
        });
        $analyticsChart1.appendTo($analyticsComponents);

        // Events handling & animations

        var tableRowListener;

        viewSelector.on('change', function(ids) {
            var options = {query: {ids: ids}};
            activeUsers.set({ids: ids}).execute();
            mainChart.set(options).execute();
            breakdownChart.set(options).execute();

            if (tableRowListener) { google.visualization.events.removeListener(tableRowListener); }
        });

        mainChart.on('success', function(response) {
            var chart = response.chart;
            var dataTable = response.dataTable;

            tableRowListener = google.visualization.events.addListener(chart, 'select', function() {
                var options;
                if (chart.getSelection().length) {
                    var row =  chart.getSelection()[0].row;
                    var medium =  dataTable.getValue(row, 0);
                    options = {
                        query: {
                            filters: 'ga:medium==' + medium,
                        },
                        chart: {
                            options: {
                                title: medium,
                            }
                        }
                    };
                } else {
                    options = {
                        chart: {
                            options: {
                                title: 'All',
                            }
                        }
                    };
                    delete breakdownChart.get().query.filters;
                }
                breakdownChart.set(options).execute();
            });
        });

        // Add CSS animation to visually show the when users come and go.
        activeUsers.once('success', function() {
            var element = this.container.firstChild;
            var timeout;

            this.on('change', function(data) {
                element = this.container.firstChild;
                var animationClass = data.delta > 0 ? 'is-increasing' : 'is-decreasing';
                element.className += (' ' + animationClass);

                clearTimeout(timeout);
                timeout = setTimeout(function() {
                    element.className = element.className.replace(/ is-(increasing|decreasing)/g, '');
                }, 3000);
            });
        });
    },

    /*
     * Credits to https://github.com/googleanalytics/ga-dev-tools
     * This is the Active Users component that polls
     * the number of active users on Analytics each 5 secs
     */
    analyticsCreateComponents: function() {

        gapi.analytics.createComponent('ActiveUsers', {

            initialize: function() {
                this.activeUsers = 0;
                gapi.analytics.auth.once('signOut', this.handleSignOut_.bind(this));
            },

            execute: function() {
                // Stop any polling currently going on.
                if (this.polling_) {
                    this.stop();
                }

                this.render_();

                // Wait until the user is authorized.
                if (gapi.analytics.auth.isAuthorized()) {
                    this.pollActiveUsers_();
                } else {
                    gapi.analytics.auth.once('signIn', this.pollActiveUsers_.bind(this));
                }
            },

            stop: function() {
                clearTimeout(this.timeout_);
                this.polling_ = false;
                this.emit('stop', {activeUsers: this.activeUsers});
            },

            render_: function() {
                var opts = this.get();

                // Render the component inside the container.
                this.container = typeof opts.container === 'string' ?
                    document.getElementById(opts.container) : opts.container;

                this.container.innerHTML = opts.template || this.template;
                this.container.querySelector('b').innerHTML = this.activeUsers;
            },

            pollActiveUsers_: function() {
                var options = this.get();
                var pollingInterval = (options.pollingInterval || 5) * 1000;

                if (isNaN(pollingInterval) || pollingInterval < 5000) {
                    throw new Error('Frequency must be 5 seconds or more.');
                }

                this.polling_ = true;
                gapi.client.analytics.data.realtime
                    .get({ids:options.ids, metrics:'rt:activeUsers'})
                    .then(function(response) {
                        var result = response.result;
                        var newValue = result.totalResults ? +result.rows[0][0] : 0;
                        var oldValue = this.activeUsers;

                        this.emit('success', {activeUsers: this.activeUsers});

                        if (newValue !== oldValue) {
                            this.activeUsers = newValue;
                            this.onchange_(newValue - oldValue);
                        }

                        if (this.polling_) {
                            this.timeout_ = setTimeout(this.pollActiveUsers_.bind(this), pollingInterval);
                        }
                    }.bind(this));
            },

            onchange_: function(delta) {
                var valueContainer = this.container.querySelector('b');
                if (valueContainer) { valueContainer.innerHTML = this.activeUsers; }

                this.emit('change', {activeUsers: this.activeUsers, delta: delta});
                if (delta > 0) {
                    this.emit('increase', {activeUsers: this.activeUsers, delta: delta});
                } else {
                    this.emit('decrease', {activeUsers: this.activeUsers, delta: delta});
                }
            },

            handleSignOut_: function() {
                this.stop();
                gapi.analytics.auth.once('signIn', this.handleSignIn_.bind(this));
            },

            handleSignIn_: function() {
                this.pollActiveUsers_();
                gapi.analytics.auth.once('signOut', this.handleSignOut_.bind(this));
            },

            template:
                '<div class="ActiveUsers">' +
                    'Active Users: <b class="ActiveUsers-value"></b>' +
                '</div>'

        });
    },

    // Utility functions
    addLoader: function(selector) {
        var loader = '<span class="fa fa-3x fa-spin fa-circle-o-notch fa-spin"/>';
        selector.html("<div class='o-loader'>" + loader + "</div>");
    },
    getValue: function(d) { return d[1]; },
    formatNumber: function(value, type, digits, symbol) {
        if (type === 'currency') {
            return this.renderMonetaryField(value, this.currencyId);
        } else {
            return fieldUtils.format[type](value || 0, {digits: digits}) + ' ' + symbol;
        }
    },
    formatValue: function (value) {
        var formatter = fieldUtils.format.float;
        var formatedValue = formatter(value, undefined, FORMAT_OPTIONS);
        return formatedValue;
    },
    renderMonetaryField: function(value, currencyId) {
        var currency = session.getCurrency(currencyId);
        var formattedValue = fieldUtils.format.float(value || 0, {digits: currency && currency.digits});
        if (currency) {
            if (currency.position === "after") {
                formattedValue += currency.symbol;
            } else {
                formattedValue = currency.symbol + formattedValue;
            }
        }
        return formattedValue;
    },

});

core.actionRegistry.add('backendDashboard', Dashboard);

return Dashboard;
});
