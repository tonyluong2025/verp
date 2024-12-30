verp.define('website.sPopup', function (require) {
'use strict';

const config = require('web.config');
const dom = require('web.dom');
const publicWidget = require('web.public.widget');
const utils = require('web.utils');

// TODO In master, export this class too or merge it with PopupWidget
const SharedPopupWidget = publicWidget.Widget.extend({
    selector: '.s-popup',
    disabledInEditableMode: false,
    events: {
        // A popup element is composed of a `.s-popup` parent containing the
        // actual `.modal` BS modal. Our internal logic and events are hiding
        // and showing this inner `.modal` modal element without considering its
        // `.s-popup` parent. It means that when the `.modal` is hidden, its
        // `.s-popup` parent is not touched and kept visible.
        // It might look like it's not an issue as it would just be an empty
        // element (its only child is hidden) but it leads to some issues as for
        // instance on chrome this div will have a forced `height` due to its
        // `contenteditable=true` attribute in edit mode. It will result in a
        // ugly white bar.
        // tl;dr: this is keeping those 2 elements visibility synchronized.
        'show.bs.modal': '_onModalShow',
        'hidden.bs.modal': '_onModalHidden',
    },

    /**
     * @override
     */
    destroy() {
        this._super(...arguments);

        if (!this._isNormalCase()) {
            return;
        }

        // Popup are always closed when entering/leaving edit mode (see
        // PopupWidget), this allows to make sure the class is sync on the
        // .s-popup parent after that moment too.
        this.el.classList.add('d-none');
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * This whole widget was added as a stable fix, this function allows to
     * be a bit more stable friendly. TODO remove in master.
     */
    _isNormalCase() {
        return this.el.children.length === 1
            && this.el.firstElementChild.classList.contains('modal');
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onModalShow() {
        if (!this._isNormalCase()) {
            return;
        }
        this.el.classList.remove('d-none');
    },
    /**
     * @private
     */
    _onModalHidden() {
        if (!this._isNormalCase()) {
            return;
        }
        this.el.classList.add('d-none');
    },
});

publicWidget.registry.SharedPopup = SharedPopupWidget;

const PopupWidget = publicWidget.Widget.extend({
    selector: '.s-popup',
    events: {
        'click .js-close-popup': '_onCloseClick',
        'hide.bs.modal': '_onHideModal',
        'show.bs.modal': '_onShowModal',
    },

    /**
     * @override
     */
    start: function () {
        this._popupAlreadyShown = !!utils.getCookie(this.$el.attr('id'));
        if (!this._popupAlreadyShown) {
            this._bindPopup();
        }
        return this._super(...arguments);
    },
    /**
     * @override
     */
    destroy: function () {
        this._super.apply(this, arguments);
        $(document).off('mouseleave.openPopup');
        this.$target.find('.modal').modal('hide');
        clearTimeout(this.timeout);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _bindPopup: function () {
        const $main = this.$target.find('.modal');

        let display = $main.data('display');
        let delay = $main.data('showAfter');

        if (config.device.isMobile) {
            if (display === 'mouseExit') {
                display = 'afterDelay';
                delay = 5000;
            }
            this.$('.modal').removeClass('s-popup-middle').addClass('s-popup-bottom');
        }

        if (display === 'afterDelay') {
            this.timeout = setTimeout(() => this._showPopup(), delay);
        } else {
            $(document).on('mouseleave.openPopup', () => this._showPopup());
        }
    },
    /**
     * @private
     */
    _canShowPopup() {
        return true;
    },
    /**
     * @private
     */
    _hidePopup: function () {
        this.$target.find('.modal').modal('hide');
    },
    /**
     * @private
     */
    _showPopup: function () {
        if (this._popupAlreadyShown || !this._canShowPopup()) {
            return;
        }
        this.$target.find('.modal').modal('show');
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onCloseClick: function () {
        this._hidePopup();
    },
    /**
     * @private
     */
    _onHideModal: function () {
        const nbDays = this.$el.find('.modal').data('consentsDuration');
        utils.setCookie(this.$el.attr('id'), true, nbDays * 24 * 60 * 60);
        this._popupAlreadyShown = true;

        this.$target.find('.media-iframe-video iframe').each((i, iframe) => {
            iframe.src = '';
        });
    },
    /**
     * @private
     */
    _onShowModal() {
        this.el.querySelectorAll('.media-iframe-video').forEach(media => {
            const iframe = media.querySelector('iframe');
            iframe.src = media.dataset.oeExpression || media.dataset.src; // TODO still oeExpression to remove someday
        });
    },
});

publicWidget.registry.popup = PopupWidget;

// Try to update the scrollbar based on the current context (modal state)
// and only if the modal overflowing has changed

function _updateScrollbar(ev) {
    const context = ev.data;
    const isOverflowing = dom.hasScrollableContent(context._element);
    if (context._isOverflowingWindow !== isOverflowing) {
        context._isOverflowingWindow = isOverflowing;
        context._checkScrollbar();
        context._setScrollbar();
        if (isOverflowing) {
            document.body.classList.add('modal-open');
        } else {
            document.body.classList.remove('modal-open');
            context._resetScrollbar();
        }
    }
}

// Prevent bootstrap to prevent scrolling and to add the strange body
// padding-right they add if the popup does not use a backdrop (especially
// important for default cookie bar).

const _baseShowElement = $.fn.modal.Constructor.prototype._showElement;
$.fn.modal.Constructor.prototype._showElement = function () {
    _baseShowElement.apply(this, arguments);

    if (this._element.classList.contains('s-popup-no-backdrop')) {
        // Update the scrollbar if the content changes or if the window has been
        // resized. Note this could technically be done for all modals and not
        // only the ones with the s-popup-no-backdrop class but that would be
        // useless as allowing content scroll while a modal with that class is
        // opened is a very specific Verp behavior.
        $(this._element).on('contentChanged.updateScrollbar', this, _updateScrollbar);
        $(window).on('resize.updateScrollbar', this, _updateScrollbar);

        this._verpLoadEventCaptureHandler = _.debounce(() => _updateScrollbar({ data: this }, 100));
        this._element.addEventListener('load', this._verpLoadEventCaptureHandler, true);

        _updateScrollbar({ data: this });
    }
};

const _baseHideModal = $.fn.modal.Constructor.prototype._hideModal;
$.fn.modal.Constructor.prototype._hideModal = function () {
    _baseHideModal.apply(this, arguments);

    // Note: do this in all cases, not only for popup with the
    // s-popup-no-backdrop class, as the modal may have lost that class during
    // edition before being closed.
    this._element.classList.remove('s-popup-overflow-page');

    $(this._element).off('contentChanged.updateScrollbar');
    $(window).off('resize.updateScrollbar');

    if (this._verpLoadEventCaptureHandler) {
        this._element.removeEventListener('load', this._verpLoadEventCaptureHandler, true);
        delete this._verpLoadEventCaptureHandler;
    }
};

const _baseSetScrollbar = $.fn.modal.Constructor.prototype._setScrollbar;
$.fn.modal.Constructor.prototype._setScrollbar = function () {
    if (this._element.classList.contains('s-popup-no-backdrop')) {
        this._element.classList.toggle('s-popup-overflow-page', !!this._isOverflowingWindow);

        if (!this._isOverflowingWindow) {
            return;
        }
    }
    return _baseSetScrollbar.apply(this, arguments);
};

const _baseGetScrollbarWidth = $.fn.modal.Constructor.prototype._getScrollbarWidth;
$.fn.modal.Constructor.prototype._getScrollbarWidth = function () {
    if (this._element.classList.contains('s-popup-no-backdrop') && !this._isOverflowingWindow) {
        return 0;
    }
    return _baseGetScrollbarWidth.apply(this, arguments);
};

return PopupWidget;
});
