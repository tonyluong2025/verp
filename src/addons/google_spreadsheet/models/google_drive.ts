import xpath from 'xpath';
import { api } from "../../../core";
import { httpPost } from "../../../core/http";
import { _super, MetaModel, Model } from "../../../core/models"
import { urlEncode } from "../../../core/service/middleware/utils";
import { bool, f, getrootXml, jsonParse, parseXml, stringify } from "../../../core/tools";

const TIMEOUT = 20;

@MetaModel.define()
class GoogleDrive extends Model {
    static _module = module;
    static _parents = 'google.drive.config';

    async getGoogleScope() {
        const scope = await _super(GoogleDrive, this).getGoogleScope();
        return f('%s https://www.googleapis.com/auth/spreadsheets', scope);
    }

    @api.model()
    async writeConfigFormula(attachmentId, spreadsheetKey, model, domain, groupbys, viewId) {
        const accessToken = await (this as any).getAccessToken('https://www.googleapis.com/auth/spreadsheets');

        const formula = await this._getDataFormula(model, domain, groupbys, viewId);

        const url = await (await this.env.items('ir.config.parameter').sudo()).getParam('web.base.url');
        const dbName = this._cr.dbName;
        const user = (await this.env.items('res.users').browse((await this.env.user()).id).read(['login', 'password']))[0];
        const username = await user['login'],
        password = await user['password'];
        let configFormula;
        if (! password) {
            configFormula = f('=oe_settings("%s";"%s")', url, dbName);
        }
        else {
            configFormula = f('=oe_settings("%s";"%s";"%s";"%s")', url, dbName, username, password);
        }
        const request = {
            "valueInputOption": "USER_ENTERED",
            "data": [
                {"range": "A1", "values": [[formula]]},
                {"range": "O60", "values": [[configFormula]]},
            ]
        }
        try {
            const req = await httpPost(stringify(request),
                f('https://sheets.googleapis.com/v4/spreadsheets/%s/values:batchUpdate?%s', spreadsheetKey, urlEncode({'accessToken': accessToken})),
                {headers: {'content-type': 'application/json', 'If-Match': '*'},
                timeout: TIMEOUT},
            );
        } catch(e) {
            console.warn("An error occured while writing the formula on the Google Spreadsheet.");
        }
        const description = f(`
        formula: %s
        `, formula);
        if (bool(attachmentId)) {
            await this.env.items('ir.attachment').browse(attachmentId).write({'description': description});
        }
        return true;
    }

    async _getDataFormula(model, domain, groupbys, viewId) {
        let fields = await this.env.items(model).fieldsViewGet(viewId, 'tree');
        const doc = getrootXml(parseXml(fields['arch']));
        const displayFields = [];
        for (const node of xpath.select("//field", doc) as Element[]) {
            if (node.hasAttribute('modifiers')) {
                const modifiers = jsonParse(node.getAttribute('modifiers'));
                if (! modifiers['invisible'] && ! modifiers['columnInvisible']) {
                    displayFields.push(node.getAttribute('name'));
                }
            }
        }
        fields = displayFields.join(" ");
        domain = domain.replace(/\'/gm, "'").replace('"', "'");
        let formula;
        if (bool(groupbys)) {
            fields = f("%s %s", groupbys, fields);
            formula = f('=oe_read_group("%s";"%s";"%s";"%s")', model, fields, groupbys, domain);
        }
        else {
            formula = f('=oe_browse("%s";"%s";"%s")', model, fields, domain);
        }
        return formula;
    }

    @api.model()
    async setSpreadsheet(model, domain, groupbys, viewId) {
        const config = await this.env.ref('google_spreadsheet.googleSpreadsheetTemplate');

        if ((this as any)._moduleDeprecated()) {
            return {
                'url': await config.googleDriveTemplateUrl,
                'deprecated': true,
                'formula': await this._getDataFormula(model, domain, groupbys, viewId),
            }
        }

        const title = f('Spreadsheet %s', model);
        const res = await (this as any).copyDoc(false, await config.googleDriveResourceId, title, model);

        const mo = res['url'].match(/(key=|\/d\/)([A-Za-z0-9-_]+)/g);
        let key;
        if (mo) {
            key = mo[2];
        }
        await this.writeConfigFormula(res['id'], key, model, domain, groupbys, viewId);
        return res;
    }
}
