import { UserError, ValueError } from "../helper/errors";

export class PdfStreamError extends UserError {}

export class PdfReadError extends UserError {}

export class zlibError extends UserError {}

const inch = 72.0;
const cm = inch / 2.54;
const mm = cm * 0.1;
const pica = 12.0
/**
 * convert a string to  a length
 * @param str 
 * @returns 
 */
export function toLength(str: string) {
  try {
    if (str.slice(-2) == 'cm') return parseFloat(str.slice(0, -2)) * cm;
    if (str.slice(-2) == 'in') return parseFloat(str.slice(0, -2)) * inch;
    if (str.slice(-2) == 'pt') return parseFloat(str.slice(0, -2));
    if (str.slice(-1) == 'i') return parseFloat(str.slice(0, -1)) * inch;
    if (str.slice(-2) == 'mm') return parseFloat(str.slice(0, -2)) * mm;
    if (str.slice(-4) == 'pica') return parseFloat(str.slice(0, -4)) * pica;
    return parseFloat(str);
  } catch (e) {
    throw new ValueError("Can't convert '%s' to length", str);
  }
}
/**
 * Add a banner on a PDF in the upper right corner, with Odoo's logo (optionally).
    @param stream (Buffer)    The PDF stream where the banner will be applied.
    @param text (string)              The text to be displayed.
    @param logo (bool)             Whether to display Odoo's logo in the banner.
    @param thickness (number)       The thickness of the banner in pixels.
    @returns (Buffer)              The modified PDF stream.
 */
export function addBanner(stream: any, text: any, opts: { logo?: boolean; thickness?: number }) {
  console.warn("Function not implemented.");
  return stream;
}