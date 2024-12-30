import { Fields } from "../../../core/fields";
import { httpGet } from "../../../core/http";
import { MetaModel, Model } from "../../../core/models";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class MailIceServer extends Model {
    static _module = module;
    static _name = 'mail.ice.server';
    static _description = 'ICE server';

    static serverType = Fields.Selection([['stun', 'stun:'], ['turn', 'turn:']], {string: 'Type', required: true, default: 'stun'})
    static uri = Fields.Char('URI', {required: true})
    static username = Fields.Char()
    static credential = Fields.Char()

    /**
     * :return: List of up to 5 dict, each of which representing a stun or turn server
     * @returns 
     */
    async _getLocalIceServers() {
        // firefox has a hard cap of 5 ice servers
        const iceServers = await (await this.sudo()).search([], {limit: 5});
        const formattedIceServers = [];
        for (const iceServer of iceServers) {
            const formattedIceServer = {
                'urls': f('%s:%s', await iceServer.serverType, await iceServer.uri),
            }
            if (await iceServer.username) {
                formattedIceServer['username'] = await iceServer.username;
            }
            if (await iceServer.credential) {
                formattedIceServer['credential'] = await iceServer.credential;
            }
            formattedIceServers.push(formattedIceServer);
        }
        return formattedIceServers;
    }

    /**
     * To be overridable if we need to obtain credentials from another source.
        :return: tuple
     * @returns 
     */
    async _getTwilioCredentials() {
        const accountSid = await (await this.env.items('ir.config.parameter').sudo()).getParam('mail.twilioAccountSid');
        const authToken = await (await this.env.items('ir.config.parameter').sudo()).getParam('mail.twilioAccountToken');
        return [accountSid, authToken];
    }

    /**
     * :return: List of dict, each of which representing a stun or turn server, formatted as expected by the specifications of RTCConfiguration.iceServers
     * @returns 
     */
    async _getIceServers() {
        if (await (await this.env.items('ir.config.parameter').sudo()).getParam('mail.useTwilioRtcServers')) {
            const [accountSid, authToken] = await this._getTwilioCredentials();
            if (accountSid && authToken) {
                const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`);
                // const response = post(url, auth=(account_sid, auth_token), timeout=60)
                const options = {
                    auth: `${accountSid}:${authToken}`,
                    method: 'GET',
                    timeout: 60,
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded',
                    //   'Content-Length': Buffer.byteLength(data)
                    },
                  };
              
                const r = await httpGet(url, options)
                return r;// literalEval(r.text)

                // if response.ok:
                //     response_content = response.json()
                //     if response_content:
                //         return response_content['ice_servers']
            }
        }
        return this._getLocalIceServers();
    }
}