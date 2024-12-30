import fs from 'fs';
import archiver from 'archiver';
import { lstrip } from "./utils";

const WINDOWS_RESERVED = /^(:?CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(:?\..*)?$/gi;
// new RegExp(
//   '^' +
//   // forbidden stems: reserved keywords
//   '(:?CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])' +
//   // even with an extension this is recommended against
//   '(:?\..*)?' +
//   '$'
// , 'iv');s

/**
 * Strips or replaces possibly problematic or annoying characters our of
    the input string, in order to make it a valid filename in most operating
    systems (including dropping reserved Windows filenames).

    If this results in an empty string, results in "Untitled" (localized).

    Allows:

    * any alphanumeric character (unicode)
    * underscore (_) as that's innocuous
    * dot (.) except in leading position to avoid creating dotfiles
    * dash (-) except in leading position to avoid annoyance / confusion with
      command options
    * brackets ([ and ]), while they correspond to shell *character class*
      they're a common way to mark / tag files especially on windows
    * parenthesis ("(" and ")"), a more natural though less common version of
      the former
    * space (" ")
 * @param name file name to clean up
 * @param replacement replacement string to use for sequences of problematic input, by default
        an empty string to remove them entirely, each contiguous sequence of
        problems is replaced by a single replacement
 * @returns 
 */
export function cleanFilename(name, replacement = '') {
  if (WINDOWS_RESERVED.test(name)) {
    return "Untitled";
  }
  return lstrip(name.replace(/[^\w_.\(\)\[\] -]+/, replacement, name), '.-') || "Untitled";
}

export function zipDir(dumpDir, stream, opts: {includeDir?: boolean, fnctSort?: Function}={}) {
  var output = fs.createWriteStream(dumpDir);
  var archive = archiver("zip");

  output.on("close", function () {
    console.log(archive.pointer() + " total bytes");
    console.log(
      "archiver has been finalized and the output file descriptor has closed.",
    );
  });

  archive.on("error", function (err) {
    throw err;
  });

  archive.pipe(output);

  archive
    .append(stream)
    .finalize();
}