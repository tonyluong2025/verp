/** @verp-module **/

import { BUILTINS } from "./builtin";
import {
    NotSupportedError,
    JsDate,
    JsDateTime,
    JsRelativeDelta,
    JsTime,
    JsTimeDelta,
} from "./date";
import { Dict, toDict } from "./utils";
import { parseArgs } from './parser';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * @typedef { import("./parser").AST } AST
 */

export class EvaluationError extends Error {}

// -----------------------------------------------------------------------------
// Constants and helpers
// -----------------------------------------------------------------------------

const isTrue = BUILTINS.bool;

/**
 * @param {AST} ast
 * @param {Object} context
 * @returns {any}
 */
function applyUnaryOp(ast, context) {
    const value = evaluate(ast.right, context);
    switch (ast.op) {
        case "-":
            if (value instanceof Object && value.negate) {
                return value.negate();
            }
            return -value;
        case "+":
            return value;
        case "not":
            return !isTrue(value);
    }
    throw new EvaluationError(`Unknown unary operator: ${ast.op}`);
}

/**
 * We want to maintain this order:
 *   None < number (boolean) < dict < string < list < dict
 * So, each type is mapped to a number to represent that order
 *
 * @param {any} val
 * @returns {number} index type
 */
function typeIndex(val) {
    switch (typeof val) {
        case "object":
            // null, List, Object, Dict
            return val === null ? 1 : Array.isArray(val) ? 5 : 3;
        case "number":
            return 2;
        case "string":
            return 4;
    }
    throw new EvaluationError(`Unknown type: ${typeof val}`);
}

/**
 * @param {Object} obj
 * @returns {boolean}
 */
function isConstructor(obj) {
    return !!obj.prototype && !!obj.prototype.constructor.name;
}

/**
 * Compare two values
 *
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function isLess(left, right) {
    if (typeof left === "number" && typeof right === "number") {
        return left < right;
    }
    if (typeof left === "boolean") {
        left = left ? 1 : 0;
    }
    if (typeof right === "boolean") {
        right = right ? 1 : 0;
    }
    const leftIndex = typeIndex(left);
    const rightIndex = typeIndex(right);
    if (leftIndex === rightIndex) {
        return left < right;
    }
    return leftIndex < rightIndex;
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function isEqual(left, right) {
    if (typeof left !== typeof right) {
        if (typeof left === "boolean" && typeof right === "number") {
            return right === (left ? 1 : 0);
        }
        if (typeof left === "number" && typeof right === "boolean") {
            return left === (right ? 1 : 0);
        }
        return false;
    }
    if (left instanceof Object && left.isEqual) {
        return left.isEqual(right);
    }
    return left === right;
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function isIn(left, right) {
    if (Array.isArray(right)) {
        return right.includes(left);
    }
    if (typeof right === "string" && typeof left === "string") {
        return right.includes(left);
    }
    return false;
}

/**
 * @param {AST} ast
 * @param {object} context
 * @returns {any}
 */
function applyBinaryOp(ast, context) {
    const left = evaluate(ast.left, context);
    const right = evaluate(ast.right, context);
    switch (ast.op) {
        case "+": {
            const relativeDeltaOnLeft = left instanceof JsRelativeDelta;
            const relativeDeltaOnRight = right instanceof JsRelativeDelta;
            if (relativeDeltaOnLeft || relativeDeltaOnRight) {
                const date = relativeDeltaOnLeft ? right : left;
                const delta = relativeDeltaOnLeft ? left : right;
                return JsRelativeDelta.add(date, delta);
            }

            const timeDeltaOnLeft = left instanceof JsTimeDelta;
            const timeDeltaOnRight = right instanceof JsTimeDelta;
            if (timeDeltaOnLeft && timeDeltaOnRight) {
                return left.add(right);
            }
            if (timeDeltaOnLeft) {
                if (right instanceof JsDate || right instanceof JsDateTime) {
                    return right.add(left);
                } else {
                    throw NotSupportedError();
                }
            }
            if (timeDeltaOnRight) {
                if (left instanceof JsDate || left instanceof JsDateTime) {
                    return left.add(right);
                } else {
                    throw NotSupportedError();
                }
            }

            return left + right;
        }
        case "-": {
            const isRightDelta = right instanceof JsRelativeDelta;
            if (isRightDelta) {
                return JsRelativeDelta.substract(left, right);
            }

            const timeDeltaOnRight = right instanceof JsTimeDelta;
            if (timeDeltaOnRight) {
                if (left instanceof JsTimeDelta) {
                    return left.substract(right);
                } else if (left instanceof JsDate || left instanceof JsDateTime) {
                    return left.substract(right);
                } else {
                    throw NotSupportedError();
                }
            }

            if (left instanceof JsDate) {
                return left.substract(right);
            }
            return left - right;
        }
        case "*":
            const timeDeltaOnLeft = left instanceof JsTimeDelta;
            const timeDeltaOnRight = right instanceof JsTimeDelta;
            if (timeDeltaOnLeft || timeDeltaOnRight) {
                const number = timeDeltaOnLeft ? right : left;
                const delta = timeDeltaOnLeft ? left : right;
                return delta.multiply(number); // check number type?
            }

            return left * right;
        case "/":
            return left / right;
        case "%":
            return left % right;
        case "//":
            if (left instanceof JsTimeDelta) {
                return left.divide(right); // check number type?
            }
            return Math.floor(left / right);
        case "**":
            return left ** right;
        case "==":
            return isEqual(left, right);
        case "<>":
        case "!=":
            return !isEqual(left, right);
        case "<":
            return isLess(left, right);
        case ">":
            return isLess(right, left);
        case ">=":
            return isEqual(left, right) || isLess(right, left);
        case "<=":
            return isEqual(left, right) || isLess(left, right);
        case "in":
            return isIn(left, right);
        case "not in":
            return !isIn(left, right);
    }
    throw new EvaluationError(`Unknown binary operator: ${ast.op}`);
}

