import _ from "lodash";
import path from "path"
import { isInstance } from "./func";

/**
 * Test whether FILENAME matches PATTERN.

  Patterns are Unix shell style:

  *       matches everything
  ?       matches any single character
  [seq]   matches any character in seq
  [!seq]  matches any char not in seq

  An initial period in FILENAME is not special.
  Both FILENAME and PATTERN are first case-normalized
  if the operating system requires it.
  If you don't want this, use fnmatchcase(FILENAME, PATTERN).
 * @param name 
 * @param pat 
 * @returns 
 */
export function fnmatch(name: string, pat: string) {
  name = path.normalize(name);
  pat = path.normalize(pat);
  return fnmatchcase(name, pat);
}

/**
 * Return the subset of the list NAMES that match PAT.
 * @param names 
 * @param patern 
 * @returns 
 */
export function fnfilter(names: string[], patern: string) {
  const result = [];
  patern = path.normalize(patern);
  const reg = compileRegex(patern);
  // normcase on posix is NOP. Optimize it away from the loop.
  for (const name of names) {
    if (reg.test(name)) {
      result.push(name);
    }
  }
  return result;
}

// @lruCache({maxsize: 256, typed: true})
function compileRegex(patern) {
  let res;
  if (isInstance(patern, Uint8Array)) {
    const patStr = patern.toString('ISO-8859-1');
    const resStr = Buffer.from(translate(patStr));
    res = (new TextDecoder('windows-1252')).decode(resStr);
  }
  else {
    res = translate(patern);
  }
  return new RegExp(res);
}

/**
 * Test whether FILENAME matches PATTERN, including case.

  This is a version of fnmatch() which doesn't case-normalize
  its arguments.
 * @param name 
 * @param pat 
 * @returns 
 */
function fnmatchcase(name, pat) {
  const reg = compileRegex(pat);
  return reg.test(name);
}

/**
 * Translate a shell PATTERN to a regular expression.

  There is no way to quote meta-characters.
 * @param pat 
 */
function translate(pat: string) {
  let [i, n] = [0, pat.length];
  let res = ''
  while (i < n) {
    let c = pat[i]
    i = i+1
    if (c === '*')
      res = res + '.*'
    else if (c === '?')
      res = res + '.'
    else if (c === '[') {
      let j = i
      if (j < n && pat[j] === '!')
        j = j+1
      if (j < n && pat[j] === ']')
        j = j+1
      while (j < n && pat[j] !== ']')
        j = j+1
      if (j >= n)
        res = res + '\\['
      else {
        let stuff = pat.slice(i, j);
        if (!stuff.includes('--'))
          stuff = stuff.replace(/\\/, '\\');
        else {
          const chunks = []
          let k = pat[i] === '!' ? i+2 : i+1
          while (true) {
            k = pat.slice(k,j).indexOf('-')
            if (k < 0)
              break
            chunks.push(pat.slice(i, k))
            i = k+1
            k = k+3
          }
          chunks.push(pat.slice(i, j))
          // Escape backslashes and hyphens for set difference (--).
          // Hyphens that create ranges shouldn't be escaped.
          stuff = chunks.map(s => s.replace(/\\/, '\\').replace('\-', '-')).join('-');
        }
        // Escape set operations (&&, ~~ and ||).
        stuff = stuff.replace(/([&~|])/, '\\$1');
        i = j+1
        if (stuff[0] === '!')
          stuff = '^' + stuff.slice(1);
        else if (['^', '['].includes(stuff[0]))
          stuff = '\\' + stuff
        res = `${res}[${stuff}]`;
      }
    }
    else
      res = res + _.escape(c);
  }
  return `(?:${res})\\Z`
}