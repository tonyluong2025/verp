import { http } from "../../../core";
import { OrderedDict } from "../../../core/helper/collections";
import { AccessError, MissingError } from "../../../core/helper/errors";
import { WebRequest } from "../../../core/http";
import { isInstance, sorted, update } from "../../../core/tools";
import { CustomerPortal, pager as portalPager } from "../../portal/controllers/portal";

@http.define()
class PortalAccount extends CustomerPortal {
  static _module = module;

  async _prepareHomePortalValues(req: WebRequest, counters: string[]) {
        const values = super._prepareHomePortalValues(req, counters);
        if (counters.includes('invoiceCount')) {
          const env = await req.getEnv();
            const invoiceCount = await env.items('account.move').checkAccessRights('read', false) ? await env.items('account.move').searchCount(this._getInvoicesDomain()) : 0;
            values['invoiceCount'] = invoiceCount
        }
        return values;
  }

  // My Invoices

  async _invoiceGetPageViewValues(req, invoice, accessToken, opts) {
    const values = {
        'pageName': 'invoice',
        'invoice': invoice,
    }
    return this._getPageViewValues(req, invoice, accessToken, values, 'myInvoicesHistory', false, opts);
  }

  _getInvoicesDomain() {
      return [['state', 'not in', ['cancel', 'draft']], ['moveType', 'in', ['outInvoice', 'outRefund', 'inInvoice', 'inRefund', 'outReceipt', 'inReceipt']]];
  }

  @http.route(['/my/invoices', '/my/invoices/page/<int:page>'], {type: 'http', auth: "user", website: true})
  async portalMyInvoices(req: WebRequest, res, {page=1, dateBegin=null, dateEnd=null, sortby=null, filterby=null}={}) {
      const values = await this._preparePortalLayoutValues(req);
      const accountInvoice = (await req.getEnv()).items('account.move');

      let domain = this._getInvoicesDomain();

      const searchbarSortings = {
          'date': {'label': await this._t(await req.getEnv(), 'Date'), 'order': 'invoiceDate desc'},
          'duedate': {'label': await this._t(await req.getEnv(), 'Due Date'), 'order': 'invoiceDateDue desc'},
          'label': {'label': await this._t(await req.getEnv(), 'Reference'), 'order': 'label desc'},
          'state': {'label': await this._t(await req.getEnv(), 'Status'), 'order': 'state'},
      }
      // default sort by order
      if (! sortby) {
          sortby = 'date';
      }
      const order = searchbarSortings[sortby]['order'];

      const searchbarFilters = {
          'all': {'label': await this._t(await req.getEnv(), 'All'), 'domain': []},
          'invoices': {'label': await this._t(await req.getEnv(), 'Invoices'), 'domain': [['moveType', 'in', ['outInvoice', 'outRefund']]]},
          'bills': {'label': await this._t(await req.getEnv(), 'Bills'), 'domain': [['moveType', 'in', ['inInvoice', 'inRefund']]]},
      }
      // default filter by value
      if (! filterby) {
          filterby = 'all';
      }
      domain = domain.concat(searchbarFilters[filterby]['domain']);

      if (dateBegin && dateEnd) {
          domain = domain.concat([['createdAt', '>', dateBegin], ['createdAt', '<=', dateEnd]]);
      }

      // count for pager
      const invoiceCount = await accountInvoice.searchCount(domain);
      // pager
      const pager = portalPager({
          url: "/my/invoices",
          urlArgs: {'dateBegin': dateBegin, 'dateEnd': dateEnd, 'sortby': sortby},
          total: invoiceCount,
          page: page,
          step: this._itemsPerPage
      });
      // content according to pager and archive selected
      const invoices = await accountInvoice.search(domain, {order: order, limit: this._itemsPerPage, offset: pager['offset']});
      req.session['myInvoicesHistory'] = invoices.ids.slice(0,100);

      update(values, {
          'date': dateBegin,
          'invoices': invoices,
          'pageName': 'invoice',
          'pager': pager,
          'defaultUrl': '/my/invoices',
          'searchbarSortings': searchbarSortings,
          'sortby': sortby,
          'searchbarFilters': new OrderedDict(sorted(Object.entries(searchbarFilters), (item) => item[0])),
          'filterby': filterby,
      })
      return req.render(res, "account.portalMyInvoices", values);
  }

  @http.route(['/my/invoices/<int:invoiceId>'], {type: 'http', auth: "public", website: true})
  async portalMyInvoiceDetail(req: WebRequest, res, opts: {invoiceId?: any, accessToken?: string, reportType?: string, download?: boolean}={}) {
    let invoiceSudo;
      try {
          invoiceSudo = await this._documentCheckAccess(req, 'account.move', opts.invoiceId, opts.accessToken);
      } catch(e) {
        if (isInstance(e, AccessError, MissingError)) {
          return req.redirect(res, '/my');
        }
        throw e;
      }
      if (['html', 'pdf', 'text'].includes(opts.reportType)) {
          return this._showReport(req, res, invoiceSudo, opts.reportType, 'account.accountInvoices', opts.download);
      }

      const values = await this._invoiceGetPageViewValues(req, invoiceSudo, opts.accessToken, opts);
      return req.render(res, "account.portalInvoicePage", values);
  }

  // My Home

  async detailsFormValidate(req: WebRequest, data) {
      const [error, errorMessage] = await super.detailsFormValidate(req, data);
      // prevent VAT/name change if invoices exist
      const partner = await (await req.getEnv()).items('res.users').browse(req.uid).partnerId;
      if (! await partner.canEditVat()) {
          if ('vat' in data && (data['vat'] || false) != (await partner.vat || false)) {
              error['vat'] = 'error';
              errorMessage.push(await this._t(await req.getEnv(), 'Changing VAT number is not allowed once invoices have been issued for your account. Please contact us directly for this operation.'));
          }
          if ('label' in data && (data['label'] || false) != (await partner.label || false)) {
              error['label'] = 'error';
              errorMessage.push(await this._t(await req.getEnv(), 'Changing your name is not allowed once invoices have been issued for your account. Please contact us directly for this operation.'));
          }
          if ('companyName' in data && (data['companyName'] || false) != (await partner.companyName || false)) {
              error['companyName'] = 'error';
              errorMessage.push(await this._t(await req.getEnv(), 'Changing your company name is not allowed once invoices have been issued for your account. Please contact us directly for this operation.'));
          }
      }
      return [error, errorMessage];
  }
}