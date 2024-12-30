
verp.define('backend_web_theme.relationalFields', function (require) {
"use strict";

const config = require("web.config");
const fields = require('web.relationalFields');

fields.FieldStatus.include({
    _setState() {
        this._super(...arguments);
        if (config.device.isMobile) {
            _.map(this.statusInformation, (value) => {
                value.fold = true;
            });
        }
    },
});

fields.FieldOne2Many.include({
    _renderButtons() {
        const result = this._super(...arguments);
        if (config.device.isMobile && this.$buttons) {
        	const $buttons = this.$buttons.find('.btn-secondary');
        	$buttons.addClass('btn-primary bw-mobile-add');
            $buttons.removeClass('btn-secondary');
        }
        return result;
    }
});

fields.FieldMany2Many.include({
    _renderButtons() {
        const result = this._super(...arguments);
        if (config.device.isMobile && this.$buttons) {
        	const $buttons = this.$buttons.find('.btn-secondary');
        	$buttons.addClass('btn-primary bw-mobile-add');
            $buttons.removeClass('btn-secondary');
        }
        return result;
    }
});

});