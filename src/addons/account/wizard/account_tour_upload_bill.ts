import { Command, Fields, _Date } from "../../../core/fields";
import { MetaModel, TransientModel } from "../../../core/models";
import { bool } from "../../../core/tools/bool";
import { addDate, subDate, toFormat } from "../../../core/tools/date_utils";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class AccountTourUploadBill extends TransientModel {
  static _module = module;
  static _name = 'account.tour.upload.bill';
  static _description = 'Account tour upload bill';

  static attachmentIds = Fields.Many2many({
    comodelName: 'ir.attachment',
    relation: 'accountTourUploadBillIrAttachmentsRel',
    string: 'Attachments'
  });

  static selection = Fields.Selection({
    selection: async (self) => self._selectionValues(),
    default: "sample"
  })

  static previewInvoice = Fields.Html({
    compute: "_computePreviewInvoice",
    string: "Invoice Preview",
    translate: true,
  });

  async _computePreviewInvoice() {
    const invoiceDate = subDate(_Date.today(), { days: 12 });
    const company = await this.env.company();
    const addr = [
      await company.street,
      await company.street2,
      [await (await company.stateId).label, await company.zip].filter(x => bool(x)).join(' '),
      await (await company.countryId).label,
    ].filter(x => bool(x));
    const ref = f('INV/%s/0001', toFormat(invoiceDate, 'yyyy/mm'));
    const html = await (await this.env.ref('account.billPreview'))._render({
      'companyName': await company.label,
      'companyStreetAddress': addr,
      'invoiceName': 'Invoice ' + ref,
      'invoiceRef': ref,
      'invoiceDate': invoiceDate,
      'invoiceDueDate': addDate(invoiceDate, { days: 30 }),
    })
    for (const record of this) {
      await record.set('previewInvoice', html);
    }
  }

  async _selectionValues() {
    const journalAlias = await this.env.items('account.journal')
      .search([['type', '=', 'purchase'], ['companyId', '=', (await this.env.company()).id]], { limit: 1 });

    const values = [['sample', await this._t('Try a sample vendor bill')], ['upload', await this._t('Upload your own bill')]];
    if (await journalAlias.aliasName && await journalAlias.aliasDomain) {
      values.push(['email', await this._t('Or send a bill to %s@%s', await journalAlias.aliasName, await journalAlias.aliasDomain)]);
    }
    return values;
  }

  async _actionListViewBill(billIds: any[] = []) {
    const context = Object.assign({}, this._context);
    context['default_moveType'] = 'inInvoice';
    return {
      'label': await this._t('Generated Documents'),
      'domain': [['id', 'in', billIds]],
      'viewMode': 'tree,form',
      'resModel': 'account.move',
      'views': [[false, "tree"], [false, "form"]],
      'type': 'ir.actions.actwindow',
      'context': context
    }
  }

  async apply() {
    let purchaseJournal;
    if (this._context['activeModel'] === 'account.journal' && this._context['activeIds']) {
      purchaseJournal = this.env.items('account.journal').browse(this._context['activeIds']);
    }
    else {
      purchaseJournal = await this.env.items('account.journal').search([['type', '=', 'purchase']], { limit: 1 });
    }
    if (await this['selection'] === 'upload') {
      return await (await purchaseJournal.withContext({ default_journalId: purchaseJournal.id, default_moveType: 'inInvoice' })).createInvoiceFromAttachment((await this['attachmentIds']).ids);
    }
    else if (await this['selection'] === 'sample') {
      const bodies = (await this.env.items('ir.actions.report')._prepareHtml(await this['previewInvoice']))[0];
      const samplePdf = await this.env.items('ir.actions.report')._runHtmltoPdf(bodies);

      const invoiceDate = subDate(_Date.today(), { days: 12 });
      const attachment = await this.env.items('ir.attachment').create({
        'type': 'binary',
        'label': f('INV-%s-0001.pdf', toFormat(invoiceDate, 'yyyy-mm')),
        'resModel': 'mail.compose.message',
        'datas': Buffer.from(samplePdf),
      });
      let partner = await this.env.items('res.partner').search([['label', '=', 'Deco Addict']], { limit: 1 });
      if (!bool(partner)) {
        partner = await this.env.items('res.partner').create({
          'label': 'Deco Addict',
          'isCompany': true,
        });
      }
      const bill = await this.env.items('account.move').create({
        'moveType': 'inInvoice',
        'partnerId': partner.id,
        'ref': f('INV/%s/0001', toFormat(invoiceDate, 'YYYYY/mm')),
        'invoiceDate': invoiceDate,
        'invoiceDateDue': addDate(invoiceDate, { days: 30 }),
        'journalId': purchaseJournal.id,
        'invoiceLineIds': [
          Command.create({
            'label': "[FURN_8999] Three-Seat Sofa",
            'quantity': 5,
            'priceUnit': 1500,
          }),
          Command.create({
            'label': "[FURN_8220] Four Person Desk",
            'quantity': 5,
            'priceUnit': 2350,
          })
        ],
      })
      await (await bill.withContext({ noNewInvoice: true })).messagePost({ attachmentIds: [attachment.id] });

      return this._actionListViewBill(bill.ids);
    }
    else {
      const emailAlias = f('%s@%s', await purchaseJournal.aliasName, await purchaseJournal.aliasDomain);
      const newWizard = await this.env.items('account.tour.upload.bill.email.confirm').create({ 'emailAlias': emailAlias });
      const viewId = (await this.env.ref('account.accountTourUploadBillEmailConfirm')).id;

      return {
        'type': 'ir.actions.actwindow',
        'label': await this._t('Confirm'),
        'viewMode': 'form',
        'resModel': 'account.tour.upload.bill.email.confirm',
        'target': 'new',
        'resId': newWizard.id,
        'views': [[viewId, 'form']],
      }
    }
  }
}

@MetaModel.define()
class AccountTourUploadBillEmailConfirm extends TransientModel {
  static _module = module;
  static _name = 'account.tour.upload.bill.email.confirm';
  static _description = 'Account tour upload bill email confirm';

  static emailAlias = Fields.Char({ readonly: true });

  async apply() {
    const purchaseJournal = await this.env.items('account.journal').search([['type', '=', 'purchase']], { limit: 1 });
    const billIds = (await this.env.items('account.move').search([['journalId', '=', purchaseJournal.id]])).ids;
    return this.env.items('account.tour.upload.bill')._actionListViewBill(billIds);
  }
}