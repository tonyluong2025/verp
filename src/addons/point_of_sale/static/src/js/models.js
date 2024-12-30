/* global Backbone, waitForWebfonts */
verp.define('point_of_sale.models', function (require) {
"use strict";

const { Context } = owl;
var BarcodeParser = require('barcodes.BarcodeParser');
var BarcodeReader = require('point_of_sale.BarcodeReader');
var PosDB = require('point_of_sale.DB');
var devices = require('point_of_sale.devices');
var concurrency = require('web.concurrency');
var config = require('web.config');
var core = require('web.core');
var fieldUtils = require('web.fieldUtils');
var time = require('web.time');
var utils = require('web.utils');
var { Gui } = require('point_of_sale.Gui');

var QWeb = core.qweb;
var _t = core._t;
var Mutex = concurrency.Mutex;
var roundDi = utils.roundDecimals;
var roundPr = utils.roundPrecision;

var exports = {};

// The PosModel contains the Point Of Sale's representation of the backend.
// Since the PoS must work in standalone ( Without connection to the server )
// it must contains a representation of the server's PoS backend.
// (taxes, product list, configuration options, etc.)  this representation
// is fetched and stored by the PosModel at the initialisation.
// this is done asynchronously, a ready deferred alows the GUI to wait interactively
// for the loading to be completed
// There is a single instance of the PosModel for each Front-End instance, it is usually called
// 'pos' and is available to all widgets extending PosWidget.

exports.PosModel = Backbone.Model.extend({
    initialize: function(attributes) {
        Backbone.Model.prototype.initialize.call(this, attributes);
        var  self = this;
        this.flushMutex = new Mutex();                   // used to make sure the orders are sent to the server once at time

        this.env = this.get('env');
        this.rpc = this.get('rpc');
        this.session = this.get('session');
        this.doAction = this.get('doAction');
        this.setLoadingMessage = this.get('setLoadingMessage');
        this.setLoadingProgress = this.get('setLoadingProgress');
        this.showLoadingSkip = this.get('showLoadingSkip');

        this.proxy = new devices.ProxyDevice(this);              // used to communicate to the hardware devices via a local proxy
        this.barcodeReader = new BarcodeReader({'pos': this, proxy:this.proxy});

        this.proxyQueue = new devices.JobQueue();           // used to prevent parallels communications to the proxy
        this.db = new PosDB();                       // a local database used to search trough products and categories & store pending orders
        this.debug = config.isDebug(); //debug mode

        // Business data; loaded from the server at launch
        this.companyLogo = null;
        this.companyLogoBase64 = '';
        this.currency = null;
        this.company = null;
        this.user = null;
        this.users = [];
        this.employee = {name: null, id: null, barcode: null, userId:null, pin:null};
        this.employees = [];
        this.partners = [];
        this.taxes = [];
        this.posSession = null;
        this.config = null;
        this.units = [];
        this.unitsById = {};
        this.uomUnitId = null;
        this.defaultPricelist = null;
        this.orderSequence = 1;
        window.posmodel = this;

        // Object mapping the order's name (which contains the uid) to it's serverId after
        // validation (order paid then sent to the backend).
        this.validatedOrdersNameServerIdMap = {};

        // Record<orderlineId, { 'qty': number, 'orderline': { qty: number, refundedQty: number, orderUid: string }, 'destinationOrderUid': string }>
        this.toRefundLines = {};
        this.TICKET_SCREEN_STATE = {
            syncedOrders: {
                currentPage: 1,
                cache: {},
                toShow: [],
                nPerPage: 80,
                totalCount: null,
            },
            ui: {
                selectedSyncedOrderId: null,
                searchDetails: this.getDefaultSearchDetails(),
                filter: null,
                // maps the order's backendId to it's selected orderline
                selectedOrderlineIds: {},
                highlightHeaderNote: false,
            },
        };

        // Extract the config id from the url.
        var givenConfig = new RegExp('[\?&]configId=([^&#]*)').exec(window.location.href);
        this.configId = givenConfig && givenConfig[1] && parseInt(givenConfig[1]) || false;

        // these dynamic attributes can be watched for change by other models or widgets
        this.set({
            'synch':            { status:'connected', pending:0 },
            'orders':           new OrderCollection(),
            'selectedOrder':    null,
            'selectedClient':   null,
            'cashier':          null,
            'selectedCategoryId': null,
        });

        this.get('orders').on('remove', function(order,_unused_,options){
            self.onRemovedOrder(order,options.index,options.reason);
        });

        // Forward the 'client' attribute on the selected order to 'selectedClient'
        function updateClient() {
            var order = self.getOrder();
            this.set('selectedClient', order ? order.getClient() : null );
        }
        this.get('orders').on('add remove change', updateClient, this);
        this.on('change:selectedOrder', updateClient, this);

        // We fetch the backend data on the server asynchronously. this is done only when the pos user interface is launched,
        // Any change on this data made on the server is thus not reflected on the point of sale until it is relaunched.
        // when all the data has loaded, we compute some stuff, and declare the Pos ready to be used.
        this.ready = this.loadServerData().then(function(){
            return self.afterLoadServerData();
        });
    },
    getDefaultSearchDetails: function() {
        return {
            fieldName: 'RECEIPT_NUMBER',
            searchTerm: '',
        };
    },
    loadProductUomUnit: async function() {
        const params = {
            model: 'ir.model.data',
            method:'checkObjectReference',
            args: ['uom', 'productUomUnit'],
        };

        const uomId = await this.rpc(params);
        this.uomUnitId = uomId[1];
    },

    afterLoadServerData: async function(){
        await this.loadProductUomUnit();
        await this.loadOrders();
        this.setStartOrder();

        if(this.config.limitedProductsLoading) {
            await this.loadLimitedProducts();
            if(this.config.productLoadBackground)
                this.loadProductsBackground();
        }
        if(this.config.partnerLoadBackground )
            this.loadPartnersBackground();

        if(this.config.useProxy){
            if (this.config.ifaceCustomerFacingDisplay) {
                this.on('change:selectedOrder', this.sendCurrentOrderToCustomerFacingDisplay, this);
            }

            return this.connectToProxy();
        }

        return Promise.resolve();
    },
    // releases ressources holds by the model at the end of life of the posmodel
    destroy: function(){
        // FIXME, should wait for flushing, return a deferred to indicate successfull destruction
        // this.flush();
        this.proxy.disconnect();
        this.barcodeReader.disconnectFromProxy();
    },

    connectToProxy: function () {
        var self = this;
        return new Promise(function (resolve, reject) {
            self.barcodeReader.disconnectFromProxy();
            self.setLoadingMessage(_t('Connecting to the IoT Box'), 0);
            self.showLoadingSkip(function () {
                self.proxy.stopSearching();
            });
            self.proxy.autoconnect({
                forceIp: self.config.proxyIp || undefined,
                progress: function(prog){
                    self.setLoadingProgress(prog);
                },
            }).then(
                function () {
                    if (self.config.ifaceScanViaProxy) {
                        self.barcodeReader.connectToProxy();
                    }
                    resolve();
                },
                function (statusText, url) {
                    // this should reject so that it can be captured when we wait for pos.ready
                    // in the chrome component.
                    // then, if it got really rejected, we can show the error.
                    if (statusText == 'error' && window.location.protocol == 'https:') {
                        reject({
                            title: _t('HTTPS connection to IoT Box failed'),
                            body: _.str.sprintf(
                              _t('Make sure you are using IoT Box v18.12 or higher. Navigate to %s to accept the certificate of your IoT Box.'),
                              url
                            ),
                            popup: 'alert',
                        });
                    } else {
                        resolve();
                    }
                }
            );
        });
    },

    // Server side model loaders. This is the list of the models that need to be loaded from
    // the server. The models are loaded one by one by this list's order. The 'loaded' callback
    // is used to store the data in the appropriate place once it has been loaded. This callback
    // can return a promise that will pause the loading of the next module.
    // a shared temporary dictionary is available for loaders to communicate private variables
    // used during loading such as object ids, etc.
    models: [
    {
        label:  'version',
        loaded: function (self) {
            return self.session.rpc('/web/webclient/versionInfo',{}).then(function (version) {
                self.version = version;
            });
        },

    },{
        model:  'res.company',
        fields: [ 'currencyId', 'email', 'website', 'companyRegistry', 'vat', 'label', 'phone', 'partnerId' , 'countryId', 'stateId', 'taxCalculationRoundingMethod'],
        ids:    function(self){ return [self.session.userContext.allowedCompanyIds[0]]; },
        loaded: function(self,companies){ self.company = companies[0]; },
    },{
        model:  'decimal.precision',
        fields: ['label','digits'],
        loaded: function(self,dps){
            self.dp  = {};
            for (var i = 0; i < dps.length; i++) {
                self.dp[dps[i].label] = dps[i].digits;
            }
        },
    },{
        model:  'uom.uom',
        fields: [],
        domain: null,
        context: function(self){ return { activeTest: false }; },
        loaded: function(self,units){
            self.units = units;
            _.each(units, function(unit){
                self.unitsById[unit.id] = unit;
            });
        }
    },{
        model:  'res.country.state',
        fields: ['label', 'countryId'],
        loaded: function(self,states){
            self.states = states;
        },
    },{
        model:  'res.country',
        fields: ['label', 'vatLabel', 'code'],
        loaded: function(self,countries){
            self.countries = countries;
            self.company.country = null;
            for (var i = 0; i < countries.length; i++) {
                if (countries[i].id === self.company.countryId[0]){
                    self.company.country = countries[i];
                }
            }
        },
    },{
        model:  'res.lang',
        fields: ['label', 'code'],
        loaded: function (self, langs){
            self.langs = langs;
        },
    },{
        model:  'account.tax',
        fields: ['label','amount', 'priceInclude', 'includeBaseAmount', 'isBaseAffected', 'amountType', 'childrenTaxIds'],
        domain: function(self) {return [['companyId', '=', self.company && self.company.id || false]]},
        loaded: function(self, taxes){
            self.taxes = taxes;
            self.taxesById = {};
            _.each(taxes, function(tax){
                self.taxesById[tax.id] = tax;
            });
            _.each(self.taxesById, function(tax) {
                tax.childrenTaxIds = _.map(tax.childrenTaxIds, function (childTaxId) {
                    return self.taxesById[childTaxId];
                });
            });
            return new Promise(function (resolve, reject) {
              var taxIds = _.pluck(self.taxes, 'id');
              self.rpc({
                  model: 'account.tax',
                  method: 'getRealTaxAmount',
                  args: [taxIds],
              }).then(function (taxes) {
                  _.each(taxes, function (tax) {
                      self.taxesById[tax.id].amount = tax.amount;
                  });
                  resolve();
              });
            });
        },
    },{
        model:  'pos.session',
        fields: ['id', 'label', 'userId', 'configId', 'startAt', 'stopAt', 'sequenceNumber', 'paymentMethodIds', 'cashRegisterId', 'state', 'updateStockAtClosing'],
        domain: function(self){
            var domain = [
                ['state','in',['opening','opened']],
                ['rescue', '=', false],
            ];
            if (self.configId) domain.push(['configId', '=', self.configId]);
            return domain;
        },
        loaded: function(self, posSessions, tmp){
            self.posSession = posSessions[0];
            self.posSession.loginNumber = verp.loginNumber;
            self.configId = self.configId || self.posSession && self.posSession.configId[0];
            tmp.paymentMethodIds = posSessions[0].paymentMethodIds;
        },
    },{
        model: 'pos.config',
        fields: [],
        domain: function(self){ return [['id','=', self.configId]]; },
        loaded: function(self,configs){
            self.config = configs[0];
            self.config.useProxy = self.config.isPosbox && (
                                    self.config.ifaceElectronicScale ||
                                    self.config.ifacePrintViaProxy  ||
                                    self.config.ifaceScanViaProxy   ||
                                    self.config.ifaceCustomerFacingDisplayViaProxy);

            self.db.setUuid(self.config.uuid);
            self.setCashier(self.getCashier());
            // We need to do it here, since only then the local storage has the correct uuid
            self.db.save('posSessionId', self.posSession.id);

            var orders = self.db.getOrders();
            for (var i = 0; i < orders.length; i++) {
                self.posSession.sequenceNumber = Math.max(self.posSession.sequenceNumber, orders[i].data.sequenceNumber+1);
            }
       },
    },{
        model: 'pos.bill',
        fields: ['label', 'value'],
        domain: function (self) {
            return [['id', 'in', self.config.defaultBillIds]];
        },
        loaded: function (self, bills) {
            self.bills = bills;
        },
      }, {
        model:  'res.partner',
        label: 'loadPartners',
        fields: ['label','street','city','stateId','countryId','vat','lang',
                 'phone','zip','mobile','email','barcode','updatedAt',
                 'propertyAccountPositionId','propertyProductPricelist'],
        domain: async function(self){
            if(self.config.limitedPartnersLoading) {
                const result = await self.rpc({
                      model: 'pos.config',
                      method: 'getLimitedPartnersLoading',
                      args: [self.config.id],
                });
                return [['id','in', result.map(elem => elem[0])]];
            }
            return [];
        },
        loaded: function(self,partners){
            self.partners = partners;
            self.db.addPartners(partners);
        },
    },{
      model: 'stock.picking.type',
      fields: ['useCreateLots', 'useExistingLots'],
      domain: function(self){ return [['id', '=', self.config.pickingTypeId[0]]]; },
      loaded: function(self, pickingType) {
          self.pickingType = pickingType[0];
      },
    },{
        model:  'res.users',
        fields: ['label','companyId', 'id', 'groupsId', 'lang'],
        domain: function(self){ return [['companyIds', 'in', self.config.companyId[0]],'|', ['groupsId','=', self.config.groupPosManagerId[0]],['groupsId','=', self.config.groupPosUserId[0]]]; },
        loaded: function(self,users){
            users.forEach(function(user) {
                user.role = 'cashier';
                user.groupsId.some(function(groupId) {
                    if (groupId === self.config.groupPosManagerId[0]) {
                        user.role = 'manager';
                        return true;
                    }
                });
                if (user.id === self.session.uid) {
                    self.user = user;
                    self.employee.label = user.label;
                    self.employee.role = user.role;
                    self.employee.userId = [user.id, user.label];
                }
            });
            self.users = users;
            self.employees = [self.employee];
            self.setCashier(self.employee);
        },
    },{
        model:  'product.pricelist',
        fields: ['label', 'displayName', 'discountPolicy'],
        domain: function(self) {
            if (self.config.usePricelist) {
                return [['id', 'in', self.config.availablePricelistIds]];
            } else {
                return [['id', '=', self.config.pricelistId[0]]];
            }
        },
        loaded: function(self, pricelists){
            _.map(pricelists, function (pricelist) { pricelist.items = []; });
            self.defaultPricelist = _.findWhere(pricelists, {id: self.config.pricelistId[0]});
            self.pricelists = pricelists;
        },
    },{
        model:  'account.bank.statement',
        fields: ['id', 'balanceStart'],
        domain: function(self){ return [['id', '=', self.posSession.cashRegisterId[0]]]; },
        loaded: function(self, statement){
            self.bankStatement = statement[0];
        },
    },{
        model:  'product.pricelist.item',
        domain: function(self) { return [['pricelistId', 'in', _.pluck(self.pricelists, 'id')]]; },
        loaded: function(self, pricelistItems){
            var pricelistById = {};
            _.each(self.pricelists, function (pricelist) {
                pricelistById[pricelist.id] = pricelist;
            });

            _.each(pricelistItems, function (item) {
                var pricelist = pricelistById[item.pricelistId[0]];
                pricelist.items.push(item);
                item.basePricelist = pricelistById[item.basePricelistId[0]];
            });
        },
    },{
        model:  'product.category',
        fields: ['label', 'parentId'],
        loaded: function(self, productCategories){
            var categoryById = {};
            _.each(productCategories, function (category) {
                categoryById[category.id] = category;
            });
            _.each(productCategories, function (category) {
                category.parent = categoryById[category.parentId[0]];
            });

            self.productCategories = productCategories;
        },
    },{
        model: 'res.currency',
        fields: ['label','symbol','position','rounding','rate'],
        ids:    function(self){ return [self.config.currencyId[0], self.company.currencyId[0]]; },
        loaded: function(self, currencies){
            self.currency = currencies[0];
            if (self.currency.rounding > 0 && self.currency.rounding < 1) {
                self.currency.decimals = Math.ceil(Math.log(1.0 / self.currency.rounding) / Math.log(10));
            } else {
                self.currency.decimals = 0;
            }

            self.companyCurrency = currencies[1];
        },
    },{
        model:  'pos.category',
        fields: ['id', 'label', 'parentId', 'childId', 'updatedAt'],
        domain: function(self) {
            return self.config.limitCategories && self.config.ifaceAvailableCategIds.length ? [['id', 'in', self.config.ifaceAvailableCategIds]] : [];
        },
        loaded: function(self, categories){
            self.db.addCategories(categories);
        },
    },{
        model:  'product.product',
        label: 'loadProducts',
        condition: function (self) { return !self.config.limitedProductsLoading; },
        fields: ['displayName', 'lstPrice', 'standardPrice', 'categId', 'posCategId', 'taxesId',
                 'barcode', 'defaultCode', 'toWeight', 'uomId', 'descriptionSale', 'description',
                 'productTemplateId','tracking', 'updatedAt', 'availableInPos', 'attributeLineIds', 'active'],
        order:  _.map(['sequence','defaultCode','label'], function (name) { return {name: name}; }),
        domain: function(self){
            var domain = ['&', '&', ['saleOk','=',true],['availableInPos','=',true],'|',['companyId','=',self.config.companyId[0]],['companyId','=',false]];
            if (self.config.limitCategories &&  self.config.ifaceAvailableCategIds.length) {
                domain.unshift('&');
                domain.push(['posCategId', 'in', self.config.ifaceAvailableCategIds]);
            }
            if (self.config.ifaceTipproduct){
              domain.unshift(['id', '=', self.config.tipProductId[0]]);
              domain.unshift('|');
            }

            return domain;
        },
        context: function(self){ return { displayDefaultCode: false }; },
        loaded: function(self, products){
            var usingCompanyCurrency = self.config.currencyId[0] === self.company.currencyId[0];
            var conversionRate = self.currency.rate / self.companyCurrency.rate;
            self.db.addProducts(_.map(products, function (product) {
                if (!usingCompanyCurrency) {
                    product.lstPrice = roundPr(product.lstPrice * conversionRate, self.currency.rounding);
                }
                product.categ = _.findWhere(self.productCategories, {'id': product.categId[0]});
                product.pos = self;
                return new exports.Product({}, product);
            }));
        },
    },{
        model: 'product.packaging',
        fields: ['label', 'barcode', 'productId', 'qty'],
        domain: function(self){return [['barcode', '!=', '']]; },
        loaded: function(self, productPackagings) {
            self.db.addPackagings(productPackagings);
        }
    },{
        model: 'product.attribute',
        fields: ['label', 'displayType'],
        condition: function (self) { return self.config.productConfigurator; },
        domain: function(){ return [['createVariant', '=', 'noVariant']]; },
        loaded: function(self, productAttributes, tmp) {
            tmp.productAttributesById = {};
            _.map(productAttributes, function (productAttribute) {
                tmp.productAttributesById[productAttribute.id] = productAttribute;
            });
        }
    },{
        model: 'product.attribute.value',
        fields: ['label', 'attributeId', 'isCustom', 'htmlColor'],
        condition: function (self) { return self.config.productConfigurator; },
        domain: function(self, tmp){ return [['attributeId', 'in', _.keys(tmp.productAttributesById).map(parseFloat)]]; },
        loaded: function(self, pavs, tmp) {
            tmp.pavById = {};
            _.map(pavs, function (pav) {
                tmp.pavById[pav.id] = pav;
            });
        }
    }, {
        model: 'product.template.attribute.value',
        fields: ['productAttributeValueId', 'attributeId', 'attributeLineId', 'priceExtra'],
        condition: function (self) { return self.config.productConfigurator; },
        domain: function(self, tmp){ return [['attributeId', 'in', _.keys(tmp.productAttributesById).map(parseFloat)]]; },
        loaded: function(self, ptavs, tmp) {
            self.attributesByPtalId = {};
            _.map(ptavs, function (ptav) {
                if (!self.attributesByPtalId[ptav.attributeLineId[0]]){
                    self.attributesByPtalId[ptav.attributeLineId[0]] = {
                        id: ptav.attributeLineId[0],
                        name: tmp.productAttributesById[ptav.attributeId[0]].label,
                        displayType: tmp.productAttributesById[ptav.attributeId[0]].displayType,
                        values: [],
                    };
                }
                self.attributesByPtalId[ptav.attributeLineId[0]].values.push({
                    id: ptav.productAttributeValueId[0],
                    name: tmp.pavById[ptav.productAttributeValueId[0]].label,
                    isCustom: tmp.pavById[ptav.productAttributeValueId[0]].isCustom,
                    htmlColor: tmp.pavById[ptav.productAttributeValueId[0]].htmlColor,
                    priceExtra: ptav.priceExtra,
                });
            });
        }
    },{
        model: 'account.cash.rounding',
        fields: ['label', 'rounding', 'roundingMethod'],
        domain: function(self){return [['id', '=', self.config.roundingMethod[0]]]; },
        loaded: function(self, cashRounding) {
            self.cashRounding = cashRounding;
        }
    },{
        model:  'pos.payment.method',
        fields: ['label', 'isCashCount', 'usePaymentTerminal', 'splitTransactions', 'type'],
        domain: function(self){return ['|',['active', '=', false], ['active', '=', true]]; },
        loaded: function(self, paymentMethods) {
            self.paymentMethods = paymentMethods.sort(function(a,b){
                // prefer cash paymentMethod to be first in the list
                if (a.isCashCount && !b.isCashCount) {
                    return -1;
                } else if (!a.isCashCount && b.isCashCount) {
                    return 1;
                } else {
                    return a.id - b.id;
                }
            });
            self.paymentMethodsById = {};
            _.each(self.paymentMethods, function(paymentMethod) {
                self.paymentMethodsById[paymentMethod.id] = paymentMethod;

                var PaymentInterface = self.electronicPaymentInterfaces[paymentMethod.usePaymentTerminal];
                if (PaymentInterface) {
                    paymentMethod.paymentTerminal = new PaymentInterface(self, paymentMethod);
                }
            });
        }
    },{
        model:  'account.fiscal.position',
        fields: [],
        domain: function(self){ return [['id','in',self.config.fiscalPositionIds]]; },
        loaded: function(self, fiscalPositions){
            self.fiscalPositions = fiscalPositions;
        }
    }, {
        model:  'account.fiscal.position.tax',
        fields: [],
        domain: function(self){
            var fiscalPositionTaxIds = [];

            self.fiscalPositions.forEach(function (fiscalPosition) {
                fiscalPosition.taxIds.forEach(function (taxId) {
                    fiscalPositionTaxIds.push(taxId);
                });
            });

            return [['id','in',fiscalPositionTaxIds]];
        },
        loaded: function(self, fiscalPositionTaxes){
            self.fiscalPositionTaxes = fiscalPositionTaxes;
            self.fiscalPositions.forEach(function (fiscalPosition) {
                fiscalPosition.fiscalPositionTaxesById = {};
                fiscalPosition.taxIds.forEach(function (taxId) {
                    var fiscalPositionTax = _.find(fiscalPositionTaxes, function (fiscalPositionTax) {
                        return fiscalPositionTax.id === taxId;
                    });

                    fiscalPosition.fiscalPositionTaxesById[fiscalPositionTax.id] = fiscalPositionTax;
                });
            });
        }
    },  {
        label: 'fonts',
        loaded: function(){
            return new Promise(function (resolve, reject) {
                // Waiting for fonts to be loaded to prevent receipt printing
                // from printing empty receipt while loading Inconsolata
                // ( The font used for the receipt )
                waitForWebfonts(['Lato','Inconsolata'], function () {
                    resolve();
                });
                // The JS used to detect font loading is not 100% robust, so
                // do not wait more than 5sec
                setTimeout(resolve, 5000);
            });
        },
    },{
        label: 'pictures',
        loaded: function (self) {
            self.companyLogo = new Image();
            return new Promise(function (resolve, reject) {
                self.companyLogo.onload = function () {
                    var img = self.companyLogo;
                    var ratio = 1;
                    var targetwidth = 300;
                    var maxheight = 150;
                    if( img.width !== targetwidth ){
                        ratio = targetwidth / img.width;
                    }
                    if( img.height * ratio > maxheight ){
                        ratio = maxheight / img.height;
                    }
                    var width  = Math.floor(img.width * ratio);
                    var height = Math.floor(img.height * ratio);
                    var c = document.createElement('canvas');
                    c.width  = width;
                    c.height = height;
                    var ctx = c.getContext('2d');
                    ctx.drawImage(self.companyLogo,0,0, width, height);

                    self.companyLogoBase64 = c.toDataURL();
                    resolve();
                };
                self.companyLogo.onerror = function () {
                    reject();
                };
                self.companyLogo.crossOrigin = "anonymous";
                self.companyLogo.src = `/web/image?model=res.company&id=${self.company.id}&field=logo`;
            });
        },
    }, {
        label: 'barcodes',
        loaded: function(self) {
            var barcodeParser = new BarcodeParser({'nomenclatureId': self.config.barcodeNomenclatureId});
            self.barcodeReader.setBarcodeParser(barcodeParser);
            return barcodeParser.isLoaded();
        },
    },
    ],

    // loads all the needed data on the sever. returns a promise indicating when all the data has loaded.
    loadServerData: function(){
        var self = this;
        var progress = 0;
        var progressStep = 1.0 / self.models.length;
        var tmp = {}; // this is used to share a temporary state between models loaders

        var loaded = new Promise(function (resolve, reject) {
            async function loadModel(index) {
                if (index >= self.models.length) {
                    resolve();
                } else {
                    var model = self.models[index];
                    self.setLoadingMessage(_t('Loading')+' '+(model.label || model.model || ''), progress);

                    var cond = typeof model.condition === 'function'  ? model.condition(self,tmp) : true;
                    if (!cond) {
                        loadModel(index+1);
                        return;
                    }

                    var fields =  typeof model.fields === 'function'  ? model.fields(self,tmp)  : model.fields;
                    var domain =  typeof model.domain === 'function'  ? await model.domain(self,tmp)  : model.domain;
                    var context = typeof model.context === 'function' ? model.context(self,tmp) : model.context || {};
                    var ids     = typeof model.ids === 'function'     ? model.ids(self,tmp) : model.ids;
                    var order   = typeof model.order === 'function'   ? model.order(self,tmp):    model.order;
                    progress += progressStep;

                    if(model.model ){
                        var params = {
                            model: model.model,
                            context: _.extend(context, self.session.userContext || {}),
                        };

                        if (model.ids) {
                            params.method = 'read';
                            params.args = [ids, fields];
                        } else {
                            params.method = 'searchRead';
                            params.domain = domain;
                            params.fields = fields;
                            params.orderBy = order;
                        }

                        self.rpc(params).then(function (result) {
                            try { // catching exceptions in model.loaded(...)
                                Promise.resolve(model.loaded(self, result, tmp))
                                    .then(function () { loadModel(index + 1); },
                                        function (err) { reject(err); });
                            } catch (err) {
                                console.error(err.message, err.stack);
                                reject(err);
                            }
                        }, function (err) {
                            reject(err);
                        });
                    } else if (model.loaded) {
                        try { // catching exceptions in model.loaded(...)
                            Promise.resolve(model.loaded(self, tmp))
                                .then(function () { loadModel(index +1); },
                                    function (err) { reject(err); });
                        } catch (err) {
                            reject(err);
                        }
                    } else {
                        loadModel(index + 1);
                    }
                }
            }

            try {
                return loadModel(0);
            } catch (err) {
                return Promise.reject(err);
            }
        });

        return loaded;
    },

    prepareNewPartnersDomain: function(){
        return [['updatedAt','>', this.db.getPartnerUpdatedAt()]];
    },

    // reload the list of partner, returns as a promise that resolves if there were
    // updated partners, and fails if not
    loadNewPartners: function(){
        var self = this;
        return new Promise(function (resolve, reject) {
            var fields = _.find(self.models, function(model){ return model.label === 'loadPartners'; }).fields;
            var domain = self.prepareNewPartnersDomain();
            self.rpc({
                model: 'res.partner',
                method: 'searchRead',
                args: [domain, fields],
            }, {
                timeout: 3000,
                shadow: true,
            })
            .then(function (partners) {
                if (self.db.addPartners(partners)) {   // check if the partners we got were real updates
                    resolve();
                } else {
                    reject(new Error('Failed in updating partners.'));
                }
            }, function (type, err) { reject(); });
        });
    },

    // this is called when an order is removed from the order collection. It ensures that there is always an existing
    // order and a valid selected order
    onRemovedOrder: function(removedOrder,index,reason){
        var orderList = this.getOrderList();
        if( (reason === 'abandon' || removedOrder.temporary) && orderList.length > 0){
            // when we intentionally remove an unfinished order, and there is another existing one
            this.setOrder(orderList[index] || orderList[orderList.length - 1], { silent: true });
        }else{
            // when the order was automatically removed after completion,
            // or when we intentionally delete the only concurrent order
            this.addNewOrder({ silent: true });
        }
        // Remove the link between the refund orderlines when deleting an order
        // that contains a refund.
        for (const line of removedOrder.getOrderlines()) {
            if (line.refundedOrderlineId) {
                delete this.toRefundLines[line.refundedOrderlineId];
            }
        }
    },

    // returns the user who is currently the cashier for this point of sale
    getCashier: function(){
        // reset the cashier to the current user if session is new
        if (this.db.load('posSessionId') !== this.posSession.id) {
            this.setCashier(this.employee);
        }
        return this.db.getCashier() || this.get('cashier') || this.employee;
    },
    // changes the current cashier
    setCashier: function(employee){
        this.set('cashier', employee);
        this.db.setCashier(this.get('cashier'));
    },
    // creates a new empty order and sets it as the current order
    addNewOrder: function(options){
        var order = new exports.Order({},{pos:this});
        this.get('orders').add(order);
        this.set('selectedOrder', order, options);
        return order;
    },
    /**
     * Load the locally saved unpaid orders for this PoS Config.
     *
     * First load all orders belonging to the current session.
     * Second load all orders belonging to the same config but from other sessions,
     * Only if tho order has orderlines.
     */
    loadOrders: async function(){
        var jsons = this.db.getUnpaidOrders();
        await this._loadMissingProducts(jsons);
        await this._loadMissingPartners(jsons);
        var orders = [];

        for (var i = 0; i < jsons.length; i++) {
            var json = jsons[i];
            if (json.posSessionId === this.posSession.id) {
                orders.push(new exports.Order({},{
                    pos:  this,
                    json: json,
                }));
            }
        }
        for (var i = 0; i < jsons.length; i++) {
            var json = jsons[i];
            if (json.posSessionId !== this.posSession.id && (json.lines.length > 0 || json.statementIds.length > 0)) {
                orders.push(new exports.Order({},{
                    pos:  this,
                    json: json,
                }));
            } else if (json.posSessionId !== this.posSession.id) {
                this.db.removeUnpaidOrder(jsons[i]);
            }
        }

        orders = orders.sort(function(a,b){
            return a.sequenceNumber - b.sequenceNumber;
        });

        if (orders.length) {
            this.get('orders').add(orders);
        }
    },
    async _loadMissingProducts(orders) {
        const missingProductIds = new Set([]);
        for (const order of orders) {
            for (const line of order.lines) {
                const productId = line[2].productId;
                if (missingProductIds.has(productId)) continue;
                if (!this.db.getProductById(productId)) {
                    missingProductIds.add(productId);
                }
            }
        }
        const productModel = _.find(this.models, function(model){return model.model === 'product.product';});
        const fields = productModel.fields;
        const products = await this.rpc({
            model: 'product.product',
            method: 'read',
            args: [[...missingProductIds], fields],
            context: Object.assign(this.session.userContext, { display_defaultCode: false }),
        });
        productModel.loaded(this, products);
    },

    // load the partners based on the ids
    async _loadPartners(partnerIds) {
        if (partnerIds.length > 0) {
            var fields = _.find(this.models, function(model){ return model.label === 'loadPartners'; }).fields;
            var domain = [['id','in', partnerIds]];
            const fetchedPartners = await this.env.services.rpc({
                model: 'res.partner',
                method: 'searchRead',
                args: [domain, fields],
            }, {
                timeout: 3000,
                shadow: true,
            });
            this.env.pos.db.addPartners(fetchedPartners);
        }
    },
    async _loadMissingPartners(orders) {
        const missingPartnerIds = new Set([]);
        for (const order of orders) {
            const partnerId = order.partnerId;
            if(missingPartnerIds.has(partnerId)) continue;
            if (partnerId && !this.db.getPartnerById(partnerId)) {
                missingPartnerIds.add(partnerId);
            }
        }
        await this._loadPartners([...missingPartnerIds]);
    },
    // Load the products following specific rules into the `db`
    loadLimitedProducts: async function() {
        let productModel = _.find(this.models, (model) => model.model === 'product.product');
        const products = await this.rpc({
            model: 'pos.config',
            method: 'getLimitedProductsLoading',
            args: [this.configId, productModel.fields],
            context: { ...this.session.userContext, ...productModel.context() },
        });
        productModel.loaded(this, products);
        return products.length
    },
    loadProductsBackground: async function() {
        let page = 0;
        let productModel = _.find(this.models, (model) => model.model === 'product.product');
        let products = [];
        do {
            products = await this.rpc({
                model: 'product.product',
                method: 'searchRead',
                kwargs: {
                    'domain': productModel.domain(this),
                    'fields': productModel.fields,
                    'offset': page * this.env.pos.config.limitedProductsAmount,
                    'limit': this.env.pos.config.limitedProductsAmount
                },
                context: { ...this.session.userContext, ...productModel.context() },
            }, { shadow: true });
            productModel.loaded(this, products);
            page += 1;
        } while(products.length == this.config.limitedProductsAmount);
    },
    loadPartnersBackground: async function() {
        let i = 1;
        let PartnerIds = [];
        var fields = _.find(this.env.pos.models, function(model){ return model.label === 'loadPartners'; }).fields;
        do {
            PartnerIds = await this.rpc({
                model: 'res.partner',
                method: 'searchRead',
                args: [[], fields],
                kwargs: {
                    limit: this.env.pos.config.limitedPartnersAmount,
                    offset: this.env.pos.config.limitedPartnersAmount * i
                },
                context: this.env.session.userContext,
            }, { shadow: true });
            this.env.pos.db.addPartners(PartnerIds);
            i += 1;
        } while(PartnerIds.length);
    },
    async getProductInfo(product, quantity) {
        const order = this.getOrder();
        try {
            // check back-end method `getProductInfoPos` to see what it returns
            // We do this so it's easier to override the value returned and use it in the component template later
            const productInfo = await this.env.services.rpc({
                model: 'product.product',
                method: 'getProductInfoPos',
                args: [[product.id],
                    product.getPrice(order.pricelist, quantity),
                    quantity,
                    this.config.id],
                kwargs: {context: this.env.session.userContext},
            });

            const priceWithoutTax = productInfo['allPrices']['priceWithoutTax'];
            const margin = priceWithoutTax - product.standardPrice;
            const orderPriceWithoutTax = order.getTotalWithoutTax();
            const orderCost = order.getTotalCost();
            const orderMargin = orderPriceWithoutTax - orderCost;

            const costCurrency = this.formatCurrency(product.standardPrice);
            const marginCurrency = this.formatCurrency(margin);
            const marginPercent = priceWithoutTax ? Math.round(margin/priceWithoutTax * 10000) / 100 : 0;
            const orderPriceWithoutTaxCurrency = this.formatCurrency(orderPriceWithoutTax);
            const orderCostCurrency = this.formatCurrency(orderCost);
            const orderMarginCurrency = this.formatCurrency(orderMargin);
            const orderMarginPercent = orderPriceWithoutTax ? Math.round(orderMargin/orderPriceWithoutTax * 10000) / 100 : 0;
            return {
            costCurrency, marginCurrency, marginPercent, orderPriceWithoutTaxCurrency,
            orderCostCurrency, orderMarginCurrency, orderMarginPercent,productInfo
            }
        } catch (error) {
            return { error }
        }
    },
    async getClosePosInfo() {
        try {
            const closingData = await this.env.services.rpc({
                model: 'pos.session',
                method: 'getClosingControlData',
                args: [[this.posSession.id]]
            });
            const ordersDetails = closingData.ordersDetails;
            const paymentsAmount = closingData.paymentsAmount;
            const payLaterAmount = closingData.payLaterAmount;
            const openingNotes = closingData.openingNotes;
            const defaultCashDetails = closingData.defaultCashDetails;
            const otherPaymentMethods = closingData.otherPaymentMethods;
            const isManager = closingData.isManager;
            const amountAuthorizedDiff = closingData.amountAuthorizedDiff;
            const cashControl = this.config.cashControl;

            // component state and refs definition
            const state = {notes: '', acceptClosing: false, payments: {}};
            if (cashControl) {
                state.payments[defaultCashDetails.id] = {counted: 0, difference: -defaultCashDetails.amount, number: 0};
            }
            if (otherPaymentMethods.length > 0) {
                otherPaymentMethods.forEach(pm => {
                    if (pm.type === 'bank') {
                        state.payments[pm.id] = {counted: this.roundDecimalsCurrency(pm.amount), difference: 0, number: pm.number}
                    }
                })
            }
            return {
            ordersDetails, paymentsAmount, payLaterAmount, openingNotes, defaultCashDetails, otherPaymentMethods,
            isManager, amountAuthorizedDiff, state, cashControl
            }
        } catch (error) {
            return { error }
        }
    },
    setStartOrder: function(){
        var orders = this.get('orders').models;

        if (orders.length && !this.get('selectedOrder')) {
            this.set('selectedOrder',orders[0]);
        } else {
            this.addNewOrder();
        }
    },

    // return the current order
    getOrder: function(){
        return this.get('selectedOrder');
    },

    getClient: function() {
        var order = this.getOrder();
        if (order) {
            return order.getClient();
        }
        return null;
    },

    // change the current order
    setOrder: function(order, options){
        this.set({ selectedOrder: order }, options);
    },

    // return the list of unpaid orders
    getOrderList: function(){
        return this.get('orders').models;
    },

    //removes the current order
    deleteCurrentOrder: function(){
        var order = this.getOrder();
        if (order) {
            order.destroy({'reason':'abandon'});
        }
    },
    computePriceAfterFp: function(price, taxes){
        const order = this.getOrder();
        if(order && order.fiscalPosition) {
            let mappedIncludedTaxes = [];
            let newIncludedTaxes = [];
            const self = this;
            _(taxes).each(function(tax) {
                const lineTaxes = self._mapTaxFiscalPosition(tax, order);
                if (lineTaxes.length && lineTaxes[0].priceInclude){
                    newIncludedTaxes = newIncludedTaxes.concat(lineTaxes);
                }
                if(tax.priceInclude && !_.contains(lineTaxes, tax)){
                    mappedIncludedTaxes.push(tax);
                }
            });

            if (mappedIncludedTaxes.length > 0) {
                if (newIncludedTaxes.length > 0) {
                    const priceWithoutTaxes = this.computeAll(mappedIncludedTaxes, price, 1, this.currency.rounding, true).totalExcluded
                    return this.computeAll(newIncludedTaxes, priceWithoutTaxes, 1, this.currency.rounding, false).totalIncluded
                }
                else{
                    return this.computeAll(mappedIncludedTaxes, price, 1, this.currency.rounding, true).totalExcluded;
                }
            }
        }
        return price;
    },
    getTaxesByIds: function(taxIds) {
        let taxes = [];
        for (let i = 0; i < taxIds.length; i++) {
            if (this.taxesById[taxIds[i]]) {
                taxes.push(this.taxesById[taxIds[i]]);
            }
        }
        return taxes;
    },
    _convertProductImgToBase64: function (product, url) {
        return new Promise(function (resolve, reject) {
            var img = new Image();

            img.onload = function () {
                var canvas = document.createElement('CANVAS');
                var ctx = canvas.getContext('2d');

                canvas.height = this.height;
                canvas.width = this.width;
                ctx.drawImage(this,0,0);

                var dataURL = canvas.toDataURL('image/jpeg');
                product.imageBase64 = dataURL;
                canvas = null;

                resolve();
            };
            img.crossOrigin = 'use-credentials';
            img.src = url;
        });
    },

    sendCurrentOrderToCustomerFacingDisplay: function() {
        var self = this;
        this.renderHtmlForCustomerFacingDisplay().then(function (renderedHtml) {
            if (self.env.pos.customerDisplay) {
                var $renderedHtml = $('<div>').html(renderedHtml);
                $(self.env.pos.customerDisplay.document.body).html($renderedHtml.find('.pos-customer-facing-display'));
                var orderlines = $(self.env.pos.customerDisplay.document.body).find('.pos-orderlines-list');
                orderlines.scrollTop(orderlines.prop("scrollHeight"));
            } else if (self.env.pos.proxy.posboxSupportsDisplay) {
                self.proxy.updateCustomerFacingDisplay(renderedHtml);
            }
        });
    },

    /**
     * @returns {Promise<string>}
     */
    renderHtmlForCustomerFacingDisplay: function () {
        var self = this;
        var order = this.getOrder();

        // If we're using an external device like the IoT Box, we
        // cannot get /web/image?model=product.product because the
        // IoT Box is not logged in and thus doesn't have the access
        // rights to access product.product. So instead we'll base64
        // encode it and embed it in the HTML.
        var getImagePromises = [];

        if (order) {
            order.getOrderlines().forEach(function (orderline) {
                var product = orderline.product;
                var imageUrl = `/web/image?model=product.product&field=image128&id=${product.id}&updatedAt=${product.updatedAt}&unique=1`;

                // only download and convert image if we haven't done it before
                if (! product.imageBase64) {
                    getImagePromises.push(self._convertProductImgToBase64(product, imageUrl));
                }
            });
        }

        return Promise.all(getImagePromises).then(function () {
            return QWeb.render('CustomerFacingDisplayOrder', {
                pos: self.env.pos,
                origin: window.location.origin,
                order: order,
            });
        });
    },

    // saves the order locally and try to send it to the backend.
    // it returns a promise that succeeds after having tried to send the order and all the other pending orders.
    pushOrders: function (order, opts) {
        opts = opts || {};
        var self = this;

        if (order) {
            this.db.addOrder(order.exportAsJSON());
        }

        return new Promise((resolve, reject) => {
            self.flushMutex.exec(async () => {
                try {
                    resolve(await self._flushOrders(self.db.getOrders(), opts));
                } catch (error) {
                    reject(error);
                }
            });
        });
    },

    pushSingleOrder: function (order, opts) {
        opts = opts || {};
        const self = this;
        const orderId = self.db.addOrder(order.exportAsJSON());

        return new Promise((resolve, reject) => {
            self.flushMutex.exec(async () => {
                const order = self.db.getOrder(orderId);
                try {
                    resolve(await self._flushOrders([order], opts));
                } catch (error) {
                    reject(error);
                }
            });
        });
    },

    // saves the order locally and try to send it to the backend and make an invoice
    // returns a promise that succeeds when the order has been posted and successfully generated
    // an invoice. This method can fail in various ways:
    // error-no-client: the order must have an associated partnerId. You can retry to make an invoice once
    //     this error is solved
    // error-transfer: there was a connection error during the transfer. You can retry to make the invoice once
    //     the network connection is up

    pushAndInvoiceOrder: function (order) {
        var self = this;
        return new Promise((resolve, reject) => {
            if (!order.getClient()) {
                reject({ code: 400, message: 'Missing Customer', data: {} });
            } else {
                var orderId = self.db.addOrder(order.exportAsJSON());
                self.flushMutex.exec(async () => {
                    try {
                        const serverIds = await self._flushOrders([self.db.getOrder(orderId)], {
                            timeout: 30000,
                            toInvoice: true,
                        });
                        if (serverIds.length) {
                            const [orderWithInvoice] = await self.rpc({
                                method: 'read',
                                model: 'pos.order',
                                args: [serverIds, ['accountMove']],
                                kwargs: { load: false },
                            });
                            await self
                                .doAction('account.accountInvoices', {
                                    additionalContext: {
                                        activeIds: [orderWithInvoice.accountMove],
                                    },
                                })
                                .catch(() => {
                                    reject({ code: 401, message: 'Backend Invoice', data: { order: order } });
                                });
                        } else {
                            reject({ code: 401, message: 'Backend Invoice', data: { order: order } });
                        }
                        resolve(serverIds);
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        });
    },

    // wrapper around the _saveToServer that updates the synch status widget
    // Resolves to the backend ids of the synced orders.
    _flushOrders: function(orders, options) {
        var self = this;
        this.setSynch('connecting', orders.length);

        return this._saveToServer(orders, options).then(function (serverIds) {
            self.setSynch('connected');
            for (let i = 0; i < serverIds.length; i++) {
                self.validatedOrdersNameServerIdMap[serverIds[i].posReference] = serverIds[i].id;
            }
            return _.pluck(serverIds, 'id');
        }).catch(function(error) {
            if (self._isRPCError(error)) {
                if (orders.length > 1) {
                    return self._flushOrdersRetry(orders, options);
                } else {
                    self.setSynch('error');
                    throw error;
                }
            } else {
                self.setSynch('disconnected');
                throw error;
            }
        }).finally(function() {
            self._afterFlushOrders(orders);
        });
    },
    // Attempts to send the orders to the server one by one if an RPC error is encountered.
    _flushOrdersRetry: async function(orders, options) {

        let successfulOrders = 0;
        let lastError;
        let serverIds = [];

        for (let order of orders) {
            try {
                let serverIds = await this._saveToServer([order], options);
                successfulOrders++;
                this.validatedOrdersNameServerIdMap[serverIds[0].posReference] = serverIds[0].id;
                serverIds.push(serverIds[0].id);
            } catch (err) {
                lastError = err;
            }
        }

        if (successfulOrders === orders.length) {
            this.setSynch('connected');
            return serverIds;
        }
        if (this._isRPCError(lastError)) {
            this.setSynch('error');
        } else {
            this.setSynch('disconnected');
        }
        throw lastError;
    },
    _isRPCError: function (error) {
        return error.message && error.message.name === 'RPC_ERROR';
    },
    /**
     * Hook method after _flushOrders resolved or rejected.
     * It aims to:
     *   - remove the refund orderlines from toRefundLines
     *   - invalidate cache of refunded synced orders
     */
    _afterFlushOrders: function(orders) {
        const refundedOrderIds = new Set();
        for (const order of orders) {
            for (const line of order.data.lines) {
                const refundDetail = this.toRefundLines[line[2].refundedOrderlineId];
                if (!refundDetail) continue;
                // Collect the backend id of the refunded orders.
                refundedOrderIds.add(refundDetail.orderline.orderBackendId);
                // Reset the refund detail for the orderline.
                delete this.toRefundLines[refundDetail.orderline.id];
            }
        }
        this._invalidateSyncedOrdersCache([...refundedOrderIds]);
    },
    _invalidateSyncedOrdersCache: function(ids) {
        for (const id of ids) {
            delete this.TICKET_SCREEN_STATE.syncedOrders.cache[id];
        }
    },
    setSynch: function(status, pending) {
        if (['connected', 'connecting', 'error', 'disconnected'].indexOf(status) === -1) {
            console.error(status, ' is not a known connection state.');
        }
        pending = pending || this.db.getOrders().length + this.db.getIdsToRemoveFromServer().length;
        this.set('synch', { status, pending });
    },

    // send an array of orders to the server
    // available options:
    // - timeout: timeout for the rpc call in ms
    // returns a promise that resolves with the list of
    // server generated ids for the sent orders
    _saveToServer: function (orders, options) {
        if (!orders || !orders.length) {
            return Promise.resolve([]);
        }

        options = options || {};

        var self = this;
        var timeout = typeof options.timeout === 'number' ? options.timeout : 30000 * orders.length;

        // Keep the order ids that are about to be sent to the
        // backend. In between createFromUi and the success callback
        // new orders may have been added to it.
        var orderIdsToSync = _.pluck(orders, 'id');

        // we try to send the order. shadow prevents a spinner if it takes too long. (unless we are sending an invoice,
        // then we want to notify the user that we are waiting on something )
        var args = [_.map(orders, function (order) {
                order.toInvoice = options.toInvoice || false;
                return order;
            })];
        args.push(options.draft || false);
        return this.rpc({
                model: 'pos.order',
                method: 'createFromUi',
                args: args,
                kwargs: {context: this.session.userContext},
            }, {
                timeout: timeout,
                shadow: !options.toInvoice
            })
            .then(function (serverIds) {
                _.each(orderIdsToSync, function (orderId) {
                    self.db.removeOrder(orderId);
                });
                self.set('failed',false);
                return serverIds;
            }).catch(function (error){
                console.warn('Failed to send orders:', orders);
                if(error.code === 200 ){    // Business Logic Error, not a connection problem
                    // Hide error if already shown before ...
                    if ((!self.get('failed') || options.showError) && !options.toInvoice) {
                        self.set('failed',error);
                        throw error;
                    }
                }
                throw error;
            });
    },

    /**
     * Remove orders with given ids from the database.
     * @param {array<number>} serverIds ids of the orders to be removed.
     * @param {dict} options.
     * @param {number} options.timeout optional timeout parameter for the rpc call.
     * @return {Promise<array<number>>} returns a promise of the ids successfully removed.
     */
    _removeFromServer: function (serverIds, options) {
        options = options || {};
        if (!serverIds || !serverIds.length) {
            return Promise.resolve([]);
        }

        var self = this;
        var timeout = typeof options.timeout === 'number' ? options.timeout : 7500 * serverIds.length;

        return this.rpc({
                model: 'pos.order',
                method: 'removeFromUi',
                args: [serverIds],
                kwargs: {context: this.session.userContext},
            }, {
                timeout: timeout,
                shadow: true,
            })
            .then(function (data) {
                return self._postRemoveFromServer(serverIds, data)
            }).catch(function (reason){
                var error = reason.message;
                if(error.code === 200 ){    // Business Logic Error, not a connection problem
                    //if warning do not need to display traceback!!
                    if (error.data.exceptionType == 'warning') {
                        delete error.data.debug;
                    }
                }
                // important to throw error here and let the rendering component handle the
                // error
                console.warn('Failed to remove orders:', serverIds);
                throw error;
            });
    },

    // to override
    _postRemoveFromServer(serverIds, data) {
        this.db.setIdsRemovedFromServer(serverIds);
        return serverIds;
    },

    // Exports the paid orders (the ones waiting for internet connection)
    exportPaidOrders: function() {
        return JSON.stringify({
            'paidOrders':   this.db.getOrders(),
            'session':      this.posSession.label,
            'sessionId':    this.posSession.id,
            'date':         (new Date()).toUTCString(),
            'version':      this.version.serverVersionInfo,
        },null,2);
    },

    // Exports the unpaid orders (the tabs)
    exportUnpaidOrders: function() {
        return JSON.stringify({
            'unpaidOrders':  this.db.getUnpaidOrders(),
            'session':       this.posSession.label,
            'sessionId':     this.posSession.id,
            'date':          (new Date()).toUTCString(),
            'version':       this.version.serverVersionInfo,
        },null,2);
    },

    // This imports paid or unpaid orders from a json file whose
    // contents are provided as the string str.
    // It returns a report of what could and what could not be
    // imported.
    importOrders: function(str) {
        var json = JSON.parse(str);
        var report = {
            // Number of paid orders that were imported
            paid: 0,
            // Number of unpaid orders that were imported
            unpaid: 0,
            // Orders that were not imported because they already exist (uid conflict)
            unpaidSkippedExisting: 0,
            // Orders that were not imported because they belong to another session
            unpaidSkippedSession:  0,
            // The list of session ids to which skipped orders belong.
            unpaidSkippedSessions: [],
        };

        if (json.paidOrders) {
            for (var i = 0; i < json.paidOrders.length; i++) {
                this.db.addOrder(json.paidOrders[i].data);
            }
            report.paid = json.paidOrders.length;
            this.pushOrders();
        }

        if (json.unpaidOrders) {

            var orders  = [];
            var existing = this.getOrderList();
            var existingUids = {};
            var skippedSessions = {};

            for (var i = 0; i < existing.length; i++) {
                existingUids[existing[i].uid] = true;
            }

            for (var i = 0; i < json.unpaidOrders.length; i++) {
                var order = json.unpaidOrders[i];
                if (order.posSessionId !== this.posSession.id) {
                    report.unpaidSkippedSession += 1;
                    skippedSessions[order.posSessionId] = true;
                } else if (existingUids[order.uid]) {
                    report.unpaidSkippedExisting += 1;
                } else {
                    orders.push(new exports.Order({},{
                        pos: this,
                        json: order,
                    }));
                }
            }

            orders = orders.sort(function(a,b){
                return a.sequenceNumber - b.sequenceNumber;
            });

            if (orders.length) {
                report.unpaid = orders.length;
                this.get('orders').add(orders);
            }

            report.unpaidSkippedSessions = _.keys(skippedSessions);
        }

        return report;
    },

    _loadOrders: function(){
        var jsons = this.db.getUnpaidOrders();
        var orders = [];
        var notLoadedCount = 0;

        for (var i = 0; i < jsons.length; i++) {
            var json = jsons[i];
            if (json.posSessionId === this.posSession.id) {
                orders.push(new exports.Order({},{
                    pos:  this,
                    json: json,
                }));
            } else {
                notLoadedCount += 1;
            }
        }

        if (notLoadedCount) {
            console.info('There are '+notLoadedCount+' locally saved unpaid orders belonging to another session');
        }

        orders = orders.sort(function(a,b){
            return a.sequenceNumber - b.sequenceNumber;
        });

        if (orders.length) {
            this.get('orders').add(orders);
        }
    },

    /**
     * Mirror JS method of:
     * _computeAmount in addons/account/models/account.js
     */
    _computeAll: function(tax, baseAmount, quantity, priceExclude) {
        if(priceExclude === undefined)
            var priceInclude = tax.priceInclude;
        else
            var priceInclude = !priceExclude;
        if (tax.amountType === 'fixed') {
            // Use sign on baseAmount and abs on quantity to take into account the sign of the base amount,
            // which includes the sign of the quantity and the sign of the priceUnit
            // Amount is the fixed price for the tax, it can be negative
            // Base amount included the sign of the quantity and the sign of the unit price and when
            // a product is returned, it can be done either by changing the sign of quantity or by changing the
            // sign of the price unit.
            // When the price unit is equal to 0, the sign of the quantity is absorbed in baseAmount then
            // a "else" case is needed.
            if (baseAmount)
                return Math.sign(baseAmount) * Math.abs(quantity) * tax.amount;
            else
                return quantity * tax.amount;
        }
        if (tax.amountType === 'percent' && !priceInclude){
            return baseAmount * tax.amount / 100;
        }
        if (tax.amountType === 'percent' && priceInclude){
            return baseAmount - (baseAmount / (1 + tax.amount / 100));
        }
        if (tax.amountType === 'division' && !priceInclude) {
            return baseAmount / (1 - tax.amount / 100) - baseAmount;
        }
        if (tax.amountType === 'division' && priceInclude) {
            return baseAmount - (baseAmount * (tax.amount / 100));
        }
        return false;
    },

    /**
     * Mirror JS method of:
     * computeAll in addons/account/models/account.js
     *
     * Read comments in the javascript side method for more details about each sub-methods.
     */
    computeAll: function(taxes, priceUnit, quantity, currencyRounding, handlePriceInclude=true) {
        var self = this;

        // 1) Flatten the taxes.

        var _collectTaxes = function(taxes, allTaxes){
            taxes.sort(function (tax1, tax2) {
                return tax1.sequence - tax2.sequence;
            });
            _(taxes).each(function(tax){
                if(tax.amountType === 'group')
                    allTaxes = _collectTaxes(tax.childrenTaxIds, allTaxes);
                else
                    allTaxes.push(tax);
            });
            return allTaxes;
        }
        var collectTaxes = function(taxes){
            return _collectTaxes(taxes, []);
        }

        taxes = collectTaxes(taxes);

        // 2) Deal with the rounding methods

        var roundTax = this.company.taxCalculationRoundingMethod != 'roundGlobally';

        var initialCurrencyRounding = currencyRounding;
        if(!roundTax)
            currencyRounding = currencyRounding * 0.00001;

        // 3) Iterate the taxes in the reversed sequence order to retrieve the initial base of the computation.
        var recomputeBase = function(baseAmount, fixedAmount, percentAmount, divisionAmount){
             return (baseAmount - fixedAmount) / (1.0 + percentAmount / 100.0) * (100 - divisionAmount) / 100;
        }

        var base = roundPr(priceUnit * quantity, initialCurrencyRounding);

        var sign = 1;
        if(base < 0){
            base = -base;
            sign = -1;
        }

        var totalIncludedCheckpoints = {};
        var i = taxes.length - 1;
        var storeIncludedTaxTotal = true;

        var inclFixedAmount = 0.0;
        var inclPercentAmount = 0.0;
        var inclDivisionAmount = 0.0;

        var cachedTaxAmounts = {};
        if (handlePriceInclude){
            _(taxes.reverse()).each(function(tax){
                if(tax.includeBaseAmount){
                    base = recomputeBase(base, inclFixedAmount, inclPercentAmount, inclDivisionAmount);
                    inclFixedAmount = 0.0;
                    inclPercentAmount = 0.0;
                    inclDivisionAmount = 0.0;
                    storeIncludedTaxTotal = true;
                }
                if(tax.priceInclude){
                    if(tax.amountType === 'percent')
                        inclPercentAmount += tax.amount;
                    else if(tax.amountType === 'division')
                        inclDivisionAmount += tax.amount;
                    else if(tax.amountType === 'fixed')
                        inclFixedAmount += Math.abs(quantity) * tax.amount
                    else{
                        var taxAmount = self._computeAll(tax, base, quantity);
                        inclFixedAmount += taxAmount;
                        cachedTaxAmounts[i] = taxAmount;
                    }
                    if(storeIncludedTaxTotal){
                        totalIncludedCheckpoints[i] = base;
                        storeIncludedTaxTotal = false;
                    }
                }
                i -= 1;
            });
        }

        var totalExcluded = roundPr(recomputeBase(base, inclFixedAmount, inclPercentAmount, inclDivisionAmount), initialCurrencyRounding);
        var totalIncluded = totalExcluded;

        // 4) Iterate the taxes in the sequence order to fill missing base/amount values.

        base = totalExcluded;

        var skipCheckpoint = false;

        var taxesVals = [];
        i = 0;
        var cumulatedTaxIncludedAmount = 0;
        _(taxes.reverse()).each(function(tax){
            if(tax.priceInclude || tax.isBaseAffected)
                var taxBaseAmount = base;
            else
                var taxBaseAmount = totalExcluded;

            if(!skipCheckpoint && tax.priceInclude && totalIncludedCheckpoints[i] !== undefined){
                var taxAmount = totalIncludedCheckpoints[i] - (base + cumulatedTaxIncludedAmount);
                cumulatedTaxIncludedAmount = 0;
            }else
                var taxAmount = self._computeAll(tax, taxBaseAmount, quantity, true);

            taxAmount = roundPr(taxAmount, currencyRounding);

            if(tax.priceInclude && totalIncludedCheckpoints[i] === undefined)
                cumulatedTaxIncludedAmount += taxAmount;

            taxesVals.push({
                'id': tax.id,
                'label': tax.label,
                'amount': sign * taxAmount,
                'base': sign * roundPr(taxBaseAmount, currencyRounding),
            });

            if(tax.includeBaseAmount){
                base += taxAmount;
                if(!tax.priceInclude)
                    skipCheckpoint = true;
            }

            totalIncluded += taxAmount;
            i += 1;
        });

        return {
            'taxes': taxesVals,
            'totalExcluded': sign * roundPr(totalExcluded, this.currency.rounding),
            'totalIncluded': sign * roundPr(totalIncluded, this.currency.rounding),
        }
    },

    _mapTaxFiscalPosition: function(tax, order = false) {
        var self = this;
        var currentOrder = order || this.getOrder();
        var orderFiscalPosition = currentOrder && currentOrder.fiscalPosition;
        var taxes = [];

        if (orderFiscalPosition) {
            var taxMappings = _.filter(orderFiscalPosition.fiscalPositionTaxesById, function (fiscalPositionTax) {
                return fiscalPositionTax.taxSrcId[0] === tax.id;
            });

            if (taxMappings && taxMappings.length) {
                _.each(taxMappings, function(tm) {
                    if (tm.taxDestId) {
                        var taxe = self.taxesById[tm.taxDestId[0]];
                        if (taxe) {
                            taxes.push(taxe);
                        }
                    }
                });
            } else{
                taxes.push(tax);
            }
        } else {
            taxes.push(tax);
        }

        return taxes;
    },

    getTaxesAfterFp: function(taxesIds, order = false){
        var self = this;
        var taxes =  this.taxes;
        var productTaxes = [];
        _(taxesIds).each(function(el){
            var tax = _.detect(taxes, function(t){
                return t.id === el;
            });
            productTaxes.push.apply(productTaxes, self._mapTaxFiscalPosition(tax, order));
        });
        productTaxes = _.uniq(productTaxes, function(tax) { return tax.id; });
        return productTaxes;
      },

    /**
     * Directly calls the requested service, instead of triggering a
     * 'callService' event up, which wouldn't work as services have no parent
     *
     * @param {VerpEvent} ev
     */
    _triggerUp: function (ev) {
        if (ev.isStopped()) {
            return;
        }
        const payload = ev.data;
        if (ev.name === 'callService') {
            let args = payload.args || [];
            if (payload.service === 'ajax' && payload.method === 'rpc') {
                // ajax service uses an extra 'target' argument for rpc
                args = args.concat(ev.target);
            }
            const service = this.env.services[payload.service];
            const result = service[payload.method].apply(service, args);
            payload.callback(result);
        }
    },

    electronicPaymentInterfaces: {},

    isProductQtyZero: function(qty) {
        return utils.floatIsZero(qty, this.env.pos.dp['Product Unit of Measure']);
    },

    formatProductQty: function(qty) {
        return fieldUtils.format.float(qty, { digits: [true, this.dp['Product Unit of Measure']] });
    },

    formatCurrency: function(amount, precision) {
        var currency =
            this && this.currency
                ? this.currency
                : { symbol: '$', position: 'after', rounding: 0.01, decimals: 2 };

        amount = this.formatCurrencyNoSymbol(amount, precision, currency);

        if (currency.position === 'after') {
            return amount + ' ' + (currency.symbol || '');
        } else {
            return (currency.symbol || '') + ' ' + amount;
        }
    },

    formatCurrencyNoSymbol: function(amount, precision, currency) {
        if (!currency) {
            currency =
                this && this.currency
                    ? this.currency
                    : { symbol: '$', position: 'after', rounding: 0.01, decimals: 2 };
        }
        var decimals = currency.decimals;

        if (precision && this.dp[precision] !== undefined) {
            decimals = this.dp[precision];
        }

        if (typeof amount === 'number') {
            amount = roundDi(amount, decimals).toFixed(decimals);
            amount = fieldUtils.format.float(roundDi(amount, decimals), {
                digits: [69, decimals],
            });
        }

        return amount;
    },

    formatPr: function(value, precision) {
        var decimals =
            precision > 0
                ? Math.max(0, Math.ceil(Math.log(1.0 / precision) / Math.log(10)))
                : 0;
        return value.toFixed(decimals);
    },

    roundDecimalsCurrency(value) {
        const decimals = this.currency.decimals;
        return parseFloat(roundDi(value, decimals).toFixed(decimals));
    },

    /**
     * (value = 1.0000, decimals = 2) => '1'
     * (value = 1.1234, decimals = 2) => '1.12'
     * @param {number} value amount to format
     */
    formatFixed: function(value) {
        const currency = this.currency || { decimals: 2 };
        return `${Number(value.toFixed(currency.decimals || 0))}`;
    },

    disallowLineQuantityChange() {
        return false;
    },

    getCurrencySymbol() {
        return this.currency ? this.currency.symbol : '$';
    },
    /**
     * Make the products corresponding to the given ids to be availableInPos and
     * fetch them to be added on the loaded products.
     */
    async _addProducts(ids, setAvailable=true){
        if(setAvailable){
            await this.rpc({
                model: 'product.product',
                method: 'write',
                args: [ids, {'availableInPos': true}],
                context: this.session.userContext,
            });
        }
        let productModel = _.find(this.models, (model) => model.model === 'product.product');
        let product = await this.rpc({
            model: 'product.product',
            method: 'read',
            args: [ids, productModel.fields],
            context: { ...this.session.userContext, ...productModel.context() },
        });
        productModel.loaded(this, product);
    },
    htmlToImgLetterRendering() {
        return false;
    },
    doNotAllowRefundAndSales() {
        return false;
    }
});

/**
 * Call this function to map your PaymentInterface implementation to
 * the usePaymentTerminal field. When the POS loads it will take
 * care of instantiating your interface and setting it on the right
 * payment methods.
 *
 * @param {string} usePaymentTerminal - value used in the
 * usePaymentTerminal selection field
 *
 * @param {Object} ImplementedPaymentInterface - implemented
 * PaymentInterface
 */
exports.registerPaymentMethod = function(usePaymentTerminal, ImplementedPaymentInterface) {
    exports.PosModel.prototype.electronicPaymentInterfaces[usePaymentTerminal] = ImplementedPaymentInterface;
};

// Add fields to the list of read fields when a model is loaded
// by the point of sale.
// e.g: module.loadFields("product.product",['price','category'])

exports.loadFields = function(modelName, fields) {
    if (!(fields instanceof Array)) {
        fields = [fields];
    }

    var models = exports.PosModel.prototype.models;
    for (var i = 0; i < models.length; i++) {
        var model = models[i];
        if (model.model === modelName) {
            // if 'fields' is empty all fields are loaded, so we do not need
            // to modify the array
            if ((model.fields instanceof Array) && model.fields.length > 0) {
                model.fields = model.fields.concat(fields || []);
            }
        }
    }
};

// Loads verp models at the point of sale startup.
// loadModels take an array of model loader declarations.
// - The models will be loaded in the array order.
// - If no verp model name is provided, no server data
//   will be loaded, but the system can be used to preprocess
//   data before load.
// - loader arguments can be functions that return a dynamic
//   value. The function takes the PosModel as the first argument
//   and a temporary object that is shared by all models, and can
//   be used to store transient information between model loads.
// - There is no dependency management. The models must be loaded
//   in the right order. Newly added models are loaded at the end
//   but the after / before options can be used to load directly
//   before / after another model.
//
// models: [{
//  model: [string] the name of the verp model to load.
//  label: [string] The label displayed during load.
//  fields: [[string]|function] the list of fields to be loaded.
//          Empty Array / Null loads all fields.
//  order:  [[string]|function] the models will be ordered by
//          the provided fields
//  domain: [domain|function] the domain that determines what
//          models need to be loaded. Null loads everything
//  ids:    [[id]|function] the id list of the models that must
//          be loaded. Overrides domain.
//  context: [Dict|function] the verp context for the model read
//  condition: [function] do not load the models if it evaluates to
//             false.
//  loaded: [function(self,model)] this function is called once the
//          models have been loaded, with the data as second argument
//          if the function returns a promise, the next model will
//          wait until it resolves before loading.
// }]
//
// options:
//   before: [string] The model will be loaded before the named models
//           (applies to both model name and label)
//   after:  [string] The model will be loaded after the (last loaded)
//           named model. (applies to both model name and label)
//
exports.loadModels = function(models,options) {
    options = options || {};
    if (!(models instanceof Array)) {
        models = [models];
    }

    var pmodels = exports.PosModel.prototype.models;
    var index = pmodels.length;
    if (options.before) {
        for (var i = 0; i < pmodels.length; i++) {
            if (    pmodels[i].model === options.before ||
                    pmodels[i].label === options.before ){
                index = i;
                break;
            }
        }
    } else if (options.after) {
        for (var i = 0; i < pmodels.length; i++) {
            if (    pmodels[i].model === options.after ||
                    pmodels[i].label === options.after ){
                index = i + 1;
            }
        }
    }
    pmodels.splice.apply(pmodels,[index,0].concat(models));
};

exports.Product = Backbone.Model.extend({
    initialize: function(attr, options){
        _.extend(this, options);
    },
    isAllowOnlyOneLot: function() {
        const productUnit = this.getUnit();
        return this.tracking === 'lot' || !productUnit || !productUnit.isPosGroupable;
    },
    getUnit: function() {
        var unitId = this.uomId;
        if(!unitId){
            return undefined;
        }
        unitId = unitId[0];
        if(!this.pos){
            return undefined;
        }
        return this.pos.unitsById[unitId];
    },
    // Port of getProductPrice on product.pricelist.
    //
    // Anything related to UOM can be ignored, the POS will always use
    // the default UOM set on the product and the user cannot change
    // it.
    //
    // Pricelist items do not have to be sorted. All
    // product.pricelist.item records are loaded with a searchRead
    // and were automatically sorted based on their _order by the
    // ORM. After that they are added in this order to the pricelists.
    getPrice: function(pricelist, quantity, priceExtra){
        var self = this;
        var date = moment();

        // In case of nested pricelists, it is necessary that all pricelists are made available in
        // the POS. Display a basic alert to the user in this case.
        if (pricelist === undefined) {
            alert(_t(
                'An error occurred when loading product prices. ' +
                'Make sure all pricelists are available in the POS.'
            ));
        }

        var categoryIds = [];
        var category = this.categ;
        while (category) {
            categoryIds.push(category.id);
            category = category.parent;
        }

        var pricelistItems = _.filter(pricelist.items, function (item) {
            return (! item.productTemplateId || item.productTemplateId[0] === self.productTemplateId) &&
                   (! item.productId || item.productId[0] === self.id) &&
                   (! item.categId || _.contains(categoryIds, item.categId[0])) &&
                   (! item.dateStart || moment.utc(item.dateStart).isSameOrBefore(date)) &&
                   (! item.dateEnd || moment.utc(item.dateEnd).isSameOrAfter(date));
        });

        var price = self.lstPrice;
        if (priceExtra){
            price += priceExtra;
        }
        _.find(pricelistItems, function (rule) {
            if (rule.minQuantity && quantity < rule.minQuantity) {
                return false;
            }

            if (rule.base === 'pricelist') {
                price = self.getPrice(rule.basePricelist, quantity);
            } else if (rule.base === 'standardPrice') {
                price = self.standardPrice;
            }

            if (rule.computePrice === 'fixed') {
                price = rule.fixedPrice;
                return true;
            } else if (rule.computePrice === 'percentage') {
                price = price - (price * (rule.percentPrice / 100));
                return true;
            } else {
                var priceLimit = price;
                price = price - (price * (rule.priceDiscount / 100));
                if (rule.priceRound) {
                    price = roundPr(price, rule.priceRound);
                }
                if (rule.priceSurcharge) {
                    price += rule.priceSurcharge;
                }
                if (rule.priceMinMargin) {
                    price = Math.max(price, priceLimit + rule.priceMinMargin);
                }
                if (rule.priceMaxMargin) {
                    price = Math.min(price, priceLimit + rule.priceMaxMargin);
                }
                return true;
            }

            return false;
        });

        // This return value has to be rounded with roundDi before
        // being used further. Note that this cannot happen here,
        // because it would cause inconsistencies with the backend for
        // pricelist that have base == 'pricelist'.
        return price;
    },
    getDisplayPrice: function(pricelist, quantity) {
        const taxes = this.pos.getTaxesAfterFp(this.taxesId);
        const currentTaxes = this.pos.getTaxesByIds(this.taxesId);
        const priceAfterFp = this.pos.computePriceAfterFp(this.getPrice(pricelist, quantity), currentTaxes);
        const allPrices = this.pos.computeAll(taxes, priceAfterFp, 1, this.pos.currency.rounding);
        if (this.pos.config.ifaceTaxIncluded === 'total') {
            return allPrices.totalIncluded;
        } else {
            return allPrices.totalExcluded;
        }
    },
});

var orderlineId = 1;

// An orderline represent one element of the content of a client's shopping cart.
// An orderline contains a product, its quantity, its price, discount. etc.
// An Order contains zero or more Orderlines.
exports.Orderline = Backbone.Model.extend({
    initialize: function(attr,options){
        this.pos   = options.pos;
        this.order = options.order;
        this.priceManuallySet = options.priceManuallySet || false;
        this.priceAutomaticallySet = options.priceAutomaticallySet || false;
        if (options.json) {
            try {
                this.initFromJSON(options.json);
            } catch(error) {
                console.error('ERROR: attempting to recover product ID', options.json.productId,
                    'not available in the point of sale. Correct the product or clean the browser cache.');
            }
            return;
        }
        this.product = options.product;
        this.taxIds = options.taxIds;
        this.setProductLot(this.product);
        this.setQuantity(1);
        this.discount = 0;
        this.discountStr = '0';
        this.selected = false;
        this.description = '';
        this.priceExtra = 0;
        this.fullProductName = options.description || '';
        this.id = orderlineId++;
        this.customerNote = this.customerNote || '';

        if (options.price) {
            this.setUnitPrice(options.price);
        } else {
            this.setUnitPrice(this.product.getPrice(this.order.pricelist, this.getQuantity()));
        }
    },
    initFromJSON: function(json) {
        this.product = this.pos.db.getProductById(json.productId);
        this.setProductLot(this.product);
        this.price = json.priceUnit;
        this.priceManuallySet = json.priceManuallySet;
        this.priceAutomaticallySet = json.priceAutomaticallySet;
        this.setDiscount(json.discount);
        this.setQuantity(json.qty, 'do not recompute unit price');
        this.setDescription(json.description);
        this.setPriceExtra(json.priceExtra);
        this.setFullProductName(json.fullProductName);
        this.id = json.id ? json.id : orderlineId++;
        orderlineId = Math.max(this.id+1,orderlineId);
        var packLotLines = json.packLotIds;
        for (var i = 0; i < packLotLines.length; i++) {
            var packlotline = packLotLines[i][2];
            var packLotLine = new exports.Packlotline({}, {'json': _.extend({...packlotline}, {'orderLine':this})});
            this.packLotLines.add(packLotLine);
        }
        this.taxIds = json.taxIds && json.taxIds.length !== 0 ? json.taxIds[0][2] : undefined;
        this.setCustomerNote(json.customerNote);
        this.refundedQty = json.refundedQty;
        this.refundedOrderlineId = json.refundedOrderlineId;
    },
    clone: function(){
        var orderline = new exports.Orderline({},{
            pos: this.pos,
            order: this.order,
            product: this.product,
            price: this.price,
        });
        orderline.order = null;
        orderline.quantity = this.quantity;
        orderline.quantityStr = this.quantityStr;
        orderline.discount = this.discount;
        orderline.price = this.price;
        orderline.selected = false;
        orderline.priceManuallySet = this.priceManuallySet;
        orderline.priceAutomaticallySet = this.priceAutomaticallySet;
        orderline.customerNote = this.customerNote;
        return orderline;
    },
    getPackLotLinesToEdit: function(isAllowOnlyOneLot) {
        const currentPackLotLines = this.packLotLines.models;
        let nExtraLines = Math.abs(this.quantity) - currentPackLotLines.length;
        nExtraLines = Math.ceil(nExtraLines);
        nExtraLines = nExtraLines > 0 ? nExtraLines : 1;
        const tempLines = currentPackLotLines
            .map(lotLine => ({
                id: lotLine.cid,
                text: lotLine.get('lotName'),
            }))
            .concat(
                Array.from(Array(nExtraLines)).map(_ => ({
                    text: '',
                }))
            );
        return isAllowOnlyOneLot ? [tempLines[0]] : tempLines;
    },
    /**
     * @param { modifiedPackLotLines, newPackLotLines }
     *    @param {Object} modifiedPackLotLines key-value pair of String (the cid) & String (the new lotName)
     *    @param {Array} newPackLotLines array of { lotName: String }
     */
    setPackLotLines: function({ modifiedPackLotLines, newPackLotLines }) {
        // Set the new values for modified lot lines.
        let lotLinesToRemove = [];
        for (let lotLine of this.packLotLines.models) {
            const modifiedLotName = modifiedPackLotLines[lotLine.cid];
            if (modifiedLotName) {
                lotLine.set({ lotName: modifiedLotName });
            } else {
                // We should not call lotLine.remove() here because
                // we don't want to mutate the array while looping thru it.
                lotLinesToRemove.push(lotLine);
            }
        }

        // Remove those that needed to be removed.
        for (let lotLine of lotLinesToRemove) {
            lotLine.remove();
        }

        // Create new pack lot lines.
        let newPackLotLine;
        for (let newLotLine of newPackLotLines) {
            newPackLotLine = new exports.Packlotline({}, { orderLine: this });
            newPackLotLine.set({ lotName: newLotLine.lotName });
            this.packLotLines.add(newPackLotLine);
        }

        // Set the quantity of the line based on number of pack lots.
        if(!this.product.toWeight){
            this.packLotLines.setQuantityByLot();
        }
    },
    setProductLot: function(product){
        this.hasProductLot = product.tracking !== 'none';
        this.packLotLines  = this.hasProductLot && new PacklotlineCollection(null, {'orderLine': this});
    },
    // sets a discount [0,100]%
    setDiscount: function(discount){
        var parsedDiscount = typeof(discount) === 'number' ? discount : isNaN(parseFloat(discount)) ? 0 : fieldUtils.parse.float('' + discount);
        var disc = Math.min(Math.max(parsedDiscount || 0, 0),100);
        this.discount = disc;
        this.discountStr = '' + disc;
        this.trigger('change',this);
    },
    // returns the discount [0,100]%
    getDiscount: function(){
        return this.discount;
    },
    getDiscountStr: function(){
        return this.discountStr;
    },
    setDescription: function(description){
        this.description = description || '';
    },
    setPriceExtra: function(priceExtra){
        this.priceExtra = parseFloat(priceExtra) || 0.0;
    },
    setFullProductName: function(fullProductName){
        this.fullProductName = fullProductName || '';
    },
    getPriceExtra: function () {
        return this.priceExtra;
    },
    // sets the quantity of the product. The quantity will be rounded according to the
    // product's unity of measure properties. Quantities greater than zero will not get
    // rounded to zero
    // Return true if successfully set the quantity, otherwise, return false.
    setQuantity: function(quantity, keepPrice){
        this.order.assertEditable();
        if(quantity === 'remove'){
            if (this.refundedOrderlineId in this.pos.toRefundLines) {
                delete this.pos.toRefundLines[this.refundedOrderlineId];
            }
            this.order.removeOrderline(this);
            return true;
        }else{
            var quant = typeof(quantity) === 'number' ? quantity : (fieldUtils.parse.float('' + quantity) || 0);
            if (this.refundedOrderlineId in this.pos.toRefundLines) {
                const toRefundDetail = this.pos.toRefundLines[this.refundedOrderlineId];
                const maxQtyToRefund = toRefundDetail.orderline.qty - toRefundDetail.orderline.refundedQty
                if (quant > 0) {
                    Gui.showPopup('ErrorPopup', {
                        title: _t('Positive quantity not allowed'),
                        body: _t('Only a negative quantity is allowed for this refund line. Click on +/- to modify the quantity to be refunded.')
                    });
                    return false;
                } else if (quant == 0) {
                    toRefundDetail.qty = 0;
                } else if (-quant <= maxQtyToRefund) {
                    toRefundDetail.qty = -quant;
                } else {
                    Gui.showPopup('ErrorPopup', {
                        title: _t('Greater than allowed'),
                        body: _.str.sprintf(
                            _t('The requested quantity to be refunded is higher than the refundable quantity of %s.'),
                            this.pos.formatProductQty(maxQtyToRefund)
                        ),
                    });
                    return false;
                }
            }
            var unit = this.getUnit();
            if(unit){
                if (unit.rounding) {
                    var decimals = this.pos.dp['Product Unit of Measure'];
                    var rounding = Math.max(unit.rounding, Math.pow(10, -decimals));
                    this.quantity    = roundPr(quant, rounding);
                    this.quantityStr = fieldUtils.format.float(this.quantity, {digits: [69, decimals]});
                } else {
                    this.quantity    = roundPr(quant, 1);
                    this.quantityStr = this.quantity.toFixed(0);
                }
            }else{
                this.quantity    = quant;
                this.quantityStr = '' + this.quantity;
            }
        }

        // just like in sale.order changing the quantity will recompute the unit price
        if (!keepPrice && !(this.priceManuallySet || this.priceAutomaticallySet) && !(
            this.pos.config.productConfigurator && _.some(this.product.attributeLineIds, (id) => id in this.pos.attributesByPtalId))){
            this.setUnitPrice(this.product.getPrice(this.order.pricelist, this.getQuantity(), this.getPriceExtra()));
            this.order.fixTaxIncludedPrice(this);
        }
        this.trigger('change', this);
        return true;
    },
    // return the quantity of product
    getQuantity: function(){
        return this.quantity;
    },
    getQuantityStr: function(){
        return this.quantityStr;
    },
    getQuantityStrWithUnit: function(){
        var unit = this.getUnit();
        if(unit && !unit.isPosGroupable){
            return this.quantityStr + ' ' + unit.label;
        }else{
            return this.quantityStr;
        }
    },

    getLotLines: function() {
        return this.packLotLines.models;
    },

    getRequiredNumberOfLots: function(){
        var lotsRequired = 1;

        if (this.product.tracking == 'serial') {
            lotsRequired = Math.abs(this.quantity);
        }

        return lotsRequired;
    },

    hasValidProductLot: function(){
        if(!this.hasProductLot){
            return true;
        }
        var validProductLot = this.packLotLines.getValidLots();
        return this.getRequiredNumberOfLots() === validProductLot.length;
    },

    // return the unit of measure of the product
    getUnit: function(){
        return this.product.getUnit();
    },
    // return the product of this orderline
    getProduct: function(){
        return this.product;
    },
    getFullProductName: function () {
        if (this.fullProductName) {
            return this.fullProductName
        }
        var fullName = this.product.displayName;
        if (this.description) {
            fullName += ` (${this.description})`;
        }
        return fullName;
    },
    // selects or deselects this orderline
    setSelected: function(selected){
        this.selected = selected;
        // this trigger also triggers the change event of the collection.
        this.trigger('change',this);
        this.trigger('new-orderline-selected');
    },
    // returns true if this orderline is selected
    isSelected: function(){
        return this.selected;
    },
    // when we add an new orderline we want to merge it with the last line to see reduce the number of items
    // in the orderline. This returns true if it makes sense to merge the two
    canBeMergedWith: function(orderline){
        var price = parseFloat(roundDi(this.price || 0, this.pos.dp['Product Price']).toFixed(this.pos.dp['Product Price']));
        var orderLinePrice = orderline.getProduct().getPrice(orderline.order.pricelist, this.getQuantity());
        orderLinePrice = roundDi(orderline.computeFixedPrice(orderLinePrice), this.pos.currency.decimals);
        if( this.getProduct().id !== orderline.getProduct().id){    //only orderline of the same product can be merged
            return false;
        }else if(!this.getUnit() || !this.getUnit().isPosGroupable){
            return false;
        }else if(this.getDiscount() > 0){             // we don't merge discounted orderlines
            return false;
        }else if(!utils.floatIsZero(price - orderLinePrice - orderline.getPriceExtra(),
                    this.pos.currency.decimals)){
            return false;
        }else if(this.product.tracking == 'lot' && (this.pos.pickingType.useCreateLots || this.pos.pickingType.useExistingLots)) {
            return false;
        }else if (this.description !== orderline.description) {
            return false;
        }else if (orderline.getCustomerNote() !== this.getCustomerNote()) {
            return false;
        } else if (this.refundedOrderlineId) {
            return false;
        }else{
            return true;
        }
    },
    merge: function(orderline){
        this.order.assertEditable();
        this.setQuantity(this.getQuantity() + orderline.getQuantity());
    },
    exportAsJSON: function() {
        var packLotIds = [];
        if (this.hasProductLot){
            this.packLotLines.each(_.bind( function(item) {
                return packLotIds.push([0, 0, item.exportAsJSON()]);
            }, this));
        }
        return {
            qty: this.getQuantity(),
            priceUnit: this.getUnitPrice(),
            priceSubtotal: this.getPriceWithoutTax(),
            priceSubtotalIncl: this.getPriceWithTax(),
            discount: this.getDiscount(),
            productId: this.getProduct().id,
            taxIds: [[6, false, _.map(this.getApplicableTaxes(), function(tax){ return tax.id; })]],
            id: this.id,
            packLotIds: packLotIds,
            description: this.description,
            fullProductName: this.getFullProductName(),
            priceExtra: this.getPriceExtra(),
            customerNote: this.getCustomerNote(),
            refundedOrderlineId: this.refundedOrderlineId,
            priceManuallySet: this.priceManuallySet,
            priceAutomaticallySet: this.priceAutomaticallySet,
        };
    },
    //used to create a json of the ticket, to be sent to the printer
    exportForPrinting: function(){
        return {
            id: this.id,
            quantity:           this.getQuantity(),
            unitName:          this.getUnit().label,
            isInUnit:         this.getUnit().id == this.pos.uomUnitId,
            price:              this.getUnitDisplayPrice(),
            discount:           this.getDiscount(),
            productName:       this.getProduct().displayName,
            productNameWrapped: this.generateWrappedProductName(),
            priceLst:          this.getTaxedLstUnitPrice(),
            fixedLstPrice:    this.getFixedLstPrice(),
            priceManuallySet: this.priceManuallySet,
            priceAutomaticallySet: this.priceAutomaticallySet,
            displayDiscountPolicy:    this.displayDiscountPolicy(),
            priceDisplayOne:  this.getDisplayPriceOne(),
            priceDisplay :     this.getDisplayPrice(),
            priceWithTax :    this.getPriceWithTax(),
            priceWithoutTax:  this.getPriceWithoutTax(),
            priceWithTaxBeforeDiscount:  this.getPriceWithTaxBeforeDiscount(),
            tax:                this.getTax(),
            productDescription:      this.getProduct().description,
            productDescriptionSale: this.getProduct().descriptionSale,
            packLotLines:      this.getLotLines(),
            customerNote:      this.getCustomerNote(),
            unitDisplayPriceBeforeDiscount: this.getUnitDisplayPriceBeforeDiscount(),
        };
    },
    generateWrappedProductName: function() {
        var MAX_LENGTH = 24; // 40 * line ratio of .6
        var wrapped = [];
        var name = this.getFullProductName();
        var currentLine = "";

        while (name.length > 0) {
            var spaceIndex = name.indexOf(" ");

            if (spaceIndex === -1) {
                spaceIndex = name.length;
            }

            if (currentLine.length + spaceIndex > MAX_LENGTH) {
                if (currentLine.length) {
                    wrapped.push(currentLine);
                }
                currentLine = "";
            }

            currentLine += name.slice(0, spaceIndex + 1);
            name = name.slice(spaceIndex + 1);
        }

        if (currentLine.length) {
            wrapped.push(currentLine);
        }

        return wrapped;
    },
    // changes the base price of the product for this orderline
    setUnitPrice: function(price){
        this.order.assertEditable();
        var parsedPrice = !isNaN(price) ?
            price :
            isNaN(parseFloat(price)) ? 0 : fieldUtils.parse.float('' + price)
        this.price = roundDi(parsedPrice || 0, this.pos.dp['Product Price']);
        this.trigger('change',this);
    },
    getUnitPrice: function(){
        var digits = this.pos.dp['Product Price'];
        // round and truncate to mimic _symbolSet behavior
        return parseFloat(roundDi(this.price || 0, digits).toFixed(digits));
    },
    getUnitDisplayPrice: function(){
        const quantity = this.quantity;
        this.quantity = 1.0;
        const allPrices = this.getAllPrices()
        this.quantity = quantity;
        if (this.pos.config.ifaceTaxIncluded === 'total') {
            return allPrices.priceWithTax;
        } else {
            return allPrices.priceWithoutTax;
        }
    },
    getUnitDisplayPriceBeforeDiscount: function(){
        const quantity = this.quantity;
        this.quantity = 1.0;
        const allPrices = this.getAllPrices()
        this.quantity = quantity;
        if (this.pos.config.ifaceTaxIncluded === 'total') {
            return allPrices.priceWithTaxBeforeDiscount;
        } else {
            return allPrices.priceWithoutTaxBeforeDiscount;
        }
    },
    getBasePrice:    function(){
        var rounding = this.pos.currency.rounding;
        return roundPr(this.getUnitPrice() * this.getQuantity() * (1 - this.getDiscount()/100), rounding);
    },
    getTaxesAfterFp: function(taxesIds){
        return this.pos.getTaxesAfterFp(taxesIds, this.order);
    },
    getDisplayPriceOne: function(){
        var rounding = this.pos.currency.rounding;
        var priceUnit = this.getUnitPrice();
        if (this.pos.config.ifaceTaxIncluded !== 'total') {
            return roundPr(priceUnit * (1.0 - (this.getDiscount() / 100.0)), rounding);
        } else {
            var product =  this.getProduct();
            var taxesIds = this.taxIds || product.taxesId;
            var productTaxes = this.getTaxesAfterFp(taxesIds);
            var allTaxes = this.computeAll(productTaxes, priceUnit, 1, this.pos.currency.rounding);

            return roundPr(allTaxes.totalIncluded * (1 - this.getDiscount()/100), rounding);
        }
    },
    getDisplayPrice: function(){
        if (this.pos.config.ifaceTaxIncluded === 'total') {
            return this.getPriceWithTax();
        } else {
            return this.getPriceWithoutTax();
        }
    },
    getTaxedLstUnitPrice: function(){
        const lstPrice = this.computeFixedPrice(this.getLstPrice());
        const product =  this.getProduct();
        const taxesIds = product.taxesId;
        const productTaxes = this.getTaxesAfterFp(taxesIds);
        const unitPrices =  this.computeAll(productTaxes, lstPrice, 1, this.pos.currency.rounding);
        if (this.pos.config.ifaceTaxIncluded === 'total') {
            return unitPrices.totalIncluded;
        } else {
            return unitPrices.totalExcluded;
        }
    },
    getPriceWithoutTax: function(){
        return this.getAllPrices().priceWithoutTax;
    },
    getPriceWithTax: function(){
        return this.getAllPrices().priceWithTax;
    },
    getPriceWithTaxBeforeDiscount: function () {
        return this.getAllPrices().priceWithTaxBeforeDiscount;
    },
    getTax: function(){
        return this.getAllPrices().tax;
    },
    getApplicableTaxes: function(){
        var i;
        // Shenaningans because we need
        // to keep the taxes ordering.
        var ptaxesIds = this.taxIds || this.getProduct().taxesId;
        var ptaxesSet = {};
        for (i = 0; i < ptaxesIds.length; i++) {
            ptaxesSet[ptaxesIds[i]] = true;
        }
        var taxes = [];
        for (i = 0; i < this.pos.taxes.length; i++) {
            if (ptaxesSet[this.pos.taxes[i].id]) {
                taxes.push(this.pos.taxes[i]);
            }
        }
        return taxes;
    },
    getTaxDetails: function(){
        return this.getAllPrices().taxDetails;
    },
    getTaxes: function(){
        var taxesIds = this.taxIds || this.getProduct().taxesId;
        return this.pos.getTaxesByIds(taxesIds);
    },
    /**
     * Calculate the amount of taxes of a specific Orderline, that are included in the price.
     * @returns {Number} the total amount of price included taxes
     */
    getTotalTaxesIncludedInPrice() {
        const productTaxes = this._getProductTaxesAfterFiscalPosition();
        const taxDetails = this.getTaxDetails();
        return productTaxes
            .filter(tax => tax.priceInclude)
            .reduce((sum, tax) => sum + taxDetails[tax.id],
            0
        );
    },
    _mapTaxFiscalPosition: function(tax, order = false) {
        return this.pos._mapTaxFiscalPosition(tax, order);
    },
    /**
     * Mirror JS method of:
     * _computeAmount in addons/account/models/account.js
     */
    _computeAll: function(tax, baseAmount, quantity, priceExclude) {
        return this.pos._computeAll(tax, baseAmount, quantity, priceExclude);
    },
    /**
     * Mirror JS method of:
     * computeAll in addons/account/models/account.js
     *
     * Read comments in the javascript side method for more details about each sub-methods.
     */
    computeAll: function(taxes, priceUnit, quantity, currencyRounding, handlePriceInclude=true) {
        return this.pos.computeAll(taxes, priceUnit, quantity, currencyRounding, handlePriceInclude);
    },
    /**
     * Calculates the taxes for a product, and converts the taxes based on the fiscal position of the order.
     *
     * @returns {Object} The calculated product taxes after filtering and fiscal position conversion.
     */
    _getProductTaxesAfterFiscalPosition: function() {
        const product = this.getProduct();
        let taxesIds = this.taxIds || product.taxesId;
        taxesIds = _.filter(taxesIds, t => t in this.pos.taxesById);
        return this.getTaxesAfterFp(taxesIds);
    },
    getAllPrices: function(){

        var priceUnit = this.getUnitPrice() * (1.0 - (this.getDiscount() / 100.0));
        var taxtotal = 0;

        var product =  this.getProduct();
        var taxesIds = this.taxIds || product.taxesId;
        taxesIds = _.filter(taxesIds, t => t in this.pos.taxesById);
        var taxdetail = {};
        var productTaxes = this.getTaxesAfterFp(taxesIds);

        var allTaxes = this.computeAll(productTaxes, priceUnit, this.getQuantity(), this.pos.currency.rounding);
        var allTaxesBeforeDiscount = this.computeAll(productTaxes, this.getUnitPrice(), this.getQuantity(), this.pos.currency.rounding);
        _(allTaxes.taxes).each(function(tax) {
            taxtotal += tax.amount;
            taxdetail[tax.id] = tax.amount;
        });

        return {
            "priceWithTax": allTaxes.totalIncluded,
            "priceWithoutTax": allTaxes.totalExcluded,
            "priceSumTaxVoid": allTaxes.totalVoid,
            "priceWithTaxBeforeDiscount": allTaxesBeforeDiscount.totalIncluded,
            "priceWithoutTaxBeforeDiscount": allTaxesBeforeDiscount.totalExcluded,
            "tax": taxtotal,
            "taxDetails": taxdetail,
        };
    },
    displayDiscountPolicy: function(){
        return this.order.pricelist.discountPolicy;
    },
    computeFixedPrice: function (price) {
        return this.pos.computePriceAfterFp(price, this.getTaxes());
    },
    getFixedLstPrice: function(){
        return this.computeFixedPrice(this.getLstPrice());
    },
    getLstPrice: function(){
        return this.product.getPrice(this.pos.defaultPricelist, 1, 0)
    },
    setLstPrice: function(price){
      this.order.assertEditable();
      this.product.lstPrice = roundDi(parseFloat(price) || 0, this.pos.dp['Product Price']);
      this.trigger('change',this);
    },
    isLastLine: function() {
        var order = this.pos.getOrder();
        var lastId = Object.keys(order.orderlines._byId)[Object.keys(order.orderlines._byId).length-1];
        var selectedLine = order? order.selectedOrderline: null;

        return !selectedLine ? false : lastId === selectedLine.cid;
    },
    setCustomerNote: function(note) {
        this.customerNote = note;
    },
    getCustomerNote: function() {
        return this.customerNote;
    },
    getTotalCost: function() {
        return this.product.standardPrice * this.quantity;
    },
    /**
     * Checks if the current line is a tip from a customer.
     * @returns Boolean
     */
    isTipLine: function() {
        const tipProduct = this.pos.config.tipProductId;
        return tipProduct && this.product.id === tipProduct[0];
    },
});

var OrderlineCollection = Backbone.Collection.extend({
    model: exports.Orderline,
});

exports.Packlotline = Backbone.Model.extend({
    defaults: {
        lotName: null
    },
    initialize: function(attributes, options){
        this.orderLine = options.orderLine;
        if (options.json) {
            this.initFromJSON(options.json);
            return;
        }
    },

    initFromJSON: function(json) {
        this.orderLine = json.orderLine;
        this.setLotName(json.lotName);
    },

    setLotName: function(name){
        this.set({lotName : _.str.trim(name) || null});
    },

    getLotName: function(){
        return this.get('lotName');
    },

    exportAsJSON: function(){
        return {
            lotName: this.getLotName(),
        };
    },

    add: function(){
        var orderLine = this.orderLine,
            index = this.collection.indexOf(this);
        var newLotModel = new exports.Packlotline({}, {'orderLine': this.orderLine});
        this.collection.add(newLotModel, {at: index + 1});
        return newLotModel;
    },

    remove: function(){
        this.collection.remove(this);
    }
});

var PacklotlineCollection = Backbone.Collection.extend({
    model: exports.Packlotline,
    initialize: function(models, options) {
        this.orderLine = options.orderLine;
    },

    getValidLots: function(){
        return this.filter(function(model){
            return model.get('lotName');
        });
    },

    setQuantityByLot: function() {
        var validLotsQuantity = this.getValidLots().length;
        if (this.orderLine.quantity < 0){
            validLotsQuantity = -validLotsQuantity;
        }
        this.orderLine.setQuantity(validLotsQuantity);
    }
});

// Every Paymentline contains a cashregister and an amount of money.
exports.Paymentline = Backbone.Model.extend({
    initialize: function(attributes, options) {
        this.pos = options.pos;
        this.order = options.order;
        this.amount = 0;
        this.selected = false;
        this.cashierReceipt = '';
        this.ticket = '';
        this.paymentStatus = '';
        this.cardType = '';
        this.cardholderName = '';
        this.transactionId = '';

        if (options.json) {
            this.initFromJSON(options.json);
            return;
        }
        this.paymentMethod = options.paymentMethod;
        if (this.paymentMethod === undefined) {
            throw new Error(_t('Please configure a payment method in your POS.'));
        }
        this.label = this.paymentMethod.label;
    },
    initFromJSON: function(json){
        this.amount = json.amount;
        this.paymentMethod = this.pos.paymentMethodsById[json.paymentMethodId];
        this.canBeReversed = json.canBeReversed;
        this.label = this.paymentMethod.label;
        this.paymentStatus = json.paymentStatus;
        this.ticket = json.ticket;
        this.cardType = json.cardType;
        this.cardholderName = json.cardholderName;
        this.transactionId = json.transactionId;
        this.isChange = json.isChange;
    },
    //sets the amount of money on this payment line
    setAmount: function(value){
        this.order.assertEditable();
        this.amount = roundDi(parseFloat(value) || 0, this.pos.currency.decimals);
        if (this.pos.config.ifaceCustomerFacingDisplay) this.pos.sendCurrentOrderToCustomerFacingDisplay();
        this.trigger('change',this);
    },
    // returns the amount of money on this paymentline
    getAmount: function(){
        return this.amount;
    },
    getAmountStr: function(){
        return fieldUtils.format.float(this.amount, {digits: [69, this.pos.currency.decimals]});
    },
    setSelected: function(selected){
        if(this.selected !== selected){
            this.selected = selected;
            this.trigger('change',this);
        }
    },
    /**
     * returns {string} payment status.
     */
    getPaymentStatus: function() {
        return this.paymentStatus;
    },

    /**
     * Set the new payment status.
     *
     * @param {string} value - new status.
     */
    setPaymentStatus: function(value) {
        this.paymentStatus = value;
        this.trigger('change', this);
    },

    /**
     * Check if paymentline is done.
     * Paymentline is done if there is no payment status or the payment status is done.
     */
    isDone: function() {
        return this.getPaymentStatus() ? this.getPaymentStatus() === 'done' || this.getPaymentStatus() === 'reversed': true;
    },

    /**
    * Set info to be printed on the cashier receipt. value should
    * be compatible with both the QWeb and ESC/POS receipts.
    *
    * @param {string} value - receipt info
    */
    setCashierReceipt: function (value) {
        this.cashierReceipt = value;
        this.trigger('change', this);
    },

    /**
     * Set additional info to be printed on the receipts. value should
     * be compatible with both the QWeb and ESC/POS receipts.
     *
     * @param {string} value - receipt info
     */
    setReceiptInfo: function(value) {
        this.ticket += value;
        this.trigger('change', this);
    },

    // returns the associated cashregister
    //exports as JSON for server communication
    exportAsJSON: function(){
        return {
            name: time.datetimeToStr(new Date()),
            paymentMethodId: this.paymentMethod.id,
            amount: this.getAmount(),
            paymentStatus: this.paymentStatus,
            canBeReversed: this.canBeReversed,
            ticket: this.ticket,
            cardType: this.cardType,
            cardholderName: this.cardholderName,
            transactionId: this.transactionId,
        };
    },
    //exports as JSON for receipt printing
    exportForPrinting: function(){
        return {
            cid: this.cid,
            amount: this.getAmount(),
            label: this.label,
            ticket: this.ticket,
        };
    },
    // If payment status is a non-empty string, then it is an electronic payment.
    // TODO: There has to be a less confusing way to distinguish simple payments
    // from electronic transactions. Perhaps use a flag?
    isElectronic: function() {
        return Boolean(this.getPaymentStatus());
    },
});

var PaymentlineCollection = Backbone.Collection.extend({
    model: exports.Paymentline,
});

// An order more or less represents the content of a client's shopping cart (the OrderLines)
// plus the associated payment information (the Paymentlines)
// there is always an active ('selected') order in the Pos, a new one is created
// automaticaly once an order is completed and sent to the server.
exports.Order = Backbone.Model.extend({
    initialize: function(attributes,options){
        Backbone.Model.prototype.initialize.apply(this, arguments);
        var self = this;
        options  = options || {};

        this.locked         = false;
        this.pos            = options.pos;
        this.selectedOrderline   = undefined;
        this.selectedPaymentline = undefined;
        this.screenData    = {};  // see Gui
        this.temporary      = options.temporary || false;
        this.creationDate  = new Date();
        this.toInvoice     = false;
        this.orderlines     = new OrderlineCollection();
        this.paymentlines   = new PaymentlineCollection();
        this.posSessionId = this.pos.posSession.id;
        this.employee       = this.pos.employee;
        this.finalized      = false; // if true, cannot be modified.
        this.setPricelist(this.pos.defaultPricelist);

        this.set({ client: null });

        this.uiState = {
            ReceiptScreen: new Context({
                inputEmail: '',
                // if null: not yet tried to send
                // if false/true: tried sending email
                emailSuccessful: null,
                emailNotice: '',
            }),
            TipScreen: new Context({
                inputTipAmount: '',
            })
        };

        if (options.json) {
            this.initFromJSON(options.json);
        } else {
            this.sequenceNumber = this.pos.posSession.sequenceNumber++;
            this.uid  = this.generateUniqueId();
            this.label = _.str.sprintf(_t("Order %s"), this.uid);
            this.validationDate = undefined;
            this.fiscalPosition = _.find(this.pos.fiscalPositions, function(fp) {
                return fp.id === self.pos.config.defaultFiscalPositionId[0];
            });
        }

        this.on('change',              function(){ this.saveToDb("order:change"); }, this);
        this.orderlines.on('change',   function(){ this.saveToDb("orderline:change"); }, this);
        this.orderlines.on('add',      function(){ this.saveToDb("orderline:add"); }, this);
        this.orderlines.on('remove',   function(){ this.saveToDb("orderline:remove"); }, this);
        this.paymentlines.on('change', function(){ this.saveToDb("paymentline:change"); }, this);
        this.paymentlines.on('add',    function(){ this.saveToDb("paymentline:add"); }, this);
        this.paymentlines.on('remove', function(){ this.saveToDb("paymentline:rem"); }, this);

        if (this.pos.config.ifaceCustomerFacingDisplay) {
            this.paymentlines.on('add', this.pos.sendCurrentOrderToCustomerFacingDisplay, this.pos);
            this.paymentlines.on('remove', this.pos.sendCurrentOrderToCustomerFacingDisplay, this.pos);
        }

        this.saveToDb();

        return this;
    },
    saveToDb: function(){
        if (!this.temporary && !this.locked) {
            this.assertEditable();
            this.pos.db.saveUnpaidOrder(this);
        }
    },
    /**
     * Initialize PoS order from a JSON string.
     *
     * If the order was created in another session, the sequence number should be changed so it doesn't conflict
     * with orders in the current session.
     * Else, the sequence number of the session should follow on the sequence number of the loaded order.
     *
     * @param {object} json JSON representing one PoS order.
     */
    initFromJSON: function(json) {
        var client;
        if (json.state && ['done', 'invoiced', 'paid'].includes(json.state)) {
            this.sequenceNumber = json.sequenceNumber;
        } else if (json.posSessionId !== this.pos.posSession.id) {
            this.sequenceNumber = this.pos.posSession.sequenceNumber++;
        } else {
            this.sequenceNumber = json.sequenceNumber;
            this.pos.posSession.sequenceNumber = Math.max(this.sequenceNumber+1,this.pos.posSession.sequenceNumber);
        }
        this.sessionId = this.pos.posSession.id;
        this.uid = json.uid;
        this.label = _.str.sprintf(_t("Order %s"), this.uid);
        this.validationDate = json.creationDate;
        this.serverId = json.serverId ? json.serverId : false;
        this.userId = json.userId;

        if (json.fiscalPositionId) {
            var fiscalPosition = _.find(this.pos.fiscalPositions, function (fp) {
                return fp.id === json.fiscalPositionId;
            });

            if (fiscalPosition) {
                this.fiscalPosition = fiscalPosition;
            } else {
                this.fiscalPositionNotFound = true;
                console.error('ERROR: trying to load a fiscal position not available in the pos');
            }
        }

        if (json.pricelistId) {
            this.pricelist = _.find(this.pos.pricelists, function (pricelist) {
                return pricelist.id === json.pricelistId;
            });
        } else {
            this.pricelist = this.pos.defaultPricelist;
        }

        if (json.partnerId) {
            client = this.pos.db.getPartnerById(json.partnerId);
            if (!client) {
                console.error('ERROR: trying to load a partner not available in the pos');
            }
        } else {
            client = null;
        }
        this.setClient(client);

        this.temporary = false;     // FIXME
        this.toInvoice = false;    // FIXME
        this.toShip = false;

        var orderlines = json.lines;
        for (var i = 0; i < orderlines.length; i++) {
            var orderline = orderlines[i][2];
            if(this.pos.db.getProductById(orderline.productId)){
                this.addOrderline(new exports.Orderline({}, {pos: this.pos, order: this, json: orderline}));
            }
        }

        var paymentlines = json.statementIds;
        for (var i = 0; i < paymentlines.length; i++) {
            var paymentline = paymentlines[i][2];
            var newpaymentline = new exports.Paymentline({},{pos: this.pos, order: this, json: paymentline});
            this.paymentlines.add(newpaymentline);

            if (i === paymentlines.length - 1) {
                this.selectPaymentline(newpaymentline);
            }
        }

        // Tag this order as 'locked' if it is already paid.
        this.locked = ['paid', 'done', 'invoiced'].includes(json.state);
        this.state = json.state;
        this.amountReturn = json.amountReturn;
        this.accountMove = json.accountMove;
        this.backendId = json.id;
        this.isFromClosedSession = json.isSessionClosed;
        this.isTipped = json.isTipped || false;
        this.tipAmount = json.tipAmount || 0;
    },
    exportAsJSON: function() {
        var orderLines, paymentLines;
        orderLines = [];
        this.orderlines.each(_.bind( function(item) {
            return orderLines.push([0, 0, item.exportAsJSON()]);
        }, this));
        paymentLines = [];
        this.paymentlines.each(_.bind( function(item) {
            return paymentLines.push([0, 0, item.exportAsJSON()]);
        }, this));
        var json = {
            name: this.getName(),
            amountPaid: this.getTotalPaid() - this.getChange(),
            amountTotal: this.getTotalWithTax(),
            amountTax: this.getTotalTax(),
            amountReturn: this.getChange(),
            lines: orderLines,
            statementIds: paymentLines,
            posSessionId: this.posSessionId,
            pricelistId: this.pricelist ? this.pricelist.id : false,
            partnerId: this.getClient() ? this.getClient().id : false,
            userId: this.pos.user.id,
            uid: this.uid,
            sequenceNumber: this.sequenceNumber,
            creationDate: this.validationDate || this.creationDate, // todo: rename creationDate in master
            fiscalPositionId: this.fiscalPosition ? this.fiscalPosition.id : false,
            serverId: this.serverId ? this.serverId : false,
            toInvoice: this.toInvoice ? this.toInvoice : false,
            toShip: this.toShip ? this.toShip : false,
            isTipped: this.isTipped || false,
            tipAmount: this.tipAmount || 0,
        };
        if (!this.isPaid && this.userId) {
            json.userId = this.userId;
        }
        return json;
    },
    exportForPrinting: function(){
        var orderlines = [];
        var self = this;

        this.orderlines.each(function(orderline){
            orderlines.push(orderline.exportForPrinting());
        });

        // If order is locked (paid), the 'change' is saved as negative payment,
        // and is flagged with isChange = true. A receipt that is printed first
        // time doesn't show this negative payment so we filter it out.
        var paymentlines = this.paymentlines.models
            .filter(function (paymentline) {
                return !paymentline.isChange;
            })
            .map(function (paymentline) {
                return paymentline.exportForPrinting();
            });
        var client  = this.get('client');
        var cashier = this.pos.getCashier();
        var company = this.pos.company;
        var date    = new Date();

        function isHtml(subreceipt){
            return subreceipt ? (subreceipt.split('\n')[0].indexOf('<!DOCTYPE QWEB') >= 0) : false;
        }

        function renderHtml(subreceipt){
            if (!isHtml(subreceipt)) {
                return subreceipt;
            } else {
                subreceipt = subreceipt.split('\n').slice(1).join('\n');
                var qweb = new QWeb2.Engine();
                    qweb.debug = config.isDebug();
                    qweb.defaultDict = _.clone(QWeb.defaultDict);
                    qweb.addTemplate('<templates><t t-name="subreceipt">'+subreceipt+'</t></templates>');

                return qweb.render('subreceipt',{'pos':self.pos,'order':self, 'receipt': receipt}) ;
            }
        }

        var receipt = {
            orderlines: orderlines,
            paymentlines: paymentlines,
            subtotal: this.getSubtotal(),
            totalWithTax: this.getTotalWithTax(),
            totalRounded: this.getTotalWithTax() + this.getRoundingApplied(),
            totalWithoutTax: this.getTotalWithoutTax(),
            totalTax: this.getTotalTax(),
            totalPaid: this.getTotalPaid(),
            totalDiscount: this.getTotalDiscount(),
            roundingApplied: this.getRoundingApplied(),
            taxDetails: this.getTaxDetails(),
            change: this.locked ? this.amountReturn : this.getChange(),
            label : this.getName(),
            client: client ? client : null ,
            invoiceId: null,   //TODO
            cashier: cashier ? cashier.label : null,
            precision: {
                price: 2,
                money: 2,
                quantity: 3,
            },
            date: {
                year: date.getFullYear(),
                month: date.getMonth(),
                date: date.getDate(),       // day of the month
                day: date.getDay(),         // day of the week
                hour: date.getHours(),
                minute: date.getMinutes() ,
                isostring: date.toISOString(),
                localestring: this.formattedValidationDate,
                validationDate: this.validationDate,
            },
            company:{
                email: company.email,
                website: company.website,
                companyRegistry: company.companyRegistry,
                contactAddress: company.partnerId[1],
                vat: company.vat,
                vatLabel: company.country && company.country.vatLabel || _t('Tax ID'),
                label: company.label,
                phone: company.phone,
                logo:  this.pos.companyLogoBase64,
            },
            currency: this.pos.currency,
        };

        if (isHtml(this.pos.config.receiptHeader)){
            receipt.header = '';
            receipt.headerHtml = renderHtml(this.pos.config.receiptHeader);
        } else {
            receipt.header = this.pos.config.receiptHeader || '';
        }

        if (isHtml(this.pos.config.receiptFooter)){
            receipt.footer = '';
            receipt.footerHtml = renderHtml(this.pos.config.receiptFooter);
        } else {
            receipt.footer = this.pos.config.receiptFooter || '';
        }
        if (!receipt.date.localestring && (!this.state || this.state == 'draft')){
            receipt.date.localestring = fieldUtils.format.datetime(moment(new Date()), {}, {timezone: false});
        }

        return receipt;
    },
    isEmpty: function(){
        return this.orderlines.models.length === 0;
    },
    generateUniqueId: function() {
        // Generates a public identification number for the order.
        // The generated number must be unique and sequential. They are made 12 digit long
        // to fit into EAN-13 barcodes, should it be needed

        function zeroPad(num,size){
            var s = ""+num;
            while (s.length < size) {
                s = "0" + s;
            }
            return s;
        }
        return zeroPad(this.pos.posSession.id,5) +'-'+
               zeroPad(this.pos.posSession.loginNumber,3) +'-'+
               zeroPad(this.sequenceNumber,4);
    },
    getName: function() {
        return this.label;
    },
    assertEditable: function() {
        if (this.finalized) {
            throw new Error('Finalized Order cannot be modified');
        }
    },
    /* ---- Order Lines --- */
    addOrderline: function(line){
        this.assertEditable();
        if(line.order){
            line.order.removeOrderline(line);
        }
        line.order = this;
        this.orderlines.add(line);
        this.selectLastOrderline(line);
    },
    selectLastOrderline: function(line){
        this.selectOrderline(this.getLastOrderline());
    },
    getOrderline: function(id){
        var orderlines = this.orderlines.models;
        for(var i = 0; i < orderlines.length; i++){
            if(orderlines[i].id === id){
                return orderlines[i];
            }
        }
        return null;
    },
    getOrderlines: function(){
        return this.orderlines.models;
    },
    /**
     * Groups the orderlines of the specific order according to the taxes applied to them. The orderlines that have
     * the exact same combination of taxes are grouped together.
     *
     * @returns {taxIds: Orderlines[]} contains pairs of taxIds (in csv format) and arrays of Orderlines
     * with the corresponding taxIds.
     * e.g. {
     *  '1,2': [orderlineA, orderlineB],
     *  '3': [orderlineC],
     * }
     */
    getOrderlinesGroupedByTaxIds() {
        let orderlinesByTaxGroup = {};
        const lines = this.getOrderlines();
        for (let line of lines) {
            const taxGroup = this._getTaxGroupKey(line);
            if (!(taxGroup in orderlinesByTaxGroup)) {
                orderlinesByTaxGroup[taxGroup] = [];
            }
            orderlinesByTaxGroup[taxGroup].push(line);
        }
        return orderlinesByTaxGroup;
    },
    _getTaxGroupKey(line) {
        return line
            ._getProductTaxesAfterFiscalPosition()
            .map(tax => tax.id)
            .join(',');
    },
    /**
     * Calculate the amount that will be used as a base in order to apply a downpayment or discount product in PoS.
     * In our calculation we take into account taxes that are included in the price.
     *
     * @param  {String} taxIds a string of the tax ids that are applied on the orderlines, in csv format
     * e.g. if taxes with ids 2, 5 and 6 are applied taxIds will be "2,5,6"
     * @param  {Orderline[]} lines an srray of Orderlines
     * @return {Number} the base amount on which we will apply a percentile reduction
     */
    calculateBaseAmount(taxIdsArray, lines) {
        // Consider priceInclude taxes use case
        let hasTaxesIncludedInPrice = taxIdsArray.filter(taxId =>
            this.pos.taxesById[taxId].priceInclude
        ).length;

        let baseAmount = lines.reduce((sum, line) =>
                sum +
                line.getPriceWithoutTax() +
                (hasTaxesIncludedInPrice ? line.getTotalTaxesIncludedInPrice() : 0),
            0
        );
        return baseAmount;
    },
    getLastOrderline: function(){
        return this.orderlines.at(this.orderlines.length -1);
    },
    getTip: function() {
        var tipProduct = this.pos.db.getProductById(this.pos.config.tipProductId[0]);
        var lines = this.getOrderlines();
        if (!tipProduct) {
            return 0;
        } else {
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].getProduct() === tipProduct) {
                    return lines[i].getUnitPrice();
                }
            }
            return 0;
        }
    },

    initializeValidationDate: function () {
        this.validationDate = new Date();
        this.formattedValidationDate = fieldUtils.format.datetime(
            moment(this.validationDate), {}, {timezone: false});
    },

    setTip: async function(tip) {
        var tipProduct = this.pos.db.getProductById(this.pos.config.tipProductId[0]);
        var lines = this.getOrderlines();
        if (tipProduct) {
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].getProduct() === tipProduct) {
                    lines[i].setUnitPrice(tip);
                    lines[i].setLstPrice(tip);
                    lines[i].priceAutomaticallySet = true;
                    lines[i].order.tipAmount = tip;
                    return;
                }
            }
            return await this.addProduct(tipProduct, {
              isTip: true,
              quantity: 1,
              price: tip,
              lstPrice: tip,
              extras: {priceAutomaticallySet: true},
            });
        }
    },
    setPricelist: function (pricelist) {
        var self = this;
        this.pricelist = pricelist;

        var linesToRecompute = _.filter(this.getOrderlines(), function (line) {
            return ! (line.priceManuallySet || line.priceAutomaticallySet);
        });
        _.each(linesToRecompute, function (line) {
            line.setUnitPrice(line.product.getPrice(self.pricelist, line.getQuantity(), line.getPriceExtra()));
            self.fixTaxIncludedPrice(line);
        });
        this.trigger('change');
    },
    removeOrderline: function( line ){
        this.assertEditable();
        this.orderlines.remove(line);
        if (this.selectedOrderline === line) {
            this.selectOrderline(this.getLastOrderline());
        }
    },

    fixTaxIncludedPrice: function(line){
        line.setUnitPrice(line.computeFixedPrice(line.price));
    },

    _isRefundAndSaleOrder: function() {
        if(this.orderlines.length && this.orderlines.models[0].refundedOrderlineId)
            return true;
        else
            return false;
    },

    addProduct: async function(product, options){
        if(this.pos.doNotAllowRefundAndSales() && this._isRefundAndSaleOrder()) {
            await Gui.showPopup('ErrorPopup',{
                    'title': _t("POS error"),
                    'body':  _t("Can't mix order with refund products with new products."),
                });
            return false;
        }
        if(this._printed){
            this.destroy();
            return await this.pos.getOrder().addProduct(product, options);
        }
        this.assertEditable();
        options = options || {};
        var line = new exports.Orderline({}, {pos: this.pos, order: this, product: product});
        this.fixTaxIncludedPrice(line);

        this.setOrderlineOptions(line, options);

        var toMergeOrderline;
        for (var i = 0; i < this.orderlines.length; i++) {
            if(this.orderlines.at(i).canBeMergedWith(line) && options.merge !== false){
                toMergeOrderline = this.orderlines.at(i);
            }
        }
        if (toMergeOrderline){
            toMergeOrderline.merge(line);
            this.selectOrderline(toMergeOrderline);
        } else {
            this.addOrderline(line);
            this.selectOrderline(this.getLastOrderline());
        }

        if (options.draftPackLotLines) {
            this.selectedOrderline.setPackLotLines(options.draftPackLotLines);
        }
        if (this.pos.config.ifaceCustomerFacingDisplay) {
            this.pos.sendCurrentOrderToCustomerFacingDisplay();
        }
    },
    setOrderlineOptions: function(orderline, options) {
        if(options.quantity !== undefined){
            orderline.setQuantity(options.quantity);
        }

        if (options.priceExtra !== undefined){
            orderline.priceExtra = options.priceExtra;
            orderline.setUnitPrice(orderline.product.getPrice(this.pricelist, orderline.getQuantity(), options.priceExtra));
            this.fixTaxIncludedPrice(orderline);
        }

        if(options.price !== undefined){
            orderline.setUnitPrice(options.price);
            this.fixTaxIncludedPrice(orderline);
        }

        if(options.lstPrice !== undefined){
            orderline.setLstPrice(options.lstPrice);
        }

        if(options.discount !== undefined){
            orderline.setDiscount(options.discount);
        }

        if (options.description !== undefined){
            orderline.description += options.description;
        }

        if(options.extras !== undefined){
            for (var prop in options.extras) {
                orderline[prop] = options.extras[prop];
            }
        }
        if (options.isTip) {
            this.isTipped = true;
            this.tipAmount = options.price;
        }
        if (options.refundedOrderlineId) {
            orderline.refundedOrderlineId = options.refundedOrderlineId;
        }
        if (options.taxIds) {
            orderline.taxIds = options.taxIds;
        }
    },
    getSelectedOrderline: function(){
        return this.selectedOrderline;
    },
    selectOrderline: function(line){
        if(line){
            if(line !== this.selectedOrderline){
                // if line (new line to select) is not the same as the old
                // selectedOrderline, then we set the old line to false,
                // and set the new line to true. Also, set the new line as
                // the selectedOrderline.
                if(this.selectedOrderline){
                    this.selectedOrderline.setSelected(false);
                }
                this.selectedOrderline = line;
                this.selectedOrderline.setSelected(true);
            }
        }else{
            this.selectedOrderline = undefined;
        }
    },
    deselectOrderline: function(){
        if(this.selectedOrderline){
            this.selectedOrderline.setSelected(false);
            this.selectedOrderline = undefined;
        }
    },

    /* ---- Payment Lines --- */
    addPaymentline: function(paymentMethod) {
        this.assertEditable();
        if (this.electronicPaymentInProgress()) {
            return false;
        } else {
            var newPaymentline = new exports.Paymentline({},{order: this, paymentMethod:paymentMethod, pos: this.pos});
            newPaymentline.setAmount(this.getDue());
            this.paymentlines.add(newPaymentline);
            this.selectPaymentline(newPaymentline);
            if(this.pos.config.cashRounding){
              this.selectedPaymentline.setAmount(0);
              this.selectedPaymentline.setAmount(this.getDue());
            }

            if (paymentMethod.paymentTerminal) {
                newPaymentline.setPaymentStatus('pending');
            }
            return newPaymentline;
        }
    },
    getPaymentlines: function(){
        return this.paymentlines.models;
    },
    /**
     * Retrieve the paymentline with the specified cid
     *
     * @param {String} cid
     */
    getPaymentline: function (cid) {
        var lines = this.getPaymentlines();
        return lines.find(function (line) {
            return line.cid === cid;
        });
    },
    removePaymentline: function(line){
        this.assertEditable();
        if(this.selectedPaymentline === line){
            this.selectPaymentline(undefined);
        }
        this.paymentlines.remove(line);
    },
    cleanEmptyPaymentlines: function() {
        var lines = this.paymentlines.models;
        var empty = [];
        for ( var i = 0; i < lines.length; i++) {
            if (!lines[i].getAmount()) {
                empty.push(lines[i]);
            }
        }
        for ( var i = 0; i < empty.length; i++) {
            this.removePaymentline(empty[i]);
        }
    },
    selectPaymentline: function(line){
        if(line !== this.selectedPaymentline){
            if(this.selectedPaymentline){
                this.selectedPaymentline.setSelected(false);
            }
            this.selectedPaymentline = line;
            if(this.selectedPaymentline){
                this.selectedPaymentline.setSelected(true);
            }
            this.trigger('change:selectedPaymentline',this.selectedPaymentline);
        }
    },
    electronicPaymentInProgress: function() {
        return this.getPaymentlines()
            .some(function(pl) {
                if (pl.paymentStatus) {
                    return !['done', 'reversed'].includes(pl.paymentStatus);
                } else {
                    return false;
                }
            });
    },
    /**
     * Stops a payment on the terminal if one is running
     */
    stopElectronicPayment: function () {
        var lines = this.getPaymentlines();
        var line = lines.find(function (line) {
            var status = line.getPaymentStatus();
            return status && !['done', 'reversed', 'reversing', 'pending', 'retry'].includes(status);
        });
        if (line) {
            line.setPaymentStatus('waitingCancel');
            line.paymentMethod.paymentTerminal.setndPaymentCancel(this, line.cid).finally(function () {
                line.setPaymentStatus('retry');
            });
        }
    },
    /* ---- Payment Status --- */
    getSubtotal: function(){
        return roundPr(this.orderlines.reduce((function(sum, orderLine){
            return sum + orderLine.getDisplayPrice();
        }), 0), this.pos.currency.rounding);
    },
    getTotalWithTax: function() {
        return this.getTotalWithoutTax() + this.getTotalTax();
    },
    getTotalWithoutTax: function() {
        return roundPr(this.orderlines.reduce((function(sum, orderLine) {
            return sum + orderLine.getPriceWithoutTax();
        }), 0), this.pos.currency.rounding);
    },
    _reduceTotalDiscountCallback: function(sum, orderLine) {
        let discountUnitPrice = orderLine.getUnitDisplayPriceBeforeDiscount() * (orderLine.getDiscount()/100);
        if (orderLine.displayDiscountPolicy() === 'withoutDiscount'){
            discountUnitPrice += orderLine.getTaxedLstUnitPrice() - orderLine.getUnitDisplayPriceBeforeDiscount();
        }
        return sum + discountUnitPrice * orderLine.getQuantity();
    },
    getTotalDiscount: function() {
        const reduceCallback = this._reduceTotalDiscountCallback.bind(this);
        return roundPr(this.orderlines.reduce(reduceCallback, 0), this.pos.currency.rounding);
    },
    getTotalTax: function() {
        if (this.pos.company.taxCalculationRoundingMethod === "roundGlobally") {
            // As always, we need:
            // 1. For each tax, sum their amount across all order lines
            // 2. Round that result
            // 3. Sum all those rounded amounts
            var groupTaxes = {};
            this.orderlines.each(function (line) {
                var taxDetails = line.getTaxDetails();
                var taxIds = Object.keys(taxDetails);
                for (var t = 0; t<taxIds.length; t++) {
                    var taxId = taxIds[t];
                    if (!(taxId in groupTaxes)) {
                        groupTaxes[taxId] = 0;
                    }
                    groupTaxes[taxId] += taxDetails[taxId];
                }
            });

            var sum = 0;
            var taxIds = Object.keys(groupTaxes);
            for (var j = 0; j<taxIds.length; j++) {
                var taxAmount = groupTaxes[taxIds[j]];
                sum += roundPr(taxAmount, this.pos.currency.rounding);
            }
            return sum;
        } else {
            return roundPr(this.orderlines.reduce((function(sum, orderLine) {
                return sum + orderLine.getTax();
            }), 0), this.pos.currency.rounding);
        }
    },
    getTotalPaid: function() {
        return roundPr(this.paymentlines.reduce((function(sum, paymentLine) {
            if (paymentLine.isDone()) {
                sum += paymentLine.getAmount();
            }
            return sum;
        }), 0), this.pos.currency.rounding);
    },
    getTaxDetails: function(){
        var details = {};
        var fulldetails = [];

        this.orderlines.each(function(line){
            var ldetails = line.getTaxDetails();
            for(var id in ldetails){
                if(ldetails.hasOwnProperty(id)){
                    details[id] = (details[id] || 0) + ldetails[id];
                }
            }
        });

        for(var id in details){
            if(details.hasOwnProperty(id)){
                fulldetails.push({amount: details[id], tax: this.pos.taxesById[id], label: this.pos.taxesById[id].label});
            }
        }

        return fulldetails;
    },
    // Returns a total only for the orderlines with products belonging to the category
    getTotalForCategoryWithTax: function(categId){
        var total = 0;
        var self = this;

        if (categId instanceof Array) {
            for (var i = 0; i < categId.length; i++) {
                total += this.getTotalForCategoryWithTax(categId[i]);
            }
            return total;
        }

        this.orderlines.each(function(line){
            if ( self.pos.db.categoryContains(categId,line.product.id) ) {
                total += line.getPriceWithTax();
            }
        });

        return total;
    },
    getTotalForTaxes: function(taxId){
        var total = 0;

        if (!(taxId instanceof Array)) {
            taxId = [taxId];
        }

        var taxSet = {};

        for (var i = 0; i < taxId.length; i++) {
            taxSet[taxId[i]] = true;
        }

        this.orderlines.each(line => {
            var taxesIds = this.taxIds || line.getProduct().taxesId;
            for (var i = 0; i < taxesIds.length; i++) {
                if (taxSet[taxesIds[i]]) {
                    total += line.getPriceWithTax();
                    return;
                }
            }
        });

        return total;
    },
    getChange: function(paymentline) {
        if (!paymentline) {
            var change = this.getTotalPaid() - this.getTotalWithTax() - this.getRoundingApplied();
        } else {
            var change = -this.getTotalWithTax();
            var lines  = this.paymentlines.models;
            for (var i = 0; i < lines.length; i++) {
                change += lines[i].getAmount();
                if (lines[i] === paymentline) {
                    break;
                }
            }
        }
        return roundPr(Math.max(0,change), this.pos.currency.rounding);
    },
    getDue: function(paymentline) {
        if (!paymentline) {
            var due = this.getTotalWithTax() - this.getTotalPaid() + this.getRoundingApplied();
        } else {
            var due = this.getTotalWithTax();
            var lines = this.paymentlines.models;
            for (var i = 0; i < lines.length; i++) {
                if (lines[i] === paymentline) {
                    break;
                } else {
                    due -= lines[i].getAmount();
                }
            }
        }
        return roundPr(due, this.pos.currency.rounding);
    },
    getRoundingApplied: function() {
        if(this.pos.config.cashRounding) {
            const onlyCash = this.pos.config.onlyRoundCashMethod;
            const paymentlines = this.getPaymentlines();
            const lastLine = paymentlines ? paymentlines[paymentlines.length-1]: false;
            const lastLineIsCash = lastLine ? lastLine.paymentMethod.isCashCount == true: false;
            if (!onlyCash || (onlyCash && lastLineIsCash)) {
                var remaining = this.getTotalWithTax() - this.getTotalPaid();
                var total = roundPr(remaining, this.pos.cashRounding[0].rounding);
                var sign = remaining > 0 ? 1.0 : -1.0;

                var roundingApplied = total - remaining;
                roundingApplied *= sign;
                // because floor and ceil doesn't include decimals in calculation, we reuse the value of the half-up and adapt it.
                if (utils.floatIsZero(roundingApplied, this.pos.currency.decimals)){
                    // https://xkcd.com/217/
                    return 0;
                } else if(Math.abs(this.getTotalWithTax()) < this.pos.cashRounding[0].rounding) {
                    return 0;
                } else if(this.pos.cashRounding[0].roundingMethod === "UP" && roundingApplied < 0 && remaining > 0) {
                    roundingApplied += this.pos.cashRounding[0].rounding;
                }
                else if(this.pos.cashRounding[0].roundingMethod === "UP" && roundingApplied > 0 && remaining < 0) {
                    roundingApplied -= this.pos.cashRounding[0].rounding;
                }
                else if(this.pos.cashRounding[0].roundingMethod === "DOWN" && roundingApplied > 0 && remaining > 0){
                    roundingApplied -= this.pos.cashRounding[0].rounding;
                }
                else if(this.pos.cashRounding[0].roundingMethod === "DOWN" && roundingApplied < 0 && remaining < 0){
                    roundingApplied += this.pos.cashRounding[0].rounding;
                }
                return sign * roundingApplied;
            }
            else {
                return 0;
            }
        }
        return 0;
    },
    hasNotValidRounding: function() {
        if(!this.pos.config.cashRounding || this.getTotalWithTax() < this.pos.cashRounding[0].rounding)
            return false;

        const onlyCash = this.pos.config.onlyRoundCashMethod;
        var lines = this.paymentlines.models;

        for(var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (onlyCash && !line.paymentMethod.isCashCount)
                continue;

            if(!utils.floatIsZero(line.amount - roundPr(line.amount, this.pos.cashRounding[0].rounding), 6))
                return line;
        }
        return false;
    },
    isPaid: function(){
        return this.getDue() <= 0 && this.checkPaymentlinesRounding();
    },
    isPaidWithCash: function(){
        return !!this.paymentlines.find( function(pl){
            return pl.paymentMethod.isCashCount;
        });
    },
    checkPaymentlinesRounding: function() {
        if(this.pos.config.cashRounding) {
            var cashRounding = this.pos.cashRounding[0].rounding;
            var defaultRounding = this.pos.currency.rounding;
            for(var id in this.getPaymentlines()) {
                var line = this.getPaymentlines()[id];
                var diff = roundPr(roundPr(line.amount, cashRounding) - roundPr(line.amount, defaultRounding), defaultRounding);
                if(this.getTotalWithTax() < this.pos.cashRounding[0].rounding)
                    return true;
                if(diff && line.paymentMethod.isCashCount) {
                    return false;
                } else if(!this.pos.config.onlyRoundCashMethod && diff) {
                    return false;
                }
            }
            return true;
        }
        return true;
    },
    getTotalCost: function() {
        return this.orderlines.reduce((function(sum, orderLine) {
            return sum + orderLine.getTotalCost();
        }), 0)
    },
    finalize: function(){
        this.destroy();
    },
    destroy: function(){
        Backbone.Model.prototype.destroy.apply(this,arguments);
        this.pos.db.removeUnpaidOrder(this);
    },
    /* ---- Invoice --- */
    setToInvoice: function(toInvoice) {
        this.assertEditable();
        this.toInvoice = toInvoice;
    },
    isToInvoice: function(){
        return this.toInvoice;
    },
    /* ---- Client / Customer --- */
    // the client related to the current order.
    setClient: function(client){
        this.assertEditable();
        this.set('client',client);
    },
    getClient: function(){
        return this.get('client');
    },
    getClientName: function(){
        var client = this.get('client');
        return client ? client.label : "";
    },
    getCardholderName: function(){
        var cardPaymentLine = this.paymentlines.find(pl => pl.cardholderName);
        return cardPaymentLine ? cardPaymentLine.cardholderName : "";
    },
    /* ---- Screen Status --- */
    // the order also stores the screen status, as the PoS supports
    // different active screens per order. This method is used to
    // store the screen status.
    setScreenData: function(value){
        this.screenData['value'] = value;
    },
    //see setScreenData
    getScreenData: function(){
        const screen = this.screenData['value'];
        // If no screen data is saved
        //   no payment line -> product screen
        //   with payment line -> payment screen
        if (!screen) {
            if (this.getPaymentlines().length > 0) return { name: 'PaymentScreen' };
            return { name: 'ProductScreen' };
        }
        if (!this.finalized && this.getPaymentlines().length > 0) {
            return { name: 'PaymentScreen' };
        }
        return screen;
    },
    waitForPushOrder: function () {
        return false;
    },
    /**
     * @returns {Object} object to use as props for instantiating OrderReceipt.
     */
    getOrderReceiptEnv: function() {
        // Formerly getReceiptRenderEnv defined in ScreenWidget.
        return {
            order: this,
            receipt: this.exportForPrinting(),
            orderlines: this.getOrderlines(),
            paymentlines: this.getPaymentlines(),
        };
    },
    updatePricelist: function(newClient) {
        let newClientPricelist, newClientFiscalPosition;
        const defaultFiscalPosition = this.pos.fiscalPositions.find(
            (position) => position.id === this.pos.config.defaultFiscalPositionId[0]
        );
        if (newClient) {
            newClientFiscalPosition = newClient.propertyAccountPositionId
                ? this.pos.fiscalPositions.find(
                      (position) => position.id === newClient.propertyAccountPositionId[0]
                  )
                : defaultFiscalPosition;
            newClientPricelist =
                this.pos.pricelists.find(
                    (pricelist) => pricelist.id === newClient.propertyProductPricelist[0]
                ) || this.pos.defaultPricelist;
        } else {
            newClientFiscalPosition = defaultFiscalPosition;
            newClientPricelist = this.pos.defaultPricelist;
        }
        this.fiscalPosition = newClientFiscalPosition;
        this.setPricelist(newClientPricelist);
    },
    /* ---- Ship later --- */
    setToShip: function(toShip) {
        this.assertEditable();
        this.toShip = toShip;
    },
    isToShip: function(){
        return this.toShip;
    },
    getHasRefundLines: function() {
        for (const line of this.getOrderlines()) {
            if (line.refundedOrderlineId) {
                return true;
            }
        }
        return false;
    },
});

var OrderCollection = Backbone.Collection.extend({
    model: exports.Order,
});

// exports = {
//     PosModel: PosModel,
//     loadFields: loadFields,
//     loadModels: loadModels,
//     Orderline: Orderline,
//     Order: Order,
// };
return exports;

});
