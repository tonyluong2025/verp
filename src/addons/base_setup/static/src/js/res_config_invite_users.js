verp.define('base_setup.ResConfigInviteUsers', function (require) {
    "use strict";

    var Widget = require('web.Widget');
    var widgetRegistry = require('web.widgetRegistryOld');
    var core = require('web.core');

    var _t = core._t;

    var ResConfigInviteUsers = Widget.extend({
        template: 'resConfigInviteUsers',

        events: {
            'click .o-web-settings-invite': '_onClickInvite',
            'click .o-web-settings-user': '_onClickUser',
            'click .o-web-settings-more': '_onClickMore',
            'keydown .o-user-emails': '_onKeydownUserEmails',
        },

        /**
         * @override
         */
        init: function () {
            this._super.apply(this, arguments);
            this.emails = [];
        },

        willStart: function () {
            var self = this;

            return this._super.apply(this, arguments).then(function () {
                return self.load();
            });
        },

        load: function () {
            var self = this;

            return this._rpc({
                route: '/base_setup/data',
            }).then(function (data) {
                self.activeUsers = data.activeUsers;
                self.pendingUsers = data.pendingUsers;
                self.actionPendingUsers = data.actionPendingUsers;
                self.pendingCount = data.pendingCount;
                self.resendInvitation = data.resendInvitation || false;
            });
        },

        //--------------------------------------------------------------------------
        // Private
        //--------------------------------------------------------------------------

        /**
         * @private
         * @param {string} email
         * @returns {boolean} true if the given email address is valid
         */
        _validateEmail: function (email) {
            var re = /^([a-z0-9][-a-z0-9_\+\.]*)@((?:[\w-]+\.)*\w[\w-]{0,66})\.([a-z]{2,63}(?:\.[a-z]{2})?)$/i;
            return re.test(email);
        },

        /**
         * Send invitation for valid and unique email addresses
         *
         * @private
         */
        _invite: function () {
            var self = this;

            var $userEmails = this.$('.o-user-emails');
            $userEmails.prop('disabled', true);
            this.$('.o-web-settings-invite').prop('disabled', true);
            var value = $userEmails.val().trim();
            if (value) {
                // filter out duplicates
                var emails = _.uniq(value.split(/[ ,;\n]+/));

                // filter out invalid email addresses
                var invalidEmails = _.reject(emails, this._validateEmail);
                if (invalidEmails.length) {
                    this.displayNotification({ message: _.str.sprintf(
                        _t('Invalid email addresses: %s.'),
                        invalidEmails.join(', ')
                    ), type: 'danger' });
                }
                emails = _.difference(emails, invalidEmails);

                if (!this.resendInvitation) {
                    // filter out already processed or pending addresses
                    var pendingEmails = _.map(this.pendingUsers, function (info) {
                        return info[1];
                    });
                    var existingEmails = _.intersection(emails, this.emails.concat(pendingEmails));
                    if (existingEmails.length) {
                        this.displayNotification({ message: _.str.sprintf(
                            _t('Email addresses already existing: %s.'),
                            existingEmails.join(', ')
                        ), type: 'danger' });
                    }
                    emails = _.difference(emails, existingEmails);
                }

                if (emails.length) {
                    $userEmails.val('');
                    this._rpc({
                        model: 'res.users',
                        method: 'webCreateUsers',
                        args: [emails],
                    }).then(function () {
                        return self.load().then(function () {
                            self.renderElement();
                            self.$('.o-user-emails').focus();
                        });
                    });
                } else {
                    $userEmails.prop('disabled', false);
                    this.$('.o-web-settings-invite').prop('disabled', false);
                    self.$('.o-user-emails').focus();
                }
            }
        },

        //--------------------------------------------------------------------------
        // Handlers
        //--------------------------------------------------------------------------

        /**
         * @private
         * @param {MouseEvent} ev
         */
        _onClickInvite: function (ev) {
            if (this.$('.o-user-emails').val().length) {
                var $button = $(ev.target);
                $button.button('loading');
                return this._invite();
            }
        },
        /**
         * @private
         * @param {MouseEvent} ev
         */
        _onClickMore: function (ev) {
            ev.preventDefault();
            this.doAction(this.actionPendingUsers);
        },
        /**
         * @private
         * @param {MouseEvent} ev
         */
        _onClickUser: function (ev) {
            ev.preventDefault();
            var userId = $(ev.currentTarget).data('user-id');

            var action = Object.assign({}, this.actionPendingUsers, {resId: userId});
            this.doAction(action);
        },
        /**
         * @private
         * @param {KeyboardEvent} ev
         */
        _onKeydownUserEmails: function (ev) {
            var keyCodes = [$.ui.keyCode.TAB, $.ui.keyCode.COMMA, $.ui.keyCode.ENTER];
            if (_.contains(keyCodes, ev.which)) {
                ev.preventDefault();
                this._invite();
            }
        },
    });

   widgetRegistry.add('resConfigInviteUsers', ResConfigInviteUsers);

});
