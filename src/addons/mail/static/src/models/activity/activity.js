/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { attr, many2many, many2one } from '@mail/model/model_field';
import { clear, insert, unlink, unlinkAll } from '@mail/model/model_field_command';

function factory(dependencies) {

    class Activity extends dependencies['mail.model'] {


        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * Delete the record from database and locally.
         */
        async deleteServerRecord() {
            await this.async(() => this.env.services.rpc({
                model: 'mail.activity',
                method: 'unlink',
                args: [[this.id]],
            }));
            this.delete();
        }

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * @static
         * @param {Object} data
         * @return {Object}
         */
        static convertData(data) {
            const data2 = {};
            if ('activityCategory' in data) {
                data2.category = data.activityCategory;
            }
            if ('canWrite' in data) {
                data2.canWrite = data.canWrite;
            }
            if ('createdAt' in data) {
                data2.dateCreate = data.createdAt;
            }
            if ('dateDeadline' in data) {
                data2.dateDeadline = data.dateDeadline;
            }
            if ('chainingType' in data) {
                data2.chainingType = data.chainingType;
            }
            if ('icon' in data) {
                data2.icon = data.icon;
            }
            if ('id' in data) {
                data2.id = data.id;
            }
            if ('note' in data) {
                data2.note = data.note;
            }
            if ('state' in data) {
                data2.state = data.state;
            }
            if ('summary' in data) {
                data2.summary = data.summary;
            }

            // relation
            if ('activityTypeId' in data) {
                if (!data.activityTypeId) {
                    data2.type = unlinkAll();
                } else {
                    data2.type = insert({
                        displayName: data.activityTypeId[1],
                        id: data.activityTypeId[0],
                    });
                }
            }
            if ('createdUid' in data) {
                if (!data.createdUid) {
                    data2.creator = unlinkAll();
                } else {
                    data2.creator = insert({
                        id: data.createdUid[0],
                        displayName: data.createdUid[1],
                    });
                }
            }
            if ('mailTemplateIds' in data) {
                data2.mailTemplates = insert(data.mailTemplateIds);
            }
            if ('resId' in data && 'resModel' in data) {
                data2.thread = insert({
                    id: data.resId,
                    model: data.resModel,
                });
            }
            if ('userId' in data) {
                if (!data.userId) {
                    data2.assignee = unlinkAll();
                } else {
                    data2.assignee = insert({
                        id: data.userId[0],
                        displayName: data.userId[1],
                    });
                }
            }
            if ('requestPartnerId' in data) {
                if (!data.requestPartnerId) {
                    data2.requestingPartner = unlink();
                } else {
                    data2.requestingPartner = insert({
                        id: data.requestPartnerId[0],
                        displayName: data.requestPartnerId[1],
                    });
                }
            }

            return data2;
        }

        /**
         * Opens (legacy) form view dialog to edit current activity and updates
         * the activity when dialog is closed.
         *
         * @return {Promise} promise that is fulfilled when the form has been closed
         */
        edit() {
            const action = {
                type: 'ir.actions.actwindow',
                label: this.env._t("Schedule Activity"),
                resModel: 'mail.activity',
                viewMode: 'form',
                views: [[false, 'form']],
                target: 'new',
                context: {
                    default_resId: this.thread.id,
                    default_resModel: this.thread.model,
                },
                resId: this.id,
            };
            return new Promise(resolve => {
                this.env.bus.trigger('do-action', {
                    action,
                    options: {
                        onClose: () => {
                            resolve();
                            this.fetchAndUpdate();
                        },
                    },
                });
            });
        }

        async fetchAndUpdate() {
            const [data] = await this.env.services.rpc({
                model: 'mail.activity',
                method: 'activityFormat',
                args: [this.id],
            }, { shadow: true }).catch(e => {
                const errorName = e.message && e.message.data && e.message.data.name;
                if (errorName === 'verp.exceptions.MissingError') {
                    return [];
                } else {
                    throw e;
                }
            });
            let shouldDelete = false;
            if (data) {
                this.update(this.constructor.convertData(data));
            } else {
                shouldDelete = true;
            }
            this.thread.refreshActivities();
            this.thread.refresh();
            if (shouldDelete) {
                this.delete();
            }
        }

        /**
         * @param {Object} param0
         * @param {mail.attachment[]} [param0.attachments=[]]
         * @param {string|boolean} [param0.feedback=false]
         */
        async markAsDone({ attachments = [], feedback = false }) {
            const attachmentIds = attachments.map(attachment => attachment.id);
            await this.async(() => this.env.services.rpc({
                model: 'mail.activity',
                method: 'actionFeedback',
                args: [[this.id]],
                kwargs: {
                    attachmentIds: attachmentIds,
                    feedback,
                },
            }));
            this.thread.refresh();
            this.delete();
        }

        /**
         * @param {Object} param0
         * @param {string} param0.feedback
         * @returns {Object}
         */
        async markAsDoneAndScheduleNext({ feedback }) {
            const action = await this.async(() => this.env.services.rpc({
                model: 'mail.activity',
                method: 'actionFeedbackScheduleNext',
                args: [[this.id]],
                kwargs: { feedback },
            }));
            this.thread.refresh();
            const thread = this.thread;
            this.delete();
            if (!action) {
                thread.refreshActivities();
                return;
            }
            this.env.bus.trigger('do-action', {
                action,
                options: {
                    onClose: () => {
                        thread.refreshActivities();
                    },
                },
            });
        }

        //----------------------------------------------------------------------
        // Private
        //----------------------------------------------------------------------

        /**
         * @private
         * @returns {boolean}
         */
        _computeIsCurrentPartnerAssignee() {
            if (!this.assignee || !this.assignee.partner || !this.messaging.currentPartner) {
                return false;
            }
            return this.assignee.partner === this.messaging.currentPartner;
        }

        /**
         * Wysiwyg editor put `<p><br></p>` even without a note on the activity.
         * This compute replaces this almost empty value by an actual empty
         * value, to reduce the size the empty note takes on the UI.
         *
         * @private
         * @returns {string|undefined}
         */
        _computeNote() {
            if (this.note === '<p><br></p>') {
                return clear();
            }
            return this.note;
        }
    }

    Activity.fields = {
        assignee: many2one('mail.user'),
        attachments: many2many('mail.attachment', {
            inverse: 'activities',
        }),
        canWrite: attr({
            default: false,
        }),
        category: attr(),
        creator: many2one('mail.user'),
        dateCreate: attr(),
        dateDeadline: attr(),
        /**
         * Backup of the feedback content of an activity to be marked as done in the popover.
         * Feature-specific to restoring the feedback content when component is re-mounted.
         * In all other cases, this field value should not be trusted.
         */
        feedbackBackup: attr(),
        chainingType: attr({
            default: 'suggest',
        }),
        icon: attr(),
        id: attr({
            readonly: true,
            required: true,
        }),
        isCurrentPartnerAssignee: attr({
            compute: '_computeIsCurrentPartnerAssignee',
            default: false,
        }),
        mailTemplates: many2many('mail.mailTemplate', {
            inverse: 'activities',
        }),
        /**
         * This value is meant to be returned by the server
         * (and has been sanitized before stored into db).
         * Do not use this value in a 't-raw' if the activity has been created
         * directly from user input and not from server data as it's not escaped.
         */
        note: attr({
            compute: '_computeNote',
        }),
        /**
         * Determines that an activity is linked to a requesting partner or not.
         * It will be used notably in website slides to know who triggered the
         * "request access" activity.
         * Also, be useful when the assigned user is different from the
         * "source" or "requesting" partner.
         */
        requestingPartner: many2one('mail.partner'),
        state: attr(),
        summary: attr(),
        /**
         * Determines to which "thread" (using `mail.activity.mixin` on the
         * server) `this` belongs to.
         */
        thread: many2one('mail.thread', {
            inverse: 'activities',
        }),
        type: many2one('mail.activityType', {
            inverse: 'activities',
        }),
    };
    Activity.identifyingFields = ['id'];
    Activity.modelName = 'mail.activity';

    return Activity;
}

registerNewModel('mail.activity', factory);
