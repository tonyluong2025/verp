verp.define('website.sImageGalleryOptions', function (require) {
'use strict';

var core = require('web.core');
var weWidgets = require('wysiwyg.widgets');
var options = require('web_editor.snippets.options');

var _t = core._t;
var qweb = core.qweb;

options.registry.gallery = options.Class.extend({
    xmlDependencies: ['/website/static/src/snippets/s_image_gallery/000.xml'],

    /**
     * @override
     */
    start: function () {
        var self = this;

        // Make sure image previews are updated if images are changed
        this.$target.on('imageChanged.gallery', 'img', function (ev) {
            var $img = $(ev.currentTarget);
            var index = self.$target.find('.carousel-item.active').index();
            self.$('.carousel:first li[data-target]:eq(' + index + ')')
                .css('background-image', 'url(' + $img.attr('src') + ')');
        });

        // When the snippet is empty, an edition button is the default content
        // TODO find a nicer way to do that to have editor style
        this.$target.on('click.gallery', '.o-add-images', function (e) {
            e.stopImmediatePropagation();
            self.addImages(false);
        });

        this.$target.on('dropped.gallery', 'img', function (ev) {
            self.mode(null, self.getMode());
            if (!ev.target.height) {
                $(ev.target).one('load', function () {
                    setTimeout(function () {
                        self.triggerUp('coverUpdate');
                    });
                });
            }
        });

        const $container = this.$('> .container, > .container-fluid, > .o-container-small');
        if ($container.find('> *:not(div)').length) {
            self.mode(null, self.getMode());
        }

        return this._super.apply(this, arguments);
    },
    /**
     * @override
     */
    onBuilt: function () {
        if (this.$target.find('.o-add-images').length) {
            this.addImages(false);
        }
        // TODO should consider the async parts
        this._adaptNavigationIDs();
    },
    /**
     * @override
     */
    onClone: function () {
        this._adaptNavigationIDs();
    },
    /**
     * @override
     */
    cleanForSave: function () {
        if (this.$target.hasClass('slideshow')) {
            this.$target.removeAttr('style');
        }
    },
    /**
     * @override
     */
    destroy() {
        this._super(...arguments);
        this.$target.off('.gallery');
    },

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * Allows to select images to add as part of the snippet.
     *
     * @see this.selectClass for parameters
     */
    addImages: function (previewMode) {
        // Prevent opening dialog twice.
        if (this.__imageDialogOpened) {
            return Promise.resolve();
        }
        this.__imageDialogOpened = true;
        const $images = this.$('img');
        var $container = this.$('> .container, > .container-fluid, > .o-container-small');
        var dialog = new weWidgets.MediaDialog(this, {multiImages: true, onlyImages: true, mediaWidth: 1920});
        var lastImage = _.last(this._getImages());
        var index = lastImage ? this._getIndex(lastImage) : -1;
        return new Promise(resolve => {
            dialog.on('save', this, function (attachments) {
                for (var i = 0; i < attachments.length; i++) {
                    $('<img/>', {
                        class: $images.length > 0 ? $images[0].className : 'img img-fluid d-block ',
                        src: attachments[i].imageSrc,
                        'data-index': ++index,
                        alt: attachments[i].description || '',
                        'data-name': _t('Image'),
                        style: $images.length > 0 ? $images[0].style.cssText : '',
                    }).appendTo($container);
                }
                if (attachments.length > 0) {
                    this.mode('reset', this.getMode());
                    this.triggerUp('coverUpdate');
                }
            });
            dialog.on('closed', this, () => {
                this.__imageDialogOpened = false;
                return resolve();
            });
            dialog.open();
        });
    },
    /**
     * Allows to change the number of columns when displaying images with a
     * grid-like layout.
     *
     * @see this.selectClass for parameters
     */
    columns: function (previewMode, widgetValue, params) {
        const nbColumns = parseInt(widgetValue || '1');
        this.$target.attr('data-columns', nbColumns);

        this.mode(previewMode, this.getMode(), {}); // TODO improve
    },
    /**
     * Get the image target's layout mode (slideshow, masonry, grid or nomode).
     *
     * @returns {String('slideshow'|'masonry'|'grid'|'nomode')}
     */
    getMode: function () {
        var mode = 'slideshow';
        if (this.$target.hasClass('o-masonry')) {
            mode = 'masonry';
        }
        if (this.$target.hasClass('o-grid')) {
            mode = 'grid';
        }
        if (this.$target.hasClass('o-nomode')) {
            mode = 'nomode';
        }
        return mode;
    },
    /**
     * Displays the images with the "grid" layout.
     */
    grid: function () {
        var imgs = this._getImages();
        var $row = $('<div/>', {class: 'row s-nb-column-fixed'});
        var columns = this._getColumns();
        var colClass = 'col-lg-' + (12 / columns);
        var $container = this._replaceContent($row);

        _.each(imgs, function (img, index) {
            var $img = $(img);
            var $col = $('<div/>', {class: colClass});
            $col.append($img).appendTo($row);
            if ((index + 1) % columns === 0) {
                $row = $('<div/>', {class: 'row s-nb-column-fixed'});
                $row.appendTo($container);
            }
        });
        this.$target.css('height', '');
    },
    /**
     * Displays the images with the "masonry" layout.
     */
    masonry: function () {
        var self = this;
        var imgs = this._getImages();
        var columns = this._getColumns();
        var colClass = 'col-lg-' + (12 / columns);
        var cols = [];

        var $row = $('<div/>', {class: 'row s-nb-column-fixed'});
        this._replaceContent($row);

        // Create columns
        for (var c = 0; c < columns; c++) {
            var $col = $('<div/>', {class: 'o-masonry-col o-snippet-not-selectable ' + colClass});
            $row.append($col);
            cols.push($col[0]);
        }

        // Dispatch images in columns by always putting the next one in the
        // smallest-height column
        while (imgs.length) {
            var min = Infinity;
            var $lowest;
            _.each(cols, function (col) {
                var $col = $(col);
                var height = $col.is(':empty') ? 0 : $col.find('img').last().offset().top + $col.find('img').last().height() - self.$target.offset().top;
                if (height < min) {
                    min = height;
                    $lowest = $col;
                }
            });
            $lowest.append(imgs.shift());
        }
    },
    /**
     * Allows to change the images layout. @see grid, masonry, nomode, slideshow
     *
     * @see this.selectClass for parameters
     */
    mode: function (previewMode, widgetValue, params) {
        widgetValue = widgetValue || 'slideshow'; // FIXME should not be needed
        this.$target.css('height', '');
        this.$target
            .removeClass('o-nomode o-masonry o-grid o-slideshow')
            .addClass('o-' + widgetValue.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()); // Todo: Tony must fix
        this[widgetValue]();
        this.triggerUp('coverUpdate');
        this._refreshPublicWidgets();
    },
    /**
     * Displays the images with the standard layout: floating images.
     */
    nomode: function () {
        var $row = $('<div/>', {class: 'row s-nb-column-fixed'});
        var imgs = this._getImages();

        this._replaceContent($row);

        _.each(imgs, function (img) {
            var wrapClass = 'col-lg-3';
            if (img.width >= img.height * 2 || img.width > 600) {
                wrapClass = 'col-lg-6';
            }
            var $wrap = $('<div/>', {class: wrapClass}).append(img);
            $row.append($wrap);
        });
    },
    /**
     * Allows to remove all images. Restores the snippet to the way it was when
     * it was added in the page.
     *
     * @see this.selectClass for parameters
     */
    removeAllImages: function (previewMode) {
        var $addImg = $('<div>', {
            class: 'alert alert-info css-non-editable-mode-hidden text-center',
        });
        var $text = $('<span>', {
            class: 'o-add-images',
            style: 'cursor: pointer;',
            text: _t(" Add Images"),
        });
        var $icon = $('<i>', {
            class: ' fa fa-plus-circle',
        });
        this._replaceContent($addImg.append($icon).append($text));
    },
    /**
     * Displays the images with a "slideshow" layout.
     */
    slideshow: function () {
        const imageEls = this._getImages();
        const images = _.map(imageEls, img => ({
            // Use getAttribute to get the attribute value otherwise .src
            // returns the absolute url.
            src: img.getAttribute('src'),
            alt: img.getAttribute('alt'),
        }));
        var currentInterval = this.$target.find('.carousel:first').attr('data-interval');
        var params = {
            images: images,
            index: 0,
            title: "",
            interval: currentInterval || 0,
            id: 'slideshow_' + new Date().getTime(),
            attrClass: imageEls.length > 0 ? imageEls[0].className : '',
            attrStyle: imageEls.length > 0 ? imageEls[0].style.cssText : '',
        },
        $slideshow = $(qweb.render('website.gallery.slideshow', params));
        this._replaceContent($slideshow);
        _.each(this.$('img'), function (img, index) {
            $(img).attr({contenteditable: true, 'data-index': index});
        });
        this.$target.css('height', Math.round(window.innerHeight * 0.7));

        // Apply layout animation
        this.$target.off('slide.bs.carousel').off('slid.bs.carousel');
        this.$('li.fa').off('click');
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Handles image removals and image index updates.
     *
     * @override
     */
    notify: function (name, data) {
        this._super(...arguments);
        if (name === 'imageRemoved') {
            data.$image.remove(); // Force the removal of the image before reset
            this.mode('reset', this.getMode());
        } else if (name === 'imageIndexRequest') {
            var imgs = this._getImages();
            var position = _.indexOf(imgs, data.$image[0]);
            imgs.splice(position, 1);
            switch (data.position) {
                case 'first':
                    imgs.unshift(data.$image[0]);
                    break;
                case 'prev':
                    imgs.splice(position - 1, 0, data.$image[0]);
                    break;
                case 'next':
                    imgs.splice(position + 1, 0, data.$image[0]);
                    break;
                case 'last':
                    imgs.push(data.$image[0]);
                    break;
            }
            position = imgs.indexOf(data.$image[0]);
            _.each(imgs, function (img, index) {
                // Note: there might be more efficient ways to do that but it is
                // more simple this way and allows compatibility with 10.0 where
                // indexes were not the same as positions.
                $(img).attr('data-index', index);
            });
            const currentMode = this.getMode();
            this.mode('reset', currentMode);
            if (currentMode === 'slideshow') {
                const $carousel = this.$target.find('.carousel');
                $carousel.removeClass('slide');
                $carousel.carousel(position);
                this.$target.find('.carousel-indicators li').removeClass('active');
                this.$target.find('.carousel-indicators li[data-slide-to="' + position + '"]').addClass('active');
                this.triggerUp('activateSnippet', {
                    $snippet: this.$target.find('.carousel-item.active img'),
                    ifInactiveOptions: true,
                });
                $carousel.addClass('slide');
            } else {
                this.triggerUp('activateSnippet', {
                    $snippet: data.$image,
                    ifInactiveOptions: true,
                });
            }
        }
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _adaptNavigationIDs: function () {
        var uuid = new Date().getTime();
        this.$target.find('.carousel').attr('id', 'slideshow_' + uuid);
        _.each(this.$target.find('[data-slide], [data-slide-to]'), function (el) {
            var $el = $(el);
            if ($el.attr('data-target')) {
                $el.attr('data-target', '#slideshow_' + uuid);
            } else if ($el.attr('href')) {
                $el.attr('href', '#slideshow_' + uuid);
            }
        });
    },
    /**
     * @override
     */
    _computeWidgetState: function (methodName, params) {
        switch (methodName) {
            case 'mode': {
                let activeModeName = 'slideshow';
                for (const modeName of params.possibleValues) {
                    if (this.$target.hasClass(`o-${modeName.replace(/_/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`)) {
                        activeModeName = modeName;
                        break;
                    }
                }
                this.activeMode = activeModeName;
                return activeModeName;
            }
            case 'columns': {
                return `${this._getColumns()}`;
            }
        }
        return this._super(...arguments);
    },
    /**
     * @private
     */
    async _computeWidgetVisibility(widgetName, params) {
        if (widgetName === 'slideshowModeOpt') {
            return false;
        }
        return this._super(...arguments);
    },
    /**
     * Returns the images, sorted by index.
     *
     * @private
     * @returns {DOMElement[]}
     */
    _getImages: function () {
        var imgs = this.$('img').get();
        var self = this;
        imgs.sort(function (a, b) {
            return self._getIndex(a) - self._getIndex(b);
        });
        return imgs;
    },
    /**
     * Returns the index associated to a given image.
     *
     * @private
     * @param {DOMElement} img
     * @returns {integer}
     */
    _getIndex: function (img) {
        return img.dataset.index || 0;
    },
    /**
     * Returns the currently selected column option.
     *
     * @private
     * @returns {integer}
     */
    _getColumns: function () {
        return parseInt(this.$target.attr('data-columns')) || 3;
    },
    /**
     * Empties the container, adds the given content and returns the container.
     *
     * @private
     * @param {jQuery} $content
     * @returns {jQuery} the main container of the snippet
     */
    _replaceContent: function ($content) {
        var $container = this.$('> .container, > .container-fluid, > .o-container-small');
        $container.empty().append($content);
        return $container;
    },
});

options.registry.galleryImg = options.Class.extend({
    /**
     * Rebuilds the whole gallery when one image is removed.
     *
     * @override
     */
    onRemove: function () {
        this.triggerUp('optionUpdate', {
            optionName: 'gallery',
            name: 'imageRemoved',
            data: {
                $image: this.$target,
            },
        });
    },

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * Allows to change the position of an image (its order in the image set).
     *
     * @see this.selectClass for parameters
     */
    position: function (previewMode, widgetValue, params) {
        this.triggerUp('optionUpdate', {
            optionName: 'gallery',
            name: 'imageIndexRequest',
            data: {
                $image: this.$target,
                position: widgetValue,
            },
        });
    },
});
});
