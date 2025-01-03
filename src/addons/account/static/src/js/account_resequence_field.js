verp.define('account.ShowResequenceRenderer', function (require) {
"use strict";

const { Component } = owl;
const { useState } = owl.hooks;
const AbstractFieldOwl = require('web.AbstractFieldOwl');
const fieldRegistry = require('web.fieldRegistryOwl');

class ChangeLine extends Component { }
ChangeLine.template = 'account.ResequenceChangeLine';
ChangeLine.props = ["changeLine", 'ordering'];


class ShowResequenceRenderer extends AbstractFieldOwl {
    constructor(...args) {
        super(...args);
        this.data = this.value ? JSON.parse(this.value) : {
            changeLines: [],
            ordering: 'date',
        };
    }
    async willUpdateProps(nextProps) {
        await super.willUpdateProps(nextProps);
        Object.assign(this.data, JSON.parse(this.value));
    }
}
ShowResequenceRenderer.template = 'account.ResequenceRenderer';
ShowResequenceRenderer.components = { ChangeLine }

fieldRegistry.add('accountResequenceWidget', ShowResequenceRenderer);
return ShowResequenceRenderer;
});
