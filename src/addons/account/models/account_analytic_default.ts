import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { ValidationError } from "../../../core/helper/errors";
import { MetaModel, Model } from "../../../core/models";
import { bool, extend } from "../../../core/tools";

@MetaModel.define()
class AccountAnalyticDefault extends Model {
  static _module = module;
  static _name = "account.analytic.default";
  static _description = "Analytic Distribution";
  static _recName = "analyticId"
  static _order = "sequence";

  static sequence = Fields.Integer({ string: 'Sequence', help: "Gives the sequence order when displaying a list of analytic distribution" });
  static analyticId = Fields.Many2one('account.analytic.account', { string: 'Analytic Account' });
  static analyticTagIds = Fields.Many2many('account.analytic.tag', { string: 'Analytic Tags' });
  static productId = Fields.Many2one('product.product', { string: 'Product', ondelete: 'CASCADE', help: "Select a product which will use analytic account specified in analytic default (e.g. create new customer invoice or Sales order if we select this product, it will automatically take this as an analytic account)" });
  static partnerId = Fields.Many2one('res.partner', { string: 'Partner', ondelete: 'CASCADE', help: "Select a partner which will use analytic account specified in analytic default (e.g. create new customer invoice or Sales order if we select this partner, it will automatically take this as an analytic account)" });
  static accountId = Fields.Many2one('account.account', { string: 'Account', ondelete: 'CASCADE', help: "Select an accounting account which will use analytic account specified in analytic default (e.g. create new customer invoice or Sales order if we select this account, it will automatically take this as an analytic account)" });
  static userId = Fields.Many2one('res.users', { string: 'User', ondelete: 'CASCADE', help: "Select a user which will use analytic account specified in analytic default." });
  static companyId = Fields.Many2one('res.company', { string: 'Company', ondelete: 'CASCADE', help: "Select a company which will use analytic account specified in analytic default (e.g. create new customer invoice or Sales order if we select this company, it will automatically take this as an analytic account)" });
  static dateStart = Fields.Date({ string: 'Start Date', help: "Default start date for this Analytic Account." });
  static dateStop = Fields.Date({ string: 'End Date', help: "Default end date for this Analytic Account." });

  @api.constrains('analyticId', 'analyticTagIds')
  async _checkAccountOrTags() {
    if (! await this.some(async (def) => bool(await def.analyticId) && !bool(await def.analyticTagIds))) {
      throw new ValidationError(await this._t('An analytic default requires at least an analytic account or an analytic tag.'));
    }
  }

  @api.model()
  async accountGet(opts: {productId?: any, partnerId?: any, accountId?: any, userId?: any, date?: any, companyId?: any}={}) {
    const {productId, partnerId, accountId, userId, date, companyId} = opts;
    let domain: any[] = [];
    if (productId) {
      extend(domain, ['|', ['productId', '=', productId]]);
    }
    extend(domain, [['productId', '=', false]]);
    if (partnerId) {
      extend(domain, ['|', ['partnerId', '=', partnerId]]);
    }
    extend(domain, [['partnerId', '=', false]]);
    if (accountId) {
      extend(domain, ['|', ['accountId', '=', accountId]]);
    }
    extend(domain, [['accountId', '=', false]]);
    if (companyId) {
      extend(domain, ['|', ['companyId', '=', companyId]]);
    }
    extend(domain, [['companyId', '=', false]]);
    if (userId) {
      extend(domain, ['|', ['userId', '=', userId]]);
    }
    extend(domain, [['userId', '=', false]]);
    if (date) {
      extend(domain, ['|', ['dateStart', '<=', date], ['dateStart', '=', false]]);
      extend(domain, ['|', ['dateStop', '>=', date], ['dateStop', '=', false]]);
    }
    let bestIndex = -1;
    let res = this.env.items('account.analytic.default');
    for (const rec of await this.search(domain)) {
      let index = 0;
      if ((await rec.productId).ok) index += 1;
      if ((await rec.partnerId).ok) index += 1;
      if ((await rec.accountId).ok) index += 1;
      if ((await rec.companyId).ok) index += 1;
      if ((await rec.userId).ok) index += 1;
      if (await rec.dateStart) index += 1;
      if (await rec.dateStop) index += 1;
      if (index > bestIndex) {
        res = rec;
        bestIndex = index;
      }
    }
    return res;
  }
}