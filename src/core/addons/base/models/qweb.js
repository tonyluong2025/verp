import assert from 'assert';
import _ from "lodash";
import { format } from 'util';
import { XmlError } from "../../../helper/errors";
import { AbstractModel } from '../../../models';
import { enumerate } from "../../../tools/iterable";

export class QWebException extends XmlError {
  constructor(message, qweb, options, error, kw = {}) {
    super();
    console.debug(message, kw.template, error.stack);
  }
}

export class QWebCodeFound extends XmlError { };

export class QWeb extends AbstractModel {}

const _whitespaceOnlyRe = /^[ \t]+$/gm;
const _leadingWhitespaceRe = /(^[ \t]*)(?:[^ \t\n])/gm;

/**
 * Remove any common leading whitespace from every line in `text`.

  This can be used to make triple-quoted strings line up with the left
  edge of the display, while still presenting them in the source code
  in indented form.

  Note that tabs and spaces are both treated as whitespace, but they
  are not equal: the lines "  hello" and "\\thello" are
  considered to have no common leading whitespace.

  Entirely blank lines are normalized to a newline character.
 * @param text 
 * @returns 
 */
export function dedent(text) {
  // Look for the longest leading str of spaces and tabs common to
  // all lines.
  let margin;
  text = text.replace(_whitespaceOnlyRe, '');
  const indents = text.matchAll(_leadingWhitespaceRe)
  for (const res of indents) {
    const indent = res[1];
    if (margin == null)
      margin = indent;

    // Current line more deeply indented than previous winner:
    // no change (previous winner is still on top).
    else if (indent.startsWith(margin)) {
    }

    // Current line consistent with and no deeper than previous winner:
    // it's the new winner.
    else if (margin.startsWith(indent)) {
      margin = indent;
    }

    // Find the largest common whitespace between current line and previous winner.
    else {
      for (const [i, [x, y]] of enumerate(_.zip(margin, indent))) {
        if (x !== y) {
          margin = margin.slice(0, i);
          break;
        }
      }
    }
  }

  // sanity check (testing/debugging only)
  if (0 && margin) {
    for (const line of text.split("\n")) {
      assert(!line || line.startsWith(margin), format("line = %s, margin = %s", line, margin));
    }
  }

  if (margin) {
    margin = '(?<m>)^' + margin;
    text = text.replace(new RegExp(margin, 'gm'), '');
  }
  return text;
}