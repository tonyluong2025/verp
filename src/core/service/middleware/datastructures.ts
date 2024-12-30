import { Dict, FrozenSet } from "../../helper/collections";
import { iter } from "../../tools/iterable";
import { generateEtag, httpDate, quoteEtag, unquoteEtag } from "./utils";

/**
 * Very simple object that represents the `If-Range` header in parsed
    form.  It will either have neither a etag or date or one of either but
    never both.
 */
export class IfRange {
  etag: any;
  date: Date;
  constructor(options?: {etag?: string, date?: Date}) {
    // The etag parsed and unquoted.  Ranges always operate on strong
    // etags so the weakness information is not necessary.
    this.etag = options.etag;
    // The date in parsed format or `None`.
    this.date = options.date;
  }

  /**
   * Converts the object back into an HTTP header.
   * @returns 
   */
  toHeader() {
    if (this.date != null) {
      return httpDate(this.date);
    }
    if (this.etag != null) {
      return quoteEtag(this.etag);
    }
    return "";
  }

  toString() {
    return this.toHeader();
  }

  print() {
    return `<${this.constructor.name} ${this}>`;
  }
}

export class ETags extends Function {
  _strong: FrozenSet<any>;
  _weak: FrozenSet<any>;
  starTag: boolean;

  constructor(strongEtags?: any, weakEtags?: any, starTag=false) {
    super();
    this._strong = new FrozenSet(!starTag && strongEtags || []);
    this._weak = new FrozenSet(weakEtags || []);
    this.starTag = starTag;

    return new Proxy(this, {
      apply(target, thisArg, args: any[]=[]) {
        return target.__call__(...args);
      },
    });
  }
  
  /**
   * Convert the `ETags` object into a set.  Per default all the
      weak etags are not part of this set.
   * @param includeWeak 
   * @returns 
   */
  asSet(includeWeak=false) {
    const rv = new Set(this._strong);
    if (includeWeak) {
      this._weak.forEach(e => rv.add(e));
    }
    return rv;
  }

  isWeak(etag) {
    return this._weak.has(etag);
  }

  isStrong(etag) {
    return this._strong.has(etag);
  }

  containsWeak(etag) {
    return this.isWeak(etag) || this.contains(etag);
  }

  /**
   * Check if an etag is part of the set ignoring weak tags.
      It is also possible to use the ``in`` operator.
   * @param etag 
   * @returns 
   */
  contains(etag) {
    if (this.starTag) {
      return true;
    }
    return this.isStrong(etag);
  }

  /**
   * When passed a quoted tag it will check if this tag is part of the set. If the tag is weak it is checked against weak and strong tags, otherwise strong only.
   * @param etag 
   * @returns 
   */
  containsRaw(etag) {
    let weak;
    [etag, weak] = unquoteEtag(etag);
    if (weak) {
      return this.containsWeak(etag);
    }
    return this.contains(etag);
  }

  /**
   * Convert the etags set into a HTTP header string.
   * @returns 
   */
  toHeader() {
    if (this.starTag) {
        return "*";
    }
    return Array.from(this._strong).map(x => `"${x}"`).concat(Array.from(this._weak).map(x => `W/"${x}"`)).join(', ');
  }

  __call__(etag?: any, data?: any, includeWeak=false) {
    if (!(etag == null !== data == null)) {
      throw new TypeError("either tag or data required, but at least one");
    }
    if (etag == null) {
      etag = generateEtag(data);
    }
    if (includeWeak) {
      if (this._weak.has(etag)) {
        return true;
      }
    }
    return this._strong.has(etag);
  }

  _bool() {
    return this.starTag || this._strong.size || this._weak.size;
  }

  toString() {
    return this.toHeader();
  }

  *[Symbol.iterator]() {
    return iter(this._strong);
  }

  print(this) {
    return `<${this.constructor.name} ${this}>`;
  }
}

export class Headers extends Dict<any>{}