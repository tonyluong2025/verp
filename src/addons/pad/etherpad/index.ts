// Module to talk to EtherpadLite API.

import { encode } from "utf8"
import { ValueError } from "../../../core/helper"
import { httpPost } from "../../../core/http"
import { f, html2Text, markup } from "../../../core/tools"

/**
 * Client to talk to EtherpadLite API.
 */
export class EtherpadLiteClient {
    API_VERSION = 1  // TODO probably 1.1 sometime soon

    CODE_OK = 0
    CODE_INVALID_PARAMETERS = 1
    CODE_INTERNAL_ERROR = 2
    CODE_INVALID_FUNCTION = 3
    CODE_INVALID_API_KEY = 4
    TIMEOUT = 20

    apiKey = "";
    baseUrl = "http://localhost:9001/api";

    constructor(apiKey?: string, baseUrl?: string) {
        if (apiKey) {
            this.apiKey = apiKey;
        }
        if (baseUrl) {
            this.baseUrl = baseUrl;
        }
    }

    /**
     * Create a dictionary of all parameters
     */
    async __call(func, args?: any) {
        const url = f('%s/%s/%s', this.baseUrl, this.API_VERSION, func);

        const params = args ?? {};
        params['apikey'] = this.apiKey;

        const res = await httpPost(params, url, {timeout: this.TIMEOUT});
        res.raiseForStatus();
        return this.handleResult(res.json());
    }

    /**
     * Handle API call result
     * @param result 
     * @returns 
     */
    handleResult(result) {
        if (!('code' in result)) {
            throw new Error("API response has no code");
        }
        if (!('message' in result)) {
            throw new Error("API response has no message");
        }

        if (!('data' in result)) {
            result['data'] = null;
        }

        if (result['code'] == this.CODE_OK) {
            return result['data'];
        }
        else if (result['code'] == this.CODE_INVALID_PARAMETERS || result['code'] == this.CODE_INVALID_API_KEY) {
            throw new ValueError(result['message']);
        }
        else if (result['code'] == this.CODE_INTERNAL_ERROR) {
            throw new Error(result['message']);
        }
        else if (result['code'] == this.CODE_INVALID_FUNCTION) {
            throw new Error(result['message']);
        }
        else {
            throw new Error("An unexpected error occurred whilst handling the response");
        }
    }

    // GROUPS
    // Pads can belong to a group. There will always be public pads that do not belong to a group (or we give this group the id 0)

    /**
     * creates a new group
     */
    async createGroup() {
        return this.__call("createGroup");
    }

    /**
     * this functions helps you to map your application group ids to etherpad lite group ids
     * @param groupMapper 
     * @returns 
     */
    async createGroupIfNotExistsFor(groupMapper) {
        return this.__call("createGroupIfNotExistsFor", {
            "groupMapper": groupMapper
        });
    }

    /**
     * deletes a group
     * @param groupID 
     * @returns 
     */
    async deleteGroup(groupID) {
        return this.__call("deleteGroup", {
            "groupID": groupID
        });
    }

    /**
     * returns all pads of this group
     * @param groupID 
     * @returns 
     */
    async listPads(groupID) {
        return this.__call("listPads", {
            "groupID": groupID
        });
    }

    /**
     * creates a new pad in this group
     * @param groupID 
     * @param padName 
     * @param text 
     * @returns 
     */
    async createGroupPad(groupID, padName, text='') {
        const params = {
            "groupID": groupID,
            "padName": padName,
        }
        if (text) {
            params['text'] = text;
        }
        return this.__call("createGroupPad", params);
    }

    // AUTHORS
    // Theses authors are bind to the attributes the users choose (color and name).

    /**
     * creates a new author
     * @param name 
     * @returns 
     */
    async createAuthor(name='') {
        const params = {}
        if (name) {
            params['name'] = name;
        }
        return this.__call("createAuthor", params);
    }

    /**
     * this functions helps you to map your application author ids to etherpad lite author ids
     * @param authorMapper 
     * @param name 
     * @returns 
     */
    async createAuthorIfNotExistsFor(authorMapper, name='') {
        const params = {
            'authorMapper': authorMapper
        }
        if (name) {
            params['name'] = name;
        }
        return this.__call("createAuthorIfNotExistsFor", params);
    }

    // SESSIONS
    // Sessions can be created between a group and a author. This allows
    // an author to access more than one group. The sessionID will be set as
    // a cookie to the client and is valid until a certain date.

