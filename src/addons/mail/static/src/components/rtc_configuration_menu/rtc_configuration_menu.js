/** @verp-module **/

import { registerMessagingComponent } from '@mail/utils/messaging_component';

import { browser } from "@web/core/browser/browser";

const { Component } = owl;
const { useState } = owl.hooks;

export class RtcConfigurationMenu extends Component {

    /**
     * @override
     */
    setup() {
        super.setup();
        this.state = useState({
            userDevices: undefined,
        });
    }

    async willStart() {
        this.state.userDevices = await browser.navigator.mediaDevices.enumerateDevices();
    }

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {Event} ev
     */
    _onchangeDelay(ev) {
        this.messaging.userSetting.rtcConfigurationMenu.onchangeDelay(ev.target.value);
    }

    /**
     * @private
     * @param {Event} ev
     */
    _onchangePushToTalk(ev) {
        this.messaging.userSetting.rtcConfigurationMenu.onchangePushToTalk();
    }

    /**
     * @private
     * @param {Event} ev
     */
    _onchangeSelectAudioInput(ev) {
        this.messaging.userSetting.rtcConfigurationMenu.onchangeSelectAudioInput(ev.target.value);
    }

    /**
     * @private
     * @param {Event} ev
     */
    _onchangeThreshold(ev) {
        this.messaging.userSetting.rtcConfigurationMenu.onchangeThreshold(ev.target.value);
    }

    /**
     * @private
     * @param {MouseEvent} ev
     */
    _onClickRegisterKeyButton() {
        this.messaging.userSetting.rtcConfigurationMenu.onClickRegisterKeyButton();
    }
}

Object.assign(RtcConfigurationMenu, {
    template: 'mail.RtcConfigurationMenu',
});

registerMessagingComponent(RtcConfigurationMenu);
