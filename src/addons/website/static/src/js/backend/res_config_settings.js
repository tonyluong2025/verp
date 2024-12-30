verp.define('website.settings', function (require) {

const BaseSettingController = require('base.settings').Controller;
const core = require('web.core');
const Dialog = require('web.Dialog');
const FieldBoolean = require('web.basicFields').FieldBoolean;
const fieldRegistry = require('web.fieldRegistry');
const FormController = require('web.FormController');

const QWeb = core.qweb;
const _t = core._t;

BaseSettingController.include({

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Bypasses the discard confirmation dialog when going to a website because
     * the target website will be the one selected and when selecting a theme
     * because the theme will be installed on the selected website.
     *
     * Without this override, it is impossible to go to a website other than the
     * first because discarding will revert it back to the default value.
     *
     * Without this override, it is impossible to edit robots.txt website other than the
     * first because discarding will revert it back to the default value.
     *
     * Without this override, it is impossible to submit sitemap to google other than for the
     * first website because discarding will revert it back to the default value.
     *
     * Without this override, it is impossible to install a theme on a website
     * other than the first because discarding will revert it back to the
     * default value.
     *
     * @override
     */
    _onButtonClicked: function (ev) {
        if (ev.data.attrs.name === 'websiteGoTo'
                || ev.data.attrs.name === 'actionOpenRobots'
                || ev.data.attrs.name === 'actionPingSitemap'
                || ev.data.attrs.name === 'installThemeOnCurrentWebsite') {
            FormController.prototype._onButtonClicked.apply(this, arguments);
        } else {
            this._super.apply(this, arguments);
        }
    },
});

const WebsiteCookiesbarField = FieldBoolean.extend({
    xmlDependencies: ['/website/static/src/xml/website.res_config_settings.xml'],

    _onchange: function () {
        const checked = this.$input[0].checked;
        if (!checked) {
            return this._setValue(checked);
        }

        const cancelCallback = () => this.$input[0].checked = !checked;
        Dialog.confirm(this, null, {
            title: _t("Please confirm"),
            $content: QWeb.render('website.resConfigSettings.cookiesModalMain'),
            buttons: [{
                text: _t('Do not activate'),
                classes: 'btn-primary',
                close: true,
                click: cancelCallback,
            },
            {
                text: _t('Activate anyway'),
                close: true,
                click: () => this._setValue(checked),
            }],
            cancelCallback: cancelCallback,
        });
    },
});

fieldRegistry.add('websiteCookiesbarField', WebsiteCookiesbarField);
});
