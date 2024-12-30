export function encodeString(s: string) {
	let out = "";
	let skip = false;
	let _g1 = 0, _g = s.length;
	while(_g1 < _g) {
		const i = _g1++;
		if(!skip) {
			let code = s.charCodeAt(i);
			if(55296 <= code && code <= 56319) {
				const low = s.charCodeAt(i + 1);
				code = (code - 55296) * 1024 + (low - 56320) + 65536;
				skip = true;
			}
			if(code > 1114111) { throw new Error("Char out of range"); }
			const hex = "00000000".concat((new Number(code)).toString(16).toUpperCase());
			if(code >= 65536) {
				out += "\\U" + hex.slice(-8);
			} else {
				if(code >= 127 || code <= 31) {
					switch(code) {
						case 9:	out += "\\t"; break;
						case 10: out += "\\n"; break;
						case 13: out += "\\r"; break;
						default: out += "\\u" + hex.slice(-4); break;
					}
				} else {
					switch(code) {
						case 34: out += '\\"'; break;
						case 92: out += "\\\\"; break;
						default: out += s.charAt(i); break;
					}
				}
			}
		} else {
			skip = !skip;
		}
	}
	return out;
};

/**
 * IRI
 */
export class IRI {
  static SCHEME_MATCH = new RegExp("^[a-z0-9-.+]+:", "i");

  value: string;
  constructor(iri: string) { 
    this.value = iri; 
  }

  toString() { return this.value; };
  
  nodeType() { return "IRI"; };
  
  toNT() { return "<" + encodeString(this.value) + ">"; };
  
  n3() { return this.toNT(); };
  
  defrag() {
    const i = this.value.indexOf("#");
    return (i < 0) ? this : new IRI(this.value.slice(0, i));
  };
  
  isAbsolute() {
    return this.scheme != null && this.hierpart!=null && this.fragment == null;
  };

  toAbsolute() {
    if(this.scheme == null || this.hierpart == null) { throw new Error("IRI must have a scheme and a hierpart!"); }
    return resolveReference(this.value).defrag();
  };

  get authority() {
    const hierpart = this.hierpart;
    if(hierpart.substring(0, 2) != "//") return null;
    const authority = hierpart.slice(2);
    const q = authority.indexOf("/");
    return q>=0 ? authority.substring(0, q) : authority;
  };

  get fragment() {
    const i = this.value.indexOf("#");
    return (i<0) ? null : this.value.slice(i);
  };

  get hierpart() {
    let _hierpart = this.value;
    let q = _hierpart.indexOf("?");
    if(q >= 0) {
      _hierpart = _hierpart.substring(0, q);
    } else {
      q = _hierpart.indexOf("#");
      if(q >= 0) _hierpart = _hierpart.substring(0, q);
    }
    const q2 = this.scheme;
    if(q2 != null) _hierpart = _hierpart.slice(1 + q2.length);
    return _hierpart;
  };

  get host() {
    let _host = this.authority;
    let q = _host.indexOf("@");
    if(q >= 0) _host = _host.slice(++q);
    if(_host.indexOf("[") == 0) {
      q = _host.indexOf("]");
      if (q > 0) return _host.substring(0, q);
    }
    q = _host.lastIndexOf(":");
    return q >= 0 ? _host.substring(0, q) : _host;
  };

  get path() {
    const q = this.authority;
    if(q == null) return this.hierpart;
    return this.hierpart.slice(q.length + 2);
  };

  get port() {
    let host = this.authority;
    let q = host.indexOf("@");
    if(q >= 0) host = host.slice(++q);
    if(host.indexOf("[") == 0) {
      q = host.indexOf("]");
      if(q > 0) return host.substring(0, q);
    }
    q = host.lastIndexOf(":");
    if(q < 0) return null;
    host = host.slice(++q);
    return host.length == 0 ? null : host;
  };

  get query() {
    const q = this.value.indexOf("?");
    if(q < 0) return null;
    const f = this.value.indexOf("#");
    if(f < 0) return this.value.slice(q);
    return this.value.substring(q, f);
  };

  get scheme() {
    const scheme = this.value.match(IRI.SCHEME_MATCH);
    return (scheme == null) ? null : scheme.shift().slice(0, -1);
  };

  get userinfo() {
    const authority = this.authority;
    const q = authority.indexOf("@");
    return (q < 0) ? null : authority.substring(0, q);
  };
  
  toURIString(){
    return this.value.replace(/([\u00A0-\uD7FF\uE000-\uFDCF\uFDF0-\uFFEF]|[\uD800-\uDBFF][\uDC00-\uDFFF])/g, function(a){return encodeURI(a);});
  };

