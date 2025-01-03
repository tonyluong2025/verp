verp.define('point_of_sale.CashOpeningPopup', function(require) {
    'use strict';

    const { useState, useRef } = owl.hooks;
    const { useValidateCashInput } = require('point_of_sale.customHooks');
    const AbstractAwaitablePopup = require('point_of_sale.AbstractAwaitablePopup');
    const Registries = require('point_of_sale.Registries');
    const { parse } = require('web.fieldUtils');


    class CashOpeningPopup extends AbstractAwaitablePopup {
        constructor() {
            super(...arguments);
            this.manualInputCashCount = null;
            this.state = useState({
                notes: "",
                openingCash: this.env.pos.bankStatement.balanceStart || 0,
            });
            this.moneyDetailsRef = useRef('moneyDetails');
            useValidateCashInput("openingCashInput", this.env.pos.bankStatement.balanceStart);
        }
        openDetailsPopup() {
            if (this.moneyDetailsRef.comp.isClosed()){
                this.moneyDetailsRef.comp.openPopup();
                this.state.openingCash = 0;
                this.state.notes = "";
                if (this.manualInputCashCount) {
                    this.moneyDetailsRef.comp.reset();
                }
            }
        }
        startSession() {
            this.env.pos.bankStatement.balanceStart = this.state.openingCash;
            this.env.pos.posSession.state = 'opened';
            this.rpc({
                   model: 'pos.session',
                    method: 'setCashboxPos',
                    args: [this.env.pos.posSession.id, this.state.openingCash, this.state.notes],
                });
            this.cancel(); // close popup
        }
        updateCashOpening(event) {
            const { total, moneyDetailsNotes } = event.detail;
            this.state.openingCash = total;
            if (moneyDetailsNotes) {
                this.state.notes = moneyDetailsNotes;
            }
            this.manualInputCashCount = false;
        }
        handleInputChange(event) {
            if (event.target.classList.contains('invalid-cash-input')) return;
            this.manualInputCashCount = true;
            this.state.openingCash = parse.float(event.target.value);
        }
    }

    CashOpeningPopup.template = 'CashOpeningPopup';
    Registries.Component.add(CashOpeningPopup);

    return CashOpeningPopup;
});
