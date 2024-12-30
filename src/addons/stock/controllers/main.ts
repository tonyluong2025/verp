import { ServerResponse } from "http"
import { http } from "../../../core"
import { WebRequest, serializeException } from "../../../core/http"
import { escapeHtml } from "../../../core/tools/xml";
import { stringify } from "../../../core/tools/json";

@http.define()
class StockReportController extends http.Controller {
  static _module = module;

  @http.route('/stock/<string:outputFormat>/<string:reportName>', { type: 'http', auth: "user" })
  async report(req: WebRequest, res: ServerResponse, opts: { outputFormat?: any, reportName?: any } = {}) {
    const uid = req.session.uid;
    const domain = [['createdUid', '=', uid]];
    const stockTraceability = (await (await req.getEnv()).items('stock.traceability.report').withUser(uid)).search(domain, { limit: 1 });
    const lineData = JSON.parse(opts['data']);
    try {
      if (opts.outputFormat === 'pdf') {
        const response = req.makeResponse(res,
          await (await stockTraceability.withContext({ activeId: opts['activeId'], activeModel: opts['activeModel'] })).getPdf(lineData),
          [
            ['Content-Type', 'application/pdf'],
            ['Content-Disposition', ('attachment; filename=' + 'stock_traceability' + '.pdf;')]
          ]
        )
        return response;
      }
    } catch (e) {
      // except Exception as e:
      const se = serializeException(e);
      const error = {
        'code': 200,
        'message': 'Verp Server Error',
        'data': se
      }
      return req.makeResponse(res, escapeHtml(stringify(error)));
    }
  }
}