const DICT = {
    get(dict) {
        return (...args) => {
            const { key, defValue } = parseArgs(args, ["key", "defValue"]);
            if (key in dict) {
                return dict[key];
            } else if (defValue) {
                return defValue;
            }
            return null;
        };
    },
};

// -----------------------------------------------------------------------------
// Evaluate function
// -----------------------------------------------------------------------------

/**
 * @param {AST} ast
 * @param {Object} context
 * @returns {any}
 */
export function evaluate(ast, context = {}) {
    const dicts = new Set();
    let _context;
    const evalContext = Object.create(context);
    Object.defineProperty(evalContext, "context", {
        get() {
            if (!_context) {
                _context = toDict(context);
            }
            return _context;
        },
    });

    /**
     * @param {AST} ast
     */
    function _evaluate(ast) {
        switch (ast.type) {
            case 0 /* Number */:
            case 1 /* String */:
                return ast.value;
            case 5 /* Name */:
                if (ast.value in evalContext) {
                    return evalContext[ast.value];
                } else if (ast.value in BUILTINS) {
                    return BUILTINS[ast.value];
                } else {
                    throw new EvaluationError(`Name '${ast.value}' is not defined`);
                }
            case 3 /* None */:
                return null;
            case 2 /* Boolean */:
                return ast.value;
            case 6 /* UnaryOperator */:
                return applyUnaryOp(ast, evalContext);
            case 7 /* BinaryOperator */:
                return applyBinaryOp(ast, evalContext);
            case 14 /* BooleanOperator */:
                const left = _evaluate(ast.left);
                if (ast.op === "and") {
                    return isTrue(left) ? _evaluate(ast.right) : left;
                } else {
                    return isTrue(left) ? left : _evaluate(ast.right);
                }
            case 4 /* List */:
            case 10 /* Tuple */:
                return ast.value.map(_evaluate);
            case 11 /* Dictionary */:
                const dict = {};
                for (let key in ast.value) {
                    dict[key] = _evaluate(ast.value[key]);
                }
                dicts.add(dict);
                return dict;
            case 8 /* FunctionCall */:
                const fnValue = _evaluate(ast.fn);
                const args = ast.args.map(_evaluate);
                const kwargs = {};
                for (let kwarg in ast.kwargs) {
                    kwargs[kwarg] = _evaluate(ast.kwargs[kwarg]);
                }
                if (
                    fnValue === JsDate ||
                    fnValue === JsDateTime ||
                    fnValue === JsTime ||
                    fnValue === JsRelativeDelta ||
                    fnValue === JsTimeDelta
                ) {
                    return fnValue.create(...args, kwargs);
                }
                return fnValue(...args, kwargs);
            case 12 /* Lookup */: {
                const dict = _evaluate(ast.target);
                const key = _evaluate(ast.key);
                return dict[key];
            }
            case 13 /* If */: {
                if (isTrue(_evaluate(ast.condition))) {
                    return _evaluate(ast.ifTrue);
                } else {
                    return _evaluate(ast.ifFalse);
                }
            }
            case 15 /* ObjLookup */: {
                const left = _evaluate(ast.obj);
                if (dicts.has(left) || Object.isPrototypeOf.call(Dict, left)) {
                    // this is a dictionary => need to apply dict methods
                    return DICT[ast.key](left);
                }
                const result = left[ast.key];
                if (typeof result === "function" && !isConstructor(result)) {
                    return result.bind(left);
                }
                return result;
            }
        }
        throw new EvaluationError(`AST of type ${ast.type} cannot be evaluated`);
    }
    return _evaluate(ast);
}
