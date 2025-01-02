import _ from "lodash";
import sharp from "sharp";
import { format } from "util";
import { UserError, ValueError } from "../helper/errors";
import { bool } from "./bool";
import { range } from "./iterable";
import { setOptions, sha512 } from "./misc";
import { randrange } from "./utils";

// Arbitrary limit to fit most resolutions, including Samsung Galaxy A22 photo, 8K with a ratio up to 16:10, and almost all variants of 4320p
const IMAGE_MAX_RESOLUTION = 50e6;
const EXIF_TAG_ORIENTATION = 0x112
// The target is to have 1st row/col to be top/left
// Note: rotate is counterclockwise
const FLIP_LEFT_RIGHT = 0
const FLIP_TOP_BOTTOM = 1
const ROTATE_90 = 2
const ROTATE_180 = 3
const ROTATE_270 = 4
const TRANSPOSE = 5
const TRANSVERSE = 6

const FILETYPE_BASE64_MAGICWORD = {
  '/': 'jpg',
  'R': 'gif',
  'i': 'png',
  'P': 'svg+xml',
}

const EXIF_TAG_ORIENTATION_TO_TRANSPOSE_METHODS = { // Initial side on 1st row/col:
  0: [],                              // reserved
  1: [],                              // top/left
  2: [FLIP_LEFT_RIGHT],               // top/right
  3: [ROTATE_180],                    // bottom/right
  4: [FLIP_TOP_BOTTOM],               // bottom/left
  5: [FLIP_LEFT_RIGHT, ROTATE_90],    // left/top
  6: [ROTATE_270],                    // right/top
  7: [FLIP_TOP_BOTTOM, ROTATE_90],    // right/bottom
  8: [ROTATE_90],                     // left/bottom
}

export class ImageProcess {
  base64Source: any;
  operationsCount: number;
  image: sharp.Sharp;
  originalFormat: string;
  verifyResolution: boolean;

  private constructor() { }

  static async new(base64Source: any, verifyResolution: boolean = true) {
    try {
      const obj = new ImageProcess();
      obj.base64Source = base64Source ?? false;
      obj.operationsCount = 0;
      obj.verifyResolution = verifyResolution;

      if (!base64Source || base64Source[0] === 'P' || base64Source[0] === 'P'.charCodeAt(0)) {
        // don't process empty source or SVG  
        // string: "<svg" [60 115 118 103]
        // base64: "PHN2Zw=="
        // Buffer: [50 48 4e 32 5a 77 3d 3d]x # [80 72 78 50 90 121 66 111]d
        obj.image = null;
      } else {
        const image = base64ToImage(base64Source);
        /**
          metadata = {
            orientation: 0,
            format: 'svg',
            size: 313, //bytes
            width: 100, //pixels
            height: 100, //pixels
            space: 'srgb',
            channels: 4,
            depth: 'uchar', 
            density: 72, //dpi: pixels per inch
            isProgressive: false,
            hasProfile: false,
            hasAlpha: true,
            ...
          }
        */
        const meta = await image.metadata();
        obj.originalFormat = (meta.format || '').toLowerCase();
        obj.image = await imageFixOrientation(image);

        if (obj.verifyResolution && (meta.width * meta.height) > IMAGE_MAX_RESOLUTION) {
          throw new ValueError("Image size excessive, uploaded images must be smaller than %s million pixels.", `${IMAGE_MAX_RESOLUTION / 1e6}`);
        }
      }
      return obj;
    } catch(e) {
      throw e;
    }
  }

