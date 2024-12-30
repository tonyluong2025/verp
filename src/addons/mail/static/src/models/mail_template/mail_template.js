/** @verp-module **/

import { registerNewModel } from '@mail/model/model_core';
import { attr, many2many } from '@mail/model/model_field';

function factory(dependencies) {

    class MailTemplate extends dependencies['mail.model'] {

        //----------------------------------------------------------------------
        // Public
        //----------------------------------------------------------------------

        /**
         * @param {mail.activity} activity
         */
        preview(activity) {
            const action = {
                label:this.env._t("Compose Email"),
                type: 'ir.actions.actwindow',
                resModel: 'mail.compose.message',
                views: [[false, 'form']],
                target: 'new',
                context: {
                    default_resId: activity.thread.id,
                    default_model: activity.thread.model,
                    default_useTemplate: true,
                    default_templateId: this.id,
                    forceEmail: true,
                },
            };
            this.env.bus.trigger('do-action', {
                action,
                options: {
                    onClose: () => {
                        activity.thread.refresh();
                    },
                },
            });
        }

        /**
         * @param {mail.activity} activity
         */
        async send(activity) {
            await this.async(() => this.env.services.rpc({
                model: activity.thread.model,
                method: 'activitySendMail',
                args: [[activity.thread.id], this.id],
            }));
            activity.thread.refresh();
        }

    }

    MailTemplate.fields = {
        activities: many2many('mail.activity', {
            inverse: 'mailTemplates',
        }),
        id: attr({
            readonly: true,
            required: true,
        }),
        label: attr(),
    };
    MailTemplate.identifyingFields = ['id'];
    MailTemplate.modelName = 'mail.mailTemplate';

    return MailTemplate;
}

registerNewModel('mail.mailTemplate', factory);
