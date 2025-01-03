verp.define('wysiwyg.widgets.LinkDialog', function (require) {
'use strict';

const Dialog = require('wysiwyg.widgets.Dialog');
const Link = require('wysiwyg.widgets.Link');


// This widget is there only to extend Link and be instantiated by LinkDialog.
const _DialogLinkWidget = Link.extend({
    template: 'wysiwyg.widgets.link',
    events: _.extend({}, Link.prototype.events || {}, {
        'change [name="linkStyleColor"]': '_onTypeChange',
    }),

    /**
     * @override
     */
    start: function () {
        this.buttonOptsCollapseEl = this.el.querySelector('#oLinkDialogButtonOptsCollapse');
        this.$styleInputs = this.$('input.link-style');
        this.$styleInputs.prop('checked', false).filter('[value=""]').prop('checked', true);
        if (this.data.isNewWindow) {
            this.$('we-button.o-we-checkbox-wrapper').toggleClass('active', true);
        }
        return this._super.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    save: function () {
        var data = this._getData();
        if (data === null) {
            var $url = this.$('input[name="url"]');
            $url.closest('.form-group').addClass('o-has-error').find('.form-control, .custom-select').addClass('is-invalid');
            $url.focus();
            return Promise.reject();
        }
        this.data.content = data.content;
        this.data.url = data.url;
        var allWhitespace = /\s+/gi;
        var allStartAndEndSpace = /^\s+|\s+$/gi;
        var allBtnTypes = /(^|[ ])(btn-secondary|btn-success|btn-primary|btn-info|btn-warning|btn-danger)([ ]|$)/gi;
        this.data.classes = data.classes.replace(allWhitespace, ' ').replace(allStartAndEndSpace, '');
        if (data.classes.replace(allBtnTypes, ' ')) {
            this.data.style = {
                'background-color': '',
                'color': '',
            };
        }
        this.data.isNewWindow = data.isNewWindow;
        this.finalData = this.data;
        return Promise.resolve();
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _adaptPreview: function () {
        var data = this._getData();
        if (data === null) {
            return;
        }
        const attrs = {
            target: '_blank',
            href: data.url && data.url.length ? data.url : '#',
            class: `${data.classes.replace(/float-\w+/, '')} o-btn-preview`,
        };

        const $linkPreview = this.$("#linkPreview");
        $linkPreview.attr(attrs);
        this._updateLinkContent($linkPreview, data, { force: true });
    },
    /**
     * @override
     */
    _doStripDomain: function () {
        return this.$('#oLinkDialogUrlStripDomain').prop('checked');
    },
    /**
     * @override
     */
    _getLinkOptions: function () {
        const options = [
            'input[name="linkStyleColor"]',
            'select[name="linkStyleSize"] > option',
            'select[name="linkStyleShape"] > option',
        ];
        return this.$(options.join(','));
    },
    /**
     * @override
     */
    _getLinkShape: function () {
        return this.$('select[name="linkStyleShape"]').val() || '';
    },
    /**
     * @override
     */
    _getLinkSize: function () {
        return this.$('select[name="linkStyleSize"]').val() || '';
    },
    /**
     * @override
     */
    _getLinkType: function () {
        return this.$('input[name="linkStyleColor"]:checked').val() || '';
    },
    /**
     * @private
     */
    _isFromAnotherHostName: function (url) {
        if (url.includes(window.location.hostname)) {
            return false;
        }
        try {
            const Url = URL || window.URL || window.webkitURL;
            const urlObj = url.startsWith('/') ? new Url(url, window.location.origin) : new Url(url);
            return (urlObj.origin !== window.location.origin);
        } catch (ignored) {
            return true;
        }
    },
    /**
     * @override
     */
    _isNewWindow: function (url) {
        if (this.options.forceNewWindow) {
            return this._isFromAnotherHostName(url);
        } else {
            return this.$('input[name="isNewWindow"]').prop('checked');
        }
    },
    /**
     * @override
     */
    _setSelectOption: function ($option, active) {
        if ($option.is("input")) {
            $option.prop("checked", active);
        } else if (active) {
            $option.parent().find('option').removeAttr('selected').removeProp('selected');
            $option.parent().val($option.val());
            $option.attr('selected', 'selected').prop('selected', 'selected');
        }
    },
    /**
     * @override
     */
    _updateOptionsUI: function () {
        const el = this.el.querySelector('[name="linkStyleColor"]:checked');
        $(this.buttonOptsCollapseEl).collapse(el && el.value ? 'show' : 'hide');
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onTypeChange() {
        this._updateOptionsUI();
    },
    /**
     * @override
     */
    _onURLInput: function () {
        this._super(...arguments);
        this.$('#oLinkDialogUrlInput').closest('.form-group').removeClass('o-has-error').find('.form-control, .custom-select').removeClass('is-invalid');
    },
});

/**
 * Allows to customize link content and style.
 */
const LinkDialog = Dialog.extend({
    init: function (parent, ...args) {
        this._super(...arguments);
        this.linkWidget = new _DialogLinkWidget(this, ...args);
    },
    start: async function () {
        const res = await this._super(...arguments);
        await this.linkWidget.appendTo(this.$el);
        return res;
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    save: function () {
        const _super = this._super.bind(this);
        const saveArguments = arguments;
        return this.linkWidget.save().then(() => {
            this.finalData = this.linkWidget.finalData;
            return _super(...saveArguments);
        });
    },
});

return LinkDialog;
});
