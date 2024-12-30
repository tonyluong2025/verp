import { v1 as uuidv1 } from 'uuid';
import { tools } from "../..";
import { ValidationError } from "../../helper/errors";
import { escapeRegExp, isInstance } from "../../tools/func";
import { len } from "../../tools/iterable";
import { f } from "../../tools/utils";
import { _fastUrlQuote } from "./utils";
import { Router } from "./router";

export class BaseConverter {
  regex: RegExp = /[^\/]+/;
  weight = 100;
  route: Router;
  router: Router;

  constructor(route: Router, ...args: any) {
    this.router = route;
  }

  async toPrimary(req, value) {
    return value;
  }

  async toUrl(value) {
    if (isInstance(value, Uint8Array)) {
      return _fastUrlQuote(value);
    }
    let encoder = new TextEncoder();
    return _fastUrlQuote(Buffer.from(encoder.encode(value)));
  }
}

/**
 * This converter is the default converter and accepts any string but
    only one path segment.  Thus the string can not include a slash.

    This is the default validator.

    Example::

        new Rule('/pages/<page>'),
        new Rule('/<string(length=2):lang_code>')

    @param route the class `Route`.
    @param minlength the minimum length of the string.  Must be greater
                      or equal 1.
    @param maxlength the maximum length of the string.
    @param length the exact length of the string.
 */
export class UnicodeConverter extends BaseConverter {
  constructor(route: Router, minlength = 1, maxlength?: any, length?: any) {
    super(route);
    if (length != null) {
      length = f("{%s}", tools.parseInt(length));
    }
    else {
      if (maxlength == null) {
        maxlength = "";
      }
      else {
        maxlength = tools.parseInt(maxlength);
      }
      length = f("{%s,%s}", tools.parseInt(minlength), maxlength);
    }
    this.regex = new RegExp("[^\\/]" + length);
  }
}

/**
 * Matches one of the items provided.  Items can either be Javascript
    identifiers or strings::

        new Rule('/<any(about, help, imprint, class, "foo,bar"):pageName>')

    @param route the class `Route`.
    @param items this function accepts the possible items as positional
                  arguments.
 */
export class AnyConverter extends BaseConverter {
  constructor(route, ...items: any[]) {
    super(route);
    this.regex = new RegExp(f("(?:%s)", items.map(x => escapeRegExp(x)).join('|')));
  }
}

/**
 * Like the default class `UnicodeConverter`, but it also matches
    slashes.  This is useful for wikis and similar applications::

        new Rule('/<path:wikipage>')
        new Rule('/<path:wikipage>/edit')

    @param route the class `Route`.
 */
export class PathConverter extends BaseConverter {
  regex = /[^\/].*?/;
  weight = 200;
}

/**
 * Baseclass for `IntegerConverter` and `FloatConverter`.
 */
export class NumberConverter extends BaseConverter {
  weight = 50
  fixedDigits: number;
  min: number;
  max: number;
  signed: boolean;
  numConvert: Function;

  constructor(route: Router, fixedDigits = 0, min?: any, max?: any, signed = false) {
    super(route);
    if (signed) {
      this.regex = this.signedRegex;
    }
    this.fixedDigits = fixedDigits;
    this.min = min;
    this.max = max;
    this.signed = signed;
  }

  async toPrimary(req, value) {
    if (this.fixedDigits && len(value) !== this.fixedDigits) {
      throw new ValidationError();
    }
    value = this.numConvert(value);
    if ((this.min != null && value < this.min) ||
      (this.max != null && value > this.max)) {
      throw new ValidationError();
    }
    return value;
  }

  async toUrl(value) {
    value = this.numConvert(value);
    if (this.fixedDigits) {
      value = String(value).padStart(this.fixedDigits, '0');
    } else {
      value = String(value);
    }
    return value;
  }

  get signedRegex() {
    return new RegExp("-?" + this.regex.source);
  }
}

/**
 * This converter only accepts integer values::

        new Rule("/page/<int:page>")

    By default it only accepts unsigned, positive values. The ``signed``
    parameter will enable signed, negative values.

        new Rule("/page/<int(signed=true):page>")

    @param route The class `Route`.
    @param fixedDigits The number of fixed digits in the URL. If you
        set this to ``4`` for example, the rule will only match if the
        URL looks like ``/0001/``. The default is variable length.
    @param min The minimal value.
    @param max The maximal value.
    @param signed Allow signed (negative) values.
 */
export class IntegerConverter extends NumberConverter {
  regex = /\d+/;
  numConvert = tools.parseInt;
}

/**
 * This converter only accepts floating point values::

        new Rule("/probability/<float:probability>")

    By default it only accepts unsigned, positive values. The ``signed``
    parameter will enable signed, negative values.

        new Rule("/offset/<float(signed=true):offset>")

    @param route The class `Route`
    @param min The minimal value
    @param max The maximal value
    @param signed Allow signed (negative) values
 */
export class FloatConverter extends NumberConverter {
  regex = /\d+.\d+"/;
  numConvert = tools.parseFloat;

  constructor(route: Router, fixedDigits, min?: any, max?: any, signed = false) {
    super(route, fixedDigits, min, max, signed);
  }
}

/**
 * This converter only accepts UUID strings

        new Rule('/object/<uuid:identifier>')

    @param route the class `Route`.
 */
export class UUIDConverter extends BaseConverter {
  regex = /[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}/;

  async toPrimary(req, value) {
    return uuidv1(value);
  }

  async toUrl(value) {
    return String(value);
  }
}
