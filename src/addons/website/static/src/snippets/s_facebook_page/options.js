verp.define('website.sFacebookPageOptions', function (require) {
'use strict';

const options = require('web_editor.snippets.options');

options.registry.facebookPage = options.Class.extend({
    /**
     * Initializes the required facebook page data to create the iframe.
     *
     * @override
     */
    willStart: function () {
        var defs = [this._super.apply(this, arguments)];

        var defaults = {
            href: '',
            height: 215,
            width: 350,
            tabs: '',
            smallHeader: true,
            hideCover: true,
            showFacepile: false,
        };
        this.fbData = _.defaults(_.pick(this.$target.data(), _.keys(defaults)), defaults);

        if (!this.fbData.href) {
            // Fetches the default url for facebook page from website config
            var self = this;
            defs.push(this._rpc({
                model: 'website',
                method: 'searchRead',
                args: [[], ['socialFacebook']],
                limit: 1,
            }).then(function (res) {
                if (res) {
                    self.fbData.href = res[0].socialFacebook || '';
                }
            }));
        }

        return Promise.all(defs).then(() => this._markFbElement()).then(() => this._refreshPublicWidgets());
    },

    //--------------------------------------------------------------------------
    // Options
    //--------------------------------------------------------------------------

    /**
     * Toggles a checkbox option.
     *
     * @see this.selectClass for parameters
     * @param {String} optionName the name of the option to toggle
     */
    toggleOption: function (previewMode, widgetValue, params) {
        let optionName = params.optionName;
        if (optionName.startsWith('tab.')) {
            optionName = optionName.replace('tab.', '');
            if (widgetValue) {
                this.fbData.tabs = this.fbData.tabs
                    .split(',')
                    .filter(t => t !== '')
                    .concat([optionName])
                    .join(',');
            } else {
                this.fbData.tabs = this.fbData.tabs
                    .split(',')
                    .filter(t => t !== optionName)
                    .join(',');
            }
        } else {
            if (optionName === 'showCover') {
                this.fbData.hideCover = !widgetValue;
            } else {
                this.fbData[optionName] = widgetValue;
            }
        }
        return this._markFbElement();
    },
    /**
     * Sets the facebook page's URL.
     *
     * @see this.selectClass for parameters
     */
    pageUrl: function (previewMode, widgetValue, params) {
        this.fbData.href = widgetValue;
        return this._markFbElement();
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Sets the correct dataAttributes on the facebook iframe and refreshes it.
     *
     * @see this.selectClass for parameters
     */
    _markFbElement: function () {
        return this._checkURL().then(() => {
            // Managing height based on options
            if (this.fbData.tabs) {
                this.fbData.height = this.fbData.tabs === 'events' ? 300 : 500;
            } else if (this.fbData.smallHeader) {
                this.fbData.height = this.fbData.showFacepile ? 165 : 70;
            } else {
                this.fbData.height = this.fbData.showFacepile ? 225 : 150;
            }
            _.each(this.fbData, (value, key) => {
                this.$target.attr('data-' + key, value);
                this.$target.data(key, value);
            });
        });
    },
    /**
     * @override
     */
    _computeWidgetState: function (methodName, params) {
        const optionName = params.optionName;
        switch (methodName) {
            case 'toggleOption': {
                if (optionName.startsWith('tab.')) {
                    return this.fbData.tabs.split(',').includes(optionName.replace(/^tab./, ''));
                } else {
                    if (optionName === 'showCover') {
                        return !this.fbData.hideCover;
                    }
                    return this.fbData[optionName];
                }
            }
            case 'pageUrl': {
                return this._checkURL().then(() => this.fbData.href);
            }
        }
        return this._super(...arguments);
    },
    /**
     * @override
     */
    _computeWidgetVisibility(widgetName, params) {
        if (params.optionName === 'showFacepile') {
            // TODO: Remove this option in master (in the meantime we hide it).
            return false;
        }
        return this._super(...arguments);
    },
    /**
     * @private
     */
    _checkURL: function () {
        const defaultURL = 'https://www.facebook.com/Verp';
        const match = this.fbData.href.match(/^(?:https?:\/\/)?(?:www\.)?(?:fb|facebook)\.com\/(?:([\w.]+)|[^/?#]+-([0-9]{15,16}))(?:$|[/?# ])/);
        if (match) {
            // Check if the page exists on Facebook or not
            return new Promise((resolve, reject) => $.ajax({
                url: 'https://graph.facebook.com/' + (match[2] || match[1]) + '/picture',
                success: () => resolve(),
                error: () => {
                    this.fbData.href = defaultURL;
                    resolve();
                },
            }));
        }
        this.fbData.href = defaultURL;
        return Promise.resolve();
    },
});
});