  /**
   * Return the image resulting of all the image processing
        operations that have been applied previously.

        Return false if the initialized `image` was falsy, and return
        the initialized `image` without change if it was SVG.

        Also return the initialized `image` if no operations have been applied
        and the `outputFormat` is the same as the original format and the
        quality is not specified.
   * @param quality quality setting to apply. Default to 0.
            - for JPEG: 1 is worse, 95 is best. Values above 95 should be
                avoided. Falsy values will fallback to 95, but only if the image
                was changed, otherwise the original image is returned.
            - for PNG: set falsy to prevent conversion to a WEB palette.
            - for other formats: no effect.
   * @param outputFormat the output format. Can be PNG, JPEG, GIF, or ICO.
            Default to the format of the original image. BMP is converted to
            PNG, other formats than those mentioned above are converted to JPEG
   * @returns image bytes or false
   */
  async imageQuality(quality = 1, outputFormat = '') {
    if (!this.image) {
      return this.image;
    }
    const meta = await this.image.metadata();
    const space = meta.space?.toLowerCase() || '';
    let outputImage = this.image;

    outputFormat = outputFormat.toLowerCase() ?? this.originalFormat;
    if (outputFormat === 'bmp') {
      outputFormat = 'png';
    }
    else if (!['png', 'jpeg', 'gif', 'ico'].includes(outputFormat)) {
      outputFormat = 'jpeg';
    }

    if (!this.operationsCount && outputFormat === this.originalFormat && !quality) {
      return this.image;
    }

    const opt = { 'format': outputFormat }

    if (outputFormat === 'png') {
      opt['optimiseScans'] = true;
      if (quality) {
        if (!(space !== 'p')) {
          outputImage = outputImage
            .toColorspace('rgba')
            .pipelineColourspace('rgb')
            .toColorspace('p')
        }
      }
    }
    if (outputFormat === 'jpeg') {
      opt['optimiseScans'] = true;
      opt['quality'] = quality ?? 95;
    }
    if (outputFormat === 'gif') {
      opt['optimiseScans'] = true;
      opt['saveAll'] = true;
    }

    const outMeta = await outputImage.metadata()
    const outSpace = outMeta.space?.toLowerCase() || '';
    if (!["1", "l", "p", "rgb", "rgba"].includes(outSpace) || (space === 'jpeg' && outSpace === 'rgba')) {
      outputImage = outputImage.toColorspace("rgb");
    }

    return imageApplyOpt(outputImage, outputFormat, opt);
  }

  async imageBase64(quality = 1, outputFormat = '') {
    if (!this.image) {
      return this.base64Source;
    }

    const img = await this.imageQuality(quality, outputFormat);

    if (img !== this.image) {
      const buffer = await img.toBuffer();
      return b64encode(buffer);
    }
    return this.base64Source;
  }

  async resize(maxWidth = 0, maxHeight = 0) {
    if (this.image && this.originalFormat !== 'gif' && (maxWidth || maxHeight)) {
      const image = this.image as sharp.Sharp;
      const meta = await image.metadata();
      const [w, h] = [meta.width, meta.height];
      const askedWidth = maxWidth ?? Math.floor((w * maxHeight) / h);
      const askedHeight = maxHeight ?? Math.floor((h * maxWidth) / w);
      if (askedWidth !== w || askedHeight !== h) {
        this.image = image.resize(askedWidth, askedHeight, { kernel: 'lanczos2' });
      }
    }
    return this;
  }

  async cropResize(maxWIdth = 0, maxHeight = 0, centerX = 0.5, centerY = 0.5) {
    console.warn('Not implement');
    return this;
  }

  async colorize() {
    if (this.image) {
      const original = this.image;
      const meta = await original.metadata();
      const color = { r: randrange(32, 224, 24), g: randrange(32, 224, 24), b: randrange(32, 224, 24) };
      this.image = original.clone()
        .tint(color)
        .resize(meta.width, meta.height)
        .composite([{ input: await original.toBuffer() }]);
      this.operationsCount += 1;
    }
    return this;
  }
}

export async function imageProcess(base64Source: any, options: { size?: [number, number], verifyResolution?: boolean, quality?: number, colorize?: boolean, outputFormat?: string, crop?: any } = {}) {
  setOptions(options, { verifyResolution: false, quality: 1, colorize: false, outputFormat: '', crop: null });
  const size = options.size ?? [0, 0];
  if (!bool(base64Source) || ((!size || (!size[0] && !size[1])) && !options.verifyResolution && !options.quality && !options.crop && !options.colorize && !options.outputFormat)) {
    // for performance: don't do anything if the image is falsy or if
    // no operations have been requested
    return base64Source;
  }
  let image = await ImageProcess.new(base64Source, options.verifyResolution);

  if (size[0] > 0 && size[1] > 0) {
    if (options.crop) {
      let centerX = 0.5;
      let centerY = 0.5;
      if (options.crop === 'top') {
        centerY = 0;
      } else if (options.crop === 'bottom') {
        centerY = 1;
      }
      await image.cropResize(size[0], size[1], centerX, centerY);
    } else {
      await image.resize(size[0], size[1]);
    }
  }
  return image.imageBase64(options.quality || 80, options.outputFormat);
}

