verp.define('point_of_sale.CashierName', function(require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const Registries = require('point_of_sale.Registries');

    // Previously UsernameWidget
    class CashierName extends PosComponent {
        get username() {
            const { name } = this.env.pos.getCashier();
            return name ? name : '';
        }
        get avatar() {
            const { userId } = this.env.pos.getCashier();
            const id = userId && userId.length ? userId[0] : -1;
            return `/web/image/res.users/${id}/avatar_128`;
        }
    }
    CashierName.template = 'CashierName';

    Registries.Component.add(CashierName);

    return CashierName;
});
