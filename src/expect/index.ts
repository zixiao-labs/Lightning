/**
 * Minimal `expect` for Phase 0: `toBe`, `toEqual`, `toBeTruthy`, `toBeFalsy`,
 * `toThrow`, plus `.not`. The chai core + full jest matchers land in Phase 2.
 *
 * Assertion failures throw {@link LightningAssertionError}, which carries
 * `{ actual, expected }` so the reporter can render a diff.
 */

export class LightningAssertionError extends Error {
  diff?: { actual: unknown; expected: unknown };

  constructor(message: string, diff?: { actual: unknown; expected: unknown }) {
    super(message);
    this.name = "AssertionError";
    if (diff) this.diff = diff;
    // Drop the matcher frames so the stack points at the user's `expect(...)` call.
    (Error as { captureStackTrace?: (target: object, ctor: unknown) => void }).captureStackTrace?.(
      this,
      LightningAssertionError,
    );
  }
}

/** Structural deep equality (handles objects, arrays, Map, Set, Date, RegExp, NaN). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !deepEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    const bv = [...b];
    return [...a].every((av) => bv.some((x) => deepEqual(av, x)));
  }

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return value.name ? `[Function ${value.name}]` : "[Function]";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toThrow(expected?: string | RegExp | ErrorConstructor): void;
  readonly not: Matchers;
}

type ErrorConstructor = new (...args: never[]) => Error;

function makeMatchers(actual: unknown, negated: boolean): Matchers {
  const fail = (message: string, diff?: { actual: unknown; expected: unknown }): never => {
    throw new LightningAssertionError(message, diff);
  };

  /** Assert `pass` honoring negation; build the message from the positive phrasing. */
  const check = (
    pass: boolean,
    positiveMsg: () => string,
    negativeMsg: () => string,
    diff?: { actual: unknown; expected: unknown },
  ): void => {
    if (negated ? pass : !pass) {
      fail(negated ? negativeMsg() : positiveMsg(), negated ? undefined : diff);
    }
  };

  return {
    get not() {
      return makeMatchers(actual, !negated);
    },

    toBe(expected) {
      check(
        Object.is(actual, expected),
        () => `expected ${stringify(actual)} to be ${stringify(expected)} (Object.is)`,
        () => `expected ${stringify(actual)} not to be ${stringify(expected)}`,
        { actual, expected },
      );
    },

    toEqual(expected) {
      check(
        deepEqual(actual, expected),
        () => `expected ${stringify(actual)} to deeply equal ${stringify(expected)}`,
        () => `expected value not to deeply equal ${stringify(expected)}`,
        { actual, expected },
      );
    },

    toBeTruthy() {
      check(
        Boolean(actual),
        () => `expected ${stringify(actual)} to be truthy`,
        () => `expected ${stringify(actual)} not to be truthy`,
      );
    },

    toBeFalsy() {
      check(
        !actual,
        () => `expected ${stringify(actual)} to be falsy`,
        () => `expected ${stringify(actual)} not to be falsy`,
      );
    },

    toThrow(expected) {
      if (typeof actual !== "function") {
        fail(`expected a function to call, received ${stringify(actual)}`);
      }
      let thrown: unknown;
      let didThrow = false;
      try {
        (actual as () => unknown)();
      } catch (err) {
        didThrow = true;
        thrown = err;
      }

      if (!didThrow) {
        check(
          false,
          () => "expected function to throw, but it did not",
          () => "expected function not to throw",
        );
        return;
      }

      const message = thrown instanceof Error ? thrown.message : String(thrown);
      let matched = true;
      if (typeof expected === "string") matched = message.includes(expected);
      else if (expected instanceof RegExp) matched = expected.test(message);
      else if (typeof expected === "function") matched = thrown instanceof expected;

      check(
        matched,
        () =>
          `expected function to throw matching ${stringify(expected)}, but threw ${stringify(message)}`,
        () => `expected function not to throw matching ${stringify(expected)}`,
      );
    },
  };
}

export function expect(actual: unknown): Matchers {
  return makeMatchers(actual, false);
}
