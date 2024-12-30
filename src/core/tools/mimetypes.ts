import { isAlpha } from "./func";
import mime from 'mime-types';

const _pptPattern = new RegExp('\x00\x6E\x1E\xF0|\x0F\x00\xE8\x03|\xA0\x46\x1D\xF0|\xFD\xFF\xFF\xFF(\x0E|\x1C|\x43)\x00\x00\x00');

class _Entry {
  mimetype: string;
  signatures: Buffer[];
  discriminants: any;
  constructor(mimetype: string, signatures: Buffer[], discriminants: any) {
    this.mimetype = mimetype;
    this.signatures = signatures;
    this.discriminants = discriminants;
  }
};
// https://en.wikipedia.org/wiki/List_of_file_signatures
// https://www.ntfs.com/jpeg-signature-format.htm \xFF\xD8\xFF
const _mimeMappings: _Entry[] = [
  // pdf
  new _Entry('application/pdf', [Buffer.from('%PDF', 'ascii')], []),
  // jpg, jpeg, png, gif, bmp, jfif
  new _Entry('image/jpeg', [Buffer.from('\xFF\xD8\xFF\xE0', 'ascii'), Buffer.from('\xFF\xD8\xFF\xE2', 'ascii'), Buffer.from('\xFF\xD8\xFF\xE3', 'ascii'), Buffer.from('\xFF\xD8\xFF\xE1', 'ascii'), Buffer.from('\xFF\xD8\xFF\xDB', 'ascii'), Buffer.from('\xFF\xD8\xFF\xEE', 'ascii')], []),
  new _Entry('image/png', [Buffer.from('\x89PNG\r\n\x1A\n', 'ascii')], []),
  new _Entry('image/gif', [Buffer.from('GIF87a', 'ascii'), Buffer.from('GIF89a', 'ascii')], []),
  new _Entry('image/bmp', [Buffer.from('BM', 'ascii')], []),
  new _Entry('image/svg+xml', [Buffer.from('<', 'ascii')], [_checkSvg,]),
  new _Entry('image/x-icon', [Buffer.from('\x00\x00\x01\x00', 'ascii')], []),
  // OLECF files in general (Word, Excel, PPT, default to word because why not?)
  new _Entry('application/msword', [Buffer.from('\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1', 'ascii'), Buffer.from('\x0D\x44\x4F\x43', 'ascii')], [_checkOlecf]),
  // zip, but will include jar, odt, ods, odp, docx, xlsx, pptx, apk
  new _Entry('application/zip', [Buffer.from('PK\x03\x04', 'ascii')], [_checkOoxml, _checkOpenContainerFormat]),
];

const e = _mimeMappings[0]

/**
 * This simply checks the existence of the opening and ending SVG tags
 * @param data 
 * @returns 
 */
function _checkSvg(data: Buffer) {
  if (data.includes('<svg') && data.includes('/svg>'))
    return 'image/svg+xml';
}

function _checkOlecf(data: Buffer) {
  const offset = 0x200;
  if (data.subarray(offset).includes('\xEC\xA5\xC1\x00'))
    return 'application/msword';
  // the _xls_pattern stuff doesn't seem to work correctly (the test file
  // only has a bunch of \xf* at offset 0x200), that apparently works
  else if (data.includes('Microsoft Excel'))
    return 'application/vnd.ms-excel';
  else if (_pptPattern.test(data.subarray(offset).toString('latin1')))
    return 'application/vnd.ms-powerpoint';
  return false;
}

function _checkOoxml(data: Buffer) {
  // const f = io.BytesIO(data) as f, zipfile.ZipFile(f) as z:
  // filenames = z.namelist()
  // // OOXML documents should have a [Content_Types].xml file for early
  // // check that we're interested in this thing at all
  // if '[Content_Types].xml' not in filenames:
  //   return false

  // // then there is a directory whose name denotes the type of the file:
  // // word, pt (powerpoint) or xl (excel)
  // for dirname, mime in _ooxml_dirs.items():
  //     if any(entry.startsWith(dirname) for entry in filenames):
  //         return mime

  // return false
}

function _checkOpenContainerFormat(data: Buffer) {

}

/**
 * Attempts to guess the mime type of the provided binary data, similar
    to but significantly more limited than libmagic
    :param str bin_data: 
    :returns: 
 * @param data binary data to try and guess a mime type for
 * @param value 
 * @returns matched mimetype or `'application/octet-stream'` if none matched
 */
export function guessMimetype(data: Buffer, value='application/octet-stream') {
  // by default, guess the type using the magic number of file hex signature (like magic, but more limited)
  if (!(data instanceof Buffer)) {
    return;
  }
  for (const entry of _mimeMappings) {
    for (const signature of entry.signatures) {
      const test = data.subarray(0, signature.length);
      const res = test.compare(signature);
      if (res == 0) {
        for (const discriminant of entry.discriminants) {
          try {
            const guess = discriminant(data);
            if (guess) return guess;
          } catch(e) {
            // log-and-next
            console.warn("Sub-checker '%s' of type '%s' failed", discriminant.name, entry.mimetype)
          }
        }
        // if no discriminant or no discriminant matches, return primary mime type
        return entry.mimetype;
      }
    }
  }
  return value;
}

/**
 * Return the extension the current filename based on the heuristic that
  ext is less than or equal to 10 chars and is alphanumeric.

  :param str filename: 
  :returns: 
 * @param filename filename to try and guess a extension for
 * @returns detected extension or `''`
 */
export function getExtension(filename: string) {
  const ext = filename.includes('.') && filename.split('.').slice(-1)[0];
  return ext && ext.length <= 10 && isAlpha(ext) && '.' + ext.toLowerCase() || ''
}

export function guessType(realFilename) {
  return mime.lookup(realFilename);
}

export function guessExtension(type) {
  return mime.extension(type);
}

export function guessCharset(type) {
  return mime.charset(type);
}