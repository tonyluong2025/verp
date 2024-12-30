// Google is depreciating their OOB Auth Flow on 3rd October 2022, the Google Drive
// integration thus become irrelevant after that date.

import { _Date, api, Fields } from "../../../core";
import { RedirectWarning, UserError, ValidationError } from "../../../core/helper";
import { httpGet, httpPost } from "../../../core/http";
import { MetaModel, Model } from "../../../core/models";
import { _f, bool, f, jsonParse, stringify, update } from "../../../core/tools";
import { literalEval } from "../../../core/tools/ast";
import { GOOGLE_TOKEN_ENDPOINT, TIMEOUT } from "../../google_account";

// https://developers.googleblog.com/2022/02/making-oauth-flows-safer.html#disallowed-oob
const GOOGLE_AUTH_DEPRECATION_DATE = new Date(2022, 10, 3);

const timeout = TIMEOUT;

@MetaModel.define()
class GoogleDrive extends Model {
    static _module = module;
    static _name = 'google.drive.config';
    static _description = "Google Drive templates config";

    static label = Fields.Char('Template Name', { required: true });
    static modelId = Fields.Many2one('ir.model', { string: 'Model', required: true, ondelete: 'CASCADE' });
    static model = Fields.Char('Related Model', { related: 'modelId.model', readonly: true });
    static filterId = Fields.Many2one('ir.filters', { string: 'Filter', domain: "[['modelId', '=', model]]" });
    static googleDriveTemplateUrl = Fields.Char('Template URL', { required: true });
    static googleDriveResourceId = Fields.Char('Resource Id', { compute: '_computeRessourceId' });
    static googleDriveClientId = Fields.Char('Google Client', { compute: '_computeClientId' });
    static nameTemplate = Fields.Char('Google Drive Name Pattern', { default: 'Document %(name)s', help: 'Choose how the new google drive will be named, on google side. Eg. gdoc_%(fieldName)s', required: true });
    static active = Fields.Boolean('Active', { default: true });

    _moduleDeprecated() {
        return GOOGLE_AUTH_DEPRECATION_DATE < _Date.today();
    }

    async getGoogleDriveUrl(resId, templateId) {
        if (this._moduleDeprecated()) {
            return;
        }

        this.ensureOne();
        const sudo = await this.sudo();

        const model = await sudo.modelId;
        const filterName = bool(await sudo.filterId) ? await (await sudo.filterId).label : false;
        const record = (await sudo.env.items(await model.model).browse(resId).read())[0];
        update(record, {
            'model': await model.label,
            'filter': filterName
        });
        let nameGdocs = await sudo.nameTemplate;
        try {
            nameGdocs = f(nameGdocs, record);
        } catch (e) {
            throw new UserError(await sudo._t("At least one key cannot be found in your Google Drive name pattern."));
        }
        const attachments = await sudo.env.items("ir.attachment").search([['resModel', '=', await model.model], ['label', '=', nameGdocs], ['resId', '=', resId]]);
        let url = false;
        if (bool(attachments)) {
            url = await attachments[0].url;
        }
        else {
            url = (await sudo.copyDoc(resId, templateId, nameGdocs, await model.model))['url'];
        }
        return url;
    }

