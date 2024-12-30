verp.define('account.hierarchy.selection', function (require) {
"use strict";

    var core = require('web.core');
    var relationalFields = require('web.relationalFields');
    var _t = core._t;
    var registry = require('web.fieldRegistry');


    var FieldSelection = relationalFields.FieldSelection;

    var qweb = core.qweb;

    var HierarchySelection = FieldSelection.extend({
        _renderEdit: function () {
            var self = this;
            var prom = Promise.resolve()
            if (!self.hierarchyGroups) {
                prom = this._rpc({
                    model: 'account.account.type',
                    method: 'searchRead',
                    kwargs: {
                        domain: [],
                        fields: ['id', 'internalGroup', 'displayName'],
                    },
                }).then(function(arg) {
                    self.values = _.map(arg, v => [v['id'], v['displayName']])
                    self.hierarchyGroups = [
                        {
                            'label': _t('Balance Sheet'),
                            'children': [
                                {'label': _t('Assets'), 'ids': _.map(_.filter(arg, v => v['internalGroup'] == 'asset'), v => v['id'])},
                                {'label': _t('Liabilities'), 'ids': _.map(_.filter(arg, v => v['internalGroup'] == 'liability'), v => v['id'])},
                                {'label': _t('Equity'), 'ids': _.map(_.filter(arg, v => v['internalGroup'] == 'equity'), v => v['id'])},
                            ],
                        },
                        {
                            'label': _t('Profit & Loss'),
                            'children': [
                                {'label': _t('Income'), 'ids': _.map(_.filter(arg, v => v['internalGroup'] == 'income'), v => v['id'])},
                                {'label': _t('Expense'), 'ids': _.map(_.filter(arg, v => v['internalGroup'] == 'expense'), v => v['id'])},
                            ],
                        },
                        {'label': _t('Other'), 'ids': _.map(_.filter(arg, v => !['asset', 'liability', 'equity', 'income', 'expense'].includes(v['internalGroup'])), v => v['id'])},
                    ]
                });
            }

            Promise.resolve(prom).then(function() {
                self.$el.empty();
                self._addHierarchy(self.$el, self.hierarchyGroups, 0);
                var value = self.value;
                if (self.field.type === 'many2one' && value) {
                    value = value.data.id;
                }
                self.$el.val(JSON.stringify(value));
            });
        },
        _addHierarchy: function(el, group, level) {
            var self = this;
            _.each(group, function(item) {
                var optgroup = $('<optgroup/>').attr(({
                    'label': $('<div/>').html('&nbsp;'.repeat(6 * level) + item['label']).text(),
                }))
                _.each(item['ids'], function(id) {
                    var value = _.find(self.values, v => v[0] == id)
                    optgroup.append($('<option/>', {
                        value: JSON.stringify(value[0]),
                        text: value[1],
                    }));
                })
                el.append(optgroup)
                if (item['children']) {
                    self._addHierarchy(el, item['children'], level + 1);
                }
            })
        }
    });
    registry.add("accountHierarchySelection", HierarchySelection);
});