/**
 * Fix the orientation of the image if it has an EXIF orientation tag.

    This typically happens for images taken from a non-standard orientation
    by some phones or other devices that are able to report orientation.

    The specified transposition is applied to the image before all other
    operations, because all of them expect the image to be in its final
    orientation, which is the case only when the first row of pixels is the top
    of the image and the first column of pixels is the left of the image.

    Moreover the EXIF tags will not be kept when the image is later saved, so
    the transposition has to be done to ensure the final image is correctly
    orientated.

    Note: to be completely correct, the resulting image should have its exif
    orientation tag removed, since the transpositions have been applied.
    However since this tag is not used in the code, it is acceptable to
    save the complexity of removing it.
 * @param image the source image
 * @returns the resulting image, copy of the source, with orientation fixed
        or the source image if no operation was applied
 */
export async function imageFixOrientation(image: sharp.Sharp) {
  const meta = await image.metadata();
  const orientation = meta.orientation || 0;
  if (orientation) {
    for (const method of (EXIF_TAG_ORIENTATION_TO_TRANSPOSE_METHODS[orientation] || [])) {
      if (method === FLIP_LEFT_RIGHT)
        image = image.flip();
      else if (method === FLIP_TOP_BOTTOM)
        image = image.flop();
      else if (method === ROTATE_90)
        image = image.rotate(90);
      else if (method === ROTATE_180)
        image = image.rotate(190);
      else if (method === ROTATE_270)
        image = image.rotate(270);
    }
  }
  return image;
}

/**
 * Return the given PIL `image` using `params`.
 * @param image the PIL image
 * @param format  
 * @param opt 
 * @returns the image formatted
 */
function imageApplyOpt(image: sharp.Sharp, format: any, opt?: {}) {
  image = image.toFormat(format, opt);
  return image;
}

/**
 * This returns data URL scheme according RFC 2397
(https://tools.ietf.org/html/rfc2397) for all kind of supported images
(PNG, GIF, JPG and SVG), defaulting on PNG type if not mimetype detected.
 * @param base64Source 
 * @returns 
 */
export function imageDataUri(base64Source: Buffer) {
  return format('data:image/%s;base64,%s', FILETYPE_BASE64_MAGICWORD[base64Source.subarray(0, 1).toString()] ?? 'png', base64Source.toString(),
  )
}

/**
 * Returns the saturation (hsl format) of a given rgb color
 * @param rgb rgb tuple or list
 * @returns saturation
 */
export function getSaturation(rgb: number[]) {
  const c_max = Math.max(...rgb) / 255
  const c_min = Math.min(...rgb) / 255
  const d = c_max - c_min
  return d == 0 ? 0 : d / (1 - Math.abs(c_max + c_min - 1))
}

/**
 * Returns the lightness (hsl format) of a given rgb color
 * @param rgb rgb tuple or list
 * @returns lightness
 */
export function getLightness(rgb: number[]) {
  return (Math.max(...rgb) + Math.min(...rgb)) / 2 / 255
}

/**
 * Converts an hexadecimal string (starting with '#') to a RGB tuple
 * @param hx 
 * @returns 
 */
export function hexToRgb(hx) {
  return [...range(1, 6, 2)].map(i => parseInt(hx.slice(i, i + 2), 16));
}

/**
 * Converts a RGB tuple or list to an hexadecimal string
 * @param rgb 
 * @returns 
 */
export function rgbToHex(rgb) {
  return '#' + rgb.map(c => c.toString(16).split('x').slice(-1)[0].padStart(2, '0')).join('')
}

export function averageDominantColor(colors: number[], mitigate = 175, maxMargin = 140) {
  const dominantColor = Math.max(...colors);
  const dominantRgb = dominantColor[1].slice(0, 3);
  const dominantSet = [dominantColor]
  const remaining = []

  const margins = _.fill(Array(3),
    maxMargin * (1 - dominantColor[0] /
      colors.map(col => col[0]).reduce((prev, val) => prev + val, 0))
  );

  colors = colors.filter(c => c !== dominantColor);

  for (const color of colors) {
    const rgb = color[1];
    if (rgb[0] < dominantRgb[0] + margins[0] && rgb[0] > dominantRgb[0] - margins[0] &&
      rgb[1] < dominantRgb[1] + margins[1] && rgb[1] > dominantRgb[1] - margins[1] &&
      rgb[2] < dominantRgb[2] + margins[2] && rgb[2] > dominantRgb[2] - margins[2]) {
      dominantSet.push(color);
    }
    else {
      remaining.push(color);
    }
  }

  const dominantAvg = [];
  for (const band of range(3)) {
    let avg = 0;
    let total = 0;
    for (const color of dominantSet) {
      avg += color[0] * color[1][band]
      total += color[0]
    }
    dominantAvg.push(Math.round(avg / total))
  }

  const finalDominant = [];
  const brightest = Math.max(...dominantAvg)
  for (const color of range(3)) {
    const value = brightest > mitigate ? dominantAvg[color] / (brightest / mitigate) : dominantAvg[color]
    finalDominant.push(Math.round(value))
  }

  return [finalDominant, remaining]
}

