verp.define('web.signatureWidget', function (require) {
"use strict";

const framework = require('web.framework');
const SignatureDialog = require('web.signatureDialog');
const widgetRegistry = require('web.widgetRegistryOld');
const Widget = require('web.Widget');


const WidgetSignature = Widget.extend({
    customEvents: Object.assign({}, Widget.prototype.customEvents, {
        uploadSignature: '_onUploadSignature',
    }),
    events: Object.assign({}, Widget.prototype.events, {
        'click .o-sign-label': '_onClickSignature',
    }),
    template: 'SignButton',
    /**
     * @constructor
     * @param {Widget} parent
     * @param {Object} record
     * @param {Object} nodeInfo
     */
    init: function (parent, record, nodeInfo) {
        this._super.apply(this, arguments);
        this.resId = record.resId;
        this.resModel = record.model;
        this.state = record;
        this.node = nodeInfo;
        // signatureField is the field on which the signature image will be
        // saved (`signature` by default).
        this.signatureField = this.node.attrs.signatureField || 'signature';
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Open a dialog to sign.
     *
     * @private
     */
    _onClickSignature: function () {
        const nameAndSignatureOptions = {
            displaySignatureRatio: 3,
            mode: 'draw',
            noInputName: true,
            signatureType: 'signature',
        };

        if (this.node.attrs.fullName) {
            let signName;
            const fieldFullName = this.state.data[this.node.attrs.fullName];
            if (fieldFullName && fieldFullName.type === 'record') {
                signName = fieldFullName.data.displayName;
            } else {
                signName = fieldFullName;
            }
            nameAndSignatureOptions.defaultName = signName || undefined;
        }

        nameAndSignatureOptions.defaultFont = this.node.attrs.defaultFont || '';
        this.signDialog = new SignatureDialog(this, {
            nameAndSignatureOptions: nameAndSignatureOptions,
        });
        this.signDialog.open();
    },
    /**
     * Upload the signature image (write it on the corresponding field) and
     * close the dialog.
     *
     * @returns {Promise}
     * @private
     */
    _onUploadSignature: function (ev) {
        const file = ev.data.signatureImage[1];
        const always = () => {
            this.triggerUp('reload');
            framework.unblockUI();
        };
        framework.blockUI();
        const rpcProm = this._rpc({
            model: this.resModel,
            method: 'write',
            args: [[this.resId], {
                [this.signatureField]: file,
            }],
        });
        rpcProm.then(always).guardedCatch(always);
        return rpcProm;
    },
});

widgetRegistry.add('signature', WidgetSignature);

});
