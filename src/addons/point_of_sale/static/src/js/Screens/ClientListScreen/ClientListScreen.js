verp.define('point_of_sale.ClientListScreen', function(require) {
    'use strict';

    const { debounce } = owl.utils;
    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');
    const { useListener } = require('web.customHooks');
    const { isConnectionError } = require('point_of_sale.utils');
    const { useAsyncLockedMethod } = require('point_of_sale.customHooks');

    /**
     * Render this screen using `showTempScreen` to select client.
     * When the shown screen is confirmed ('Set Customer' or 'Deselect Customer'
     * button is clicked), the call to `showTempScreen` resolves to the
     * selected client. E.g.
     *
     * ```js
     * const { confirmed, payload: selectedClient } = await showTempScreen('ClientListScreen');
     * if (confirmed) {
     *   // do something with the selectedClient
     * }
     * ```
     *
     * @props client - originally selected client
     */
    class ClientListScreen extends PosComponent {
        constructor() {
            super(...arguments);
            this.lockedSaveChanges = useAsyncLockedMethod(this.saveChanges);
            useListener('click-save', () => this.env.bus.trigger('save-customer'));
            useListener('click-edit', () => this.editClient());
            useListener('save-changes', this.lockedSaveChanges);

            // We are not using useState here because the object
            // passed to useState converts the object and its contents
            // to Observer proxy. Not sure of the side-effects of making
            // a persistent object, such as pos, into owl.Observer. But it
            // is better to be safe.
            this.state = {
                query: null,
                selectedClient: this.props.client,
                detailIsShown: false,
                isEditMode: false,
                editModeProps: {
                    partner: {
                        countryId: this.env.pos.company.countryId,
                        stateId: this.env.pos.company.stateId,
                    }
                },
            };
            this.updateClientList = debounce(this.updateClientList, 70);
        }
        // Lifecycle hooks
        back() {
            if(this.state.detailIsShown) {
                this.state.detailIsShown = false;
                this.render();
            } else {
                this.props.resolve({ confirmed: false, payload: false });
                this.trigger('close-temp-screen');
            }
        }
        confirm() {
            this.props.resolve({ confirmed: true, payload: this.state.selectedClient });
            this.trigger('close-temp-screen');
        }
        // Getters

        get currentOrder() {
            return this.env.pos.getOrder();
        }

        get clients() {
            let res;
            if (this.state.query && this.state.query.trim() !== '') {
                res = this.env.pos.db.searchPartner(this.state.query.trim());
            } else {
                res = this.env.pos.db.getPartnersSorted(1000);
            }
            return res.sort(function (a, b) { return (a.label || '').localeCompare(b.label || '') });
        }
        get isNextButtonVisible() {
            return this.state.selectedClient ? true : false;
        }
        /**
         * Returns the text and command of the next button.
         * The command field is used by the clickNext call.
         */
        get nextButton() {
            if (!this.props.client) {
                return { command: 'set', text: this.env._t('Set Customer') };
            } else if (this.props.client && this.props.client === this.state.selectedClient) {
                return { command: 'deselect', text: this.env._t('Deselect Customer') };
            } else {
                return { command: 'set', text: this.env._t('Change Customer') };
            }
        }

        // Methods

        // We declare this event handler as a debounce function in
        // order to lower its trigger rate.
        async updateClientList(event) {
            this.state.query = event.target.value;
            const clients = this.clients;
            if (event.code === 'Enter' && clients.length === 1) {
                this.state.selectedClient = clients[0];
                this.clickNext();
            } else {
                this.render();
            }
        }
        clickClient(event) {
            let partner = event.detail.client;
            if (this.state.selectedClient === partner) {
                this.state.selectedClient = null;
            } else {
                this.state.selectedClient = partner;
            }
            this.render();
        }
        editClient() {
            this.state.editModeProps = {
                partner: this.state.selectedClient,
            };
            this.state.detailIsShown = true;
            this.render();
        }
        clickNext() {
            this.state.selectedClient = this.nextButton.command === 'set' ? this.state.selectedClient : null;
            this.confirm();
        }
        activateEditMode(event) {
            const { isNewClient } = event.detail;
            this.state.isEditMode = true;
            this.state.detailIsShown = true;
            this.state.isNewClient = isNewClient;
            if (!isNewClient) {
                this.state.editModeProps = {
                    partner: this.state.selectedClient,
                };
            }
            this.render();
        }
        deactivateEditMode() {
            this.state.isEditMode = false;
            this.state.editModeProps = {
                partner: {
                    countryId: this.env.pos.company.countryId,
                    stateId: this.env.pos.company.stateId,
                },
            };
            this.render();
        }
        async saveChanges(event) {
            try {
                let partnerId = await this.rpc({
                    model: 'res.partner',
                    method: 'createFromUi',
                    args: [event.detail.processedChanges],
                });
                await this.env.pos.loadNewPartners();
                this.state.selectedClient = this.env.pos.db.getPartnerById(partnerId);
                this.state.detailIsShown = false;
                this.render();
            } catch (error) {
                if (isConnectionError(error)) {
                    await this.showPopup('OfflineErrorPopup', {
                        title: this.env._t('Offline'),
                        body: this.env._t('Unable to save changes.'),
                    });
                } else {
                    throw error;
                }
            }
        }
        cancelEdit() {
            this.deactivateEditMode();
        }
        async searchClient() {
            let result = await this.getNewClient();
            this.env.pos.db.addPartners(result);
            if(!result.length) {
                await this.showPopup('ErrorPopup', {
                    title: '',
                    body: this.env._t('No customer found'),
                });
            }
            this.render();
        }
        async getNewClient() {
            var domain = [];
            if(this.state.query) {
                domain = [
                    '|',
                    ["displayName", "ilike", this.state.query],
                    ["email", "ilike", this.state.query],
                    ];
            }
            var fields = _.find(this.env.pos.models, function(model){ return model.label === 'loadPartners'; }).fields;
            var result = await this.rpc({
                model: 'res.partner',
                method: 'searchRead',
                args: [domain, fields],
                kwargs: {
                    limit: 10,
                },
            },{
                timeout: 3000,
                shadow: true,
            });

            return result;
        }
    }
    ClientListScreen.template = 'ClientListScreen';

    Registries.Component.add(ClientListScreen);

    return ClientListScreen;
});
