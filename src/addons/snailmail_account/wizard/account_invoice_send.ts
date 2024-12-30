import { Command, Fields, api } from "../../../core";
import { UserError } from "../../../core/helper/errors";
import { MetaModel, TransientModel, _super } from "../../../core/models";
import { bool, len } from "../../../core/tools";

@MetaModel.define()
class AccountInvoiceSend extends TransientModel {
  static _module = module;
  static _name = 'account.invoice.send';
  static _parents = 'account.invoice.send';
  static _description = 'Account Invoice Send';

  static partnerId = Fields.Many2one('res.partner', { compute: '_get_partner', string: 'Partner' });
  static snailmailIsLetter = Fields.Boolean('Send by Post',
    {
      help: 'Allows to send the document by Snailmail (conventional posting delivery service)',
      default: async (self) => (await self.env.company()).invoiceIsSnailmail
    });
  static snailmailCost = Fields.Float({ string: 'Stamp(s)', compute: '_computeSnailmailCost', readonly: true });
  static invalidAddresses = Fields.Integer('Invalid Addresses Count', { compute: '_computeInvalidAddresses' });
  static invalidInvoices = Fields.Integer('Invalid Invoices Count', { compute: '_computeInvalidAddresses' });
  static invalidPartnerIds = Fields.Many2many('res.partner', { string: 'Invalid Addresses', compute: '_computeInvalidAddresses' });

  @api.depends('invoiceIds')
  async _computeInvalidAddresses() {
    for (const wizard of this) {
      const invoiceIds = await wizard.invoiceIds;
      if (await invoiceIds.some(async (invoice) => !bool(await invoice.partnerId))) {
        throw new UserError(await this._t('You cannot send an invoice which has no partner assigned.'));
      }
      const invalidInvoices = await invoiceIds.filtered(async (i) => ! await this.env.items('snailmail.letter')._isValidAddress(await i.partnerId));
      await wizard.set('invalidInvoices', len(invalidInvoices));
      const invalidPartnerIds = (await invalidInvoices.partnerId).ids;
      await wizard.set('invalidAddresses', len(invalidPartnerIds));
      await wizard.set('invalidPartnerIds', [Command.set(invalidPartnerIds)]);
    }
  }

  @api.depends('invoiceIds')
  async _getPartner() {
    await this.set('partnerId', this.env.items('res.partner'));
    for (const wizard of this) {
      const invoiceIds = await wizard.invoiceIds;
      if (invoiceIds.ok && len(invoiceIds) == 1) {
        await wizard.set('partnerId', (await invoiceIds.partnerId).id);
      }
    }
  }

  @api.depends('snailmailIsLetter')
  async _computeSnailmailCost() {
    for (const wizard of this) {
      await wizard.set('snailmailCost', len((await wizard.invoiceIds).ids));
    }
  }

  async snailmailPrintAction() {
    this.ensureOne();
    let letters = this.env.items('snailmail.letter');
    const invoiceIds = await this['invoiceIds'];
    for (const invoice of invoiceIds) {
      const letter = await this.env.items('snailmail.letter').create({
        'partnerId': (await invoice.partnerId).id,
        'model': 'account.move',
        'resId': invoice.id,
        'userId': (await this.env.user()).id,
        'companyId': (await invoice.companyId).id,
        'reportTemplate': (await this.env.ref('account.accountInvoices')).id
      });
      letters = letters.or(letter);
    }

    await (await invoiceIds.filtered(async (inv) => ! await inv.isMoveSent)).write({ 'isMoveSent': true });
    if (len(invoiceIds) == 1) {
      await letters._snailmailPrint();
    }
    else {
      await letters._snailmailPrint(false);
    }
  }

  async sendAndPrintAction() {
    if (await this['snailmailIsLetter']) {
      if (await this.env.items('snailmail.confirm.invoice').showWarning()) {
        const wizard = await this.env.items('snailmail.confirm.invoice').create({ 'modelName': await this._t('Invoice'), 'invoiceSendId': this.id });
        return wizard.actionOpen();
      }
      this._printAction();
    }
    return this.sendAndPrint();
  }

  async _printAction() {
    if (! await this['snailmailIsLetter']) {
      return;
    }

    if (await this['invalidAddresses'] && await this['compositionMode'] === "massMail") {
      this.notifyInvalidAddresses();
    }
    this.snailmailPrintAction();
  }

  async sendAndPrint() {
    const res = await _super(AccountInvoiceSend, this).sendAndPrintAction();
    return res;
  }

  async notifyInvalidAddresses() {
    this.ensureOne();
    await this.env.items('bus.bus')._sendone(await (await this.env.user()).partnerId, 'snailmailInvalidAddress', {
      'title': await this._t("Invalid Addresses"),
      'message': await this._t("%s of the selected invoice(s) had an invalid address and were not sent", await this['invalidInvoices']),
    });
  }

  async invalidAddressesAction() {
    return {
      'label': await this._t('Invalid Addresses'),
      'type': 'ir.actions.actwindow',
      'viewMode': 'kanban,tree,form',
      'resModel': 'res.partner',
      'domain': [['id', 'in', (await this['invalidPartnerIds']).ids]],
    }
  }
}