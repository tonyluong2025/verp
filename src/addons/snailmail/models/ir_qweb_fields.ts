import { api } from "../../../core";
import { AbstractModel, MetaModel, _super } from "../../../core/models";

@MetaModel.define()
class Contact extends AbstractModel {
    static _module = module;
    static _parents = 'ir.qweb.field.contact';

    @api.model()
    async valueToHtml(value, options) {
        if (this.env.context['snailmailLayout']) {
           value = await value.withContext({snailmailLayout: this.env.context['snailmailLayout']});
        }
        return _super(Contact, this).valueToHtml(value, options);
    }

    @api.model()
    async recordToHtml(record, fieldName, options) {
        if (this.env.context['snailmailLayout']) {
           record = await record.withContext({snailmailLayout: this.env.context['snailmailLayout']});
        }
        return _super(Contact, this).recordToHtml(record, fieldName, options);
    }
}