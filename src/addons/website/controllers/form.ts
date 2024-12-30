import fs from "fs";
import fsPro from "fs/promises";
import { split } from "lodash";
import { http } from "../../../core";
import { nl2br } from "../../../core/addons/base";
import { hasattr } from "../../../core/api";
import { UserError, ValidationError, ValueError } from "../../../core/helper";
import { WebRequest } from "../../../core/http";
import { BadRequest } from "../../../core/service";
import { _lt, b64encode, bool, encodebytes, f, isInstance, parseFloat, parseInt, plaintext2html, pop, update } from "../../../core/tools";
import { stringify } from "../../../core/tools/json";

@http.define()
export class WebsiteForm extends http.Controller {
    static _module = module;

    @http.route('/website/form', {type: 'http', auth: "public", methods: ['POST'], multilang: false})
    async websiteFormEmpty(req, res, opts: {}={}) {
        // This is a workaround to don't add language prefix to <form action="/website/form/" ...>
        return "";
    }

    // Check and insert values from the form on the model <model>
    @http.route('/website/form/<string:modelName>', {type: 'http', auth: "public", methods: ['POST'], website: true, csrf: false})
    async websiteForm(req, res, opts: {modelName?: string}={}) {
        // Partial CSRF check, only performed when session is authenticated, as there
        // is no real risk for unauthenticated sessions here. It's a common case for
        // embedded forms now: SameSite policy rejects the cookies, so the session
        // is lost, and the CSRF check fails, breaking the post for no good reason.
        const csrfToken = req.params.pop('csrfToken', null);
        if (req.session.uid && ! req.validateCsrf(csrfToken)) {
            throw new BadRequest('Session expired (invalid CSRF token)');
        }
        let error;
        try {
            // The except clause below should not let what has been done inside
            // here be committed. It should not either roll back everything in
            // this controller method. Instead, we use a savepoint to roll back
            // what has been done inside the try clause.
            
            // with request.env.cr.savepoint():
            {
                if (await (await req.getEnv()).items('ir.http')._verifyRequestRecaptchaToken('websiteForm')) {
                    return this._handleWebsiteForm(pop(opts, 'modelName'), opts);
                }
            }
            error = await this._t(await req.getEnv(), "Suspicious activity detected by Google reCaptcha.");
        } catch(e) {
            if (isInstance(e, ValidationError, UserError)) {
                error = e.message;
            }
        }
        return stringify({
            'error': error,
        });
    }

    async _handleWebsiteForm(req, modelName, opts: {}={}) {
        const modelRecord = await (await (await req.getEnv()).items('ir.model').sudo()).search([['model', '=', modelName], ['websiteFormAccess', '=', true]]);
        if (! modelRecord.ok) {
            return stringify({
                'error': await this._t(await req.getEnv(), "The form's specified model does not exist")
            });
        }

        let data, idRecord;
        try {
            data = await this.extractData(req, modelRecord, req.params);
        } catch(e) {
            // If we encounter an issue while extracting data
            if (isInstance(e, ValidationError)) {
                // I couldn't find a cleaner way to pass data to an exception
                return stringify({'errorFields' : e.message});
            } else {
                throw e;
            }
        }
        try {
            idRecord = await this.insertRecord(req, modelRecord, data['record'], data['custom'], data['meta']);
            if (bool(idRecord)) {
                await this.insertAttachment(req, modelRecord, idRecord, data['attachments']);
                // in case of an email, we want to send it immediately instead of waiting
                // for the email queue to process
                if (modelName === 'mail.mail') {
                    await (await (await req.getEnv()).items(modelName).sudo()).browse(idRecord).send();
                }
            }
        } catch(e) {
            // Some fields have additional SQL constraints that we can't check generically
            // Ex: crm.lead.probability which is a float between 0 and 1
            // TODO: How to get the name of the erroneous field ?
            if (isInstance(e, IntegrityError)) {
                return stringify(false);
            } else {
                throw e;
            }
        }

        req.session['formBuilderModelModel'] = await modelRecord.model;
        req.session['formBuilderModel'] = await modelRecord.label;
        req.session['formBuilderId'] = idRecord;

        return stringify({'id': idRecord});
    }

    // Constants string to make metadata readable on a text field

    async _metaLabel() {
        return _lt("Metadata");  // Title for meta data
    }

    // Dict of dynamically called filters following type of field to be fault tolerent

    identity(fieldLabel, fieldInput) {
        return fieldInput;
    }

