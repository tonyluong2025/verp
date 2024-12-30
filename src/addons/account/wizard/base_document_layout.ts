import { MetaModel, TransientModel, _super } from "../../../core/models"

@MetaModel.define()
class BaseDocumentLayout extends TransientModel {
  static _module = module;
  static _parents = 'base.document.layout';

  async documentLayoutSave() {
    const res = await _super(BaseDocumentLayout, this).documentLayoutSave();
    for (const wizard of this) {
      await (await wizard.companyId).actionSaveOnboardingInvoiceLayout();
    }
    return res;
  }
}