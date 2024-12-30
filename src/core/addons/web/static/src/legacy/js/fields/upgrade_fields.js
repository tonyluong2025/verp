verp.define('web.upgradeWidgets', function (require) {
"use strict";

/**
 *  The upgrade widgets are intended to be used in config settings.
 *  When checked, an upgrade popup is showed to the user.
 */

var AbstractField = require('web.AbstractField');
var basicFields = require('web.basicFields');
var core = require('web.core');
var Dialog = require('web.Dialog');
var fieldRegistry = require('web.fieldRegistry');
var framework = require('web.framework');
var relationalFields = require('web.relationalFields');

var _t = core._t;
var QWeb = core.qweb;

var FieldBoolean = basicFields.FieldBoolean;
var FieldRadio = relationalFields.FieldRadio;


/**
 * Mixin that defines the common functions shared between Boolean and Radio
 * upgrade widgets
 */
var AbstractFieldUpgrade = {
    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Redirects the user to the verp-enterprise/uprade page
     *
     * @private
     * @returns {Promise}
     */
    _confirmUpgrade: function () {
        return this._rpc({
                model: 'res.users',
                method: 'searchCount',
                args: [[["share", "=", false]]],
            })
            .then(function (data) {
                framework.redirect("https://www.theverp.com/verp-enterprise/upgrade?numUsers=" + data);
            });
    },
    /**
     * This function is meant to be overridden to insert the 'Enterprise' label
     * JQuery node at the right place.
     *
     * @abstract
     * @private
     * @param {jQuery} $enterpriseLabel the 'Enterprise' label to insert
     */
    _insertEnterpriseLabel: function ($enterpriseLabel) {},
    /**
     * Opens the Upgrade dialog.
     *
     * @private
     * @returns {Dialog} the instance of the opened Dialog
     */
    _openDialog: function () {
        var message = $(QWeb.render('EnterpriseUpgrade'));

        var buttons = [
            {
                text: _t("Upgrade now"),
                classes: 'btn-primary',
                close: true,
                click: this._confirmUpgrade.bind(this),
            },
            {
                text: _t("Cancel"),
                close: true,
            },
        ];

        return new Dialog(this, {
            size: 'medium',
            buttons: buttons,
            $content: $('<div>', {
                html: message,
            }),
            title: _t("Verp Enterprise"),
        }).open();
    },
    /**
     * @override
     * @private
     */
    _render: function () {
        this._super.apply(this, arguments);
        this._insertEnterpriseLabel($("<span>", {
            text: "Enterprise",
            'class': "badge badge-primary oe-inline o-enterprise-label"
        }));
    },
    /**
     * This function is meant to be overridden to reset the $el to its initial
     * state.
     *
     * @abstract
     * @private
     */
    _resetValue: function () {},

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} event
     */
    _onInputClicked: function (event) {
        if ($(event.currentTarget).prop("checked")) {
            this._openDialog().on('closed', this, this._resetValue.bind(this));
        }
    },

};

var UpgradeBoolean = FieldBoolean.extend(AbstractFieldUpgrade, {
    supportedFieldTypes: [],
    events: _.extend({}, AbstractField.prototype.events, {
        'click input': '_onInputClicked',
    }),
    /**
     * Re-renders the widget with the label
     *
     * @param {jQuery} $label
     */
    renderWithLabel: function ($label) {
        this.$label = $label;
        this._render();
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _insertEnterpriseLabel: function ($enterpriseLabel) {
        var $el = this.$label || this.$el;
        $el.append('&nbsp;').append($enterpriseLabel);
    },
    /**
     * @override
     * @private
     */
    _resetValue: function () {
        this.$input.prop("checked", false).change();
    },
});

var UpgradeRadio = FieldRadio.extend(AbstractFieldUpgrade, {
    supportedFieldTypes: [],
    events: _.extend({}, FieldRadio.prototype.events, {
        'click input:last': '_onInputClicked',
    }),

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    isSet: function () {
        return true;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _insertEnterpriseLabel: function ($enterpriseLabel) {
        this.$('label').last().append('&nbsp;').append($enterpriseLabel);
    },
    /**
     * @override
     * @private
     */
    _resetValue: function () {
        this.$('input').first().prop("checked", true).click();
    },
});

fieldRegistry
    .add('upgradeBoolean', UpgradeBoolean)
    .add('upgradeRadio', UpgradeRadio);

});
