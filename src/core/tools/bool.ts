export function bool(obj: any): boolean {
  if (!obj) return false; // undefined | null| false | '' | == 0 | NaN
  if (obj instanceof Date) {
    return true;
  }
  if (typeof obj === 'object' || typeof obj === 'function') {
    if (typeof obj['_bool'] === 'function') { // ModelRecords
      return obj._bool();
    }
    if ('_length' in obj) {
      return obj._length > 0;
    }
    if ('length' in obj) {
      return obj.length > 0;
    }
    if ('size' in obj) {
      return obj.size > 0;
    }
    return Object.keys(obj).length > 0;
  }
  return !!obj; 
}