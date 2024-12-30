import { http } from "../../..";

@http.define()
export class TableExporter extends http.Controller {
    static _module = module;

    @http.route('/web/pivot/checkXlsxwriter', {type: 'json', auth: 'none'})
    async checkXlsxwriter() {
        return false; //xlsxwriter != null;
    }

    @http.route('/web/pivot/exportXlsx', {type: 'http', auth: "user"})
    async exportXlsx(req, res, opts: {data?: any}={}) {
      console.warn('Not Implement');
  }
}
