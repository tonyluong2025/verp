/* global checkVATNumber */
verp.define('partner_autocomplete.Mixin', function (require) {
'use strict';

var concurrency = require('web.concurrency');

var core = require('web.core');
var Qweb = core.qweb;
var utils = require('web.utils');
var _t = core._t;

/**
 * This mixin only works with classes having EventDispatcherMixin in 'web.mixins'
 */
var PartnerAutocompleteMixin = {
    _dropPreviousverp: new concurrency.DropPrevious(),
    _dropPreviousClearbit: new concurrency.DropPrevious(),
    _timeout : 1000, // Timeout for Clearbit autocomplete in ms

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Get list of companies via Autocomplete API
     *
     * @param {string} value
     * @returns {Promise}
     * @private
     */
    _autocomplete: function (value) {
        var self = this;
        value = value.trim();
        var isVAT = this._isVAT(value);
        var verpSuggestions = [];
        var clearbitSuggestions = [];
        return new Promise(function (resolve, reject) {
            var verpPromise = self._getverpSuggestions(value, isVAT).then(function (suggestions){
                verpSuggestions = suggestions;
            });

            // Only get Clearbit suggestions if not a VAT number
            var clearbitPromise = isVAT ? false : self._getClearbitSuggestions(value).then(function (suggestions){
                clearbitSuggestions = suggestions;
            });

            var concatResults = function () {
                // Add Clearbit result with Verp result (with unique domain)
                if (clearbitSuggestions && clearbitSuggestions.length) {
                    var websites = verpSuggestions.map(function (suggestion) {
                        return suggestion.website;
                    });
                    clearbitSuggestions.forEach(function (suggestion) {
                        if (websites.indexOf(suggestion.domain) < 0) {
                            websites.push(suggestion.domain);
                            verpSuggestions.push(suggestion);
                        }
                    });
                }

                verpSuggestions = _.filter(verpSuggestions, function (suggestion) {
                    return !suggestion.ignored;
                });
                _.each(verpSuggestions, function(suggestion){
                delete suggestion.ignored;
                });
                return resolve(verpSuggestions);
            };

            self._whenAll([verpPromise, clearbitPromise]).then(concatResults, concatResults);
        });

    },

    /**
     * Get enrichment data
     *
     * @param {Object} company
     * @param {string} company.website
     * @param {string} company.partnerGid
     * @param {string} company.vat
     * @returns {Promise}
     * @private
     */
    _enrichCompany: function (company) {
        return this._rpc({
            model: 'res.partner',
            method: 'enrichCompany',
            args: [company.website, company.partnerGid, company.vat],
        });
    },

    /**
     * Get the company logo as Base 64 image from url
     *
     * @param {string} url
     * @returns {Promise}
     * @private
     */
    _getCompanyLogo: function (url) {
        return this._getBase64Image(url).then(function (base64Image) {
            // base64Image equals "data:" if image not available on given url
            return base64Image ? base64Image.replace(/^data:image[^;]*;base64,?/, '') : false;
        }).catch(function () {
            return false;
        });
    },

    /**
     * Get enriched data + logo before populating partner form
     *
     * @param {Object} company
     * @returns {Promise}
     */
    _getCreateData: function (company) {
        var self = this;

        var removeUselessFields = function (company) {
            var fields = 'label,description,domain,logo,legalName,ignored,email'.split(',');
            fields.forEach(function (field) {
                delete company[field];
            });

            var notEmptyFields = "countryId,stateId".split(',');
            notEmptyFields.forEach(function (field) {
                if (!company[field]) delete company[field];
            });
        };

        return new Promise(function (resolve) {
            // Fetch additional company info via Autocomplete Enrichment API
            var enrichPromise = self._enrichCompany(company);

            // Get logo
            var logoPromise = company.logo ? self._getCompanyLogo(company.logo) : false;
            self._whenAll([enrichPromise, logoPromise]).then(function (result) {
                var companyData = result[0];
                var logoData = result[1];

                // The vat should be returned for free. This is the reason why
                // we add it into the data of 'company' even if an error such as
                // an insufficient credit error is raised. 
                if (companyData.error && companyData.vat) {
                    company.vat = companyData.vat;
                }

                if (companyData.error) {
                    if (companyData.errorMessage === 'Insufficient Credit') {
                        self._notifyNoCredits();
                    } else if (companyData.errorMessage === 'No Account Token') {
                        self._notifyAccountToken();
                    } else {
                        self.displayNotification({ message: companyData.errorMessage });
                    }
                    companyData = company;
                }

                if (_.isEmpty(companyData)) {
                    companyData = company;
                }

                // Delete attribute to avoid "Field_changed" errors
                removeUselessFields(companyData);

                // Assign VAT coming from parent VIES VAT query
                if (company.vat) {
                    companyData.vat = company.vat;
                }
                resolve({
                    company: companyData,
                    logo: logoData
                });
            });
        });
    },

    /**
     * Check connectivity
     *
     * @returns {boolean}
     */
    _isOnline: function () {
        return navigator && navigator.onLine;
    },

    /**
     * Validate: Not empty and length > 1
     *
     * @param {string} searchVal
     * @param {string} onlyVAT : Only valid VAT Number search
     * @returns {boolean}
     * @private
     */
    _validateSearchTerm: function (searchVal, onlyVAT) {
        if (onlyVAT) return this._isVAT(searchVal);
        else return searchVal && searchVal.length > 2;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Returns a promise which will be resolved with the base64 data of the
     * image fetched from the given url.
     *
     * @private
     * @param {string} url : the url where to find the image to fetch
     * @returns {Promise}
     */
    _getBase64Image: function (url) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.onload = function () {
                utils.getDataURLFromFile(xhr.response).then(resolve);
            };
            xhr.open('GET', url);
            xhr.responseType = 'blob';
            xhr.onerror = reject;
            xhr.send();
        });
    },

    /**
     * Use Clearbit Autocomplete API to return suggestions
     *
     * @param {string} value
     * @returns {Promise}
     * @private
     */
    _getClearbitSuggestions: function (value) {
        var url = 'https://autocomplete.clearbit.com/v1/companies/suggest?query=' + value;
        var def = $.ajax({
            url: url,
            dataType: 'json',
            timeout: this._timeout,
            success: function (suggestions) {
                suggestions.map(function (suggestion) {
                    suggestion.label = suggestion.label;
                    suggestion.website = suggestion.domain;
                    suggestion.description = suggestion.website;
                    return suggestion;
                });
                return suggestions;
            },
        });

        return this._dropPreviousClearbit.add(def);
    },

    /**
     * Use Verp Autocomplete API to return suggestions
     *
     * @param {string} value
     * @param {boolean} isVAT
     * @returns {Promise}
     * @private
     */
    _getverpSuggestions: function (value, isVAT) {
        var method = isVAT ? 'readByVat' : 'autocomplete';

        var def = this._rpc({
            model: 'res.partner',
            method: method,
            args: [value],
        }, {
            shadow: true,
        }).then(function (suggestions) {
            suggestions.map(function (suggestion) {
                suggestion.logo = suggestion.logo || '';
                suggestion.label = suggestion.legalName || suggestion.label;
                if (suggestion.vat) suggestion.description = suggestion.vat;
                else if (suggestion.website) suggestion.description = suggestion.website;

                if (suggestion.countryId && suggestion.countryId.displayName) {
                    if (suggestion.description) suggestion.description += _.str.sprintf(' (%s)', suggestion.countryId.displayName);
                    else suggestion.description += suggestion.countryId.displayName;
                }

                return suggestion;
            });
            return suggestions;
        });

        return this._dropPreviousverp.add(def);
    },
    /**
     * Check if searched value is possibly a VAT : 2 first chars = alpha + min 5 numbers
     *
     * @param {string} searchVal
     * @returns {boolean}
     * @private
     */
    _isVAT: function (searchVal) {
        var str = this._sanitizeVAT(searchVal);
        return checkVATNumber(str);
    },

    /**
     * Sanitize search value by removing all not alphanumeric
     *
     * @param {string} searchValue
     * @returns {string}
     * @private
     */
    _sanitizeVAT: function (searchValue) {
        return searchValue ? searchValue.replace(/[^A-Za-z0-9]/g, '') : '';
    },

    /**
     * Utility to wait for multiple promises
     * Promise.all will reject all promises whenever a promise is rejected
     * This utility will continue
     *
     * @param {Promise[]} promises
     * @returns {Promise}
     * @private
     */
    _whenAll: function (promises) {
        return Promise.all(promises.map(function (p) {
            return Promise.resolve(p);
        }));
    },

    /**
     * @private
     * @returns {Promise}
     */
    _notifyNoCredits: function () {
        var self = this;
        return this._rpc({
            model: 'iap.account',
            method: 'getCreditsUrl',
            args: ['partner_autocomplete'],
        }).then(function (url) {
            var title = _t('Not enough credits for Partner Autocomplete');
            var content = Qweb.render('partner_autocomplete.insufficientCreditNotification', {
                creditsUrl: url
            });
            self.displayNotification({
                title,
                message: utils.Markup(content),
                className: 'o-partner-autocomplete-no-credits-notify',
            });
        });
    },

    _notifyAccountToken: function () {
        var self = this;
        return this._rpc({
            model: 'iap.account',
            method: 'getConfigAccountUrl',
            args: []
        }).then(function (url) {
            var title = _t('IAP Account Token missing');
            if (url){
                var content = Qweb.render('partner_autocomplete.accountToken', {
                    accountUrl: url
                });
                self.displayNotification({
                    title,
                    message: utils.Markup(content),
                    className: 'o-partner-autocomplete-no-credits-notify',
                });
            }
            else {
                self.displayNotification({ title });
            }
        });
    },
};

return PartnerAutocompleteMixin;

});
