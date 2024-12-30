import { OrderedDict } from "../../../core/helper";
import { UserError, ValueError } from "../../../core/helper/errors";
import { MetaModel, Model, _super } from "../../../core/models";
import { PdfReadError, PdfStreamError, addBanner, isInstance, zlibError } from "../../../core/tools";
import { bool } from "../../../core/tools/bool";
import { update } from "../../../core/tools/misc";

@MetaModel.define()
class IrActionsReport extends Model {
  static _module = module;
  static _parents = 'ir.actions.report';

  async retrieveAttachment(record) {
    // get the original bills through the message_main_attachment_id field of the record
    const messageMainAttachmentId = await record.messageMainAttachmentId;
    if (await this['reportName'] === 'account.reportOriginalVendorBill' && bool(messageMainAttachmentId)) {
      const mimetype = await messageMainAttachmentId.mimetype;
      if (mimetype === 'application/pdf' || mimetype.startsWith('image')) {
        return messageMainAttachmentId;
      }
    }
    return _super(IrActionsReport, this).retrieveAttachment(record);
  }

  async _postPdf(saveInAttachment: OrderedDict<Buffer>, pdfContent?: any, resIds?: any) {
    // don't include the generated dummy report
    if (await this['reportName'] === 'account.reportOriginalVendorBill') {
      pdfContent = null;
      resIds = null
      if (!bool(saveInAttachment)) {
        throw new UserError(await this._t("No original vendor bills could be found for any of the selected vendor bills."));
      }
    }
    return _super(IrActionsReport, this)._postPdf(saveInAttachment, pdfContent, resIds);
  }

  async _postprocessPdfReport(record, buffer) {
    // don't save the 'account.report_original_vendor_bill' report as it's just a mean to print existing attachments
    if (await this['reportName'] === 'account.reportOriginalVendorBill') {
      return null;
    }
    const res = await _super(IrActionsReport, this)._postprocessPdfReport(record, buffer);
    if (await this['model'] === 'account.move' && await record.state === 'posted' && await record.isSaleDocument(true)) {
      const attachment = await this.retrieveAttachment(record);
      if (bool(attachment)) {
        await attachment.registerAsMainAttachment(false);
      }
    }
    return res;
  }

  async _renderQwebPdf(resIds?: any, data?: any) {
    // Overridden so that the print > invoices actions raises an error
    // when trying to print a miscellaneous operation instead of an invoice.
    // + append context data with the displayNameInFooter parameter
    if (await this['model'] === 'account.move' && bool(resIds)) {
      const invoiceReports = [await this.env.ref('account.accountInvoicesWithoutPayment'), await this.env.ref('account.accountInvoices')];
      if (invoiceReports.some(report => report.eq(this))) {
        if (await (await this.env.items('ir.config.parameter').sudo()).getParam('account.displayNameInFooter')) {
          data = bool(data) ? Object.assign({}, data) : {};
          update(data, { 'displayNameInFooter': true });
        }
        const moves = this.env.items('account.move').browse(resIds);
        if (await moves.some(async (move) => ! await move.isInvoice(true))) {
          throw new UserError(await this._t("Only invoices could be printed."));
        }
      }
    }

    return _super(IrActionsReport, this)._renderQwebPdf(resIds, data);
  }

  async _retrieveStreamFromAttachment(attachment) {
    // Overridden in order to add a banner in the upper right corner of the exported Vendor Bill PDF.
    const stream = await _super(IrActionsReport, this)._retrieveStreamFromAttachment(attachment);
    const vendorBillExport = await this.env.ref('account.actionAccountOriginalVendorBill');
    if (this.eq(vendorBillExport) && await attachment.mimetype === 'application/pdf') {
      const record = this.env.items(await attachment.resModel).browse(await attachment.resId);
      try {
        return addBanner(stream, await record.label, { logo: true });
      } catch (e) {
        if (isInstance(e, ValueError, PdfStreamError, PdfReadError, TypeError, zlibError)) {
          await record._messageLog({
            body: await this._t(
              `There was an error when trying to add the banner to the original PDF.\n
                    Please make sure the source file is valid.`
            )
          })
        } else {
          throw e;
        }
      }
    }
    return stream;
  }
}
