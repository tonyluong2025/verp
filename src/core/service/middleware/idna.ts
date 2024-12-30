import uts46 from "idna-uts46";

export function _encodeIdna(domain) {
  return uts46.toAscii(domain);
}

export function _decodeIdna(domain: string) {
  return uts46.toUnicode(domain);
}

export function wsgiGetBytes(data) {
  return Buffer.from(data, 'latin1').toString();
}