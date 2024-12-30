import fs from "fs";
import { ValueError } from "../../core/helper";

export class GeoIPResolver {
  fname: string;
  _db: any;
  version: number;

    constructor(fname: string) {
        this.fname = fname;
        try {
            this._db = geoip2.database.Reader(fname)
            this.version = 2
        } catch(e) {
            throw new ValueError('Invalid GeoIP database: %s', fname);
        }
    }

    delete() {
        if (this.version == 2) {
            this._db.close();
        }
    }

    static open(fname) {
        if (! geoip2) {
            return null;
        }
        if (! fs.exists(fname)) {
            return null;
        }
        return new GeoIPResolver(fname);
    }

    resolve(ip) {
        if self.version == 1:
            return self._db.record_by_addr(ip) or {}
        elif self.version == 2:
            try:
                r = self._db.city(ip)
            except (ValueError, geoip2.errors.AddressNotFoundError):
                return {}
            # Compatibility with Legacy database.
            # Some ips cannot be located to a specific country. Legacy DB used to locate them in
            # continent instead of country. Do the same to not change behavior of existing code.
            country, attr = (r.country, 'iso_code') if r.country.geoname_id else (r.continent, 'code')
            return {
                'city': r.city.name,
                'country_code': getattr(country, attr),
                'country_name': country.name,
                'latitude': r.location.latitude,
                'longitude': r.location.longitude,
                'region': r.subdivisions[0].iso_code if r.subdivisions else None,
                'time_zone': r.location.time_zone,
            }
    }
    // compat
    recordByAddr(addr) {
        return this.resolve(addr);
    }
}