/**
 * Attempt to guess the image size based on `fieldName`.

  If it can't be guessed, return (0, 0) instead.

 * @param fieldName the name of a field
 * @returns tuple [width, height] the guessed size
 */
export function imageGuessSizeFromFieldName(fieldName: string) {
  let suffix;
  if (fieldName.startsWith('image')) {
    suffix = fieldName.slice(5);
  }
  else if (fieldName.startsWith('avatar')) {
    suffix = fieldName.slice(6);
  }
  suffix = suffix || '1024';
  try {
    return [parseInt(suffix), parseInt(suffix)];
  } catch (e) {
    return [0, 0];
  }
}

/**
 * Return whether or not the size of the given image `base64Source1` isabove the size of the given image `base64Source2`.
 * @param base64Source1 
 * @param base64Source2 
 * @returns 
 */
export async function isImageSizeAbove(base64Source1, base64Source2) {
  if (!base64Source1 || !base64Source2) {
    return false;
  }
  if (base64Source1[0] === 'P' || base64Source1[0] === 'P'.charCodeAt(0) 
    || base64Source2[0] === 'P' || base64Source2[0] === 'P'.charCodeAt(0)) { //in (b'P', 'P'):
    // false for SVG
    return false;
  }
  const imageSource = await imageFixOrientation(base64ToImage(base64Source1));
  const metaSource = await imageSource.metadata();
  const imageTarget = await imageFixOrientation(base64ToImage(base64Source2));
  const metaTarget = await imageTarget.metadata();
  return metaSource.width > metaTarget.width || metaSource.height > metaTarget.height;
}

export function base64ToImage(base64Source: any): sharp.Sharp {
  try {
    const src = b64decode(base64Source);
    const image = sharp(src);
    return image;
  } catch (e) {
    throw new UserError("This file could not be decoded as an image file. Please try with a different file.\n%s", e.message);
  }
}

export function getHslFromSeed(seed) {
  const hashedSeed = sha512(seed);
  // full range of colors, in degree
  const hue = parseInt(hashedSeed.slice(0, 2), 16) * 360 / 255;
  // colorful result but not too flashy, in percent
  const sat = parseInt(hashedSeed.slice(2, 4), 16) * ((70 - 40) / 255) + 40;
  // not too bright and not too dark, in percent
  const lig = 45;
  return `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${lig.toFixed(1)}%)`;
}

/**
 *  input = binary b'?PNG...
    => [137, 80, 78, 71, 13, 10,...

    return Uint8Array base64; b'iVB
    => [105, 86, 66, 79, 82, 119, 48,...
 * @param binarySource 
 * @returns 
 */
export function b64encode(binarySource) {
  if (binarySource instanceof Buffer) {
    binarySource = binarySource.toString('base64');
  }
  return Buffer.from(binarySource);
}

/**
 *  input = Uint8Array base64; b'iVB: [105, 86, 66, 79, 82, 119, 48,...
    or    = string base64 starts with 'PHN2Zw==' (of SVG)
    return binary b'?PNG...         or b'<svg...
    => [137, 80, 78, 71, 13, 10...] or [69, 115, 118, 103...]
 * @param base64Source 
 * @returns 
 */
export function b64decode(base64Source) {
  return Buffer.from(base64Source.toString(), 'base64');
}

export function encodebytes(str) { // Tony must check
  return str;
}

const base64regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;

/**
 * From string to base64 string
 * @param str 
 * @returns base64 string
 */
export function stringBase64(str) {
  return Buffer.from(str).toString('base64');
}

/**
 * From base64 string to string
 * @param str 
 * @returns 
 */
export function base64String(str) {
  return Buffer.from(str, 'base64').toString();
}