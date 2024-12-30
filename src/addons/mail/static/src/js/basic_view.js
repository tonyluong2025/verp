/** @verp-module **/

import BasicView from 'web.BasicView';

const mailWidgets = ['kanbanActivity'];

BasicView.include({
    init: function () {
        this._super.apply(this, arguments);
        const postRefresh = this._getFieldOption('messageIds', 'postRefresh', false);
        const followersPostRefresh = this._getFieldOption('messageFollowerIds', 'postRefresh', false);
        this.chatterFields = {
            hasActivityIds: this._hasField('activityIds'),
            hasMessageFollowerIds: this._hasField('messageFollowerIds'),
            hasMessageIds: this._hasField('messageIds'),
            hasRecordReloadOnAttachmentsChanged: postRefresh === 'always',
            hasRecordReloadOnMessagePosted: !!postRefresh,
            hasRecordReloadOnFollowersUpdate: !!followersPostRefresh,
            isAttachmentBoxVisibleInitially: (
                this._getFieldOption('messageIds', 'openAttachments', false) ||
                this._getFieldOption('messageFollowerIds', 'openAttachments', false)
            ),
        };
        const fieldsInfo = this.fieldsInfo[this.viewType];
        this.rendererParams.chatterFields = this.chatterFields;

        // LEGACY for widget kanbanActivity
        this.mailFields = {};
        for (const fieldName in fieldsInfo) {
            const fieldInfo = fieldsInfo[fieldName];
            if (_.contains(mailWidgets, fieldInfo.widget)) {
                this.mailFields[fieldInfo.widget] = fieldName;
                fieldInfo.__noFetch = true;
            }
        }
        this.rendererParams.activeActions = this.controllerParams.activeActions;
        this.rendererParams.mailFields = this.mailFields;
    },
    /**
     * Gets the option value of a field if present.
     *
     * @private
     * @param {string} fieldName the desired field name
     * @param {string} optionName the desired option name
     * @param {*} defaultValue the default value if option or field is not found.
     * @returns {*}
     */
    _getFieldOption(fieldName, optionName, defaultValue) {
        const field = this.fieldsInfo[this.viewType][fieldName];
        if (field && field.options && field.options[optionName] !== undefined) {
            return field.options[optionName];
        }
        return defaultValue;
    },
    /**
     * Checks whether the view has a given field.
     *
     * @private
     * @param {string} fieldName the desired field name
     * @returns {boolean}
     */
    _hasField(fieldName) {
        return !!this.fieldsInfo[this.viewType][fieldName];
    },
});
