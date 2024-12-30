import { DateTime } from "luxon";
import { urlEncode, urlQuote } from "../service/middleware/utils";
import { len, sum } from "./iterable";
import { hasattr } from "../api/func";
import { safeEval, unsafeAsync } from "./save_eval";
import { format } from "util";
import { markup } from "./xml";

export const templateEnvGlobals = {
  'format': format,
  'f': format,
  'str': String,
  'quote': urlQuote,
  'urlencode': urlEncode,
  'datetime': DateTime,
  'len': len,
  'abs': Math.abs,
  'min': Math.min,
  'max': Math.max,
  'sum': sum,
  'filter': Array.prototype.filter,
  'reduce': Array.prototype.reduce,
  'map': Array.prototype.map,
  'round': Math.round,
  'hasattr': hasattr,
}

const INLINE_TEMPLATE_REGEX = /\{\{(.+?)\}\}/g;
/** Render string format "{{ ... }}"*/
export function parseInlineTemplate(text) {
  const groups = [];
  let currentLiteralIndex = 0;
  for (const match of text.matchAll(INLINE_TEMPLATE_REGEX)) {
    const literal = text.slice(currentLiteralIndex, match.index);
    const str = match[0];
    const expression = match[1];
    groups.push([literal, expression]);
    currentLiteralIndex = match.index + str.length;
  }

  // string past last regex match
  const literal = text.slice(currentLiteralIndex);
  if (literal) {
    groups.push([literal, '']);
  }

  return groups;
}

export function convertInlineTemplateToQweb(template) {
  const templateInstructions = parseInlineTemplate(template || '');
  const previewMarkup = [];
  for (const [string, expression] of templateInstructions) {
    if (expression) {
      previewMarkup.push(markup(`${string}<t t-out="${expression}"/>`));
    }
    else {
      previewMarkup.push(string);
    }
  }
  return previewMarkup.join(markup(''));
}

export async function renderInlineTemplate(templateInstructions, variables) {
  const results = [];
  for (const [str, expression] of templateInstructions) {
    results.push(str);

    if (expression) {
      const result = await unsafeAsync(expression, variables);
      if (result) {
        results.push(String(result));
      }
    }
  }
  return results.join('');
}