    integer(fieldLabel, fieldInput) {
        return parseInt(fieldInput);
    }

    floating(fieldLabel, fieldInput) {
        return parseFloat(fieldInput);
    }

    html(fieldLabel, fieldInput) {
        return plaintext2html(fieldInput);
    }

    boolean(fieldLabel, fieldInput) {
        return bool(fieldInput);
    }

    binary(fieldLabel, fieldInput) {
        return b64encode(fs.readFileSync(fieldInput));
    }

    one2many(fieldLabel, fieldInput) {
        return fieldInput.split(',').map(i => parseInt(i));
    }

    many2many(fieldLabel, fieldInput, ...args) {
        return [(bool(args) ? args[0] : [6,0]).concat([this.one2many(fieldLabel, fieldInput),])];
    }

    _inputFilters = {
        'char': this.identity,
        'text': this.identity,
        'html': this.html,
        'date': this.identity,
        'datetime': this.identity,
        'many2one': this.integer,
        'one2many': this.one2many,
        'many2many':this.many2many,
        'selection': this.identity,
        'boolean': this.boolean,
        'integer': this.integer,
        'float': this.floating,
        'binary': this.binary,
        'monetary': this.floating,
    }


    // Extract all data sent by the form and sort its on several properties
    async extractData(req: WebRequest, model, values) {
        const destModel = (await req.getEnv()).items(await (await model.sudo()).model);

        const data = {
            'record': {},        // Values to create record
            'attachments': [],  // Attached files
            'custom': '',        // Custom fields values
            'meta': '',         // Add metadata if enabled
        }

        const authorizedFields = await (await model.withUser(global.SUPERUSER_ID))._getFormWritableFields();
        const errorFields = [];
        const customFields = [];

        for (let [fieldName, fieldValue] of Object.entries<any>(values)) {
            // If the value of the field if a file
            if (hasattr(fieldValue, 'filename')) {
                // Undo file upload field name indexing
                fieldName = split(fieldName, '[', 1)[0];

                // If it's an actual binary field, convert the input file
                // If it's not, we'll use attachments instead
                if (fieldName in authorizedFields && authorizedFields[fieldName]['type'] === 'binary') {
                    data['record'][fieldName] = b64encode(await fsPro.readFile(fieldValue));
                    // fieldValue.stream.seek(0) // do not consume value forever
                    if (authorizedFields[fieldName]['manual'] && fieldName + "_filename" in destModel) {
                        data['record'][fieldName + "_filename"] = await fieldValue.filename;
                    }
                }
                else {
                    await fieldValue.set('fieldName', fieldName);
                    data['attachments'].push(fieldValue);
                }
            }
            // If it's a known field
            else if (fieldName in authorizedFields) {
                try {
                    const inputFilter = this._inputFilters[authorizedFields[fieldName]['type']];
                    data['record'][fieldName] = inputFilter.call(this, fieldName, fieldValue);
                } catch(e) {
                    if (isInstance(e, ValueError)) {
                        errorFields.push(fieldName);
                    } else {
                        throw e;
                    }
                }
                if (destModel._name === 'mail.mail' && fieldName === 'emailFrom') {
                    // As the "email_from" is used to populate the email_from of the
                    // sent mail.mail, it could be filtered out at sending time if no
                    // outgoing mail server "from_filter" match the sender email.
                    // To make sure the email contains that (important) information
                    // we also add it to the "custom message" that will be included
                    // in the body of the email sent.
                    customFields.push([await this._t(await req.getEnv(), 'email'), fieldValue]);
                }
            }
            // If it's a custom field
            else if (fieldName !== 'context') {
                customFields.push([fieldName, fieldValue]);
            }
        }

        data['custom'] = customFields.map(v => f("%s : %s", v)).join('\n');

        // Add metadata if enabled  // ICP for retrocompatibility
        if (await (await (await req.getEnv()).items('ir.config.parameter').sudo()).getParam('websiteFormEnableMetadata')) {
            data['meta'] += f("%s : %s\n%s : %s\n%s : %s\n%s : %s\n",
                "IP"                , req.httpRequest.socket.remoteAddress,
                "USER_AGENT"        , req.httpRequest.headers['user-agent'],
                "ACCEPT_LANGUAGE"   , req.httpRequest.headers["accept-language"] ,
                "REFERER"           , req.httpRequest.headers.referer
            );
        }

        // This function can be defined on any model to provide
        // a model-specific filtering of the record values
        // Example:
        // async websiteFormInputFilter(values) {
        //     values['label'] = f(`%s's Application`, values['partnerName']);
        //     return values;
        // }
        if (hasattr(destModel, "websiteFormInputFilter")) {
            data['record'] = await destModel.websiteFormInputFilter(req, data['record']);
        }
        const missingRequiredFields = Object.entries(authorizedFields).filter(([label, field]) => field['required'] && ! (label in data['record'])).map(([label]) => label);
        if (errorFields.some(e => bool(e))) {
            throw new ValidationError(errorFields.concat(missingRequiredFields));
        }

        return data;
    }

