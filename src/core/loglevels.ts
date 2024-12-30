import { format } from "node:util";
import fs from "fs";

if (process.env.NODE_ENV === 'production') {
  function showDate() {
    const date = new Date();
    const str = date.toISOString().replace('T', ' ').replace('Z', '');
    return str + " ";
  }
  
  function formatArgs(args) {
      return format(...args);
  }
  
  function show(func, args) {
    const name = func.name.toUpperCase() + " ? ";
    const logString = showDate() + name + formatArgs(args);
    fs.writeSync(process.stdout.fd, logString + '\n');
  };

  var orig = {
    log: console.log,
    error: console.error,
    info: console.info,
    warn: console.warn,
    debug: console.debug,
  }

  console.log = function() {
    show(orig.log, arguments);
  };

  console.error = function() {
    show(orig.error, arguments);
  };

  console.info = function() {
    show(orig.info, arguments);
  };

  console.warn = function() {
    show(orig.warn, arguments);
  };

  console.debug = function() {
    show(orig.debug, arguments);
  }
}