verp.define('point_of_sale.devices', function (require) {
"use strict";

var core = require('web.core');
var mixins = require('web.mixins');
var Session = require('web.Session');
var Printer = require('point_of_sale.Printer').Printer;

// the JobQueue schedules a sequence of 'jobs'. each job is
// a function returning a promise. The queue waits for each job to finish
// before launching the next. Each job can also be scheduled with a delay.
// the  is used to prevent parallel requests to the proxy.

var JobQueue = function(){
    var queue = [];
    var running = false;
    var scheduledEndTime = 0;
    var endOfQueue = Promise.resolve();
    var stoprepeat = false;

    var run = function () {
        var runNextJob = function () {
            if (queue.length === 0) {
                running = false;
                scheduledEndTime = 0;
                return Promise.resolve();
            }
            running = true;
            var job = queue[0];
            if (!job.opts.repeat || stoprepeat) {
                queue.shift();
                stoprepeat = false;
            }

            // the time scheduled for this job
            scheduledEndTime = (new Date()).getTime() + (job.opts.duration || 0);

            // we run the job and put in prom when it finishes
            var prom = job.fun() || Promise.resolve();

            var always = function () {
                // we run the next job after the scheduledEndTime, even if it finishes before
                return new Promise(function (resolve, reject) {
                    setTimeout(
                        resolve,
                        Math.max(0, scheduledEndTime - (new Date()).getTime())
                    );
                });
            };
            // we don't care if a job fails ...
            return prom.then(always, always).then(runNextJob);
        };

        if (!running) {
            endOfQueue = runNextJob();
        }
    };

    /**
     * Adds a job to the schedule.
     *
     * @param {function} fun must return a promise
     * @param {object} [opts]
     * @param {number} [opts.duration] the job is guaranteed to finish no quicker than this (milisec)
     * @param {boolean} [opts.repeat] if true, the job will be endlessly repeated
     * @param {boolean} [opts.important] if true, the scheduled job cannot be canceled by a queue.clear()
     */
    this.schedule  = function (fun, opts) {
        queue.push({fun:fun, opts:opts || {}});
        if(!running){
            run();
        }
    };

    // remove all jobs from the schedule (except the ones marked as important)
    this.clear = function(){
        queue = _.filter(queue,function(job){return job.opts.important === true;});
    };

    // end the repetition of the current job
    this.stoprepeat = function(){
        stoprepeat = true;
    };

    /**
     * Returns a promise that resolves when all scheduled jobs have been run.
     * (jobs added after the call to this method are considered as well)
     *
     * @returns {Promise}
     */
    this.finished = function () {
        return endOfQueue;
    };

};


// this object interfaces with the local proxy to communicate to the various hardware devices
// connected to the Point of Sale. As the communication only goes from the POS to the proxy,
// methods are used both to signal an event, and to fetch information.

var ProxyDevice  = core.Class.extend(mixins.PropertiesMixin,{
    init: function(parent,options){
        mixins.PropertiesMixin.init.call(this);
        var self = this;
        this.setParent(parent);
        options = options || {};

        this.pos = parent;

        this.weighing = false;
        this.debugWeight = 0;
        this.useDebugWeight = false;

        this.paying = false;
        this.defaultPaymentStatus = {
            status: 'waiting',
            message: '',
            paymentMethod: undefined,
            receiptClient: undefined,
            receiptShop:   undefined,
        };
        this.customPaymentStatus = this.defaultPaymentStatus;

        this.notifications = {};
        this.bypassProxy = false;

        this.connection = null;
        this.host       = '';
        this.keptalive  = false;

        this.set('status',{});

        this.setConnectionStatus('disconnected');

        this.on('change:status',this,function(eh,status){
            status = status.newValue;
            if(status.status === 'connected' && self.printer) {
                self.printer.printReceipt();
            }
        });

        this.posboxSupportsDisplay = true;

        window.hw_proxy = this;
    },
    setConnectionStatus: function(status, drivers, msg=''){
        var oldstatus = this.get('status');
        var newstatus = {};
        newstatus.status = status;
        newstatus.drivers = status === 'disconnected' ? {} : oldstatus.drivers;
        newstatus.drivers = drivers ? drivers : newstatus.drivers;
        newstatus.msg = msg;
        this.set('status',newstatus);
    },
    disconnect: function(){
        if(this.get('status').status !== 'disconnected'){
            this.connection.destroy();
            this.setConnectionStatus('disconnected');
        }
    },

    /**
     * Connects to the specified url.
     *
     * @param {string} url
     * @returns {Promise}
     */
    connect: function(url){
        var self = this;
        this.connection = new Session(undefined,url, { useCors: true});
        this.host = url;
        if (this.pos.config.ifacePrintViaProxy) {
            this.connectToPrinter();
        }
        this.setConnectionStatus('connecting',{});

        return this.message('handshake').then(function(response){
                if(response){
                    self.setConnectionStatus('connected');
                    localStorage.hwProxyUrl = url;
                    self.keepalive();
                }else{
                    self.setConnectionStatus('disconnected');
                    console.error('Connection refused by the Proxy');
                }
            },function(){
                self.setConnectionStatus('disconnected');
                console.error('Could not connect to the Proxy');
            });
    },

    connectToPrinter: function () {
        this.printer = new Printer(this.host, this.pos);
    },

    /**
     * Find a proxy and connects to it.
     *
     * @param {Object} [options]
     * @param {string} [options.forceIp] only try to connect to the specified ip.
     * @param {string} [options.port] @see findProxy
     * @param {function} [options.progress] @see findProxy
     * @returns {Promise}
     */
    autoconnect: function (options) {
        var self = this;
        this.setConnectionStatus('connecting',{});
        if (this.pos.config.ifacePrintViaProxy) {
            this.connectToPrinter();
        }
        var foundUrl = new Promise(function () {});

        if (options.forceIp) {
            // if the ip is forced by server config, bailout on fail
            foundUrl = this.tryHardToConnect(options.forceIp, options);
        } else if (localStorage.hwProxyUrl) {
            // try harder when we remember a good proxy url
            foundUrl = this.tryHardToConnect(localStorage.hwProxyUrl, options)
                .catch(function () {
                    if (window.location.protocol != 'https:') {
                        return self.findProxy(options);
                    }
                });
        } else {
            // just find something quick
            if (window.location.protocol != 'https:'){
                foundUrl = this.findProxy(options);
            }
        }

        var successProm = foundUrl.then(function (url) {
            return self.connect(url);
        });

        successProm.catch(function () {
            self.setConnectionStatus('disconnected');
        });

        return successProm;
    },

    // starts a loop that updates the connection status
    keepalive: function () {
        var self = this;

        function status(){
            var always = function () {
                setTimeout(status, 5000);
            };
            self.connection.rpc('/hw_proxy/statusJson',{},{shadow: true, timeout:2500})
                .then(function (driverStatus) {
                    self.setConnectionStatus('connected',driverStatus);
                }, function () {
                    if(self.get('status').status !== 'connecting'){
                        self.setConnectionStatus('disconnected');
                    }
                }).then(always, always);
        }

        if (!this.keptalive) {
            this.keptalive = true;
            status();
        }
    },

    /**
     * @param {string} name
     * @param {Object} [params]
     * @returns {Promise}
     */
    message : function (name, params) {
        var callbacks = this.notifications[name] || [];
        for (var i = 0; i < callbacks.length; i++) {
            callbacks[i](params);
        }
        if (this.get('status').status !== 'disconnected') {
            return this.connection.rpc('/hw_proxy/' + name, params || {}, {shadow: true});
        } else {
            return Promise.reject();
        }
    },

    /**
     * Tries several time to connect to a known proxy url.
     *
     * @param {*} url
     * @param {Object} [options]
     * @param {string} [options.port=8069] what port to listen to
     * @returns {Promise<string|Array>}
     */
    tryHardToConnect: function (url, options) {
        options   = options || {};
        var protocol = window.location.protocol;
        var port = ( !options.port && protocol == "https:") ? ':443' : ':' + (options.port || '8069');

        this.setConnectionStatus('connecting');

        if(url.indexOf('//') < 0){
            url = protocol + '//' + url;
        }

        if(url.indexOf(':',5) < 0){
            url = url + port;
        }

        // try real hard to connect to url, with a 1sec timeout and up to 'retries' retries
        function tryRealHardToConnect(url, retries) {
            return Promise.resolve(
                $.ajax({
                    url: url + '/hw_proxy/hello',
                    method: 'GET',
                    timeout: 1000,
                })
                .then(function () {
                    return Promise.resolve(url);
                }, function (resp) {
                    if (retries > 0) {
                        return tryRealHardToConnect(url, retries-1);
                    } else {
                        return Promise.reject([resp.statusText, url]);
                    }
                })
            );
        }

        return tryRealHardToConnect(url, 3);
    },

    /**
     * Returns as a promise a valid host url that can be used as proxy.
     *
     * @param {Object} [options]
     * @param {string} [options.port] what port to listen to (default 8069)
     * @param {function} [options.progress] callback for search progress ( fac in [0,1] )
     * @returns {Promise<string>} will be resolved with the proxy valid url
     */
    findProxy: function(options){
        options = options || {};
        var self  = this;
        var port  = ':' + (options.port || '8069');
        var urls  = [];
        var found = false;
        var parallel = 8;
        var threads  = [];
        var progress = 0;


        urls.push('http://localhost'+port);
        for(var i = 0; i < 256; i++){
            urls.push('http://192.168.0.'+i+port);
            urls.push('http://192.168.1.'+i+port);
            urls.push('http://10.0.0.'+i+port);
        }

        var progInc = 1/urls.length;

        function updateProgress(){
            progress = found ? 1 : progress + progInc;
            if(options.progress){
                options.progress(progress);
            }
        }

        function thread () {
            var url = urls.shift();

            if (!url || found || !self.searchingForProxy) {
                return Promise.resolve();
            }

            return Promise.resolve(
                $.ajax({
                    url: url + '/hw_proxy/hello',
                    method: 'GET',
                    timeout: 400,
                }).then(function () {
                    found = true;
                    updateProgress();
                    return Promise.resolve(url);
                }, function () {
                    updateProgress();
                    return thread();
                })
            );
        }

        this.searchingForProxy = true;

        var len  = Math.min(parallel, urls.length);
        for(i = 0; i < len; i++){
            threads.push(thread());
        }

        return new Promise(function (resolve, reject) {
            Promise.all(threads).then(function(results){
                var urls = [];
                for(var i = 0; i < results.length; i++){
                    if(results[i]){
                        urls.push(results[i]);
                    }
                }
                resolve(urls[0]);
            });
        });
    },

    stopSearching: function(){
        this.searchingForProxy = false;
        this.setConnectionStatus('disconnected');
    },

    // this allows the client to be notified when a proxy call is made. The notification
    // callback will be executed with the same arguments as the proxy call
    addNotification: function(name, callback){
        if(!this.notifications[name]){
            this.notifications[name] = [];
        }
        this.notifications[name].push(callback);
    },

    /**
     * Returns the weight on the scale.
     *
     * @returns {Promise<Object>}
     */
    scaleRead: function () {
        var self = this;
        if (self.useDebugWeight) {
            return Promise.resolve({weight:this.debugWeight, unit:'Kg', info:'ok'});
        }
        return new Promise(function (resolve, reject) {
            self.message('scaleRead',{})
            .then(function (weight) {
                resolve(weight);
            }, function () { //failed to read weight
                resolve({weight:0.0, unit:'Kg', info:'ok'});
            });
        });
    },

    // sets a custom weight, ignoring the proxy returned value.
    debugSetWeight: function(kg){
        this.useDebugWeight = true;
        this.debugWeight = kg;
    },

    // resets the custom weight and re-enable listening to the proxy for weight values
    debugResetWeight: function(){
        this.useDebugWeight = false;
        this.debugWeight = 0;
    },

    updateCustomerFacingDisplay: function(html) {
        if (this.posboxSupportsDisplay) {
            return this.message('customerFacingDisplay',
                { html: html },
                { timeout: 5000 });
        }
    },

    /**
     * @param {string} html
     * @returns {Promise}
     */
    takeOwnershipOverClientScreen: function(html) {
        return this.message("takeControl", { html: html });
    },

    /**
     * @returns {Promise}
     */
    testOwnershipOfClientScreen: function() {
        if (this.connection) {
            return this.message("testOwnership", {});
        }
        return Promise.reject({abort: true});
    },

    // asks the proxy to log some information, as with the debug.log you can provide several arguments.
    log: function(){
        return this.message('log',{'arguments': _.toArray(arguments)});
    },

});

return {
    JobQueue: JobQueue,
    ProxyDevice: ProxyDevice,
};

});
