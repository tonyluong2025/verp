import { ServerResponse } from "http"
import { WebRequest } from "../../../core/http"
import { BusController } from "../../bus/controllers/main"
import { http } from "../../../core"
import { AccessDenied } from "../../../core/helper/errors";

@http.define()
class EditorCollaborationController extends BusController {
  static _module = module;
  // ---------------------------
  // Extends BUS Controller Poll
  // ---------------------------
  async _poll(req: WebRequest, res: ServerResponse, dbname, channels, last, options) {
    if (req.session.uid) {
      // Do not alter original list.
      channels = Array.from(channels);
      for (const channel of channels) {
        if (typeof (channel) === 'string') {
          const env = await req.getEnv();
          const match = channel.match(/editorCollaboration:(\w+(?:.\w+)*):(\w+):([\d]+)/);
          if (match) {
            const modelName = match[1];
            const fieldName = match[2];
            const resId = parseInt(match[3]);

            // Verify access to the edition channel.
            if (! await (await env.user()).hasGroup('base.groupUser')) {
              throw new AccessDenied();
            }
            const document = env.items(modelName).browse([resId]);

            await document.checkAccessRights('read');
            await document.checkFieldAccessRights('read', [fieldName]);
            await document.checkAccessRule('read');
            await document.checkAccessRights('write');
            await document.checkFieldAccessRights('write', [fieldName]);
            await document.checkAccessRule('write');

            channels.push([req.db, 'editorCollaboration', modelName, fieldName, resId]);
          }
        }
      }
    }
    return super._poll(req, res, dbname, channels, last, options);
  }
}