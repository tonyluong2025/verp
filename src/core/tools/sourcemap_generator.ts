import { Dict } from "../helper/collections";
import { range } from "./iterable";
import { stringify } from "./json";

export class SourceMapGenerator {
  _file: any;
  _sourceRoot: string;
  _sources: Dict<any>;
  _mappings: any[];
  _sourcesContents: {};
  _version: number;
  _cache: {};
  
  constructor(sourceRoot?: string) {
    this._file = null;
    this._sourceRoot = sourceRoot;
    this._sources = new Dict(); 
    this._mappings = []
    this._sourcesContents = {}
    this._version = 3
    this._cache = {}
  }

  /**
   * Adds a new source file in the sourcemap. All the lines of the source file will be mapped line by line
    to the generated file from the (last_index + start_offset). All lines between
    last_index and (last_index + start_offset) will
    be mapped to line 1 of the source file.

    Example:
        ls 1 = Line 1 from new source file
        lg 1 = Line 1 from genereted file
        ls 1 <=> lg 1 Line 1 from new source file is map to  Line 1 from genereted file
        nb_ls = number of lines in the new source file

        Step 1:
        ls 1 <=> lg last_index + 1

        Step 2:
        ls 1 <=> lg last_index + start_offset + 1
        ls 2 <=> lg last_index + start_offset + 2
        ...
        ls nb_ls <=> lg last_index + start_offset + nb_ls

   * @param sourceName name of the source to add
   * @param sourceContent content of the source to add
   * @param lastIndex Line where we start to map the new source
   * @param startOffset Number of lines to pass in the generated file before starting mapping line by line
   */
  addSource(sourceName: string, sourceContent: string, lastIndex?: number, startOffset?: number) {
    const sourceLineCount = sourceContent.split("\n").length;

    this._sources.setdefault(sourceName, this._sources.length);

    this._sourcesContents[sourceName] = sourceContent;
    if (startOffset > 0) {
      // adds a mapping between the first line of the source
      // and the first line of the corresponding code in the generated file.
      this._mappings.push({
        "generatedLine": lastIndex + 1,
        "originalLine": 1,
        "source": sourceName,
      })
    }
    for (const i of range(1, sourceLineCount + 1)) {
      this._mappings.push({
        "generatedLine": lastIndex + i + startOffset,
        "originalLine": i,
        "source": sourceName,
      })
    }
  }
  
  /**
   * A source map mapping is encoded with the base 64 VLQ format.
    This function encodes the readable source to the format.

    :return the encoded content
   * @returns 
   */
  _serializeMappings() {
    let previousGeneratedLine = 1;
    let previousOriginalLine = 0;
    let previousSource = 0;
    const encodedColumn = base64vlqEncode(0);
    let result = "";
    for (const mapping of this._mappings) {
      if (mapping["generatedLine"] !== previousGeneratedLine) {
        while (mapping["generatedLine"] > previousGeneratedLine) {
          result += ";";
          previousGeneratedLine += 1;
        }
      }
      let source, line;
      if (mapping["source"] != null) {
        const sourceIdx = this._sources[mapping["source"]];
        const source = sourceIdx - previousSource;
        previousSource = sourceIdx;

        // lines are stored 0-based in SourceMap spec version 3
        line = mapping["originalLine"] - 1 - previousOriginalLine;
        previousOriginalLine = mapping["originalLine"] - 1;
      }
      const sourceLine = `${source}@${line}`;
      if (!(sourceLine in this._cache)) {
        this._cache[sourceLine] = [
          encodedColumn,
          base64vlqEncode(source),
          base64vlqEncode(line),
          encodedColumn,
        ].join('');
      }
      result += this._cache[sourceLine];
    }
    return result;
  }
  /**
   * Generates the json sourcemap.
    It is the main function that assembles all the pieces. 
   * @returns valid sourcemap in json format
   */
  toJson() {
    const mapping = {
      "version": this._version,
      "sources": this._sources.keys(),
      "mappings": this._serializeMappings(),
      "sourcesContent": this._sources.keys().map(source => this._sourcesContents[source])
    }
    if (this._file) {
      mapping["file"] = this._file
    }

    if (this._sourceRoot) {
      mapping["sourceRoot"] = this._sourceRoot;
    }

    return mapping;
  }

  /**
   * Generates the content of the sourcemap.
   * @returns the content of the sourcemap as a string encoded in UTF-8.
   */
  getContent() {
    // Store with XSSI-prevention prefix
    return ")]}'\n" + stringify(this.toJson());//.encode('utf8')
  }

}

const B64CHARS = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
const [SHIFTSIZE, FLAG, MASK] = [5, 1 << 5, (1 << 5) - 1]

/**
 * Encode Base64 VLQ encoded sequences
  https://gist.github.com/mjpieters/86b0d152bb51d5f5979346d11005588b
  Base64 VLQ is used in source maps.
  VLQ values consist of 6 bits (matching the 64 characters of the Base64
  alphabet), with the most significant bit a *continuation* flag. If the
  flag is set, then the next character in the input is part of the same
  integer value. Multiple VLQ character sequences so form an unbounded
  integer value, in little-endian order.
  The *first* VLQ value consists of a continuation flag, 4 bits for the
  value, and the last bit the *sign* of the integer:
  +-----+-----+-----+-----+-----+-----+
  |  c  |  b3 |  b2 |  b1 |  b0 |  s  |
  +-----+-----+-----+-----+-----+-----+
  while subsequent VLQ characters contain 5 bits of value:
  +-----+-----+-----+-----+-----+-----+
  |  c  |  b4 |  b3 |  b2 |  b1 |  b0 |
  +-----+-----+-----+-----+-----+-----+
  For source maps, Base64 VLQ sequences can contain 1, 4 or 5 elements.
 * @param values 
 * @returns 
 */
// @lruCache({maxsize: 64})
function base64vlqEncode(...values: any[]) {
  const results = [];
  const add = results.push;
  for (let v of values) {
    // add sign bit
    v = (Math.abs(v) << 1) | parseInt(v < 0 ? '1' : '0');
    let toencode;
    while (true) {
      [toencode, v] = [v & MASK, v >> SHIFTSIZE];
      results.push(toencode | (v && FLAG));
      if (! v) {
        break;
      }
    }
  }
  return Buffer.from(results.map(r => B64CHARS[r])).toString();
}