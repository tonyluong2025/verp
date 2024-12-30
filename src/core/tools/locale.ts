import { ValueError } from "../helper/errors";
import { isAlpha, isDigit } from "./func";
import { len } from "./iterable";

export const LOCALE_ALIASES = {
  'ar': 'ar_SY', 'bg': 'bg_BG', 'bs': 'bs_BA', 'ca': 'ca_ES', 'cs': 'cs_CZ',
  'da': 'da_DK', 'de': 'de_DE', 'el': 'el_GR', 'en': 'en_US', 'es': 'es_ES',
  'et': 'et_EE', 'fa': 'fa_IR', 'fi': 'fi_FI', 'fr': 'fr_FR', 'gl': 'gl_ES',
  'he': 'he_IL', 'hu': 'hu_HU', 'id': 'id_ID', 'is': 'is_IS', 'it': 'it_IT',
  'ja': 'ja_JP', 'km': 'km_KH', 'ko': 'ko_KR', 'lt': 'lt_LT', 'lv': 'lv_LV',
  'mk': 'mk_MK', 'nl': 'nl_NL', 'nn': 'nn_NO', 'no': 'nb_NO', 'pl': 'pl_PL',
  'pt': 'pt_PT', 'ro': 'ro_RO', 'ru': 'ru_RU', 'sk': 'sk_SK', 'sl': 'sl_SI',
  'sv': 'sv_SE', 'th': 'th_TH', 'tr': 'tr_TR', 'uk': 'uk_UA', 'vi': 'vi_VN',
}

/**
 * Parse a locale identifier into a tuple of the form ``[language,
    region, script, variant]``.

    >>> parseLocale('zh_CN')
    ['zh', 'CN', undefined, undefined]
    >>> parse_locale('zh_Hans_CN')
    ['zh', 'CN', 'Hans', undefined]

    The default component separator is "_", but a different separator can be
    specified using the `sep` parameter:

    >>> parseLocale('zh-CN', '-')
    ['zh', 'CN', undefined, undefined]

    If the identifier cannot be parsed into a locale, a `ValueError` exception
    is raised:

    >>> parseLocale('not_a_LOCALE_String')
    Traceback (most recent call last):
      ...
    ValueError: 'not_a_LOCALE_String' is not a valid locale identifier

    Encoding information and locale modifiers are removed from the identifier:

    >>> parseLocale('it_IT@euro')
    ['it', 'IT', undefined, undefined]
    >>> parseLocale('en_US.UTF-8')
    ['en', 'US', undefined, undefined]
    >>> parseLocale('de_DE.iso885915@euro')
    ['de', 'DE', undefined, undefined]

    See :rfc:`4646` for more information.

    :param identifier: the locale identifier string
    :param sep: character that separates the different components of the locale
                identifier
    :raise `ValueError`: if the string does not appear to be a valid locale
                         identifier
 * @param identifier 
 * @param sep 
 * @returns 
 */
export function parseLocale(identifier: string, sep='_') {
  if (identifier.includes('.'))
    // this is probably the charset/encoding, which we don't care about
    identifier = identifier.split('.')[0]
  if (identifier.includes('@'))
    // this is a locale modifier such as @euro, which we don't care about either
    identifier = identifier.split('@')[0]

  let parts = identifier.split(sep) || [];
  const lang = parts.shift().toLowerCase();
  if (!isAlpha(lang))
    throw new ValueError('expected only letters, got %s', lang);

  let script, region, variant;
  if (parts.length)
    if (len(parts[0]) == 4 && isAlpha(parts[0]))
      script = parts.shift();

  if (parts.length)
    if (len(parts[0]) == 2 && isAlpha(parts[0]))
      region = parts.shift().toUpperCase();
    else if (len(parts[0]) == 3 && isDigit(parts[0]))
      region = parts.shift();

  if (parts.length)
    if (len(parts[0]) == 4 && isDigit(parts[0][0]) || 
        len(parts[0]) >= 5 && isAlpha(parts[0][0]))
        variant = parts.pop();

  if (parts.length)
    throw new ValueError('%s is not a valid locale identifier', identifier);

  return [lang, region, script, variant];
}