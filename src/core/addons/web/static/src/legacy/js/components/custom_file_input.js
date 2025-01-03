verp.define('web.CustomFileInput', function (require) {
    "use strict";

    const { Component, hooks } = owl;
    const { useRef } = hooks;

    /**
     * Custom file input
     *
     * Component representing a customized input of type file. It takes a sub-template
     * in its default t-slot and uses it as the trigger to open the file upload
     * prompt.
     * @extends Component
     */
    class CustomFileInput extends Component {
        /**
         * @param {Object} [props]
         * @param {string} [props.acceptedFileExtensions='*'] Comma-separated
         *      list of authorized file extensions (default to all).
         * @param {string} [props.action='/web/binary/upload'] Route called when
         *      a file is uploaded in the input.
         * @param {string} [props.id]
         * @param {string} [props.model]
         * @param {string} [props.multiUpload=false] Whether the input should allow
         *      to upload multiple files at once.
         */
        constructor() {
            super(...arguments);

            this.fileInputRef = useRef('file-input');
        }

        //--------------------------------------------------------------------------
        // Handlers
        //--------------------------------------------------------------------------

        /**
         * Upload an attachment to the given action with the given parameters:
         * - ufile: list of files contained in the file input
         * - csrfToken: CSRF token provided by the verp global object
         * - model: a specific model which will be given when creating the attachment
         * - id: the id of the model target instance
         * @private
         */
        async _onFileInputChange() {
            const { action, model, id } = this.props;
            const params = {
                csrfToken: verp.csrfToken,
                ufile: [...this.fileInputRef.el.files],
            };
            if (model) {
                params.model = model;
            }
            if (id) {
                params.id = id;
            }
            const fileData = await this.env.services.httpRequest(action, params, 'text');
            const parsedFileData = JSON.parse(fileData);
            if (parsedFileData.error) {
                throw new Error(parsedFileData.error);
            }
            this.trigger('uploaded', { files: parsedFileData });
        }

        /**
         * Redirect clicks from the trigger element to the input.
         * @private
         */
        _onTriggerClicked() {
            this.fileInputRef.el.click();
        }
    }
    CustomFileInput.defaultProps = {
        acceptedFileExtensions: '*',
        action: '/web/binary/upload',
        multiUpload: false,
    };
    CustomFileInput.props = {
        acceptedFileExtensions: { type: String, optional: 1 },
        action: { type: String, optional: 1 },
        id: { type: Number, optional: 1 },
        model: { type: String, optional: 1 },
        multiUpload: { type: Boolean, optional: 1 },
    };
    CustomFileInput.template = 'web.CustomFileInput';

    return CustomFileInput;
});