    @api.model()
    async getAccessToken(scope = null) {
        if (this._moduleDeprecated()) {
            return;
        }

        const config = await this.env.items('ir.config.parameter').sudo();
        const googleDriveRefreshToken = await config.getParam('googleDriveRefreshToken');
        const userIsAdmin = await this.env.isAdmin();
        if (!googleDriveRefreshToken) {
            if (userIsAdmin) {
                const actionId = (await this.env.items('ir.model.data')._xmlidLookup('base_setup.actionGeneralConfiguration'))[2];
                const msg = await this._t("There is no refresh code set for Google Drive. You can set it up from the configuration panel.");
                throw new RedirectWarning(msg, actionId, await this._t('Go to the configuration panel'));
            }
            else {
                throw new UserError(await this._t("Google Drive is not yet configured. Please contact your administrator."));
            }
        }
        const googleDriveClientId = await config.getParam('googleDriveClientId');
        const googleDriveClientSecret = await config.getParam('googleDriveClientSecret');
        // For Getting New Access Token With help of old Refresh Token
        const data = {
            'client_id': googleDriveClientId,
            'refresh_token': googleDriveRefreshToken,
            'client_secret': googleDriveClientSecret,
            'grant_type': "refresh_token",
            'scope': scope || 'https://www.googleapis.com/auth/drive'
        }
        const headers = { "Content-type": "application/x-www-form-urlencoded" };
        let res;
        try {
            res = await httpPost(data, GOOGLE_TOKEN_ENDPOINT, { headers, timeout });
            res.raiseForStatus();
        } catch (e) {
            if (userIsAdmin) {
                const actionId = (await this.env.items('ir.model.data')._xmlidLookup('base_setup.actionGeneralConfiguration'))[2];
                const msg = await this._t("Something went wrong during the token generation. Please request again an authorization code.");
                throw new RedirectWarning(msg, actionId, await this._t('Go to the configuration panel'));
            }
            else {
                throw new UserError(await this._t("Google Drive is not yet configured. Please contact your administrator."));
            }
        }
        return jsonParse(res)['access_token'];
    }

    @api.model()
    async copyDoc(resId, templateId, nameGdocs, resModel) {
        if (this._moduleDeprecated()) {
            return;
        }

        const googleWebBaseUrl = await (await this.env.items('ir.config.parameter').sudo()).getParam('web.base.url');
        const accessToken = await this.getAccessToken();
        // Copy template in to drive with help of new access token
        let requestUrl = f("https://www.googleapis.com/drive/v2/files/%s?fields=parents/id&access_token=%s", templateId, accessToken);
        let headers: {} = { "Content-type": "application/x-www-form-urlencoded" };
        let parentsDict, res;
        try {
            res = await httpGet(requestUrl, { headers, timeout });
            res.raiseForStatus();
            parentsDict = jsonParse(res);
        } catch (e) {
            throw new UserError(await this._t("The Google Template cannot be found. Maybe it has been deleted."));
        }
        let recordUrl = f("Click on link to open Record in Verp\n %s/?db=%s#id=%s&model=%s", googleWebBaseUrl, this._cr.dbName, resId, resModel);
        const data = {
            "title": nameGdocs,
            "description": recordUrl,
            "parents": parentsDict['parents']
        }
        requestUrl = f("https://www.googleapis.com/drive/v2/files/%s/copy?access_token=%s", templateId, accessToken);
        headers = {
            'Content-type': 'application/json',
            'Accept': 'text/plain'
        }
        // resp, content = Http().request(request_url, "POST", data_json, headers)
        let req = await httpPost(stringify(data), requestUrl, { headers, timeout });
        req.raiseForStatus();
        const content = jsonParse(req);
        res = {}
        if (content['alternateLink']) {
            res['id'] = (await this.env.items("ir.attachment").create({
                'resModel': resModel,
                'label': nameGdocs,
                'resId': resId,
                'type': 'url',
                'url': content['alternateLink']
            })).id;
            // Commit in order to attach the document to the current object instance, even if the permissions has not been written.
            await this._cr.commit();
            res['url'] = content['alternateLink'];
            const key = await this._getKeyFromUrl(res['url']);
            requestUrl = f("https://www.googleapis.com/drive/v2/files/%s/permissions?email_message=This+is+a+drive+file+created+by+Verp&send_notification_emails=false&access_token=%s", key, accessToken);
            const data = { 'role': 'writer', 'type': 'anyone', 'value': '', 'withLink': true };
            try {
                req = await httpPost(stringify(data), requestUrl, { headers, timeout });
                req.raiseForStatus();
            } catch (e) {
                throw await this.env.items('res.config.settings').getConfigWarning(await this._t("The permission 'reader' for 'anyone with the link' has not been written on the document"));
            }
            const email = await (await this.env.user()).email;
            if (email) {
                const data = { 'role': 'writer', 'type': 'user', 'value': email }
                try {
                    await httpPost(stringify(data), requestUrl, { headers, timeout });
                } catch (e) {
                    // pass
                }
            }
        }
        return res;
    }

