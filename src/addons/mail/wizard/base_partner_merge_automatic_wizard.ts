import { MetaModel, TransientModel, _super } from "../../../core/models";
import { f } from "../../../core/tools";

@MetaModel.define()
class MergePartnerAutomatic extends TransientModel {
  static _module = module;
  static _parents = 'base.partner.merge.automatic.wizard';

  async _logMergeOperation(srcPartners, dstPartner) {
    await _super(MergePartnerAutomatic, this)._logMergeOperation(srcPartners, dstPartner);
    const msg = [];
    for (const p of srcPartners) {
      msg.push(f('%s <%s> (ID %s)', await p.label, await p.email ?? 'n/a', p.id));
    }
    await dstPartner.messagePost(f('%s %s', await this._t("Merged with the following partners:"), msg.join(', ')));
  }
}
