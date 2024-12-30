verp.define('website.sWebsiteForm', function (require) {
    'use strict';

    var core = require('web.core');
    var time = require('web.time');
    const {ReCaptcha} = require('google_recaptcha.ReCaptchaV3');
    const session = require('web.session');
    var ajax = require('web.ajax');
    var publicWidget = require('web.public.widget');
    const dom = require('web.dom');
    const concurrency = require('web.concurrency');

    var _t = core._t;
    var qweb = core.qweb;

    publicWidget.registry.EditModeWebsiteForm = publicWidget.Widget.extend({
        selector: '.s-website-form form, form.s-website-form', // !compatibility
        disabledInEditableMode: false,
        /**
         * @override
         */
        start: function () {
            if (this.editableMode) {
                // We do not initialize the datetime picker in edit mode but want the dates to be formated
                const dateTimeFormat = time.getLangDatetimeFormat();
                const dateFormat = time.getLangDateFormat();
                this.$target[0].querySelectorAll('.s-website-form-input.datetimepicker-input').forEach(el => {
                    const value = el.getAttribute('value');
                    if (value) {
                        const format = el.closest('.s-website-form-field').dataset.type === 'date' ? dateFormat : dateTimeFormat;
                        el.value = moment.unix(value).format(format);
                    }
                });
            }
            return this._super(...arguments);
        },
    });

    publicWidget.registry.sWebsiteForm = publicWidget.Widget.extend({
        selector: '.s-website-form form, form.s-website-form', // !compatibility
        xmlDependencies: ['/website/static/src/xml/website_form.xml'],
        events: {
            'click .s-website-form-send, .o-website-form-send': 'send', // !compatibility
        },

        /**
         * @constructor
         */
        init: function () {
            this._super(...arguments);
            this._recaptcha = new ReCaptcha();
            this.initialValues = new Map();
            this._visibilityFunctionByFieldName = new Map();
            this._visibilityFunctionByFieldEl = new Map();
            this.__started = new Promise(resolve => this.__startResolve = resolve);
        },
        willStart: async function () {
            const res = this._super(...arguments);
            if (!this.$target[0].classList.contains('s-website-form-no-recaptcha')) {
                this._recaptchaLoaded = true;
                this._recaptcha.loadLibs();
            }
            // fetch user data (required by fill-with behavior)
            this.preFillValues = {};
            if (session.userId) {
                this.preFillValues = (await this._rpc({
                    model: 'res.users',
                    method: 'read',
                    args: [session.userId, this._getUserPreFillFields()],
                }))[0] || {};
            }

            return res;
        },
        start: function () {
            // Prepare visibility data and update field visibilities
            const visibilityFunctionsByFieldName = new Map();
            for (const fieldEl of this.$target[0].querySelectorAll('[data-visibility-dependency]')) {
                const inputName = fieldEl.querySelector('.s-website-form-input').name;
                if (!visibilityFunctionsByFieldName.has(inputName)) {
                    visibilityFunctionsByFieldName.set(inputName, []);
                }
                const func = this._buildVisibilityFunction(fieldEl);
                visibilityFunctionsByFieldName.get(inputName).push(func);
                this._visibilityFunctionByFieldEl.set(fieldEl, func);
            }
            for (const [name, funcs] of visibilityFunctionsByFieldName.entries()) {
                this._visibilityFunctionByFieldName.set(name, () => funcs.some(func => func()));
            }
            this._updateFieldsVisibility();

            this._onFieldInputDebounced = _.debounce(this._onFieldInput.bind(this), 400);
            this.$el.on('input.s-website-form', '.s-website-form-field', this._onFieldInputDebounced);

            // Initialize datetimepickers
            var datepickersOptions = {
                minDate: moment({y: 1000}),
                maxDate: moment({y: 9999, M: 11, d: 31}),
                calendarWeeks: true,
                icons: {
                    time: 'fa fa-clock-o',
                    date: 'fa fa-calendar',
                    next: 'fa fa-chevron-right',
                    previous: 'fa fa-chevron-left',
                    up: 'fa fa-chevron-up',
                    down: 'fa fa-chevron-down',
                },
                locale: moment.locale(),
                format: time.getLangDatetimeFormat(),
                extraFormats: ['X'],
            };
            const $datetimes = this.$target.find('.s-website-form-datetime, .o-website-form-datetime'); // !compatibility
            $datetimes.datetimepicker(datepickersOptions);

            // Adapt options to date-only pickers
            datepickersOptions.format = time.getLangDateFormat();
            const $dates = this.$target.find('.s-website-form-date, .o-website-form-date'); // !compatibility
            $dates.datetimepicker(datepickersOptions);

            this.$allDates = $datetimes.add($dates);
            this.$allDates.addClass('s-website-form-datepicker-initialized');

            // Display form values from tag having data-for attribute
            // It's necessary to handle field values generated on server-side
            // Because, using t-att- inside form make it non-editable
            // Data-fill-with attribute is given during registry and is used by
            // to know which user data should be used to prfill fields.
            const dataForEl = document.querySelector(`[data-for='${this.$target[0].id}']`);
            if (dataForEl || Object.keys(this.preFillValues).length) {
                const dataForValues = dataForEl ?
                    JSON.parse(dataForEl.dataset.values
                        .replace('false', '""')
                        .replace('None', '""')
                        .replace(/'/g, '"')
                    ) : {};
                const fieldNames = this.$target.serializeArray().map(el => el.name);
                // All types of inputs do not have a value property (eg:hidden),
                // for these inputs any function that is supposed to put a value
                // property actually puts a HTML value attribute. Because of
                // this, we have to clean up these values at destroy or else the
                // data loaded here could become default values. We could set
                // the values to submit() for these fields but this could break
                // customizations that use the current behavior as a feature.
                for (const name of fieldNames) {
                    const fieldEl = this.$target[0].querySelector(`[name="${name}"]`);

                    // In general, we want the data-for and prefill values to
                    // take priority over SET DEFAULT values. The 'emailTo'
                    // field is however treated as an exception at the moment
                    // so that values set by users are always used.
                    if (name === 'emailTo' && fieldEl.value
                            // The following value is the default value that
                            // is set if the form is edited in any way. (see the
                            // website.formEditorRegistry module in editor
                            // assets bundle).
                            // TODO that value should probably never be forced
                            // unless explicitely manipulated by the user or on
                            // custom form addition but that seems risky to
                            // change as a stable fix.
                            && fieldEl.value !== 'info@yourcompany.example.com') {
                        continue;
                    }

                    let newValue;
                    if (dataForValues && dataForValues[name]) {
                        newValue = dataForValues[name];
                    } else if (this.preFillValues[fieldEl.dataset.fillWith]) {
                        newValue = this.preFillValues[fieldEl.dataset.fillWith];
                    }
                    if (newValue) {
                        this.initialValues.set(fieldEl, fieldEl.getAttribute('value'));
                        fieldEl.value = newValue;
                    }
                }
            }

            // Check disabled states
            this.inputEls = this.$target[0].querySelectorAll('.s-website-form-field.s-website-form-field-hidden-if .s-website-form-input');
            this._disabledStates = new Map();
            for (const inputEl of this.inputEls) {
                this._disabledStates[inputEl] = inputEl.disabled;
            }

            return this._super(...arguments).then(() => this.__startResolve());
        },

        destroy: function () {
            this._super.apply(this, arguments);
            this.$target.find('button').off('click');

            // Empty imputs
            this.$target[0].reset();

            // Apply default values
            const dateTimeFormat = time.getLangDatetimeFormat();
            const dateFormat = time.getLangDateFormat();
            this.$target[0].querySelectorAll('input[type="text"], input[type="email"], input[type="number"]').forEach(el => {
                let value = el.getAttribute('value');
                if (value) {
                    if (el.classList.contains('datetimepicker-input')) {
                        const format = el.closest('.s-website-form-field').dataset.type === 'date' ? dateFormat : dateTimeFormat;
                        value = moment.unix(value).format(format);
                    }
                    el.value = value;
                }
            });
            this.$target[0].querySelectorAll('textarea').forEach(el => el.value = el.textContent);

            // Remove saving of the error colors
            this.$target.find('.o-has-error').removeClass('o-has-error').find('.form-control, .custom-select').removeClass('is-invalid');

            // Remove the status message
            this.$target.find('#sWebsiteFormResult, #oWebsiteFormResult').empty(); // !compatibility

            // Remove the success message and display the form
            this.$target.removeClass('d-none');
            this.$target.parent().find('.s-website-form-end-message').addClass('d-none');

            // Reinitialize dates
            this.$allDates.removeClass('s-website-form-datepicker-initialized');

            // Restore disabled attribute
            for (const inputEl of this.inputEls) {
                inputEl.disabled = !!this._disabledStates.get(inputEl);
            }

            // All 'hidden if' fields start with d-none
            this.$target[0].querySelectorAll('.s-website-form-field-hidden-if:not(.d-none)').forEach(el => el.classList.add('d-none'));

            // Reset the initial default values.
            for (const [fieldEl, initialValue] of this.initialValues.entries()) {
                if (initialValue) {
                    fieldEl.setAttribute('value', initialValue);
                } else {
                    fieldEl.removeAttribute('value');
                }
            }

            this.$el.off('.s-website-form');
        },

        send: async function (e) {
            e.preventDefault(); // Prevent the default submit behavior
             // Prevent users from crazy clicking
            const $button = this.$target.find('.s-website-form-send, .o-website-form-send');
            $button.addClass('disabled') // !compatibility
                   .attr('disabled', 'disabled');
            this.restoreBtnLoading = dom.addButtonLoadingEffect($button[0]);

            var self = this;

            self.$target.find('#sWebsiteFormResult, #oWebsiteFormResult').empty(); // !compatibility
            if (!self.checkErrorFields({})) {
                self.updateStatus('error', _t("Please fill in the form correctly."));
                return false;
            }

            // Prepare form inputs
            this.formFields = this.$target.serializeArray();
            $.each(this.$target.find('input[type=file]:not([disabled])'), (outer_index, input) => {
                $.each($(input).prop('files'), function (index, file) {
                    // Index field name as ajax won't accept arrays of files
                    // when aggregating multiple files into a single field value
                    self.formFields.push({
                        name: input.name + '[' + outer_index + '][' + index + ']',
                        value: file
                    });
                });
            });

            // Serialize form inputs into a single object
            // Aggregate multiple values into arrays
            var formValues = {};
            _.each(this.formFields, function (input) {
                if (input.name in formValues) {
                    // If a value already exists for this field,
                    // we are facing a x2many field, so we store
                    // the values in an array.
                    if (Array.isArray(formValues[input.name])) {
                        formValues[input.name].push(input.value);
                    } else {
                        formValues[input.name] = [formValues[input.name], input.value];
                    }
                } else {
                    if (input.value !== '') {
                        formValues[input.name] = input.value;
                    }
                }
            });

            // force server date format usage for existing fields
            this.$target.find('.s-website-form-field:not(.s-website-form-custom)')
            .find('.s-website-form-date, .s-website-form-datetime').each(function () {
                var date = $(this).datetimepicker('viewDate').clone().locale('en');
                var format = 'YYYY-MM-DD';
                if ($(this).hasClass('s-website-form-datetime')) {
                    date = date.utc();
                    format = 'YYYY-MM-DD HH:mm:ss';
                }
                formValues[$(this).find('input').attr('name')] = date.format(format);
            });

            if (this._recaptchaLoaded) {
                const tokenObj = await this._recaptcha.getToken('websiteForm');
                if (tokenObj.token) {
                    formValues['recaptchaTokenResponse'] = tokenObj.token;
                } else if (tokenObj.error) {
                    self.updateStatus('error', tokenObj.error);
                    return false;
                }
            }

            // Post form and handle result
            ajax.post(this.$target.attr('action') + (this.$target.data('forceAction') || this.$target.data('modelName')), formValues)
            .then(async function (resultData) {
                // Restore send button behavior
                self.$target.find('.s-website-form-send, .o-website-form-send')
                    .removeAttr('disabled')
                    .removeClass('disabled'); // !compatibility
                resultData = JSON.parse(resultData);
                if (!resultData.id) {
                    // Failure, the server didn't return the created record ID
                    self.updateStatus('error', resultData.error ? resultData.error : false);
                    if (resultData.errorFields) {
                        // If the server return a list of bad fields, show these fields for users
                        self.checkErrorFields(resultData.errorFields);
                    }
                } else {
                    // Success, redirect or update status
                    let successMode = self.$target[0].dataset.successMode;
                    let successPage = self.$target[0].dataset.successPage;
                    if (!successMode) {
                        successPage = self.$target.attr('data-success-page'); // Compatibility
                        successMode = successPage ? 'redirect' : 'nothing';
                    }
                    switch (successMode) {
                        case 'redirect': {
                            successPage = successPage.startsWith("/#") ? successPage.slice(1) : successPage;
                            if (successPage.charAt(0) === "#") {
                                await dom.scrollTo($(successPage)[0], {
                                    duration: 500,
                                    extraOffset: 0,
                                });
                                break;
                            }
                            $(window.location).attr('href', successPage);
                            return;
                        }
                        case 'message': {
                            // Prevent double-clicking on the send button and
                            // add a upload loading effect (delay before success
                            // message)
                            await concurrency.delay(dom.DEBOUNCE);

                            self.$target[0].classList.add('d-none');
                            self.$target[0].parentElement.querySelector('.s-website-form-end-message').classList.remove('d-none');
                            return;
                        }
                        default: {
                            // Prevent double-clicking on the send button and
                            // add a upload loading effect (delay before success
                            // message)
                            await concurrency.delay(dom.DEBOUNCE);

                            self.updateStatus('success');
                            break;
                        }
                    }

                    self.$target[0].reset();
                    self.restoreBtnLoading();
                }
            })
            .guardedCatch(error => {
                this.updateStatus(
                    'error',
                    error.status && error.status === 413 ? _t("Uploaded file is too large.") : "",
                );
            });
        },

        checkErrorFields: function (errorFields) {
            var self = this;
            var formValid = true;
            // Loop on all fields
            this.$target.find('.form-field, .s-website-form-field').each(function (k, field) { // !compatibility
                var $field = $(field);
                var fieldName = $field.find('.col-form-label').attr('for');

                // Validate inputs for this field
                var inputs = $field.find('.s-website-form-input, .o-website-form-input').not('#editableSelect'); // !compatibility
                var invalidInputs = inputs.toArray().filter(function (input, k, inputs) {
                    // Special check for multiple required checkbox for same
                    // field as it seems checkValidity forces every required
                    // checkbox to be checked, instead of looking at other
                    // checkboxes with the same name and only requiring one
                    // of them to be checked.
                    if (input.required && input.type === 'checkbox') {
                        // Considering we are currently processing a single
                        // field, we can assume that all checkboxes in the
                        // inputs variable have the same name
                        var checkboxes = _.filter(inputs, function (input) {
                            return input.required && input.type === 'checkbox';
                        });
                        return !_.any(checkboxes, checkbox => checkbox.checked);

                    // Special cases for dates and datetimes
                    } else if ($(input).hasClass('s-website-form-date') || $(input).hasClass('o-website-form-date')) { // !compatibility
                        if (!self.isDatetimeValid(input.value, 'date')) {
                            return true;
                        }
                    } else if ($(input).hasClass('s-website-form-datetime') || $(input).hasClass('o-website-form-datetime')) { // !compatibility
                        if (!self.isDatetimeValid(input.value, 'datetime')) {
                            return true;
                        }
                    }
                    return !input.checkValidity();
                });

                // Update field color if invalid or erroneous
                $field.removeClass('o-has-error').find('.form-control, .custom-select').removeClass('is-invalid');
                if (invalidInputs.length || errorFields[fieldName]) {
                    $field.addClass('o-has-error').find('.form-control, .custom-select').addClass('is-invalid');
                    if (_.isString(errorFields[fieldName])) {
                        $field.popover({content: errorFields[fieldName], trigger: 'hover', container: 'body', placement: 'top'});
                        // update error message and show it.
                        $field.data("bs.popover").config.content = errorFields[fieldName];
                        $field.popover('show');
                    }
                    formValid = false;
                }
            });
            return formValid;
        },

        isDatetimeValid: function (value, typeOfDate) {
            if (value === "") {
                return true;
            } else {
                try {
                    this.parseDate(value, typeOfDate);
                    return true;
                } catch (e) {
                    return false;
                }
            }
        },

        // This is a stripped down version of format.js parse_value function
        parseDate: function (value, typeOfDate, valueIfEmpty) {
            var datePattern = time.getLangDateFormat(),
                timePattern = time.getLangTimeFormat();
            var datePatternWoZero = datePattern.replace('MM', 'M').replace('DD', 'D'),
                timePatternWoZero = timePattern.replace('HH', 'H').replace('mm', 'm').replace('ss', 's');
            switch (typeOfDate) {
                case 'datetime':
                    var datetime = moment(value, [datePattern + ' ' + timePattern, datePatternWoZero + ' ' + timePatternWoZero], true);
                    if (datetime.isValid()) {
                        return time.datetimeToStr(datetime.toDate());
                    }
                    throw new Error(_.str.sprintf(_t("'%s' is not a correct datetime"), value));
                case 'date':
                    var date = moment(value, [datePattern, datePatternWoZero], true);
                    if (date.isValid()) {
                        return time.dateToStr(date.toDate());
                    }
                    throw new Error(_.str.sprintf(_t("'%s' is not a correct date"), value));
            }
            return value;
        },

        updateStatus: function (status, message) {
            if (status !== 'success') { // Restore send button behavior if result is an error
                this.$target.find('.s-website-form-send, .o-website-form-send')
                    .removeAttr('disabled')
                    .removeClass('disabled'); // !compatibility
                this.restoreBtnLoading();
            }
            var $result = this.$('#sWebsiteFormResult, #oWebsiteFormResult'); // !compatibility

            if (status === 'error' && !message) {
                message = _t("An error has occured, the form has not been sent.");
            }

            // Note: we still need to wait that the widget is properly started
            // before any qweb rendering which depends on xmlDependencies
            // because the event handlers are binded before the call to
            // willStart for public widgets...
            this.__started.then(() => $result.replaceWith(qweb.render(`website.sWebsiteFormStatus${_.upperFirst(status)}`, {
                message: message,
            })));
        },

        //----------------------------------------------------------------------
        // Private
        //----------------------------------------------------------------------

        /**
         * Gets the user's field needed to be fetched to pre-fill the form.
         *
         * @returns {string[]} List of user's field that have to be fetched.
         */
        _getUserPreFillFields() {
            return ['label', 'phone', 'email', 'commercialCompanyName'];
        },
        /**
         * Compares the value with the comparable (and the between) with
         * comparator as a means to compare
         *
         * @private
         * @param {string} comparator The way that $value and $comparable have
         *      to be compared
         * @param {string} [value] The value of the field
         * @param {string} [comparable] The value to compare
         * @param {string} [between] The maximum date value in case comparator
         *      is between or !between
         * @returns {boolean}
         */
        _compareTo(comparator, value = '', comparable, between) {
            switch (comparator) {
                case 'contains':
                    return value.includes(comparable);
                case '!contains':
                    return !value.includes(comparable);
                case 'equal':
                case 'selected':
                    return value === comparable;
                case '!equal':
                case '!selected':
                    return value !== comparable;
                case 'set':
                    return value;
                case '!set':
                    return !value;
                case 'greater':
                    return value > comparable;
                case 'less':
                    return value < comparable;
                case 'greater or equal':
                    return value >= comparable;
                case 'less or equal':
                    return value <= comparable;
                case 'fileSet':
                    return value.name !== '';
                case '!fileSet':
                    return value.name === '';
            }
            // Date & Date Time comparison requires formatting the value
            if (value.includes(':')) {
                const datetimeFormat = time.getLangDatetimeFormat();
                value = moment(value, datetimeFormat)._d.getTime() / 1000;
            } else {
                const dateFormat = time.getLangDateFormat();
                value = moment(value, dateFormat)._d.getTime() / 1000;
            }
            comparable = parseInt(comparable);
            between = parseInt(between) || '';
            switch (comparator) {
                case 'dateEqual':
                    return value === comparable;
                case 'date!equal':
                    return value !== comparable;
                case 'before':
                    return value < comparable;
                case 'after':
                    return value > comparable;
                case 'equal or before':
                    return value <= comparable;
                case 'between':
                    return value >= comparable && value <= between;
                case '!between':
                    return !(value >= comparable && value <= between);
                case 'equal or after':
                    return value >= comparable;
            }
        },
        /**
         * @private
         * @param {HTMLElement} fieldEl the field we want to have a function
         *      that calculates its visibility
         * @returns {function} the function to be executed when we want to
         *      recalculate the visibility of fieldEl
         */
        _buildVisibilityFunction(fieldEl) {
            const visibilityCondition = fieldEl.dataset.visibilityCondition;
            const dependencyName = fieldEl.dataset.visibilityDependency;
            const comparator = fieldEl.dataset.visibilityComparator;
            const between = fieldEl.dataset.visibilityBetween;
            return () => {
                // To be visible, at least one field with the dependency name must be visible.
                const dependencyVisibilityFunction = this._visibilityFunctionByFieldName.get(dependencyName);
                const dependencyIsVisible = !dependencyVisibilityFunction || dependencyVisibilityFunction();
                if (!dependencyIsVisible) {
                    return false;
                }

                const formData = new FormData(this.$target[0]);
                const currentValueOfDependency = formData.get(dependencyName);
                return this._compareTo(comparator, currentValueOfDependency, visibilityCondition, between);
            };
        },
        /**
         * Calculates the visibility for each field with conditional visibility
         */
        _updateFieldsVisibility() {
            for (const [fieldEl, visibilityFunction] of this._visibilityFunctionByFieldEl.entries()) {
                this._updateFieldVisibility(fieldEl, visibilityFunction());
            }
        },
        /**
         * Changes the visibility of a field.
         *
         * @param {HTMLElement} fieldEl
         * @param {boolean} haveToBeVisible
         */
        _updateFieldVisibility(fieldEl, haveToBeVisible) {
            const fieldContainerEl = fieldEl.closest('.s-website-form-field');
            fieldContainerEl.classList.toggle('d-none', !haveToBeVisible);
            for (const inputEl of fieldContainerEl.querySelectorAll('.s-website-form-input')) {
                // Hidden inputs should also be disabled so that their data are
                // not sent on form submit.
                inputEl.disabled = !haveToBeVisible;
            }
        },

        //----------------------------------------------------------------------
        // Handlers
        //----------------------------------------------------------------------

        /**
         * Calculates the visibility of the fields at each input event on the
         * form (this method should be debounced in the start).
         */
        _onFieldInput() {
            this._updateFieldsVisibility();
        },
    });
});
