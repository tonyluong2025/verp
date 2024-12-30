import xpath from 'xpath';
import { api } from "../../../core";
import { _super, AbstractModel, MetaModel } from "../../../core/models"
import { urlParse } from '../../../core/service/middleware/utils';

@MetaModel.define()
class Image extends AbstractModel {
    static _module = module;
    static _parents = 'ir.qweb.field.image';

    @api.model()
    async fromHtml(model, field, element) {
        if (!xpath.select1('.//img', element)) {
            return false;
        }
        const url = (xpath.select1('.//img', element) as Element).getAttribute('src');
        const urlObject = urlParse(url);

        if (urlObject.pathname.startsWith('/unsplash/')) {
            let resId = element.getAttribute('data-oe-id');
            if (resId) {
                resId = parseInt(resId);
                const resModel = model._name;
                const attachment = await this.env.items('ir.attachment').search([
                    '&', '|', '&',
                    ['resModel', '=', resModel],
                    ['resId', '=', resId],
                    ['isPublic', '=', true],
                    ['url', '=', urlObject.pathname],
                ], {limit: 1});
                return attachment.datas;
            }
        }
        return _super(Image, this).fromHtml(model, field, element);
    }
}