    /**
     * creates a new session
     * @param groupID 
     * @param authorID 
     * @param validUntil 
     * @returns 
     */
    async createSession(groupID, authorID, validUntil) {
        return this.__call("createSession", {
            "groupID": groupID,
            "authorID": authorID,
            "validUntil": validUntil
        });
    }

    /**
     * deletes a session
     * @param sessionID 
     * @returns 
     */
    async deleteSession(sessionID) {
        return this.__call("deleteSession", {
            "sessionID": sessionID
        });
    }

    /**
     * returns informations about a session
     * @param sessionID 
     * @returns 
     */
    async getSessionInfo(sessionID) {
        return this.__call("getSessionInfo", {
            "sessionID": sessionID
        });
    }

    /**
     * returns all sessions of a group
     * @param groupID 
     * @returns 
     */
    async listSessionsOfGroup(groupID) {
        return this.__call("listSessionsOfGroup", {
            "groupID": groupID
        });
    }

    /**
     * returns all sessions of an author
     * @param authorID 
     * @returns 
     */
    async listSessionsOfAuthor(authorID) {
        return this.__call("listSessionsOfAuthor", {
            "authorID": authorID
        });
    }

    // PAD CONTENT
    // Pad content can be updated and retrieved through the API

    /**
     * returns the text of a pad
     * @param padID 
     * @param rev 
     * @returns 
     */
    async getText(padID, rev?: any) {
        const params = {"padID": padID}
        if (rev != null) {
            params['rev'] = rev;
        }
        return this.__call("getText", params);
    }

    // introduced with pull request merge
    /**
     * returns the html of a pad
     * @param padID 
     * @param rev 
     * @returns 
     */
    async getHtml(padID, rev?: any) {
        const params = {"padID": padID}
        if (rev != null) {
            params['rev'] = rev;
        }
        return this.__call("getHTML", params);
    }

    /**
     * sets the text of a pad
     * @param padID 
     * @param text 
     * @returns 
     */
    async setText(padID, text) {
        return this.__call("setText", {
            "padID": padID,
            "text": text
        });
    }

    async setHtmlFallbackText(padID, html) {
        try {
            // Prevents malformed HTML errors
            const htmlWellformed = f(markup("<html><body>%s</body></html>"), html);
            return this.setHtml(padID, htmlWellformed);
        } catch(e) {
            console.error('Falling back to setText. SetHtml failed with message:');
            return this.setText(padID, encode(html2Text(html)));
        }
    }

    /**
     * sets the text of a pad from html
     * @param padID 
     * @param html 
     * @returns 
     */
    async setHtml(padID, html) {
        return this.__call("setHTML", {
            "padID": padID,
            "html": html
        });
    }

    // PAD
    // Group pads are normal pads, but with the name schema
    // GROUPID$PADNAME. A security manager controls access of them and its
    // forbidden for normal pads to include a  in the name.

    /**
     * creates a new pad
     * @param padID 
     * @param text 
     * @returns 
     */
    async createPad(padID, text='') {
        const params = {
            "padID": padID,
        }
        if (text) {
            params['text'] = text;
        }
        return this.__call("createPad", params);
    }

    /**
     * returns the number of revisions of this pad
     * @param padID 
     * @returns 
     */
    async getRevisionsCount(padID) {
        return this.__call("getRevisionsCount", {
            "padID": padID
        });
    }

    /**
     * deletes a pad
     * @param padID 
     * @returns 
     */
    async deletePad(padID) {
        return this.__call("deletePad", {
            "padID": padID
        });
    }

    /**
     * returns the read only link of a pad
     * @param padID 
     * @returns 
     */
    async getReadOnlyID(padID) {
        return this.__call("getReadOnlyID", {
            "padID": padID
        });
    }

    /**
     * sets a boolean for the public status of a pad
     * @param padID 
     * @param publicStatus 
     * @returns 
     */
    async setPublicStatus(padID, publicStatus) {
        return this.__call("setPublicStatus", {
            "padID": padID,
            "publicStatus": publicStatus
        });
    }

    /**
     * return true of false
     * @param padID 
     * @returns 
     */
    async getPublicStatus(padID) {
        return this.__call("getPublicStatus", {
            "padID": padID
        });
    }

    /**
     * returns ok or a error message
     * @param padID 
     * @param password 
     * @returns 
     */
    async setPassword(padID, password) {
        return this.__call("setPassword", {
            "padID": padID,
            "password": password
        });
    }

    /**
     * returns true or false
     */
    async isPasswordProtected(padID) {
        return this.__call("isPasswordProtected", {
            "padID": padID
        });
    }
}