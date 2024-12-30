import assert from "assert";
import { copysign } from "./misc";

/**
 * Returns true if `'value'` is small enough to be treated as
    zero at the given precision (smaller than the corresponding *epsilon*).
    The precision (`'10**-precision_digits'` or `'precision_rounding'`)
    is used as the zero *epsilon*: values less than that are considered
    to be zero.
    Precision must be given by `'precisionDigits'` or `'precision_rounding'`,
    not both! 

    Warning: `'floatIsZero(value1-value2)'` is not equivalent to
    `'floatCompare(value1,value2) == 0'`, as the former will round after
    computing the difference, while the latter will round before, giving
    different results for e.g. 0.006 and 0.002 at 2 digits precision. 
 * @param value 
 * @param precisionDigits number of fractional digits to round to
 * @param precisionRounding decimal number representing the minimum
        non-zero value at the desired precision (for example, 0.01 for a 
        2-digit precision)
 */
export function floatIsZero(value, options: { precisionDigits?: number, precisionRounding?: number } = {}) {
  const epsilon = _floatCheckPrecision(options);
  return Math.abs(floatRound(value, { precisionRounding: epsilon })) < epsilon;
}

/**
 * Compare `'value1'` and `'value2'` after rounding them according to thegiven precision. A value is considered lower/greater than another value if their rounded value is different. This is not the same as having a non-zero difference!
    Precision must be given by `'precisionDigits'` or `'precisionRounding'`,
    not both!

    Example: 1.432 and 1.431 are equal at 2 digits precision,
    so this method would return 0
    However 0.006 and 0.002 are considered different (this method returns 1)
    because they respectively round to 0.01 and 0.0, even though
    0.006-0.002 = 0.004 which would be considered zero at 2 digits precision.

    Warning: `'floatIsZero(value1-value2)'` is not equivalent to 
    `'floatCompare(value1,value2) == 0'`, as the former will round after
    computing the difference, while the latter will round before, giving
    different results for e.g. 0.006 and 0.002 at 2 digits precision. 
  * @param value1 first value to compare
  * @param value2 second value to compare
  * @param precisionDigits number of fractional digits to round to
  * @param precisionRounding decimal number representing the minimum
          non-zero value at the desired precision (for example, 0.01 for a 
          2-digit precision)
  * @returns (resp.) -1, 0 or 1, if ``value1`` is (resp.) lower than,
        equal to, or greater than ``value2``, at the given precision
 */
export function floatCompare(value1, value2, options: { precisionDigits?: number, precisionRounding?: number } = {}) {
  const roundingFactor = _floatCheckPrecision(options);
  value1 = floatRound(value1, { precisionRounding: roundingFactor });
  value2 = floatRound(value2, { precisionRounding: roundingFactor });
  const delta = value1 - value2;
  if (floatIsZero(delta, { precisionRounding: roundingFactor })) {
    return 0;
  }
  return delta < 0.0 ? -1 : 1;
}

export function floatRepr(value: number, precisionDigits: number): string {
  return value.toFixed(precisionDigits);
}

function _floatCheckPrecision(options: { precisionDigits?: number, precisionRounding?: number } = {}) {
  const precisionDigits = options.precisionDigits;
  const precisionRounding = options.precisionRounding;
  assert((precisionDigits != null || precisionRounding != null) && !(precisionDigits && precisionRounding),
    "exactly one of precisionDigits and precisionRounding must be specified");
  assert((precisionRounding == null || precisionRounding > 0), `precisionRounding must be positive, got ${precisionRounding}`);
  if (precisionDigits != null) {
    // return 10 ** -precisionDigits; // Tony must check 10**-4 ~ 0.00009999999999999999, right: 0.0001
    const num = 10 ** -precisionDigits;
    return Number(num.toFixed(precisionDigits));
  }
  return Number(precisionRounding);
}

/**
 * Return `'value'` rounded to `'precisionDigits'` decimal digits,
       minimizing IEEE-754 floating point representation errors, and applying
       the tie-breaking rule selected with `'roundingMethod'`, by default
       HALF-UP (away from zero).
       Precision must be given by `'precisionDigits'` or `'precisionRounding'`,
       not both!
 * @param value the value to round
 * @param precisionDigits number of fractional digits to round to.
 * @param precisionRounding decimal number representing the minimum
           non-zero value at the desired precision (for example, 0.01 for a 
           2-digit precision) 
 * @param roundingMethod the rounding method used: 'HALF-UP', 'UP' or 'DOWN',
           the HALF-UP rounding up to the closest number with the rule that
           number>=0.5 is rounded up to 1, the UP always rounding up and the
           DOWN one always rounding down
 * @returns rounded float
 */
export function floatRound(value, options: number | { precisionDigits?: number, precisionRounding?: number, roundingMethod?: string } = {}) {
  if (typeof options === 'number') {
    options = { precisionDigits: options }
  }
  const roundingFactor = _floatCheckPrecision(options);
  if (roundingFactor == 0 || value == 0) {
    return 0.0;
  }
  let normalizedValue = value / roundingFactor;
  const sign = normalizedValue > 0.0 ? 1.0 : -1.0;
  const epsilonMagnitude = Math.log2(Math.abs(normalizedValue))
  const epsilon = 2 ** (epsilonMagnitude - 52);

  const roundingMethod = options.roundingMethod;
  let roundedValue;
  if (roundingMethod === 'UP') {
    normalizedValue -= sign * epsilon
    roundedValue = Math.ceil(Math.abs(normalizedValue)) * sign
  } else if (roundingMethod === 'DOWN') {
    normalizedValue += sign * epsilon
    roundedValue = Math.floor(Math.abs(normalizedValue)) * sign
  } else {
    normalizedValue += copysign(epsilon, normalizedValue);
    roundedValue = round(normalizedValue);
  }
  const result = roundedValue * roundingFactor; // de-normalize
  return result;
}

export function divmod(a, b) {
  return [Math.trunc(a / b), a % b];
}

function round(f: number): any {
  const roundf = Math.round(f);
  if (Math.round(f + 1) - roundf != 1) {
    return f + copysign(0.5, f);
  }
  return copysign(roundf, f);
}

export function parseValues(mapping, keys = ['balance', 'debit', 'credit'], parser = parseFloat) {
  if (mapping instanceof Map) {
    for (const key of keys) {
      if (mapping.has(key)) {
        mapping.set(key, parser(mapping.get(key)));
      }
    }
  }
  else {
    for (const key of keys) {
      if (key in mapping) {
        mapping[key] = parser(mapping[key]);
      }
    }
  }
  return mapping;
}