/** @verp-module alias=web.ProgressCard **/

import { _t } from 'web.core';
import Widget from 'web.Widget';

const ProgressCard = Widget.extend({
    template: 'web.ProgressCard',

    /**
     * @override
     * @param {Object} param1
     * @param {String} param1.title
     * @param {String} param1.type file mimetype
     * @param {String} param1.viewType
     */
    init(parent, { title, type, viewType }) {
        this._super(...arguments);
        this.title = title;
        this.type = type;
        this.viewType = viewType;
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @param {integer} loaded
     * @param {integer} total
     */
    update(loaded, total) {
        if (!this.$el) {
            return;
        }
        const percent = Math.round((loaded / total) * 100);
        const $textDivLeft = this.$('.o-file-upload-progress-text-left');
        const $textDivRight = this.$('.o-file-upload-progress-text-right');
        if (percent === 100) {
            $textDivLeft.text(_t('Processing...'));
        } else {
            const mbLoaded = Math.round(loaded/1000000);
            const mbTotal = Math.round(total/1000000);
            $textDivLeft.text(_.str.sprintf(_t("Uploading... (%s%%)"), percent));
            $textDivRight.text(_.str.sprintf(_t("(%s/%sMb)"), mbLoaded, mbTotal));
        }
    },
});

export default ProgressCard;
