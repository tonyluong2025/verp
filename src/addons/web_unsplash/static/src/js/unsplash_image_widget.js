verp.define('web_unsplash.imageWidgets', function (require) {
'use strict';

var core = require('web.core');
var UnsplashAPI = require('unsplash.api');
const {UploadProgressToast} = require('@web_editor/js/wysiwyg/widgets/upload_progress_toast');
var widgetsMedia = require('wysiwyg.widgets.media');
const {_t} = require('web.core');

var unsplashAPI = null;

// Prevent base class from treating unsplash images like regular attachments
const originalEvents = widgetsMedia.ImageWidget.prototype.events;
const clickHandler = originalEvents['click .o-existing-attachment-cell'];
if (!clickHandler) {
    throw new Error(`Couldn't find a handler for o-existing-attachment-cell clicks.
The unsplash image widget needs to prevent this handler from executing on unsplash attachments.`);
}
_.extend(originalEvents, {
    'click .o-existing-attachment-cell:not(.o-unsplash-attachment-cell)': clickHandler,
});
delete originalEvents['click .o-existing-attachment-cell'];

widgetsMedia.ImageWidget.include({
    xmlDependencies: widgetsMedia.ImageWidget.prototype.xmlDependencies.concat(
        ['/web_unsplash/static/src/xml/unsplash_image_widget.xml']
    ),
    events: _.extend({}, widgetsMedia.ImageWidget.prototype.events, {
        'click .o-unsplash-attachment-cell[data-imgid]': '_onUnsplashImgClick',
        'click button.save-nsplash': '_onSaveUnsplashCredentials',
    }),

    /**
     * @override
     */
    init: function () {
        this._super.apply(this, arguments);

        this._unsplash = {
            selectedImages: {},
            isMaxed: false,
            query: false,
            error: false,
            records: [],
        };

        // TODO improve this
        //
        // This is a `hack` to prevent the UnsplashAPI to be destroyed every
        // time the media dialog is closed. Indeed, UnsplashAPI has a cache
        // system to recude unsplash call, it is then better to keep its state
        // to take advantage from it from one media dialog call to another.
        //
        // Unsplash API will either be (it's still being discussed):
        //  * a service (ideally coming with an improvement to not auto load
        //    the service)
        //  * initialized in the websiteRoot (triggerUp)
        if (unsplashAPI === null) {
            this.unsplashAPI = new UnsplashAPI(this);
            unsplashAPI = this.unsplashAPI;
        } else {
            this.unsplashAPI = unsplashAPI;
            this.unsplashAPI.setParent(this);
        }
    },
    /**
     * @override
     */
    destroy: function () {
        // TODO See `hack` explained in `init`. This prevent the media dialog destroy
        //      to destroy unsplashAPI when destroying the children
        this.unsplashAPI.setParent(undefined);
        this._super.apply(this, arguments);
    },

    // --------------------------------------------------------------------------
    // Public
    // --------------------------------------------------------------------------

    /**
     * @override
     */
    _save: async function () {
        const _super = this._super;
        const selectedImages = this._unsplash.selectedImages;
        const imagesCount = Object.keys(selectedImages).length;
        if (imagesCount) {
            this.saved = true;
            await this._setUpProgressToast([{
                name: imagesCount > 1 ?
                    _.str.sprintf(_t("Uploading %s '%s' images."), imagesCount, this._unsplash.query) :
                    _.str.sprintf(_t("Uploading '%s' image."), this._unsplash.query),
                size: null,
            }]);
            const images = await this.uploader.rpcShowProgress({
                route: '/web_unsplash/attachment/add',
                params: {
                    unsplashurls: selectedImages,
                    resModel: this.options.resModel,
                    resId: this.options.resId,
                    query: this._unsplash.query,
                },
            }, 0);
            this.uploader.close(3000);
            this.attachments.push(...images);
            this.selectedAttachments.push(...images);
        }
        return _super.apply(this, arguments);
    },
    /**
     * @override
     */
    search: async function (needle) {
        var self = this;
        await this._super(...arguments);

        this._unsplash.query = needle;
        if (!needle) {
            this._unsplash.records = [];
            return;
        }

        await this.unsplashAPI.getImages(needle, this.numberOfAttachmentsToDisplay).then(function (res) {
            self._unsplash.isMaxed = res.isMaxed;
            self._unsplash.records = res.images;
            self._unsplash.error = false;
        }, function (err) {
            self._unsplash.error = err;
        });
    },
    /**
     * @override
     */
    hasContent() {
        if (this.searchService === 'all') {
            return this._super(...arguments) || (this.unsplashRecords && this.unsplashRecords.length);
        } else if (this.searchService === 'unsplash') {
            return (this.unsplashRecords && this.unsplashRecords.length);
        }
        return this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _highlightSelected: function () {
        this._super.apply(this, arguments);

        const $select = this.$('.o-unsplash-attachment-cell[data-imgid]').filter((i, el) => {
            return $(el).data('imgid') in this._unsplash.selectedImages;
        }).addClass('o-we-attachment-selected');
        return $select;
    },
    /**
     * @private
     */
    _loadMoreImages: function (forceSearch) {
        if (!this.$('.o-we-search').val()) {
            return this._super(forceSearch);
        }
        this.numberOfAttachmentsToDisplay += 10;
        this.search(this.$('.o-we-search').val()).then(() => this._renderThumbnails());
    },
    /**
     * @override
     */
    _renderThumbnails: function () {
        this._super(...arguments);
        this.$('.unsplash-error').empty();
        if (!['all', 'unsplash'].includes(this.searchService)) {
            return;
        }
        if (this._unsplash.query && this._unsplash.error) {
            this.$('.unsplash-error').html(
                core.qweb.render('web_unsplash.dialog.error.content', {
                    status: this._unsplash.error,
                })
            );
            return;
        }

        if (['all', 'unsplash'].includes(this.searchService) && this._unsplash.query && !this._unsplash.isMaxed) {
            this.$('.o-load-more').removeClass('d-none');
            this.$('.o-load-done-msg').addClass('d-none');
        }
    },
    /**
     * @override
     */
    _renderExisting: function (attachments) {
        this.unsplashRecords = this._unsplash.records.map(record => {
            const url = new URL(record.urls.regular);
            // In small windows, row height could get quite a bit larger than the min, so we keep some leeway.
            url.searchParams.set('h', 2 * this.MIN_ROW_HEIGHT);
            url.searchParams.delete('w');
            return Object.assign({}, record, {
                url: url.toString(),
            });
        });
        return this._super(...arguments);
    },
    /**
     * @override
     */
    _selectAttachement: function (attachment, save) {
        if (!this.options.multiImages) {
            this._unsplash.selectedImages = {};
        }
        this._super(...arguments);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onSaveUnsplashCredentials: function () {
        var self = this;
        var key = this.$('#accessKeyInput').val().trim();
        var appId = this.$('#appIdInput').val().trim();

        this.$('#accessKeyInput').toggleClass('is-invalid', !key);
        this.$('#appIdInput').toggleClass('is-invalid', !appId);

        if (key && appId) {
            if (!this.$el.find('.is-invalid').length) {
                this._rpc({
                    route: '/web_unsplash/saveUnsplash',
                    params: {key: key, appId: appId},
                }).then(function () {
                    self.unsplashAPI.clientId = key;
                    self._unsplash.error = false;
                    self.search(self._unsplash.query).then(() => self._renderThumbnails());
                });
            }
        }
    },
    /**
     * @private
     */
    _onUnsplashImgClick: function (ev) {
        if (this.saved) {
            // already saved, probably a double click. Ignore.
            return;
        }
        const {imgid, url, downloadUrl, description} = ev.currentTarget.dataset;
        if (!this.options.multiImages) {
            this._unsplash.selectedImages = {};
            this.selectedAttachments = [];
        }
        if (imgid in this._unsplash.selectedImages) {
            delete this._unsplash.selectedImages[imgid];
        } else {
            const _1920Url = new URL(url);
            _1920Url.searchParams.set('w', '1920');
            this._unsplash.selectedImages[imgid] = {url: _1920Url.href, downloadUrl: downloadUrl, description: description};
        }
        this._highlightSelected();
        if (!this.options.multiImages) {
            this.triggerUp('saveRequest');
        }
    },
});
});