  toIRIString(){
    // HEXDIG requires capital characters
    // 80-BF is following bytes, (%[89AB][0-9A-F])
    // 00-7F no bytes follow (%[0-7][0-9A-F])(%[89AB][0-9A-F]){0}
    // C0-DF one byte follows (%[CD][0-9A-F])(%[89AB][0-9A-F]){1}
    // E0-EF two bytes follow (%[E][0-9A-F])(%[89AB][0-9A-F]){2}
    // F0-F7 three bytes follow (%[F][0-7])(%[89AB][0-9A-F]){3}
    // F8-FB four bytes follow (%[F][89AB])(%[89AB][0-9A-F]){4}
    // FC-FD five bytes follow (%[F][CD])(%[89AB][0-9A-F]){5}
    const utf8regexp = /%([2-7][0-9A-F])|%[CD][0-9A-F](%[89AB][0-9A-F])|%[E][0-9A-F](%[89AB][0-9A-F]){2}|%[F][0-7](%[89AB][0-9A-F]){3}|%[F][89AB](%[89AB][0-9A-F]){4}|%[F][CD](%[89AB][0-9A-F]){5}/g;
    // reserved characters := gen-delims, space, and sub-delims
    // : / ? # [ ] @   ! $ & ' ( ) * + , ; =
    const reserved = [ '3A', '2F', '3F', '23', '5B', '5D', '40', '20', '21', '24', '26', '27', '28', '29', '2A', '2B', '2C', '3B', '3D'];
    const iri = this.toString().replace(utf8regexp, function(a, b){
      if(reserved.indexOf(b)>=0) return a;
      return decodeURIComponent(a);
    });
    return iri;
  };
  
  toIRI(){
    return new IRI(this.toIRIString());
  };
}

export function removeDotSegments(input) {
	let output = "";
	let q = 0;
	while(input.length > 0) {
		if(input.substr(0, 3) == "../" || input.substr(0, 2) == "./") {
			input = input.slice(input.indexOf("/"));
		}else if(input == "/.") {
			input = "/";
		}else if(input.substr(0, 3) == "/./") {
			input = input.slice(2);
		}else if(input.substr(0, 4) == "/../" || input == "/..") {
			input = (input=="/..") ? "/" : input.slice(3);
			q = output.lastIndexOf("/");
			output = (q>=0) ? output.substring(0, q) : "";
		}else if(input.substr(0, 2) == ".." || input.substr(0, 1) == ".") {
			input = input.slice(input.indexOf("."));
			q = input.indexOf(".");
			if(q >= 0) input = input.slice(q);
		}else {
			if(input.substr(0, 1) == "/") {
				output += "/";
				input = input.slice(1);
			}
			q = input.indexOf("/");
			if(q < 0) {
				output += input;
				input = "";
			}else {
				output += input.substring(0, q);
				input = input.slice(q);
			}
		}
	}
	return output;
};

function resolveReference(ref) {
	let reference;
	if(typeof ref == "string") {
		reference = new IRI(ref);
	} else if(ref.nodeType && ref.nodeType() == "IRI") {
		reference = ref;
	} else {
		throw new Error("Expected IRI or String");
	}
	const T = {scheme:"", authority:"", path:"", query:"", fragment:""};
	let q = "";
	if(reference.scheme() != null) {
		T.scheme = reference.scheme();
		q = reference.authority();
		T.authority += q!=null ? "//"+q : "";
		T.path = removeDotSegments(reference.path());
		T.query += reference.query()||'';
	} else {
		q = reference.authority();
		if(q != null) {
			T.authority = q!=null ? "//"+q : "";
			T.path = removeDotSegments(reference.path());
			T.query += reference.query()||'';
		}else {
			q = reference.path();
			if(q == "" || q == null) {
				T.path = this.path();
				q = reference.query();
				if(q != null) {
					T.query += q;
				}else {
					q = this.query();
					T.query += q!=null ? q : "";
				}
			}else {
				if(q.substring(0, 1) == "/") {
					T.path = removeDotSegments(q);
				}else {
					if(this.path() != null) {
						let q2 = this.path().lastIndexOf("/");
						if(q2 >= 0) {
							T.path = this.path().substring(0, ++q2);
						}
						T.path += reference.path();
					}else {
						T.path = "/" + q;
					}
					T.path = removeDotSegments(T.path);
				}
				T.query += reference.query()||'';
			}
			q = this.authority();
			T.authority = q!=null ? "//" + q : "";
		}
		T.scheme = this.scheme();
	}
	T.fragment = reference.fragment()||'';
	return new IRI(T.scheme + ":" + T.authority + T.path + T.query + T.fragment);
};


// Create a new IRI object and decode UTF-8 escaped characters
export function fromURI(uri){
	return new IRI(uri).toIRI();
};

export function toIRIString(uri){
	return new IRI(uri).toIRIString();
};


/**
 * URL-decode string value. Optimized to skip native call when no %.
 *
 * @param {string} str
 * @returns {string}
 */
export function decode(str: string) {
  return str.indexOf('%') === -1 ? str :
    decodeURIComponent(
      str
        .replace(/\\%2D/g, '-')
        .replace(/\\%5F/g, '_')
        .replace(/\\%2E/g, '.')
        .replace(/\\%21/g, '!')
        .replace(/\\%7E/g, '~')
        .replace(/\\%2A/g, '*')
        .replace(/\\%27/g, "'")
        .replace(/\\%28/g, '(')
        .replace(/\\%29/g, ')')
    );
}

/**
 * URL-encode value.
 *
 * @param {string} str
 * @returns {string}
 */
export function encode(str: string) {
  return encodeURIComponent(str)
    .replace(/\-/g, '%2D')
    .replace(/\_/g, '%5F')
    .replace(/\./g, '%2E')
    .replace(/\!/g, '%21')
    .replace(/\~/g, '%7E')
    .replace(/\*/g, '%2A')
    .replace(/\'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function encodeIO(str, input: BufferEncoding='utf8', output: BufferEncoding='utf8') {
  return Buffer.from(str, input).toString(output);
}
