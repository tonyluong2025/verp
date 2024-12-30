import { api } from "../../../core";
import { Fields } from "../../../core/fields";
import { MetaModel, Model } from "../../../core/models";
import { formataddr } from "../../../core/tools/mail";
import { f } from "../../../core/tools/utils";

@MetaModel.define()
class Company extends Model {
  static _module = module;
  static _name = 'res.company';
  static _parents = 'res.company';

  static catchallEmail = Fields.Char({string: "Catchall Email", compute: "_computeCatchall"});
  static catchallFormatted = Fields.Char({string: "Catchall", compute: "_computeCatchall"});
  static emailFormatted = Fields.Char({string: "Formatted Email", compute: "_computeEmailFormatted"});

  @api.depends('label')
  async _computeCatchall() {
    const ConfigParameter = await this.env.items('ir.config.parameter').sudo();
    const alias = await ConfigParameter.getParam('mail.catchall.alias');
    const domain = await ConfigParameter.getParam('mail.catchall.domain');
    if (alias && domain) {
      for (const company of this) {
        const catchallEmail = f('%s@%s', alias, domain);
        await company.set('catchallEmail', catchallEmail);
        await company.set('catchallFormatted', formataddr([await company.label, catchallEmail]));
      }
    }
    else {
      for (const company of this) {
        await company.set('catchallEmail', '')
        await company.set('catchallFormatted', '');
      }
    }
  }

  @api.depends('partnerId.emailFormatted', 'catchallFormatted')
  async _computeEmailFormatted() {
    for (const company of this) {
      const [partnerId, catchallFormatted] = await company('partnerId', 'catchallFormatted');
      const emailFormatted = await partnerId.emailFormatted;
      if (emailFormatted) {
        await company.set('emailFormatted', emailFormatted);
      }
      else if (catchallFormatted) {
        await company.set('emailFormatted', catchallFormatted);
      }
      else {
        await company.set('emailFormatted', '');
      }
    }
  }
}