import assert from 'assert';
import _ from 'lodash';
import { format } from 'util';
import { api } from '../../..';
import { OrderedDict } from '../../../helper';
import { AbstractModel, MetaModel, _super } from '../../../models';
import { urlQuote } from '../../../service/middleware/utils';
import { sha512 } from '../../../tools';
import { toText } from '../../../tools/compat';
import { markup } from '../../../tools/xml';

/**
 * Widget options:
  ``class``
      set as attribute on the generated <img> tag
 */
@MetaModel.define()
class Image extends AbstractModel {
    static _module = module;
    static _name = 'ir.qweb.field.image';
    static _description = 'Qweb Field Image';
    static _parents = 'ir.qweb.field.image';

    /**
     * Considering the rendering options, returns the src and data-zoom-image urls.

     * @param record 
     * @param fieldName 
     * @param options 
     */
    async _getSrcUrls(record, fieldName, options) {
        let maxSize;
        if (options['resize']) {
            maxSize = options['resize'];
        }
        else {
            const [maxWidth, maxHeight] = [options['maxWidth'] || 0, options['maxHeight'] || 0];
            if (maxWidth || maxHeight) {
                maxSize = format('%sx%s', maxWidth, maxHeight)
            }
        }
        const sha = sha512(String(await record['__lastUpdate'])).slice(0, 7);
        maxSize = maxSize == null ? '' : format('/%s', maxSize)

        let filename;
        if (options['filename-field'] && (await record[options['filename-field']] ?? null)) {
            filename = await record[options['filename-field']]
        }
        else if (options['filename'])
            filename = options['filename']
        else
            filename = await record.displayName
        filename = filename.replace('/', '-').replace('\\', '-').replace('..', '--')

        const src = format('/web/image/%s/%s/%s%s/%s?unique=%s', record._name, record.id, options['previewImage'] ?? fieldName, maxSize, urlQuote(filename), sha);
        // => "/web/image/website/1/logo/My%20Website?unique=f628998"
        let srcZoom;
        if (options['zoom'] && (await record[options['zoom']] ?? null)) {
            srcZoom = format('/web/image/%s/%s/%s%s/%s?unique=%s', record._name, record.id, options['zoom'], maxSize, urlQuote(filename), sha);
        }
        else if (options['zoom']) {
            srcZoom = options['zoom'];
        }

        return [src, srcZoom];
    }

    @api.model()
    async recordToHtml(record, fieldName, options) {
        assert(options['tagName'] !== 'img',
            `Oddly enough, the root tag of an image field can not be img. That is because the image goes into the tag, or it gets the hose again.`)

        if (options['qwebImgRawData'] ?? false) {
            return _super(Image, this).recordToHtml(record, fieldName, options);
        }
        let aclasses = options['qwebImgResponsive'] ?? true ? ['img', 'img-fluid'] : ['img']
        aclasses = aclasses.concat((options['class'] || '').replace('  ', ' ').split(' '))
        const classes = aclasses.map(e => _.escape(e)).join(' ')

        const [src, srcZoom] = await this._getSrcUrls(record, fieldName, options);

        let alt;
        if (options['alt-field'] && (await record[options['alt-field']] ?? null)) {
            alt = _.escape(await record[options['alt-field']]);
        }
        else if (options['alt']) {
            alt = options['alt'];
        }
        else {
            alt = _.escape(await record.displayName);
        }

        let itemprop;
        if (options['itemprop']) {
            itemprop = options['itemprop'];
        }

        let atts = new OrderedDict<any>();
        atts["src"] = src;
        atts["itemprop"] = itemprop;
        atts["class"] = classes;
        atts["style"] = options['style'];
        atts["alt"] = alt;
        atts["data-zoom"] = srcZoom && '1' || null;
        atts["data-zoom-image"] = srcZoom;
        atts["data-no-post-process"] = options['data-no-post-process'];

        atts = await this.env.items('ir.qweb')._postProcessingAttr('img', atts, options['templateOptions']);

        const img = ['<img'];
        for (const [name, value] of Object.entries(atts)) {
            if (value) {
                img.push(' ');
                img.push(_.escape(toText(name)));
                img.push('="');
                img.push(_.escape(toText(value)));
                img.push('"');
            }
        }
        img.push('/>');

        return markup(img.join(''));
    }
}

@MetaModel.define()
class ImageUrlConverter extends AbstractModel {
    static _module = module;
    static _description = 'Qweb Field Image';
    static _parents = 'ir.qweb.field.imageurl';

    async _getSrcUrls(record, fieldName, options) {
        const imageUrl = await record[options['previewImage'] ?? fieldName];
        return [imageUrl, options["zoom"] ?? null];
    }
}