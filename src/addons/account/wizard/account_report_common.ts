import { Fields, api } from "../../../core";
import { NotImplementedError } from "../../../core/helper/errors";
import { MetaModel, TransientModel } from "../../../core/models"
import { bool } from "../../../core/tools/bool";
import { getLang } from "../../../core/tools/models";

@MetaModel.define()
class AccountCommonReport extends TransientModel {
  static _module = module;
  static _name = "account.common.report";
  static _description = "Account Common Report";

  static companyId = Fields.Many2one('res.company', { string: 'Company', required: true, readonly: true, default: async (self) => self.env.company() });
  static journalIds = Fields.Many2many({
    comodelName: 'account.journal',
    string: 'Journals',
    required: true,
    default: async (self) => self.env.items('account.journal').search([['companyId', '=', (await self.companyId).id]]),
    domain: "[['companyId', '=', companyId]]",
  });
  static dateFrom = Fields.Date({ string: 'Start Date' });
  static dateTo = Fields.Date({ string: 'End Date' });
  static targetMove = Fields.Selection([['posted', 'All Posted Entries'],
  ['all', 'All Entries'],
  ], { string: 'Target Moves', required: true, default: 'posted' });

  @api.onchange('companyId')
  async _onchangeCompanyId() {
    const companyId = await this['companyId'];
    if (companyId.ok) {
      await this.set('journalIds', await this.env.items('account.journal').search([['companyId', '=', (await this['companyId']).id]]));
    }
    else {
      await this.set('journalIds', await this.env.items('account.journal').search([]));
    }
  }

  async _buildContexts(data) {
    const result = {};
    result['journalIds'] = 'journalIds' in data['form'] && data['form']['journalIds']
    result['journalIds'] = bool(result['journalIds']) ? result['journalIds'] : false;
    result['state'] = 'targetMove' in data['form'] && data['form']['targetMove'] || '';
    result['dateFrom'] = data['form']['dateFrom'] || false;
    result['dateTo'] = data['form']['dateTo'] || false;
    result['strictRange'] = result['dateFrom'] ? true : false;
    result['companyId'] = data['form']['companyId'][0];
    result['companyId'] = bool(result['companyId']) ? result['companyId'] : false;
    return result;
  }

  async _printReport(data) {
    throw new NotImplementedError();
  }

  async checkReport() {
    this.ensureOne();
    const data = {};
    data['ids'] = this.env.context['activeIds'] ?? [];
    data['model'] = this.env.context['activeModel'] ?? 'ir.ui.menu';
    data['form'] = await this.readOne(['dateFrom', 'dateTo', 'journalIds', 'targetMove', 'companyId']);
    const usedContext = await this._buildContexts(data);
    data['form']['usedContext'] = Object.assign({}, usedContext, { lang: await (await getLang(this.env)).code });
    return (await this.withContext({ discardLogoCheck: true }))._printReport(data);
  }
}