    /**
     * Function called by the js, when no google doc are yet associated with a record, with the aim to create one. It
        will first seek for a google.docs.config associated with the model `res_model` to find out what's the template
        of google doc to copy (this is usefull if you want to start with a non-empty document, a type or a name
        different than the default values). If no config is associated with the `res_model`, then a blank text document
        with a default name is created.
     * @param resModel the object for which the google doc is created
     * @param resId the list of ids of the objects for which the google doc is created. This list is supposed to have
            a length of 1 element only (batch processing is not supported in the code, though nothing really prevent it)
     * @returns the config id and config name
     */
    @api.model()
    async getGoogleDriveConfig(resModel, resId) {
        // TO DO in master: fix my signature and my model
        if (typeof resModel === 'string') {
            resModel = await this.env.items('ir.model')._getId(resModel);
        }
        if (!resId) {
            throw new UserError(await this._t("Creating google drive may only be done by one at a time."));
        }
        // check if a model is configured with a template
        const configs = await this.search([['modelId', '=', resModel]]);
        const configValues = [];
        for (const config of await configs.sudo()) {
            const filterId = await config.filterId;
            if (bool(filterId)) {
                if (bool(await filterId.userId) && (await filterId.userId).id != (await this.env.user()).id) {
                    // Private
                    continue;
                }
                let domain;
                try {
                    domain = [['id', 'in', [resId]]].concat(literalEval(await filterId.domain));
                } catch (e) {
                    throw new UserError(await this._t("The document filter must not include any 'dynamic' part, so it should not be based on the current time or current user, for example."));
                }
                const additionnalContext = literalEval(await filterId.context);
                const googleDocConfigs = await (await this.env.items(await filterId.modelId).withContext(additionnalContext)).search(domain);
                if (bool(googleDocConfigs)) {
                    configValues.push({ 'id': config.id, 'label': await config.label });
                }
            }
            else {
                configValues.push({ 'id': config.id, 'label': await config.label });
            }
        }
        return configValues;
    }

    _getKeyFromUrl(url: string) {
        const word = url.match(/(key=|\/d\/)([A-Za-z0-9-_]+)/g);
        if (word) {
            return word[2];
        }
        return null;
    }

    async _computeRessourceId() {
        for (const record of this) {
            if (await record.googleDriveTemplateUrl) {
                const word = this._getKeyFromUrl(await record.googleDriveTemplateUrl);
                if (word) {
                    await record.set('googleDriveResourceId', word);
                }
                else {
                    throw new UserError(await this._t("Please enter a valid Google Document URL."));
                }
            }
            else {
                await record.set('googleDriveResourceId', false);
            }
        }
    }

    async _computeClientId() {
        const googleDriveClientId = await (await this.env.items('ir.config.parameter').sudo()).getParam('google_drive_clientId');
        for (const record of this) {
            await record.set('googleDriveClientId', googleDriveClientId);
        }
    }

    @api.onchange('modelId')
    async _onchangeModelId() {
        if (bool(await this['modelId'])) {
            await this.set('model', await (await this['modelId']).model);
        }
        else {
            await this.set('filterId', false);
            await this.set('model', false);
        }
    }

    @api.constrains('modelId', 'filterId')
    async _checkModelId() {
        for (const drive of this) {
            const [filterId, modelId] = await drive('filterId', 'modelId');
            if (bool(filterId) && await modelId.model != await filterId.modelId) {
                throw new ValidationError(_f(await this._t(
                    "Incoherent Google Drive %(drive)s: the model of the selected filter %(filter)r is not matching the model of current template (%(filterModel)r, %(driveModel)r)"),
                    { drive: await drive.label, filter: await filterId.label, filterModel: await (await filterId.modelId).model, driveModel: await modelId.model },
                ));
            }
        }
        if (bool((await this['modelId']).model) && bool(await this['filterId'])) {
            // force an execution of the filter to verify compatibility
            await this.getGoogleDriveConfig(await (await this['modelId']).model, 1);
        }
    }

    getGoogleScope() {
        return 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file';
    }
}