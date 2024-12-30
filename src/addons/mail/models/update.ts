import http from 'http';
import { DateTime } from "luxon";
import { api, release } from "../../../core";
import { UserError } from '../../../core/helper';
import { AbstractModel, MetaModel } from "../../../core/models";
import { literalEval } from '../../../core/tools/ast';
import { bool } from '../../../core/tools/bool';
import { config } from "../../../core/tools/config";
import { stringify } from '../../../core/tools/json';
import { DEFAULT_SERVER_DATETIME_FORMAT } from "../../../core/tools/misc";
import { URI } from '../../../core/tools';

@MetaModel.define()
class PublisherWarrantyContract extends AbstractModel {
  static _module = module;
  static _name = "publisher.warranty.contract";
  static _description = 'Publisher Warranty Contract';

  @api.model()
  async _getMessage() {
    const Users = this.env.items('res.users');
    const IrParamSudo = await this.env.items('ir.config.parameter').sudo();

    const dbuuid = await IrParamSudo.getParam('database.uuid');
    const dbCreatedAt = await IrParamSudo.getParam('database.createdAt');
    const limitDate = DateTime.now().minus({days: 15});
    const limitDateStr = limitDate.toFormat(DEFAULT_SERVER_DATETIME_FORMAT);
    const nbrUsers = await Users.searchCount([['active', '=', true]]);
    const nbrActiveUsers = await Users.searchCount([["loginDate", ">=", limitDateStr], ['active', '=', true]]);
    let nbrShareUsers = 0
    let nbrActiveShareUsers = 0
    if ("share" in Users._fields) {
      nbrShareUsers = await Users.searchCount([["share", "=", true], ['active', '=', true]]);
      nbrActiveShareUsers = await Users.searchCount([["share", "=", true], ["loginDate", ">=", limitDateStr], ['active', '=', true]]);
    }
    const user = await this.env.user();
    const domain = [['application', '=', true], ['state', 'in', ['installed', 'to upgrade', 'to remove']]];
    const apps = await (await this.env.items('ir.module.module').sudo()).searchRead(domain,  ['label']);

    const enterpriseCode = await IrParamSudo.getParam('database.enterpriseCode');

    const webBaseUrl = await IrParamSudo.getParam('web.base.url');
    const msg = {
      "dbuuid": dbuuid,
      "nbrUsers": nbrUsers,
      "nbrActiveUsers": nbrActiveUsers,
      "nbrShareUsers": nbrShareUsers,
      "nbrActiveShareUsers": nbrActiveShareUsers,
      "dbName": this._cr.dbName,
      "dbCreatedAt": dbCreatedAt,
      "version": release.version,
      "language": user.lang,
      "webBaseUrl": webBaseUrl,
      "apps": apps.map(app => app['label']),
      "enterpriseCode": enterpriseCode,
    }
    const partnerId = await user.partnerId;
    let companyId = await partnerId.companyId;    
    if (companyId.ok) {
      Object.assign(msg, await companyId.getDict(["label", "email", "phone"]));
    }
    return msg;
  }

  /**
   * Utility method to send a publisher warranty get logs messages.
   * @returns 
   */
  @api.model()
  async _getSysLogs(options: {onData: Function, onEnd: Function, onError: Function}) {
    const msg = await this._getMessage();
    const data = stringify({'arg0': String(msg), "action": "update"});

    const url = new URI(config.get("publisherWarrantyUrl"));

    const postOptions = {
      host: url.host,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: 30,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      },
    };

    const r = http.request(postOptions, function(res) {
      res.setEncoding('utf8');

      res.on('data', function (chunk) {
        options.onData(chunk);
      });

      res.on('end', function () {
        options.onEnd();
      });
    });

    r.on('error', (e) => {
      options.onError(e);
    });
      
    // post the data
    r.write(data);
    r.end();
    return r;// literalEval(r.text)
  }

  /**
   * Send a message to Verp's publisher warranty server to check the
    validity of the contracts, get notifications, etc...

    @param cron_mode: If true, catch all exceptions (appropriate for usage in a cron).
    @type cron_mode: boolean
   * @param cronMode 
   * @returns 
   */
  async updateNotification(cronMode: boolean=true) {
    try {
      const r = await this._getSysLogs({
        onError: async (e) => {
          console.error(`problem with request: ${e.message}`);
          if (cronMode) {   // we don't want to see any stack trace in cron
            return false;
          }
          console.debug("Exception while sending a get logs messages");
          throw new UserError(await this._t("Error during communication with the publisher warranty server."))
        },
        onData: async (chunk) => {
          const result = literalEval(chunk);
          // old behavior based on res.log; now on mail.message, that is not necessarily installed
          const user = (await this.env.items('res.users').sudo()).browse(global.SUPERUSER_ID);
          let poster = await (await this.sudo()).env.ref('mail.channelAllEmployees');
          if (!(poster.ok && bool(await poster.exists()))) {
            if (! bool(await user.exists())) {
              return true;
            }
            poster = user;
          }
          for (const message of result["messages"]) {
            try {
              await poster.messagePost({body: message, subtypeXmlid: 'mail.mtComment', partnerIds: [(await user.partnerId).id]});
            } catch(e) {
              // pass
            }
          }
          if (result['enterpriseInfo']) {
            // Update expiration date
            const self = await this.env.items('ir.config.parameter').sudo();
            const setParam = self.setParam.bind(self);
            // await Promise.all([
              await setParam('database.expirationDate', result['enterpriseInfo']['expirationDate']);
              await setParam('database.expirationReason', result['enterpriseInfo']['expirationReason'] ?? 'trial');
              await setParam('database.enterpriseCode', result['enterpriseInfo']['enterpriseCode']);
              await setParam('database.alreadyLinkedSubscriptionUrl', result['enterpriseInfo']['databaseAlreadyLinkedSubscriptionUrl']);
              await setParam('database.alreadyLinkedEmail', result['enterpriseInfo']['databaseAlreadyLinkedEmail']);
              await setParam('database.alreadyLinkedSendMailUrl', result['enterpriseInfo']['databaseAlreadyLinkedSendMailUrl']);
            // ]);
          }
        },
        onEnd: () => {}
      })
    } catch(e) {
      if (cronMode) {
        return false    // we don't want to see any stack trace in cron
      }
      else {
        throw e;
      }
    }
    return true;
  }
}