import { Fields } from "../../../core";
import { MetaModel, Model, _super } from "../../../core/models";
import { urlEncode } from "../../../core/service/middleware/utils";
import { f } from "../../../core/tools";

@MetaModel.define()
class Partner extends Model {
  static _module = module;
  static _name = 'res.partner';
  static _parents = ['res.partner', 'website.published.multi.mixin'];

  static visitorIds = Fields.One2many('website.visitor', 'partnerId', { string: 'Visitors' });

  async googleMapImg(zoom = 8, width = 298, height = 298) {
    const googleMapsApiKey = await (await this.env.items('website').getCurrentWebsite()).googleMapsApiKey;
    if (!googleMapsApiKey) {
      return false;
    }
    const [street, city, zip, country] = await this('street', 'city', 'zip', 'countryId');
    const params = {
      'center': f('%s, %s %s, %s', street || '', city || '', zip || '', country.ok && await country.displayName || ''),
      'size': f("%sx%s", width, height),
      'zoom': zoom,
      'sensor': 'false',
      'key': googleMapsApiKey,
    }
    return '//maps.googleapis.com/maps/api/staticmap?' + urlEncode(params);
  }

  async googleMapLink(zoom = 10) {
    const [street, city, zip, country] = await this('street', 'city', 'zip', 'countryId');
    const params = {
      'q': f('%s, %s %s, %s', street || '', city || '', zip || '', country.ok && await country.displayName || ''),
      'z': zoom,
    }
    return 'https://maps.google.com/maps?' + urlEncode(params);
  }

  async _getName() {
    let name = await _super(Partner, this)._getName();
    if (this._context['displayWebsite'] && await (await this.env.user()).hasGroup('website.groupMultiWebsite')) {
      const website = await this['websiteId'];
      if (website.ok) {
        name += f(' [%s]', await website.label);
      }
    }
    return name;
  }

  async _computeDisplayName() {
    const self = await this.withContext({ displayWebsite: false });
    await _super(Partner, self)._computeDisplayName();
  }
}