import { api } from "../../../core";
import { AbstractModel, MetaModel } from "../../../core/models"
import { update } from "../../../core/tools/misc";

@MetaModel.define()
class ReportAccountHashIntegrity extends AbstractModel {
    static _module = module;
    static _name = 'report.account.hash.integrity';
    static _description = 'Get hash integrity result as PDF.';

    @api.model()
    async _getReportValues(docIds, data?: any) {
      const company = await this.env.company();
        if (data) {
            update(data, await company._checkHashIntegrity());
        }
        else {
            data = company._checkHashIntegrity();
        }
        return {
            'docIds' : docIds,
            'docModel' : this.env.items('res.company'),
            'data' : data,
            'docs' : this.env.items('res.company').browse(company.id),
        }
    }
}