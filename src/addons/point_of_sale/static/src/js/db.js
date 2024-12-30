verp.define('point_of_sale.DB', function (require) {
"use strict";

var core = require('web.core');
var utils = require('web.utils');
/* The PosDB holds reference to data that is either
 * - static: does not change between pos reloads
 * - persistent : must stay between reloads ( orders )
 */

var PosDB = core.Class.extend({
    name: 'verp_pos_db', //the prefix of the localstorage data
    limit: 100,  // the maximum number of results returned by a search
    init: function(options){
        options = options || {};
        this.name = options.name || this.name;
        this.limit = options.limit || this.limit;
        
        if (options.uuid) {
            this.name = this.name + '_' + options.uuid;
        }

        //cache the data in memory to avoid roundtrips to the localstorage
        this.cache = {};

        this.productById = {};
        this.productByBarcode = {};
        this.productByCategoryId = {};
        this.productPackagingByBarcode = {};

        this.partnerSorted = [];
        this.partnerById = {};
        this.partnerByBarcode = {};
        this.partnerSearchString = "";
        this.partnerWriteDate = null;

        this.categoryById = {};
        this.rootCategoryId  = 0;
        this.categoryProducts = {};
        this.categoryAncestors = {};
        this.categoryChilds = {};
        this.categoryParent    = {};
        this.categorySearchString = {};
    },

    /** 
     * sets an uuid to prevent conflict in locally stored data between multiple PoS Configs. By
     * using the uuid of the config the local storage from other configs will not get effected nor
     * loaded in sessions that don't belong to them.
     *
     * @param {string} uuid Unique identifier of the PoS Config linked to the current session.
     */
    setUuid: function(uuid){
        this.name = this.name + '_' + uuid;
    },

    /* returns the category object from its id. If you pass a list of id as parameters, you get
     * a list of category objects. 
     */  
    getCategoryById: function(categId){
        if(categId instanceof Array){
            var list = [];
            for(var i = 0, len = categId.length; i < len; i++){
                var cat = this.categoryById[categId[i]];
                if(cat){
                    list.push(cat);
                }else{
                    console.error("getCategoryById: no category has id:",categId[i]);
                }
            }
            return list;
        }else{
            return this.categoryById[categId];
        }
    },
    /* returns a list of the category's child categories ids, or an empty list 
     * if a category has no childs */
    getCategoryChildsIds: function(categId){
        return this.categoryChilds[categId] || [];
    },
    /* returns a list of all ancestors (parent, grand-parent, etc) categories ids
     * starting from the root category to the direct parent */
    getCategoryAncestorsIds: function(categId){
        return this.categoryAncestors[categId] || [];
    },
    /* returns the parent category's id of a category, or the rootCategoryId if no parent.
     * the root category is parent of itself. */
    getCategoryParentId: function(categId){
        return this.categoryParent[categId] || this.rootCategoryId;
    },
    /* adds categories definitions to the database. categories is a list of categories objects as
     * returned by the verp server. Categories must be inserted before the products or the 
     * product/ categories association may (will) not work properly */
    addCategories: function(categories){
        var self = this;
        if(!this.categoryById[this.rootCategoryId]){
            this.categoryById[this.rootCategoryId] = {
                id : this.rootCategoryId,
                name : 'Root',
            };
        }
        categories.forEach(function(cat){
            self.categoryById[cat.id] = cat;
        });
        categories.forEach(function(cat){
            var parentId = cat.parentId[0];
            if(!(parentId && self.categoryById[parentId])){
                parentId = self.rootCategoryId;
            }
            self.categoryParent[cat.id] = parentId;
            if(!self.categoryChilds[parentId]){
                self.categoryChilds[parentId] = [];
            }
            self.categoryChilds[parentId].push(cat.id);
        });
        function makeAncestors(catId, ancestors){
            self.categoryAncestors[catId] = ancestors;

            ancestors = ancestors.slice(0);
            ancestors.push(catId);

            var childs = self.categoryChilds[catId] || [];
            for(var i=0, len = childs.length; i < len; i++){
                makeAncestors(childs[i], ancestors);
            }
        }
        makeAncestors(this.rootCategoryId, []);
    },
    categoryContains: function(categId, productId) {
        var product = this.productById[productId];
        if (product) {
            var cid = product.posCategId[0];
            while (cid && cid !== categId){
                cid = this.categoryParent[cid];
            }
            return !!cid;
        }
        return false;
    },
    /* loads a record store from the database. returns default if nothing is found */
    load: function(store,deft){
        if(this.cache[store] !== undefined){
            return this.cache[store];
        }
        var data = localStorage[this.name + '_' + store];
        if(data !== undefined && data !== ""){
            data = JSON.parse(data);
            this.cache[store] = data;
            return data;
        }else{
            return deft;
        }
    },
    /* saves a record store to the database */
    save: function(store,data){
        localStorage[this.name + '_' + store] = JSON.stringify(data);
        this.cache[store] = data;
    },
    _productSearchString: function(product){
        var str = product.displayName;
        if (product.barcode) {
            str += '|' + product.barcode;
        }
        if (product.defaultCode) {
            str += '|' + product.defaultCode;
        }
        if (product.description) {
            str += '|' + product.description;
        }
        if (product.descriptionSale) {
            str += '|' + product.descriptionSale;
        }
        str  = product.id + ':' + str.replace(/[\n:]/g,'') + '\n';
        return str;
    },
    addProducts: async function(products){
        var storedCategories = this.productByCategoryId;

        if(!products instanceof Array){
            products = [products];
        }
        for(var i = 0, len = products.length; i < len; i++){
            var product = products[i];
            if (product.id in this.productById) continue;
            if (product.availableInPos){
                var searchString = utils.unaccent(this._productSearchString(product));
                var categId = product.posCategId ? product.posCategId[0] : this.rootCategoryId;
                product.productTemplateId = product.productTemplateId[0];
                if(!storedCategories[categId]){
                    storedCategories[categId] = [];
                }
                storedCategories[categId].push(product.id);

                if(this.categorySearchString[categId] === undefined){
                    this.categorySearchString[categId] = '';
                }
                this.categorySearchString[categId] += searchString;

                var ancestors = this.getCategoryAncestorsIds(categId) || [];

                for(var j = 0, jlen = ancestors.length; j < jlen; j++){
                    var ancestor = ancestors[j];
                    if(! storedCategories[ancestor]){
                        storedCategories[ancestor] = [];
                    }
                    storedCategories[ancestor].push(product.id);

                    if( this.categorySearchString[ancestor] === undefined){
                        this.categorySearchString[ancestor] = '';
                    }
                    this.categorySearchString[ancestor] += searchString;
                }
            }
            this.productById[product.id] = product;
            if(product.barcode){
                this.productByBarcode[product.barcode] = product;
            }
        }
    },
    addPackagings: function(productPackagings){
        var self = this;
        _.map(productPackagings, function (productPackaging) {
            if (_.find(self.productById, {'id': productPackaging.productId[0]})) {
                self.productPackagingByBarcode[productPackaging.barcode] = productPackaging;
            }
        });
    },
    _partnerSearchString: function(partner){
        var str =  partner.label || '';
        if(partner.barcode){
            str += '|' + partner.barcode;
        }
        if(partner.address){
            str += '|' + partner.address;
        }
        if(partner.phone){
            str += '|' + partner.phone.split(' ').join('');
        }
        if(partner.mobile){
            str += '|' + partner.mobile.split(' ').join('');
        }
        if(partner.email){
            str += '|' + partner.email;
        }
        if(partner.vat){
            str += '|' + partner.vat;
        }
        str = '' + partner.id + ':' + str.replace(':', '').replace(/\n/g, ' ') + '\n';
        return str;
    },
    addPartners: function(partners){
        var updatedCount = 0;
        var newUpdatedAt = '';
        var partner;
        for(var i = 0, len = partners.length; i < len; i++){
            partner = partners[i];

            var localPartnerDate = (this.partnerWriteDate || '').replace(/^(\d{4}-\d{2}-\d{2}) ((\d{2}:?){3})$/, '$1T$2Z');
            var distPartnerDate = (partner.updatedAt || '').replace(/^(\d{4}-\d{2}-\d{2}) ((\d{2}:?){3})$/, '$1T$2Z');
            if (    this.partnerWriteDate &&
                    this.partnerById[partner.id] &&
                    new Date(localPartnerDate).getTime() + 1000 >=
                    new Date(distPartnerDate).getTime() ) {
                // FIXME: The updatedAt is stored with milisec precision in the database
                // but the dates we get back are only precise to the second. This means when
                // you read partners modified strictly after time X, you get back partners that were
                // modified X - 1 sec ago. 
                continue;
            } else if ( newUpdatedAt < partner.updatedAt ) { 
                newUpdatedAt  = partner.updatedAt;
            }
            if (!this.partnerById[partner.id]) {
                this.partnerSorted.push(partner.id);
            }
            this.partnerById[partner.id] = partner;

            updatedCount += 1;
        }

        this.partnerWriteDate = newUpdatedAt || this.partnerWriteDate;

        if (updatedCount) {
            // If there were updates, we need to completely 
            // rebuild the search string and the barcode indexing

            this.partnerSearchString = "";
            this.partnerByBarcode = {};

            for (var id in this.partnerById) {
                partner = this.partnerById[id];

                if(partner.barcode){
                    this.partnerByBarcode[partner.barcode] = partner;
                }
                partner.address = (partner.street ? partner.street + ', ': '') +
                                  (partner.zip ? partner.zip + ', ': '') +
                                  (partner.city ? partner.city + ', ': '') +
                                  (partner.stateId ? partner.stateId[1] + ', ': '') +
                                  (partner.countryId ? partner.countryId[1]: '');
                this.partnerSearchString += this._partnerSearchString(partner);
            }

            this.partnerSearchString = utils.unaccent(this.partnerSearchString);
        }
        return updatedCount;
    },
    getPartnerUpdatedAt: function(){
        return this.partnerWriteDate || "1970-01-01 00:00:00";
    },
    getPartnerById: function(id){
        return this.partnerById[id];
    },
    getPartnerByBarcode: function(barcode){
        return this.partnerByBarcode[barcode];
    },
    getPartnersSorted: function(maxCount){
        maxCount = maxCount ? Math.min(this.partnerSorted.length, maxCount) : this.partnerSorted.length;
        var partners = [];
        for (var i = 0; i < maxCount; i++) {
            partners.push(this.partnerById[this.partnerSorted[i]]);
        }
        return partners;
    },
    searchPartner: function(query){
        try {
            query = query.replace(/[\[\]\(\)\+\*\?\.\-\!\&\^\$\|\~\_\{\}\:\,\\\/]/g,'.');
            query = query.replace(/ /g,'.+');
            var re = RegExp("([0-9]+):.*?"+utils.unaccent(query),"gi");
        }catch(e){
            return [];
        }
        var results = [];
        for(var i = 0; i < this.limit; i++){
            var r = re.exec(this.partnerSearchString);
            if(r){
                var id = Number(r[1]);
                results.push(this.getPartnerById(id));
            }else{
                break;
            }
        }
        return results;
    },
    /* removes all the data from the database. TODO : being able to selectively remove data */
    clear: function(){
        for(var i = 0, len = arguments.length; i < len; i++){
            localStorage.removeItem(this.name + '_' + arguments[i]);
        }
    },
    /* this internal methods returns the count of properties in an object. */
    _countProps : function(obj){
        var count = 0;
        for(var prop in obj){
            if(obj.hasOwnProperty(prop)){
                count++;
            }
        }
        return count;
    },
    getProductById: function(id){
        return this.productById[id];
    },
    getProductByBarcode: function(barcode){
        if(this.productByBarcode[barcode]){
            return this.productByBarcode[barcode];
        } else if (this.productPackagingByBarcode[barcode]) {
            return this.productById[this.productPackagingByBarcode[barcode].productId[0]];
        }
        return undefined;
    },
    getProductByCategory: function(categoryId){
        var productIds  = this.productByCategoryId[categoryId];
        var list = [];
        if (productIds) {
            for (var i = 0, len = Math.min(productIds.length, this.limit); i < len; i++) {
                const product = this.productById[productIds[i]];
                if (!(product.active && product.availableInPos)) continue;
                list.push(product);
            }
        }
        return list;
    },
    /* returns a list of products with :
     * - a category that is or is a child of categoryId,
     * - a name, package or barcode containing the query (case insensitive) 
     */
    searchProductInCategory: function(categoryId, query){
        try {
            query = query.replace(/[\[\]\(\)\+\*\?\.\-\!\&\^\$\|\~\_\{\}\:\,\\\/]/g,'.');
            query = query.replace(/ /g,'.+');
            var re = RegExp("([0-9]+):.*?"+utils.unaccent(query),"gi");
        }catch(e){
            return [];
        }
        var results = [];
        for(var i = 0; i < this.limit; i++){
            var r = re.exec(this.categorySearchString[categoryId]);
            if(r){
                var id = Number(r[1]);
                const product = this.getProductById(id);
                if (!(product.active && product.availableInPos)) continue;
                results.push(product);
            }else{
                break;
            }
        }
        return results;
    },
    /* from a product id, and a list of category ids, returns
     * true if the product belongs to one of the provided category
     * or one of its child categories.
     */
    isProductInCategory: function(categoryIds, productId) {
        if (!(categoryIds instanceof Array)) {
            categoryIds = [categoryIds];
        }
        var cat = this.getProductById(productId).posCategId[0];
        while (cat) {
            for (var i = 0; i < categoryIds.length; i++) {
                if (cat == categoryIds[i]) {   // The == is important, ids may be strings
                    return true;
                }
            }
            cat = this.getCategoryParentId(cat);
        }
        return false;
    },

    /* paid orders */
    addOrder: function(order){
        var orderId = order.uid;
        var orders  = this.load('orders',[]);

        // if the order was already stored, we overwrite its data
        for(var i = 0, len = orders.length; i < len; i++){
            if(orders[i].id === orderId){
                orders[i].data = order;
                this.save('orders',orders);
                return orderId;
            }
        }

        // Only necessary when we store a new, validated order. Orders
        // that where already stored should already have been removed.
        this.removeUnpaidOrder(order);

        orders.push({id: orderId, data: order});
        this.save('orders',orders);
        return orderId;
    },
    removeOrder: function(orderId){
        var orders = this.load('orders',[]);
        orders = _.filter(orders, function(order){
            return order.id !== orderId;
        });
        this.save('orders',orders);
    },
    removeAllOrders: function(){
        this.save('orders',[]);
    },
    getOrders: function(){
        return this.load('orders',[]);
    },
    getOrder: function(orderId){
        var orders = this.getOrders();
        for(var i = 0, len = orders.length; i < len; i++){
            if(orders[i].id === orderId){
                return orders[i];
            }
        }
        return undefined;
    },

    /* working orders */
    saveUnpaidOrder: function(order){
        var orderId = order.uid;
        var orders = this.load('unpaidOrders',[]);
        var serialized = order.exportAsJSON();

        for (var i = 0; i < orders.length; i++) {
            if (orders[i].id === orderId){
                orders[i].data = serialized;
                this.save('unpaidOrders',orders);
                return orderId;
            }
        }

        orders.push({id: orderId, data: serialized});
        this.save('unpaidOrders',orders);
        return orderId;
    },
    removeUnpaidOrder: function(order){
        var orders = this.load('unpaidOrders',[]);
        orders = _.filter(orders, function(o){
            return o.id !== order.uid;
        });
        this.save('unpaidOrders',orders);
    },
    removeAllUnpaidOrders: function(){
        this.save('unpaidOrders',[]);
    },
    getUnpaidOrders: function(){
        var saved = this.load('unpaidOrders',[]);
        var orders = [];
        for (var i = 0; i < saved.length; i++) {
            orders.push(saved[i].data);
        }
        return orders;
    },
    /**
     * Return the orders with requested ids if they are unpaid.
     * @param {array<string>} ids orderIds (uid).
     * @return {array<object>} list of orders.
     */
    getUnpaidOrdersToSync: function(ids){
        var saved = this.load('unpaidOrders',[]);
        var orders = [];
        saved.forEach(function(o) {
            if (ids.includes(o.id) && (o.data.serverId || o.data.lines.length || o.data.statementIds.length)){
                orders.push(o);
            }
        });
        return orders;
    },
    /**
     * Add a given order to the orders to be removed from the server.
     *
     * If an order is removed from a table it also has to be removed from the server to prevent it from reapearing 
     * after syncing. This function will add the serverId of the order to a list of orders still to be removed.
     * @param {object} order object.
     */
    setOrderToRemoveFromServer: function(order){
        if (order.serverId !== undefined) {
            var toRemove = this.load('unpaidOrdersToRemove',[]);
            toRemove.push(order.serverId);
            this.save('unpaidOrdersToRemove', toRemove);
        }
    },
    /**
     * Get a list of serverIds of orders to be removed.
     * @return {array<number>} list of serverIds.
     */
    getIdsToRemoveFromServer: function(){
        return this.load('unpaidOrdersToRemove',[]);
    },
    /**
     * Remove serverIds from the list of orders to be removed.
     * @param {array<number>} ids
     */
    setIdsRemovedFromServer: function(ids){
        var toRemove = this.load('unpaidOrdersToRemove',[]);
        
        toRemove = _.filter(toRemove, function(id){
            return !ids.includes(id);
        });
        this.save('unpaidOrdersToRemove', toRemove);
    },
    setCashier: function(cashier) {
        // Always update if the user is the same as before
        this.save('cashier', cashier || null);
    },
    getCashier: function() {
        return this.load('cashier');
    }
});

return PosDB;

});

