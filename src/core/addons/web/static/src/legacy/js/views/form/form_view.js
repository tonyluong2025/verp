verp.define('web.FormView', function (require) {
"use strict";

var BasicView = require('web.BasicView');
var Context = require('web.Context');
var core = require('web.core');
var FormController = require('web.FormController');
var FormRenderer = require('web.FormRenderer');
const { generateID } = require('web.utils');

var _lt = core._lt;

var FormView = BasicView.extend({
    config: _.extend({}, BasicView.prototype.config, {
        Renderer: FormRenderer,
        Controller: FormController,
    }),
    displayName: _lt('Form'),
    icon: 'fa-edit',
    multiRecord: false,
    withSearchBar: false,
    searchMenuTypes: [],
    viewType: 'form',
    /**
     * @override
     */
    init: function (viewInfo, params) {
        var hasActionMenus = params.hasActionMenus;
        this._super.apply(this, arguments);

        var mode = params.mode || (params.currentId ? 'readonly' : 'edit');
        this.loadParams.type = 'record';

        // this is kind of strange, but the param object is modified by
        // AbstractView, so we only need to use its hasActionMenus value if it was
        // not already present in the beginning of this method
        if (hasActionMenus === undefined) {
            hasActionMenus = params.hasActionMenus;
        }
        this.controllerParams.hasActionMenus = hasActionMenus;
        this.controllerParams.disableAutofocus = params.disableAutofocus || this.arch.attrs.disableAutofocus;
        this.controllerParams.toolbarActions = viewInfo.toolbar;
        this.controllerParams.footerToButtons = params.footerToButtons;

        var defaultButtons = 'defaultButtons' in params ? params.defaultButtons : true;
        this.controllerParams.defaultButtons = defaultButtons;
        this.controllerParams.mode = mode;

        this.rendererParams.mode = mode;
        this.rendererParams.isFromFormViewDialog = params.isFromFormViewDialog;
        this.rendererParams.fieldIdsToNames = this.fieldsView.fieldIdsToNames;
    },

    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    getController: function (parent) {
        return this._loadSubviews(parent).then(this._super.bind(this, parent));
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     */
    _extractParamsFromAction: function (action) {
        var params = this._super.apply(this, arguments);
        var inDialog = action.target === 'new';
        var inline = action.target === 'inline';
        var fullscreen = action.target === 'fullscreen';
        params.withControlPanel = !(inDialog || inline);
        params.footerToButtons = inDialog;
        params.hasSearchView = inDialog ? false : params.hasSearchView;
        params.hasActionMenus = !inDialog && !inline;
        params.searchMenuTypes = inDialog ? [] : params.searchMenuTypes;
        if (inDialog || inline || fullscreen) {
            params.mode = 'edit';
        } else if (action.context && action.context.formViewInitialMode) {
            params.mode = action.context.formViewInitialMode;
        }
        return params;
    },
    /**
     * Loads the subviews for x2many fields when they are not inline
     *
     * @private
     * @param {Widget} parent the parent of the model, if it has to be created
     * @returns {Promise}
     */
    _loadSubviews: function (parent) {
        var self = this;
        var defs = [];
        if (this.loadParams && this.loadParams.fieldsInfo) {
            var fields = this.loadParams.fields;

            _.each(this.loadParams.fieldsInfo.form, function (attrs, fieldName) {
                var field = fields[fieldName];
                if (!field) {
                    // when a one2many record is opened in a form view, the fields
                    // of the main one2many view (list or kanban) are added to the
                    // fieldsInfo of its form view, but those fields aren't in the
                    // loadParams.fields, as they are not displayed in the view, so
                    // we can ignore them.
                    return;
                }
                if (field.type !== 'one2many' && field.type !== 'many2many') {
                    return;
                }

                if (attrs.Widget.prototype.useSubview && !attrs.__noFetch && !attrs.views[attrs.mode]) {
                    var context = {};
                    var regex = /'([a-z]*ViewRef)' *: *'(.*?)'/g;
                    var matches;
                    while (matches = regex.exec(attrs.context)) {
                        context[matches[1]] = matches[2];
                    }

                    // Remove *ViewRef coming from parent view
                    var refinedContext = _.pick(self.loadParams.context, function (value, key) {
                        return key.indexOf('ViewRef') === -1;
                    });
                    // Specify the main model to prevent access rights defined in the context
                    // (e.g. create: 0) to apply to subviews. We use here the same logic as
                    // the one applied by the server for inline views.
                    refinedContext.baseModelName = self.controllerParams.modelName;
                    defs.push(parent.loadViews(
                            field.relation,
                            new Context(context, self.userContext, refinedContext).eval(),
                            [[null, attrs.mode === 'tree' ? 'list' : attrs.mode]])
                        .then(function (views) {
                            for (var viewName in views) {
                                // clone to make runbot green?
                                attrs.views[viewName] = self._processFieldsView(views[viewName], viewName);
                                attrs.views[viewName].fields = attrs.views[viewName].viewFields;
                                self._processSubViewAttrs(attrs.views[viewName], attrs);
                            }
                            self._setSubViewLimit(attrs);
                        }));
                } else {
                    self._setSubViewLimit(attrs);
                }
            });
        }
        return Promise.all(defs);
    },
    /**
     * @override
     */
    _processArch(arch, fv) {
        fv.fieldIdsToNames = {}; // maps field ids (identifying <field> nodes) to field names
        return this._super(...arguments);
    },
    /**
     * Override to populate the 'fieldIdsToNames' dict mapping <field> node ids
     * to field names. Those ids are computed as follows:
     *   - if set on the node, we use the 'id' attribute
     *   - otherwise
     *       - if this is the first occurrence of the field in the arch, we use
     *         its name as id ('name' attribute)
     *       - otherwise we generate an id by concatenating the field name with
     *         a unique id
     *       - in both cases, we set the id we generated in the attrs, as it
     *         will be used by the renderer.
     *
     * @override
     */
    _processNode(node, fv) {
        if (node.tag === 'field') {
            const name = node.attrs.name;
            let uid = node.attrs.id;
            if (!uid) {
                uid = name in fv.fieldIdsToNames ? `${name}__${generateID()}__` : name;
                node.attrs.id = uid;
            }
            fv.fieldIdsToNames[uid] = name;
        }
        return this._super(...arguments);
    },
    /**
     * We set here the limit for the number of records fetched (in one page).
     * This method is only called for subviews, not for main views.
     *
     * @private
     * @param {Object} attrs
     */
    _setSubViewLimit: function (attrs) {
        var view = attrs.views && attrs.views[attrs.mode];
        var limit = view && view.arch.attrs.limit && parseInt(view.arch.attrs.limit, 10);
        attrs.limit = limit || attrs.Widget.prototype.limit || 40;
    },
});

return FormView;

});
