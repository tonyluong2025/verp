verp.define('portal.composer', function (require) {
'use strict';

var ajax = require('web.ajax');
var core = require('web.core');
var publicWidget = require('web.public.widget');

var qweb = core.qweb;
var _t = core._t;

/**
 * Widget PortalComposer
 *
 * Display the composer (according to access right)
 *
 */
var PortalComposer = publicWidget.Widget.extend({
    template: 'portal.Composer',
    xmlDependencies: ['/portal/static/src/xml/portal_chatter.xml'],
    events: {
        'change .o-portal-chatter-file-input': '_onFileInputChange',
        'click .o-portal-chatter-attachment-btn': '_onAttachmentButtonClick',
        'click .o-portal-chatter-attachment-delete': 'async _onAttachmentDeleteClick',
        'click .o-portal-chatter-composer-btn': 'async _onSubmitButtonClick',
    },

    /**
     * @constructor
     */
    init: function (parent, options) {
        this._super.apply(this, arguments);
        this.options = _.defaults(options || {}, {
            'allowComposer': true,
            'displayComposer': false,
            'csrfToken': verp.csrfToken,
            'token': false,
            'resModel': false,
            'resId': false,
        });
        this.attachments = [];
    },
    /**
     * @override
     */
    start: function () {
        var self = this;
        this.$attachmentButton = this.$('.o-portal-chatter-attachment-btn');
        this.$fileInput = this.$('.o-portal-chatter-file-input');
        this.$sendButton = this.$('.o-portal-chatter-composer-btn');
        this.$attachments = this.$('.o-portal-chatter-composer-input .o-portal-chatter-attachments');
        this.$inputTextarea = this.$('.o-portal-chatter-composer-input textarea[name="message"]');

        return this._super.apply(this, arguments).then(function () {
            if (self.options.default_attachmentIds) {
                self.attachments = self.options.default_attachmentIds || [];
                _.each(self.attachments, function(attachment) {
                    attachment.state = 'done';
                });
                self._updateAttachments();
            }
            return Promise.resolve();
        });
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onAttachmentButtonClick: function () {
        this.$fileInput.click();
    },
    /**
     * @private
     * @param {Event} ev
     * @returns {Promise}
     */
    _onAttachmentDeleteClick: function (ev) {
        var self = this;
        var attachmentId = $(ev.currentTarget).closest('.o-portal-chatter-attachment').data('id');
        var accessToken = _.find(this.attachments, {'id': attachmentId}).accessToken;
        ev.preventDefault();
        ev.stopPropagation();

        this.$sendButton.prop('disabled', true);

        return this._rpc({
            route: '/portal/attachment/remove',
            params: {
                'attachmentId': attachmentId,
                'accessToken': accessToken,
            },
        }).then(function () {
            self.attachments = _.reject(self.attachments, {'id': attachmentId});
            self._updateAttachments();
            self.$sendButton.prop('disabled', false);
        });
    },
    _prepareAttachmentData: function (file) {
        return {
            'label': file.label,
            'file': file,
            'resId': this.options.resId,
            'resModel': this.options.resModel,
            'accessToken': this.options.token,
        };
    },
    /**
     * @private
     * @returns {Promise}
     */
    _onFileInputChange: function () {
        var self = this;

        this.$sendButton.prop('disabled', true);

        return Promise.all(_.map(this.$fileInput[0].files, function (file) {
            return new Promise(function (resolve, reject) {
                var data = self._prepareAttachmentData(file);
                ajax.post('/portal/attachment/add', data).then(function (attachment) {
                    attachment.state = 'pending';
                    self.attachments.push(attachment);
                    self._updateAttachments();
                    resolve();
                }).guardedCatch(function (error) {
                    self.displayNotification({
                        message: _.str.sprintf(_t("Could not save file <strong>%s</strong>"),
                            _.escape(file.name)),
                        type: 'warning',
                        sticky: true,
                    });
                    resolve();
                });
            });
        })).then(function () {
            // ensures any selection triggers a change, even if the same files are selected again
            self.$fileInput[0].value = null;
            self.$sendButton.prop('disabled', false);
        });
    },
    /**
     * prepares data to send message
     *
     * @private
     */
    _prepareMessageData: function () {
        return Object.assign(this.options || {}, {
            'message': this.$('textarea[name="message"]').val(),
            'attachmentIds': _.pluck(this.attachments, 'id'),
            'attachmentTokens': _.pluck(this.attachments, 'accessToken'),
        });
    },
    /**
     * @private
     * @param {Event} ev
     */
    _onSubmitButtonClick: function (ev) {
        ev.preventDefault();
        if (!this.$inputTextarea.val().trim() && !this.attachments.length) {
            this.$inputTextarea.addClass('border-danger');
            const error = _t('Some fields are required. Please make sure to write a message or attach a document');
            this.$(".o-portal-chatter-composer-error").text(error).removeClass('d-none');
            return Promise.reject();
        } else {
            return this._chatterPostMessage(ev.currentTarget.getAttribute('data-action'));
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _updateAttachments: function () {
        this.$attachments.html(qweb.render('portal.Chatter.Attachments', {
            attachments: this.attachments,
            showDelete: true,
        }));
    },
    /**
     * post message using rpc call and display new message and message count
     *
     * @private
     * @param {String} route
     * @returns {Promise}
     */
    _chatterPostMessage: async function (route) {
        const result = await this._rpc({
            route: route,
            params: this._prepareMessageData(),
        });
        core.bus.trigger('reloadChatterContent', result);
        return result;
    },
});

return {
    PortalComposer: PortalComposer,
};
});
