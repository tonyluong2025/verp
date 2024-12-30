/** @verp-module **/

import { Notification } from "./notification";

const { Component, tags } = owl;

export class NotificationContainer extends Component {
    setup() {
        // this works, but then this component cannot be unmounted, then
        // remounted. would need a destroyed hook different from willunmount
        this.props.bus.on("UPDATE", this, this.render);
    }
}

NotificationContainer.template = tags.xml`
    <div class="o-notification-manager">
        <t t-foreach="props.notifications" t-as="notification" t-key="notification.id">
            <Notification
                t-props="notification.props"
                t-transition="o-notification-fade"
                t-on-close="notification.close()"
            />
        </t>
    </div>`;
NotificationContainer.components = { Notification };
