import { AbstractModel, MetaModel, _super } from "../../../core/models";

@MetaModel.define()
class MailThread extends AbstractModel {
  static _module = module;
  static _parents = 'mail.thread';

  async messagePostWithView(viewsOrXmlid, opts: {} = {}) {
    await _super(MailThread, await this.withContext({ inheritBranding: false })).messagePostWithView(viewsOrXmlid, opts);
  }
}