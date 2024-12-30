verp.define('web.Signature', function (require) {
    "use strict";

    var AbstractFieldBinary = require('web.basicFields').AbstractFieldBinary;
    var core = require('web.core');
    var fieldUtils = require('web.fieldUtils');
    var registry = require('web.fieldRegistry');
    var session = require('web.session');
    const SignatureDialog = require('web.signatureDialog');
    var utils = require('web.utils');


    var qweb = core.qweb;
    var _t = core._t;
    var _lt = core._lt;

var FieldBinarySignature = AbstractFieldBinary.extend({
    description: _lt("Signature"),
    fieldDependencies: _.extend({}, AbstractFieldBinary.prototype.fieldDependencies, {
        __lastUpdate: {type: 'datetime'},
    }),
    resetOnAnyFieldChange: true,
    customEvents: _.extend({}, AbstractFieldBinary.prototype.customEvents, {
        uploadSignature: '_onUploadSignature',
    }),
    events: _.extend({}, AbstractFieldBinary.prototype.events, {
        'click .o-signature': '_onClickSignature',
    }),
    template: null,
    supportedFieldTypes: ['binary'],
    fileTypeMagicWord: {
        '/': 'jpg',
        'R': 'gif',
        'i': 'png',
        'P': 'svg+xml',
    },
    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * This widget must always have render even if there are no signature.
     * In edit mode, the real value is return to manage required fields.
     *
     * @override
     */
    isSet: function () {
        return this.value;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Renders an empty signature or the saved signature. Both must have the same size.
     *
     * @override
     * @private
     */

    _render: function () {
        var self = this;
        var displaySignatureRatio = 3;
        var url;
        var $img;
        var width = this.nodeOptions.size ? this.nodeOptions.size[0] : this.attrs.width;
        var height = this.nodeOptions.size ? this.nodeOptions.size[1] : this.attrs.height;
        if (this.value) {
            if (!utils.isBinSize(this.value)) {
                // Use magic-word technique for detecting image type
                url = 'data:image/' + (this.fileTypeMagicWord[this.value[0]] || 'png') + ';base64,' + this.value;
            } else {
                url = session.url('/web/image', {
                    model: this.model,
                    id: JSON.stringify(this.resId),
                    field: this.nodeOptions.previewImage || this.name,
                    // unique forces a reload of the image when the record has been updated
                    unique: fieldUtils.format.datetime(this.recordData.__lastUpdate).replace(/[^0-9]/g, ''),
                });
            }
            $img = $(qweb.render("FieldBinarySignature-img", {widget: this, url: url}));
        } else {
            $img = $('<div class="o-signature o-signature-empty"><svg></svg><p>' + _t('SIGNATURE') + '</p></div>');
            if (width && height) {
                width = Math.min(width, displaySignatureRatio * height);
                height = width / displaySignatureRatio;
            } else if (width) {
                height = width / displaySignatureRatio;
            } else if (height) {
                width = height * displaySignatureRatio;
            }
        }
        if (width) {
            $img.attr('width', width);
            $img.css('max-width', width + 'px');
        }
        if (height) {
            $img.attr('height', height);
            $img.css('max-height', height + 'px');
        }
        this.$('> div').remove();
        this.$('> img').remove();

        this.$el.prepend($img);

        $img.on('error', function () {
            self._clearFile();
            $img.attr('src', self.placeholder);
            self.displayNotification({ message: _t("Could not display the selected image"), type: 'danger' });
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * If the view is in edit mode, open dialog to sign.
     *
     * @private
     */
    _onClickSignature: function () {
        var self = this;
        if (this.mode === 'edit') {

            var nameAndSignatureOptions = {
                mode: 'draw',
                displaySignatureRatio: 3,
                signatureType: 'signature',
                noInputName: true,
            };

            if (this.nodeOptions.fullName) {
                var signName;
                if (this.fields[this.nodeOptions.fullName].type === 'many2one') {
                    // If m2o is empty, it will have falsy value in recordData
                    signName = this.recordData[this.nodeOptions.fullName] && this.recordData[this.nodeOptions.fullName].data.displayName;
                } else {
                     signName = this.recordData[this.nodeOptions.fullName];
                 }
                nameAndSignatureOptions.defaultName = (signName === '') ? undefined : signName;
            }

            nameAndSignatureOptions.defaultFont = this.nodeOptions.defaultFont || '';
            this.signDialog = new SignatureDialog(self, {nameAndSignatureOptions: nameAndSignatureOptions});

            this.signDialog.open();
        }
    },

    /**
     * Upload the signature image if valid and close the dialog.
     *
     * @private
     */
    _onUploadSignature: function (ev) {
        var signatureImage = ev.data.signatureImage;
        if (signatureImage !== this.signDialog.emptySignature) {
            var data = signatureImage[1];
            var type = signatureImage[0].split('/')[1];
            this.onFileUploaded(data.length, ev.data.name, type, data);
        }
        this.signDialog.close();
    }
});

registry.add('signature', FieldBinarySignature);

});
