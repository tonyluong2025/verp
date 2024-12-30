import { TextDecoder } from "util";
import { isInstance } from "./func";
import { stringify } from "./json";

/**
 *  Generates a text value (an instance of textType) from an arbitrary
    source.
    * false and null are converted to empty strings
    * text is passed through
    * bytes are decoded as UTF-8
    * rest is textified via the current version's relevant data model method
 * @param source 
 * @returns 
 */
export function toText(source) {
  if (source == null || source === false)
    return '';

  if (isInstance(source, Uint8Array))
    return (new TextDecoder('utf-8')).decode(source);

  if (typeof source === 'string')
    return source;

  return stringify(source);
}