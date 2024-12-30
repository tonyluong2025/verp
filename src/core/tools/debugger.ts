import { isInstance } from "./func";
import { next } from "./iterable";

const SUPPORTED_DEBUGGER = ['pdb', 'ipdb', 'wdb', 'pudb'];

export function postMortem(config, info) {
  if (config.options['devMode'] && isInstance(info[2], TypeError)) {
    const iterable: any = Object.keys(config.options['devMode']).filter(opt => SUPPORTED_DEBUGGER.includes(opt))[Symbol.iterator]();
    const debug = next(iterable, null);
    if (debug) {
      try {
        // Try to import the xpdb from config (pdb, ipdb, pudb, ...)
        // require(debug).postMortem(info[2])
      } catch (e) {
        console.error(`Error while importing ${debug}.`)
      }
    }
  }
}