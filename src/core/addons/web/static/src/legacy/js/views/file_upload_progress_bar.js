/** @verp-module alias=web.ProgressBar **/

import { _t } from 'web.core';
import Dialog from 'web.Dialog';
import Widget from 'web.Widget';

const ProgressBar = Widget.extend({
    template: 'web.FileUploadProgressBar',

    events: {
        'click .o-upload-cross': '_onClickCross',
    },

    /**
     * @override
     * @param {Object} param1
     * @param {String} param1.title
     * @param {String} param1.fileUploadId
     * @param {XMLHttpRequest} param2.xhr
     */
    init(parent, { title, fileUploadId, xhr }) {
        this._super(...arguments);
        this.title = title;
        this.fileUploadId = fileUploadId;
        this.xhr = xhr;
    },

    /**
     * @override
     * @return {Promise}
     */
    start() {
        this.xhr.onabort = () => this.displayNotification({ message: _t("Upload cancelled") });
        return this._super(...arguments);
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
        this.$('.o-file-upload-progress-bar-value').css("width", percent + "%");
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickCross(ev) {
        ev.stopPropagation();
        const promptText = _.str.sprintf(_t("Do you really want to cancel the upload of %s?"), _.escape(this.title));
        Dialog.confirm(this, promptText, {
            confirmCallback: () => {
                this.xhr.abort();
                this.triggerUp('progressBarAbort', { fileUploadId: this.fileUploadId });
            }
        });
    },
});

export default ProgressBar;