    async insertRecord(req, model, values, custom, meta?: any) {
        let modelName = await (await model.sudo()).model;
        if (modelName === 'mail.mail') {
            update(values, {'replyTo': values['emailFrom']});
        }
        const record = await (await (await (await req.getEnv()).items(modelName).withUser(global.SUPERUSER_ID)).withContext({
            mailCreateNosubscribe: true,
            commitAssetsbundle: false,
        })).create(values);

        if (bool(custom) || bool(meta)) {
            let _customLabel = f("%s\n___________\n\n", await this._t(await req.getEnv(), "Other Information:"));//  // Title for custom fields
            if (modelName === 'mail.mail') {
                _customLabel = f("%s\n___________\n\n", await this._t(await req.getEnv(), "This message has been posted on your website!"));
            }
            const defaultField = await model.websiteFormDefaultFieldId;
            const defaultFieldData = values[await defaultField.label] || '';
            let customContent = (defaultFieldData ? defaultFieldData + "\n\n" : '')
                           + (custom ? _customLabel + custom + "\n\n" : '')
                           + (meta ? this._metaLabel + "\n________\n\n" + meta : '')

            // If there is a default field configured for this model, use it.
            // If there isn't, put the custom data in a message instead
            if (await defaultField.label) {
                if (await defaultField.ttype === 'html' || modelName === 'mail.mail') {
                    customContent = nl2br(customContent);
                }
                await record.update({[await defaultField.label]: customContent});
            }
            else {
                values = {
                    'body': nl2br(customContent),
                    'model': modelName,
                    'messageType': 'comment',
                    'resId': record.id,
                }
                const mailId = await (await (await req.getEnv()).items('mail.message').withUser(global.SUPERUSER_ID)).create(values);
            }
        }
        return record.id;
    }

    // Link all files attached on the form
    async insertAttachment(req, model, idRecord, files) {
        const orphanAttachmentIds = [];
        const modelName = await (await model.sudo()).model;
        const record = model.env.items(modelName).browse(idRecord);
        const authorizedFields = await (await model.withUser(global.SUPERUSER_ID))._getFormWritableFields();
        for (const file of files) {
            const fieldName = await file.fieldName;
            const customField = !(fieldName in authorizedFields);
            const attachmentValue = {
                'label': await file.filename,
                'datas': encodebytes(await fsPro.readFile(file)),
                'resModel': modelName,
                'resId': record.id,
            }
            const attachment = await (await (await req.getEnv()).items('ir.attachment').sudo()).create(attachmentValue);
            if (attachment.ok && !customField) {
                const recordSudo = await record.sudo();
                let value = [[4, attachment.id]];
                if (recordSudo._fields[fieldName].type === 'many2one') {
                    value = attachment.id;
                }
                await recordSudo.set(fieldName, value);
            }
            else {
                orphanAttachmentIds.push(attachment.id);
            }
        }

        if (modelName !== 'mail.mail') {
            // If some attachments didn't match a field on the model,
            // we create a mail.message to link them to the record
            if (bool(orphanAttachmentIds)) {
                const values = {
                    'body': await this._t(await req.getEnv(), '<p>Attached files : </p>'),
                    'model': modelName,
                    'messageType': 'comment',
                    'resId': idRecord,
                    'attachmentIds': [[6, 0, orphanAttachmentIds]],
                    'subtypeId': await (await req.getEnv()).items('ir.model.data')._xmlidToResId('mail.mtComment'),
                }
                const mailId = await (await (await req.getEnv()).items('mail.message').withUser(global.SUPERUSER_ID)).create(values);
            }
        }
        else {
            // If the model is mail.mail then we have no other choice but to
            // attach the custom binary field files on the attachment_ids field.
            for (const attachment of orphanAttachmentIds) {
                await record.set('attachmentIds', [[4, attachment]]);
            }
        }
    }
}

class IntegrityError extends Error {}