const componentRe = new RegExp(/(\d+|[a-z]+|\.|-)/);
const repl = { 'pre': 'c', 'preview': 'c', '-': 'final-', '_': 'final-', 'rc': 'c', 'dev': '@', 'saas': '', '~': '' };

function* _parseVersionParts(s: string) {
  for (let part of s.split(componentRe)) {
    part = repl[part] ?? part;
    if (!part || part === '.') {
      continue
    }
    if ('0123456789'.includes(part.slice(0, 1))) {
      yield part.padStart(8, '0');    // pad for numeric comparison
    } else {
      yield '*' + part;
    }
  }
  yield '*final';
}

export function parseVersion(s: string) {
  const parts: string[] = [];
  for (const part of _parseVersionParts((s ? s : '0.1').toLowerCase())) {
    if (part.startsWith('*')) {
      if (part < '*final') {   // remove '-' before a prerelease tag
        while (parts.length && parts.slice(-1)[0] === '*final-') {
          parts.pop();
        }
      }
      // remove trailing zeros from each series of numeric parts
      while (parts.length && parts.slice(-1)[0] === '00000000') {
        parts.pop();
      }
    }
    parts.push(part);
  }
  return parts;
}