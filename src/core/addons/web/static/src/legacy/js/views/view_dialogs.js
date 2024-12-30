/** @verp-module alias=web.viewDialogs **/

import config from 'web.config';
import core from 'web.core';
import Dialog from 'web.Dialog';
import dom from 'web.dom';
import viewRegistry from 'web.viewRegistry';
import selectCreateControllersRegistry from 'web.selectCreateControllersRegistry';

var _t = core._t;

/**
 * Class with everything which is common between FormViewDialog and
 * SelectCreateDialog.
 */
var ViewDialog = Dialog.extend({
    customEvents: _.extend({}, Dialog.prototype.customEvents, {
        pushState: '_onPushState',
    }),
    /**
     * @constructor
     * @param {Widget} parent
     * @param {options} [options]
     * @param {string} [options.dialogClass=o-actwindow]
     * @param {string} [options.resModel] the model of the record(s) to open
     * @param {any[]} [options.domain]
     * @param {Object} [options.context]
     */
    init: function (parent, options) {
        options = options || {};
        options.fullscreen = config.device.isMobile;
        options.dialogClass = options.dialogClass || '' + ' o-actwindow';

        this._super(parent, $.extend(true, {}, options));

        this.resModel = options.resModel || null;
        this.domain = options.domain || [];
        this.context = options.context || {};
        this.options = _.extend(this.options || {}, options || {});
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * We stop all pushState events from bubbling up.  It would be weird to
     * change the url because a dialog opened.
     *
     * @param {VerpEvent} event
     */
    _onPushState: function (event) {
        event.stopPropagation();
    },
});

/**
 * Create and edit dialog (displays a form view record and leave once saved)
 */
var FormViewDialog = ViewDialog.extend({
    /**
     * @param {Widget} parent
     * @param {Object} [options]
     * @param {string} [options.parentId] the id of the parent record. It is
     *   useful for situations such as a one2many opened in a form view dialog.
     *   In that case, we want to be able to properly evaluate domains with the
     *   'parent' key.
     * @param {integer} [options.resId] the id of the record to open
     * @param {Object} [options.formViewOptions] dict of options to pass to
     *   the Form View @todo: make it work
     * @param {Object} [options.fieldsView] optional form fieldsView
     * @param {boolean} [options.readonly=false] only applicable when not in
     *   creation mode
     * @param {boolean} [options.deletable=false] whether or not the record can
     *   be deleted
     * @param {boolean} [options.editable=true] whether or not the record can
     *   be edited
     * @param {boolean} [options.disableMultipleSelection=false] set to true
     *   to remove the possibility to create several records in a row
     * @param {function} [options.onSaved] callback executed after saving a
     *   record.  It will be called with the record data, and a boolean which
     *   indicates if something was changed
     * @param {function} [options.onRemove] callback executed when the user
     *   clicks on the 'Remove' button
     * @param {BasicModel} [options.model] if given, it will be used instead of
     *  a new form view model
     * @param {string} [options.recordId] if given, the model has to be given as
     *   well, and in that case, it will be used without loading anything.
     * @param {boolean} [options.shouldSaveLocally] if true, the view dialog
     *   will save locally instead of actually saving (useful for one2manys)
     * @param {function} [options._createContext] function to get context for name field
     *   useful for many2manyTags widget where we want to removed defaultName field
     *   context.
     */
    init: function (parent, options) {
        var self = this;
        options = options || {};

        this.resId = options.resId || null;
        this.onSaved = options.onSaved || (function () {});
        this.onRemove = options.onRemove || (function () {});
        this.context = options.context;
        this._createContext = options._createContext;
        this.model = options.model;
        this.parentId = options.parentId;
        this.recordId = options.recordId;
        this.shouldSaveLocally = options.shouldSaveLocally;
        this.readonly = options.readonly;
        this.deletable = options.deletable;
        this.editable = options.editable;
        this.disableMultipleSelection = options.disableMultipleSelection;
        var oBtnRemove = 'o-btn-remove';

        var multiSelect = !_.isNumber(options.resId) && !options.disableMultipleSelection;
        var readonly = _.isNumber(options.resId) && options.readonly;

        if (!options.buttons) {
            options.buttons = [{
                text: options.closeText || (readonly ? _t("Close") : _t("Discard")),
                classes: "btn-secondary o-form-button-cancel",
                close: true,
                click: function () {
                    if (!readonly) {
                        self.formView.model.discardChanges(self.formView.handle, {
                            rollback: self.shouldSaveLocally,
                        });
                    }
                },
            }];

            if (!readonly) {
                options.buttons.unshift({
                    text: options.saveText || (multiSelect ? _t("Save & Close") : _t("Save")),
                    classes: "btn-primary",
                    click: function () {
                        self._save().then(self.close.bind(self));
                    }
                });

                if (multiSelect) {
                    options.buttons.splice(1, 0, {
                        text: _t("Save & New"),
                        classes: "btn-primary",
                        click: function () {
                            self._save()
                                .then(function () {
                                    // reset default name field from context when Save & New is clicked, pass additional
                                    // context so that when getContext is called additional context resets it
                                    const additionalContext = self._createContext && self._createContext(false);
                                    self.formView.createRecord(self.parentId, additionalContext);
                                })
                                .then(function () {
                                    if (!self.deletable) {
                                        return;
                                    }
                                    self.deletable = false;
                                    self.buttons = self.buttons.filter(function (button) {
                                        return button.classes.split(' ').indexOf(oBtnRemove) < 0;
                                    });
                                    self.setButtons(self.buttons);
                                    self.setTitle(_t("Create ") + _.str.strRight(self.title, _t("Open: ")));
                                });
                        },
                    });
                }

                var multi = options.disableMultipleSelection;
                if (!multi && this.deletable) {
                    this._setRemoveButtonOption(options, oBtnRemove);
                }
            }
        }
        this._super(parent, options);
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * Open the form view dialog.  It is necessarily asynchronous, but this
     * method returns immediately.
     *
     * @returns {FormViewDialog} this instance
     */
    open: function () {
        var self = this;
        var _super = this._super.bind(this);
        var FormView = viewRegistry.get('form');
        var fieldsViewDef;
        if (this.options.fieldsView) {
            fieldsViewDef = Promise.resolve(this.options.fieldsView);
        } else {
            fieldsViewDef = this.loadFieldView(this.resModel, this.context, this.options.viewId, 'form');
        }

        fieldsViewDef.then(function (viewInfo) {
            var refinedContext = _.pick(self.context, function (value, key) {
                return key.indexOf('ViewRef') === -1;
            });
            var formview = new FormView(viewInfo, {
                modelName: self.resModel,
                context: refinedContext,
                ids: self.resId ? [self.resId] : [],
                currentId: self.resId || undefined,
                index: 0,
                mode: self.resId && self.options.readonly ? 'readonly' : 'edit',
                footerToButtons: true,
                defaultButtons: false,
                withControlPanel: false,
                model: self.model,
                parentId: self.parentId,
                recordId: self.recordId,
                isFromFormViewDialog: true,
                editable: self.editable
            });
            return formview.getController(self);
        }).then(function (formView) {
            self.formView = formView;
            var fragment = document.createDocumentFragment();
            if (self.recordId && self.shouldSaveLocally) {
                self.model.save(self.recordId, {savePoint: true});
            }
            return self.formView.appendTo(fragment)
                .then(function () {
                    self.opened().then(function () {
                        var $buttons = $('<div>');
                        self.formView.renderButtons($buttons);
                        if ($buttons.children().length) {
                            self.$footer.empty().append($buttons.contents());
                        }
                        dom.append(self.$el, fragment, {
                            callbacks: [{widget: self.formView}],
                            in_DOM: true,
                        });
                        self.formView.updateButtons();
                        self.triggerUp('dialogFormLoaded');
                    });
                    return _super();
                });
        });

        return this;
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _focusOnClose: function() {
        var isFocusSet = false;
        this.triggerUp('formDialogDiscarded', {
            callback: function (isFocused) {
                isFocusSet = isFocused;
            },
        });
        return isFocusSet;
    },

    /**
     * @private
     */
    _remove: function () {
        return Promise.resolve(this.onRemove());
    },

    /**
     * @private
     * @returns {Promise}
     */
    _save: function () {
        var self = this;
        return this.formView.saveRecord(this.formView.handle, {
            stayInEdit: true,
            reload: false,
            savePoint: this.shouldSaveLocally,
            viewType: 'form',
        }).then(function (changedFields) {
            // record might have been changed by the save (e.g. if this was a new record, it has an
            // id now), so don't re-use the copy obtained before the save
            var record = self.formView.model.get(self.formView.handle);
            return self.onSaved(record, !!changedFields.length);
        });
    },

    /**
     * Set the "remove" button into the options' buttons list
     *
     * @private
     * @param {Object} options The options object to modify
     * @param {string} btnClasses The classes for the remove button
     */
    _setRemoveButtonOption(options, btnClasses) {
        const self = this;
        options.buttons.push({
            text: _t("Remove"),
            classes: 'btn-secondary ' + btnClasses,
            click: function() {
                self._remove().then(self.close.bind(self));
            }
        });
    },
});

/**
 * Search dialog (displays a list of records and permits to create a new one by switching to a form view)
 */
var SelectCreateDialog = ViewDialog.extend({
    customEvents: _.extend({}, ViewDialog.prototype.customEvents, {
        selectRecord: function (event) {
            if (!this.options.readonly) {
                this.onSelected([event.data]);
                this.close();
            }
        },
        selectionchanged: function (event) {
            event.stopPropagation();
            this.$footer.find(".o-select-button").prop('disabled', !event.data.selection.length);
        },
    }),

    /**
     * options:
     * - initialIds
     * - initialView: form or search (default search)
     * - listViewOptions: dict of options to pass to the List View
     * - onSelected: optional callback to execute when records are selected
     * - disableMultipleSelection: true to allow create/select multiple records
     * - dynamicFilters: filters to add to the searchView
     */
    init: function () {
        this._super.apply(this, arguments);
        _.defaults(this.options, { initialView: 'search' });
        this.onSelected = this.options.onSelected || (function () {});
        this.onClosed = this.options.onClosed || (function () {});
        this.initialIDs = this.options.initialIds;
        this.viewType = 'list';
    },

    open: function () {
        if (this.options.initialView !== "search") {
            return this.createEditRecord();
        }
        var self = this;
        var _super = this._super.bind(this);
        var viewRefID = this.viewType === 'kanban' ?
            (this.options.kanbanViewRef && JSON.parse(this.options.kanbanViewRef) || false) : false;
        const searchviewId = this.options.searchViewId || false;
        return this.loadViews(this.resModel, this.context, [[viewRefID, this.viewType], [searchviewId, 'search']], {loadFilters: true})
            .then(this.setup.bind(this))
            .then(function (fragment) {
                self.opened().then(function () {
                    dom.append(self.$el, fragment, {
                        callbacks: [{widget: self.viewController}],
                        in_DOM: true,
                    });
                    self.setButtons(self.__buttons);
                });
                return _super();
            });
    },

    setup: function (fieldsViews) {
        var self = this;
        var fragment = document.createDocumentFragment();

        var domain = this.domain;
        if (this.initialIDs) {
            domain = domain.concat([['id', 'in', this.initialIDs]]);
        }
        var ViewClass = viewRegistry.get(this.viewType);
        var viewOptions = {};
        var selectCreateController;
        if (this.viewType === 'list') { // add listview specific options
            _.extend(viewOptions, {
                hasSelectors: !this.options.disableMultipleSelection,
                readonly: true,

            }, this.options.listViewOptions);
            selectCreateController = selectCreateControllersRegistry.SelectCreateListController;
        }
        if (this.viewType === 'kanban') {
            _.extend(viewOptions, {
                noDefaultGroupby: true,
                selectionMode: this.options.selectionMode || false,
            });
            selectCreateController = selectCreateControllersRegistry.SelectCreateKanbanController;
        }
        var view = new ViewClass(fieldsViews[this.viewType], _.extend(viewOptions, {
            action: {
                controlPanelFieldsView: fieldsViews.search,
                help: _.str.sprintf("<p>%s</p>", _t("No records found!")),
            },
            actionButtons: false,
            dynamicFilters: this.options.dynamicFilters,
            context: this.context,
            domain: domain,
            modelName: this.resModel,
            withBreadcrumbs: false,
            withSearchPanel: false,
        }));
        view.setController(selectCreateController);
        return view.getController(this).then(function (controller) {
            self.viewController = controller;
            // render the footer buttons
            self._prepareButtons();
            return self.viewController.appendTo(fragment);
        }).then(function () {
            return fragment;
        });
    },
    close: function () {
        this._super.apply(this, arguments);
        this.onClosed();
    },
    createEditRecord: function () {
        var self = this;
        var dialog = new FormViewDialog(this, _.extend({}, this.options, {
            onSaved: function (record) {
                var values = [{
                    id: record.resId,
                    displayName: record.data.displayName || record.data.name,
                }];
                self.onSelected(values);
            },
        })).open();
        dialog.on('closed', this, this.close);
        return dialog;
    },
    /**
     * @override
     */
    _focusOnClose: function() {
        var isFocusSet = false;
        this.triggerUp('formDialogDiscarded', {
            callback: function (isFocused) {
                isFocusSet = isFocused;
            },
        });
        return isFocusSet;
    },
    /**
     * prepare buttons for dialog footer based on options
     *
     * @private
     */
    _prepareButtons: function () {
        this.__buttons = [{
            text: _t("Cancel"),
            classes: 'btn-secondary o-form-button-cancel',
            close: true,
        }];
        if (!this.options.noCreate) {
            this.__buttons.unshift({
                text: _t("Create"),
                classes: 'btn-primary',
                click: this.createEditRecord.bind(this)
            });
        }
        if (!this.options.disableMultipleSelection) {
            this.__buttons.unshift({
                text: _t("Select"),
                classes: 'btn-primary o-select-button',
                disabled: true,
                close: true,
                click: async () => {
                    const values = await this.viewController.getSelectedRecordsWithDomain();
                    this.onSelected(values);
                },
            });
        }
    },
});

export default {
    FormViewDialog: FormViewDialog,
    SelectCreateDialog: SelectCreateDialog,
};
