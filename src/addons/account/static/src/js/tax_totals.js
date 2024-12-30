/** @verp-module alias=account.taxGroupOwl **/
"use strict";

const { Component } = owl;
const { useState, useRef } = owl.hooks;
import session from 'web.session';
import AbstractFieldOwl from 'web.AbstractFieldOwl';
import fieldUtils from 'web.fieldUtils';
import fieldRegistry from 'web.fieldRegistryOwl';

/**
    A line of some TaxTotalsComponent, giving the values of a tax group.
**/
class TaxGroupComponent extends Component {

    constructor(parent, props) {
        super(parent, props);
        this.inputTax = useRef('taxValueInput');
        this.state = useState({value: 'readonly'});
        this.allowTaxEdition = this.__owl__.parent.mode === 'edit' ? props.allowTaxEdition : false;
    }

    //--------------------------------------------------------------------------
    // Life cycle methods
    //--------------------------------------------------------------------------

    willUpdateProps(nextProps) {
        this.setState('readonly'); // If props are edited, we set the state to readonly
    }

    patched() {
        if (this.state.value === 'edit') {
            this.inputTax.el.focus(); // Focus the input
            this.inputTax.el.value = this.props.taxGroup.taxGroupAmount;
        }
    }

    //--------------------------------------------------------------------------
    // Main methods
    //--------------------------------------------------------------------------

    /**
     * The purpose of this method is to change the state of the component.
     * It can have one of the following three states:
     *  - readonly: display in read-only mode of the field,
     *  - edit: display with a html input field,
     *  - disable: display with a html input field that is disabled.
     *
     * If a value other than one of these 3 states is passed as a parameter,
     * the component is set to readonly by default.
     *
     * @param {String} value
     */
    setState(value) {
        if (['readonly', 'edit', 'disable'].includes(value)) {
            this.state.value = value;
        }
        else {
            this.state.value = 'readonly';
        }
    }

    /**
     * This method handles the "_onchangeTaxValue" event. In this method,
     * we get the new value for the tax group, we format it and we call
     * the method to recalculate the tax lines. At the moment the method
     * is called, we disable the html input field.
     *
     * In case the value has not changed or the tax group is equal to 0,
     * the modification does not take place.
     */
    _onchangeTaxValue() {
        this.setState('disable'); // Disable the input
        let newValue = this.inputTax.el.value; // Get the new value
        let currency = session.getCurrency(this.props.record.data.currencyId.data.id); // The records using this widget must have a currencyId field.
        try {
            newValue = fieldUtils.parse.float(newValue); // Need a float for format the value
            newValue = fieldUtils.format.float(newValue, null, {digits: currency.digits}); // Return a string rounded to currency precision
            newValue = fieldUtils.parse.float(newValue); // Convert back to Float to compare with oldValue to know if value has changed
        } catch (err) {
            $(this.inputTax.el).addClass('o-field-invalid');
            this.setState('edit');
            return;
        }
        // The newValue can't be equals to 0
        if (newValue === this.props.taxGroup.taxGroupAmount || newValue === 0) {
            this.setState('readonly');
            return;
        }
        this.props.taxGroup.taxGroupAmount = newValue;
        this.trigger('changeTaxGroup', {
            oldValue: this.props.taxGroup.taxGroupAmount,
            newValue: newValue,
            taxGroupId: this.props.taxGroup.taxGroupId
        });
    }
}
TaxGroupComponent.props = ['taxGroup', 'allowTaxEdition', 'record'];
TaxGroupComponent.template = 'account.TaxGroupComponent';

/**
    Widget used to display tax totals by tax groups for invoices, PO and SO,
    and possibly allowing editing them.

    Note that this widget requires the object it is used on to have a
    currencyId field.
**/
class TaxTotalsComponent extends AbstractFieldOwl {
    constructor(...args) {
        super(...args);
        this.totals = useState({value: this.value ? JSON.parse(this.value) : null});
        this.allowTaxEdition = this.nodeOptions['allowTaxEdition'];
    }

    willUpdateProps(nextProps) {
        // We only reformat tax groups if there are changed
        this.totals.value = JSON.parse(nextProps.record.data[this.props.fieldName]);
    }

    _onKeydown(ev) {
        switch (ev.which) {
            // Trigger only if the user clicks on ENTER or on TAB.
            case $.ui.keyCode.ENTER:
            case $.ui.keyCode.TAB:
                // trigger blur to prevent the code being executed twice
                $(ev.target).blur();
        }
    }

    /**
     * This method is the main function of the tax group widget.
     * It is called by an event trigger (from the TaxGroupComponent) and receives
     * a particular payload.
     *
     * It is responsible for calculating taxes based on tax groups and triggering
     * an event to notify the ORM of a change.
     */
    _onchangeTaxValueByTaxGroup(ev) {
        this.trigger('fieldChanged', {
            dataPointID: this.record.id,
            changes: { taxTotalsJson: JSON.stringify(this.totals.value) }
        })
    }
}

TaxTotalsComponent.template = 'account.TaxTotalsField';
TaxTotalsComponent.components = { TaxGroupComponent };


fieldRegistry.add('accountTaxTotalsField', TaxTotalsComponent);

export default TaxTotalsComponent
