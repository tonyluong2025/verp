verp.define('account.ShowGroupedList', function (require) {
"use strict";

const { Component } = owl;
const { useState } = owl.hooks;
const AbstractFieldOwl = require('web.AbstractFieldOwl');
const fieldRegistry = require('web.fieldRegistryOwl');

class ListItem extends Component { }
ListItem.template = 'account.GroupedItemTemplate';
ListItem.props = ["itemVals", "options"];

class ListGroup extends Component { }
ListGroup.template = 'account.GroupedItemsTemplate';
ListGroup.components = { ListItem }
ListGroup.props = ["groupVals", "options"];


class ShowGroupedList extends AbstractFieldOwl {
    constructor(...args) {
        super(...args);
        this.data = this.value ? JSON.parse(this.value) : {
            groupsVals: [],
            options: {
                discardedNumber: '',
                columns: [],
            },
        };
    }
    async willUpdateProps(nextProps) {
        await super.willUpdateProps(nextProps);
        Object.assign(this.data, JSON.parse(this.value));
    }
}
ShowGroupedList.template = 'account.GroupedListTemplate';
ShowGroupedList.components = { ListGroup }

fieldRegistry.add('groupedViewWidget', ShowGroupedList);
return ShowGroupedList;
});
