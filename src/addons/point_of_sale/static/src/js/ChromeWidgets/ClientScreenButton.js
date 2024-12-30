verp.define('point_of_sale.ClientScreenButton', function(require) {
    'use strict';

    const { useState } = owl;
    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    // Formerly ClientScreenWidget
    class ClientScreenButton extends PosComponent {
        constructor() {
            super(...arguments);
            this.local = this.env.pos.config.ifaceCustomerFacingDisplayLocal && !this.env.pos.config.ifaceCustomerFacingDisplayViaProxy;
            this.state = useState({ status: this.local ? 'success' : 'failure' });
            this._start();
        }
        get message() {
            return {
                success: '',
                warning: this.env._t('Connected, Not Owned'),
                failure: this.env._t('Disconnected'),
                notFound: this.env._t('Client Screen Unsupported. Please upgrade the IoT Box'),
            }[this.state.status];
        }
        onClick() {
            if (this.local) {
                return this.onClickLocal();
            } else {
                return this.onClickProxy();
            }
        }
        async onClickLocal() {
            this.env.pos.customerDisplay = window.open('', 'Customer Display', 'height=600,width=900');
            const renderedHtml = await this.env.pos.renderHtmlForCustomerFacingDisplay();
            var $renderedHtml = $('<div>').html(renderedHtml);
            $(this.env.pos.customerDisplay.document.body).html($renderedHtml.find('.pos-customer-facing-display'));
            $(this.env.pos.customerDisplay.document.head).html($renderedHtml.find('.resources').html());
        }
        async onClickProxy() {
            try {
                const renderedHtml = await this.env.pos.renderHtmlForCustomerFacingDisplay();
                let ownership = await this.env.pos.proxy.takeOwnershipOverClientScreen(
                    renderedHtml
                );
                if (typeof ownership === 'string') {
                    ownership = JSON.parse(ownership);
                }
                if (ownership.status === 'success') {
                    this.state.status = 'success';
                } else {
                    this.state.status = 'warning';
                }
                if (!this.env.pos.proxy.posboxSupportsDisplay) {
                    this.env.pos.proxy.posboxSupportsDisplay = true;
                    this._start();
                }
            } catch (error) {
                if (typeof error == 'undefined') {
                    this.state.status = 'failure';
                } else {
                    this.state.status = 'notFound';
                }
            }
        }
        _start() {
            if (this.local) {
                return;
            }

            const self = this;
            async function loop() {
                if (self.env.pos.proxy.posboxSupportsDisplay) {
                    try {
                        let ownership = await self.env.pos.proxy.testOwnershipOfClientScreen();
                        if (typeof ownership === 'string') {
                            ownership = JSON.parse(ownership);
                        }
                        if (ownership.status === 'OWNER') {
                            self.state.status = 'success';
                        } else {
                            self.state.status = 'warning';
                        }
                        setTimeout(loop, 3000);
                    } catch (error) {
                        if (error.abort) {
                            // Stop the loop
                            return;
                        }
                        if (typeof error == 'undefined') {
                            self.state.status = 'failure';
                        } else {
                            self.state.status = 'notFound';
                            self.env.pos.proxy.posboxSupportsDisplay = false;
                        }
                        setTimeout(loop, 3000);
                    }
                }
            }
            loop();
        }
    }
    ClientScreenButton.template = 'ClientScreenButton';

    Registries.Component.add(ClientScreenButton);

    return ClientScreenButton;
});
