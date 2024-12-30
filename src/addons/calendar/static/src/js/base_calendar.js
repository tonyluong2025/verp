/** @verp-module **/

import BasicModel from 'web.BasicModel';
import fieldRegistry from 'web.fieldRegistry';
import relationalFields from 'web.relationalFields';

const FieldMany2ManyTagsAvatar = relationalFields.FieldMany2ManyTagsAvatar;

BasicModel.include({
    /**
     * @private
     * @param {Object} record
     * @param {string} fieldName
     * @returns {Promise}
     */
    _fetchSpecialAttendeeStatus: function (record, fieldName) {
        var context = record.getContext({fieldName: fieldName});
        var attendeeIDs = record.data[fieldName] ? this.localData[record.data[fieldName]].resIds : [];
        var meetingID = _.isNumber(record.resId) ? record.resId : false;
        return this._rpc({
            model: 'res.partner',
            method: 'getAttendeeDetail',
            args: [attendeeIDs, [meetingID]],
            context: context,
        }).then(function (result) {
            return result;
        });
    },
});

const Many2ManyAttendee = FieldMany2ManyTagsAvatar.extend({
    // as this widget is model dependant (rpc on res.partner), use it in another
    // context probably won't work
    // supportedFieldTypes: ['many2many'],
    specialData: "_fetchSpecialAttendeeStatus",
    className: 'o-field-many2manytags avatar',

    init: function () {
        this._super.apply(this, arguments);
        this.className += this.nodeOptions.block ? ' d-block' : '';
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @override
     * @private
     */
    _renderTags: function () {
        this._super.apply(this, arguments);
        const avatars = this.el.querySelectorAll('.o-m2m-avatar');
        for (const avatar of avatars) {
            const partnerId = parseInt(avatar.dataset["id"]);
            const partnerData = this.record.specialData.partnerIds.find(partner => partner.id === partnerId);
            if (partnerData) {
                avatar.classList.add('o-attendee-border', "o-attendee-border-" + partnerData.status);
            }
        }
    },
    /**
     * @override
     * @private
     */
    _getRenderTagsContext: function () {
        let result = this._super.apply(this, arguments);
        result.attendeesData = this.record.specialData.partnerIds;
        // Sort attendees to have the organizer on top.
        // partnerIds are sorted by default according to their id/displayName in the "elements" FieldMany2ManyTag
        // This method sort them to put the organizer on top
        const organizer = result.attendeesData.find(item => item.isOrganizer);
        if (organizer) {
            const orgId = organizer.id
            // sort elements according to the partner id
            result.elements.sort((a, b) => {
                const aOrg = a.id === orgId;
                return aOrg ? -1 : 1;
             });
        }
        return result;
    },
});

fieldRegistry.add('many2manyattendee', Many2ManyAttendee);
