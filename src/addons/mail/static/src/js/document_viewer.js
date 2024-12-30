/** @verp-module **/

import core from 'web.core';
import Widget from 'web.Widget';
import { hidePDFJSButtons } from '@web/legacy/js/libs/pdfjs';

var QWeb = core.qweb;

var SCROLL_ZOOM_STEP = 0.1;
var ZOOM_STEP = 0.5;

/**
 * This widget is deprecated, and should instead use AttachmentViewer component.
 * @see `mail/static/src/components/attachment_viewer/attachment_viewer.js`
 * TODO: remove this widget when it's not longer used
 *
 * @deprecated
 */
var DocumentViewer = Widget.extend({
    template: "DocumentViewer",
    events: {
        'click .o-download-btn': '_onDownload',
        'click .o-viewer-img': '_onImageClicked',
        'click .o-viewer-video': '_onVideoClicked',
        'click .move-next': '_onNext',
        'click .move-previous': '_onPrevious',
        'click .o-rotate': '_onRotate',
        'click .o-zoom-in': '_onZoomIn',
        'click .o-zoom-out': '_onZoomOut',
        'click .o-zoom-reset': '_onZoomReset',
        'click .o-close-btn, .o-viewer-img-wrapper': '_onClose',
        'click .o-print-btn': '_onPrint',
        'DOMMouseScroll .o-viewer-content': '_onScroll',    // Firefox
        'mousewheel .o-viewer-content': '_onScroll',        // Chrome, Safari, IE
        'keydown': '_onKeydown',
        'keyup': '_onKeyUp',
        'mousedown .o-viewer-img': '_onStartDrag',
        'mousemove .o-viewer-content': '_onDrag',
        'mouseup .o-viewer-content': '_onEndDrag'
    },
    /**
     * The documentViewer takes an array of objects describing attachments in
     * argument, and the ID of an active attachment (the one to display first).
     * Documents that are not of type image or video are filtered out.
     *
     * @override
     * @param {Array<Object>} attachments list of attachments
     * @param {integer} activeAttachmentID
     */
    init: function (parent, attachments, activeAttachmentID) {
        this._super.apply(this, arguments);
        this.attachment = _.filter(attachments, function (attachment) {
            var match = attachment.type === 'url' ? attachment.url.match("(youtu|.png|.jpg|.gif)") : attachment.mimetype.match("(image|video|application/pdf|text)");
            if (match) {
                attachment.fileType = match[1];
                if (match[1].match("(.png|.jpg|.gif)")) {
                    attachment.fileType = 'image';
                }
                if (match[1] === 'youtu') {
                    var youtubeArray = attachment.url.split('/');
                    var youtubeToken = youtubeArray[youtubeArray.length-1];
                    if (youtubeToken.indexOf('watch') !== -1) {
                        youtubeToken = youtubeToken.split('v=')[1];
                        var amp = youtubeToken.indexOf('&')
                        if (amp !== -1){
                            youtubeToken = youtubeToken.substring(0, amp);
                        }
                    }
                    attachment.youtube = youtubeToken;
                }
                return true;
            }
        });
        this.activeAttachment = _.findWhere(attachments, {id: activeAttachmentID});
        this.modelName = 'ir.attachment';
        this._reset();
    },
    /**
     * Do some actions after the widget is appended to the DOM
     * @override
     */
    setElement: function () {
        const result = this._super(...arguments);
        this._hidePdfButtonsIfPresent();
        return result;
    },
    /**
     * Open a modal displaying the active attachment
     * @override
     */
    start: function () {
        this.$el.modal('show');
        this.$el.on('hidden.bs.modal', _.bind(this._onDestroy, this));
        this.$('.o-viewer-img').on("load", _.bind(this._onImageLoaded, this));
        this.$('[data-toggle="tooltip"]').tooltip({delay: 0});
        return this._super.apply(this, arguments);
    },
    /**
     * @override
     */
    destroy: function () {
        if (this.isDestroyed()) {
            return;
        }
        this.$el.modal('hide');
        this.$el.remove();
        this._super.apply(this, arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //---------------------------------------------------------------------------

    /**
     * Hide some buttons in PDF.js
     * @override
     */
    _hidePdfButtonsIfPresent: function () {
        if (this.activeAttachment.mimetype === 'application/pdf') {
            hidePDFJSButtons(this.el);
        }
    },
    /**
     * @private
     */
    _next: function () {
        var index = _.findIndex(this.attachment, this.activeAttachment);
        index = (index + 1) % this.attachment.length;
        this.activeAttachment = this.attachment[index];
        this._updateContent();
    },
    /**
     * @private
     */
    _previous: function () {
        var index = _.findIndex(this.attachment, this.activeAttachment);
        index = index === 0 ? this.attachment.length - 1 : index - 1;
        this.activeAttachment = this.attachment[index];
        this._updateContent();
    },
    /**
     * @private
     */
    _reset: function () {
        this.scale = 1;
        this.dragStartX = this.dragstopX = 0;
        this.dragStartY = this.dragstopY = 0;
    },
    /**
     * Render the active attachment
     *
     * @private
     */
    _updateContent: function () {
        this.$('.o-viewer-content').html(QWeb.render('DocumentViewer.Content', {
            widget: this
        }));
        this.$('.o-viewer-img').on("load", _.bind(this._onImageLoaded, this));
        this._hidePdfButtonsIfPresent();
        this.$('[data-toggle="tooltip"]').tooltip({delay: 0});
        this._reset();
    },
    /**
     * Get CSS transform property based on scale and angle
     *
     * @private
     * @param {float} scale
     * @param {float} angle
     */
    _getTransform: function(scale, angle) {
        return 'scale3d(' + scale + ', ' + scale + ', 1) rotate(' + angle + 'deg)';
    },
    /**
     * Rotate image clockwise by provided angle
     *
     * @private
     * @param {float} angle
     */
    _rotate: function (angle) {
        this._reset();
        var newAngle = (this.angle || 0) + angle;
        this.$('.o-viewer-img').css('transform', this._getTransform(this.scale, newAngle));
        this.$('.o-viewer-img').css('max-width', newAngle % 180 !== 0 ? $(document).height() : '100%');
        this.$('.o-viewer-img').css('max-height', newAngle % 180 !== 0 ? $(document).width() : '100%');
        this.angle = newAngle;
    },
    /**
     * Zoom in/out image by provided scale
     *
     * @private
     * @param {integer} scale
     */
    _zoom: function (scale) {
        if (scale > 0.5) {
            this.$('.o-viewer-img').css('transform', this._getTransform(scale, this.angle || 0));
            this.scale = scale;
        }
        this.$('.o-zoom-reset').add('.o-zoom-out').toggleClass('disabled', scale === 1);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} e
     */
    _onClose: function (e) {
        e.preventDefault();
        this.destroy();
    },
    /**
     * When popup close complete destroyed modal even DOM footprint too
     *
     * @private
     */
    _onDestroy: function () {
        this.destroy();
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onDownload: function (e) {
        e.preventDefault();
        window.location = '/web/content/' + this.modelName + '/' + this.activeAttachment.id + '/' + 'datas' + '?download=true';
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onDrag: function (e) {
        e.preventDefault();
        if (this.enableDrag) {
            var $image = this.$('.o-viewer-img');
            var $zoomer = this.$('.o-viewer-zoomer');
            var top = $image.prop('offsetHeight') * this.scale > $zoomer.height() ? e.clientY - this.dragStartY : 0;
            var left = $image.prop('offsetWidth') * this.scale > $zoomer.width() ? e.clientX - this.dragStartX : 0;
            $zoomer.css("transform", "translate3d("+ left +"px, " + top + "px, 0)");
            $image.css('cursor', 'move');
        }
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onEndDrag: function (e) {
        e.preventDefault();
        if (this.enableDrag) {
            this.enableDrag = false;
            this.dragstopX = e.clientX - this.dragStartX;
            this.dragstopY = e.clientY - this.dragStartY;
            this.$('.o-viewer-img').css('cursor', '');
        }
    },
    /**
     * On click of image do not close modal so stop event propagation
     *
     * @private
     * @param {MouseEvent} e
     */
    _onImageClicked: function (e) {
        e.stopPropagation();
    },
    /**
     * Remove loading indicator when image loaded
     * @private
     */
    _onImageLoaded: function () {
        this.$('.o-loading-img').hide();
    },
    /**
     * Move next previous attachment on keyboard right left key
     *
     * @private
     * @param {KeyEvent} e
     */
    _onKeydown: function (e){
        switch (e.which) {
            case $.ui.keyCode.RIGHT:
                e.preventDefault();
                this._next();
                break;
            case $.ui.keyCode.LEFT:
                e.preventDefault();
                this._previous();
                break;
        }
    },
    /**
     * Close popup on ESCAPE keyup
     *
     * @private
     * @param {KeyEvent} e
     */
    _onKeyUp: function (e) {
        switch (e.which) {
            case $.ui.keyCode.ESCAPE:
                e.preventDefault();
                this._onClose(e);
                break;
        }
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onNext: function (e) {
        e.preventDefault();
        this._next();
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onPrevious: function (e) {
        e.preventDefault();
        this._previous();
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onPrint: function (e) {
        e.preventDefault();
        var src = this.$('.o-viewer-img').prop('src');
        var script = QWeb.render('PrintImage', {
            src: src
        });
        var printWindow = window.open('about:blank', "_new");
        printWindow.document.open();
        printWindow.document.write(script);
        printWindow.document.close();
    },
    /**
     * Zoom image on scroll
     *
     * @private
     * @param {MouseEvent} e
     */
    _onScroll: function (e) {
        var scale;
        if (e.originalEvent.wheelDelta > 0 || e.originalEvent.detail < 0) {
            scale = this.scale + SCROLL_ZOOM_STEP;
            this._zoom(scale);
        } else {
            scale = this.scale - SCROLL_ZOOM_STEP;
            this._zoom(scale);
        }
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onStartDrag: function (e) {
        e.preventDefault();
        this.enableDrag = true;
        this.dragStartX = e.clientX - (this.dragstopX || 0);
        this.dragStartY = e.clientY - (this.dragstopY || 0);
    },
    /**
     * On click of video do not close modal so stop event propagation
     * and provide play/pause the video instead of quitting it
     *
     * @private
     * @param {MouseEvent} e
     */
    _onVideoClicked: function (e) {
        e.stopPropagation();
        var videoElement = e.target;
        if (videoElement.paused) {
            videoElement.play();
        } else {
            videoElement.pause();
        }
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onRotate: function (e) {
        e.preventDefault();
        this._rotate(90);
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onZoomIn: function (e) {
        e.preventDefault();
        var scale = this.scale + ZOOM_STEP;
        this._zoom(scale);
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onZoomOut: function (e) {
        e.preventDefault();
        var scale = this.scale - ZOOM_STEP;
        this._zoom(scale);
    },
    /**
     * @private
     * @param {MouseEvent} e
     */
    _onZoomReset: function (e) {
        e.preventDefault();
        this.$('.o-viewer-zoomer').css("transform", "");
        this._zoom(1);
    },
});

export default DocumentViewer;
