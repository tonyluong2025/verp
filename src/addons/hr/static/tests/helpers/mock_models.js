/** @verp-module **/

import { MockModels } from '@mail/../tests/helpers/mock_models';
import { patch } from 'web.utils';

patch(MockModels, 'hr/static/tests/helpers/mock_models.js', {

    //----------------------------------------------------------------------
    // Public
    //----------------------------------------------------------------------

    /**
     * @override
     */
    generateData() {
        const data = this._super(...arguments);
        Object.assign(data, {
            'hr.employee.public': {
                fields: {
                    displayName: { string: "Name", type: "char" },
                    userId: { string: "User", type: "many2one", relation: 'res.users' },
                    userPartnerId: { string: "Partner", type: "many2one", relation: 'res.partner' },
                },
                records: [],
            },
        });
        return data;
    },

});
