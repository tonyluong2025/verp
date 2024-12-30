verp.define('partner_autocomplete.many2one', function (require) {
'use strict';

var FieldMany2One = require('web.relationalFields').FieldMany2One;
var core = require('web.core');
var AutocompleteMixin = require('partner_autocomplete.Mixin');
var fieldRegistry = require('web.fieldRegistry');

var _t = core._t;

var PartnerField = FieldMany2One.extend(AutocompleteMixin, {
    jsLibs: [
        '/partner_autocomplete/static/lib/jsvat.js'
    ],

    /**
     * @override
     */
    init: function () {
        this._super.apply(this, arguments);
        this._addAutocompleteSource(this._searchSuggestions, {
            placeholder: _t('Searching Autocomplete...'),
            order: 20,
            validation: this._validateSearchTerm,
        });

        this.additionalContext['showVat'] = true;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Action : create popup form with pre-filled values from Autocomplete
     *
     * @param {Object} company
     * @returns {Promise}
     * @private
     */
    _createPartner: function (company) {
        var self = this;
        self.$('input').val('');

        return self._getCreateData(company).then(function (data){
            var context = {
                'default_isCompany': true
            };
            _.each(data.company, function (val, key) {
                context['default_' + jQuery.upperFirst(jQuery.camelCase(key))] = val && val.id ? val.id : val;
            });

            // if(data.company.street_name && !data.company.street_number) context.default_street_number = '';
            if (data.logo) context.default_image1920 = data.logo;

            return self._searchCreatePopup("form", false, context);
        });
    },

    /**
     * Modify autocomplete results rendering
     * Add logo in the autocomplete results if logo is provided
     *
     * @private
     */
    _modifyAutompleteRendering: function (){
        var api = this.$input.data('ui-autocomplete');
        // FIXME: bugfix to prevent traceback in mobile apps due to override
        // of Many2one widget with native implementation.
        if (!api) {
            return;
        }
        api._renderItem = function(ul, item){
            ul.addClass('o_partner_autocomplete_dropdown');
            var $a = $('<a/>')["html"](item.label);
            if (item.logo){
                var $img = $('<img/>').attr('src', item.logo);
                $a.append($img);
            }

            return $("<li></li>")
                .data("item.autocomplete",item)
                .append($a)
                .appendTo(ul)
                .addClass(item.classname);
        };
    },

    /**
     * @override
     * @private
     */
    _renderEdit: function (){
        this._super.apply(this, arguments);
        this._modifyAutompleteRendering();
    },

    /**
     * Query Autocomplete and add results to the popup
     *
     * @override
     * @param searchVal {string}
     * @returns {Promise}
     * @private
     */
    _searchSuggestions: function (searchVal) {
        var self = this;
        return new Promise(function (resolve, reject) {
            if (self._isOnline()) {

                self._autocomplete(searchVal).then(function (suggestions) {
                    var choices = [];
                    if (suggestions && suggestions.length) {
                        _.each(suggestions, function (suggestion) {
                            var label = '<i class="fa fa-magic text-muted"/> ';
                            label += _.str.sprintf('%s, <span class="text-muted">%s</span>', suggestion.label, suggestion.description);

                            choices.push({
                                label: label,
                                action: function () {
                                    self._createPartner(suggestion);
                                },
                                logo: suggestion.logo,
                                classname: 'o_partner_autocomplete_dropdown_item',
                            });
                        });
                    }

                    resolve(choices);
                });
            } else {
               resolve([]);
            }
        });
    },
});

fieldRegistry.add('resPartnerMany2one', PartnerField);

return PartnerField;
});
