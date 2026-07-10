import { inspect } from "../utils/inspect.ts";
import { isMockFunction } from "../mock/index.ts";
import {
  addSnapshotSerializer,
  matchSnapshot,
  serializeSnapshot,
  type SnapshotSerializer,
} from "../snapshot/core.ts";

export class LightningAssertionError extends Error {
  diff?: { actual: unknown; expected: unknown };

  constructor(message: string, diff?: { actual: unknown; expected: unknown }) {
    super(message);
    this.name = "AssertionError";
    if (diff) this.diff = diff;
    (
      Error as { captureStackTrace?: (target: object, ctor: unknown) => void }
    ).captureStackTrace?.(this, LightningAssertionError);
  }
}

type ErrorConstructor = abstract new (...args: any[]) => Error;
type MaybePromise<T> = T | Promise<T>;

type MatcherResult = {
  pass: boolean;
  message: () => string;
  actual?: unknown;
  expected?: unknown;
};

type CustomMatcher = (
  this: MatcherContext,
  actual: unknown,
  ...args: unknown[]
) => MaybePromise<MatcherResult>;

interface MatcherContext {
  isNot: boolean;
  equals: typeof deepEqual;
  utils: { stringify: typeof stringify };
}

const customMatchers = new Map<string, CustomMatcher>();

interface AssertionState {
  count: number;
  expected?: number;
  requireAssertions: boolean;
  softErrors: LightningAssertionError[];
}

let assertionState: AssertionState = {
  count: 0,
  requireAssertions: false,
  softErrors: [],
};

export function startTestAssertions(): void {
  assertionState = { count: 0, requireAssertions: false, softErrors: [] };
}

export function finishTestAssertions(): void {
  const errors = [...assertionState.softErrors];
  if (
    assertionState.expected !== undefined &&
    assertionState.count !== assertionState.expected
  ) {
    errors.push(
      new LightningAssertionError(
        `expected ${assertionState.expected} assertion${assertionState.expected === 1 ? "" : "s"}, but ${assertionState.count} ran`,
      ),
    );
  }
  if (assertionState.requireAssertions && assertionState.count === 0) {
    errors.push(
      new LightningAssertionError(
        "expected at least one assertion to be called",
      ),
    );
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new LightningAssertionError(
      errors.map((error) => error.message).join("\n"),
    );
  }
}

function recordAssertion(): void {
  assertionState.count++;
}

export function getState(): AssertionState {
  return {
    count: assertionState.count,
    requireAssertions: assertionState.requireAssertions,
    softErrors: [...assertionState.softErrors],
    ...(assertionState.expected === undefined
      ? {}
      : { expected: assertionState.expected }),
  };
}

export function setState(next: Partial<AssertionState>): void {
  assertionState = { ...assertionState, ...next };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function")
    return value.name ? `[Function ${value.name}]` : "[Function]";
  if (value === undefined) return "undefined";
  return inspect(value, {
    colors: false,
    depth: Number.POSITIVE_INFINITY,
    sorted: true,
  });
}

// ---- asymmetric matchers ----------------------------------------------------

export interface AsymmetricMatcherInterface {
  asymmetricMatch(value: unknown): boolean;
  toString(): string;
}

function isAsymmetricMatcher(
  value: unknown,
): value is AsymmetricMatcherInterface {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as AsymmetricMatcherInterface).asymmetricMatch === "function",
  );
}

class AnythingMatcher implements AsymmetricMatcherInterface {
  asymmetricMatch(value: unknown): boolean {
    return value !== null && value !== undefined;
  }
  toString(): string {
    return "Anything";
  }
}

class AnyMatcher implements AsymmetricMatcherInterface {
  constructor(private readonly expected: unknown) {}
  asymmetricMatch(value: unknown): boolean {
    if (this.expected === String)
      return typeof value === "string" || value instanceof String;
    if (this.expected === Number)
      return typeof value === "number" || value instanceof Number;
    if (this.expected === Boolean)
      return typeof value === "boolean" || value instanceof Boolean;
    if (this.expected === BigInt) return typeof value === "bigint";
    if (this.expected === Symbol) return typeof value === "symbol";
    if (this.expected === Function) return typeof value === "function";
    if (typeof this.expected === "function")
      return value instanceof (this.expected as new (...args: any[]) => object);
    return false;
  }
  toString(): string {
    return `Any<${(this.expected as { name?: string })?.name ?? stringify(this.expected)}>`;
  }
}

class ObjectContainingMatcher implements AsymmetricMatcherInterface {
  constructor(private readonly sample: Record<string, unknown>) {}
  asymmetricMatch(value: unknown): boolean {
    return subsetEqual(value, this.sample);
  }
  toString(): string {
    return "ObjectContaining";
  }
}

class ArrayContainingMatcher implements AsymmetricMatcherInterface {
  constructor(private readonly sample: readonly unknown[]) {}
  asymmetricMatch(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return this.sample.every((expected) =>
      value.some((actual) => deepEqual(actual, expected)),
    );
  }
  toString(): string {
    return "ArrayContaining";
  }
}

class StringContainingMatcher implements AsymmetricMatcherInterface {
  constructor(private readonly sample: string) {}
  asymmetricMatch(value: unknown): boolean {
    return typeof value === "string" && value.includes(this.sample);
  }
  toString(): string {
    return "StringContaining";
  }
}

class StringMatchingMatcher implements AsymmetricMatcherInterface {
  private readonly pattern: RegExp;
  constructor(sample: string | RegExp) {
    this.pattern = typeof sample === "string" ? new RegExp(sample) : sample;
  }
  asymmetricMatch(value: unknown): boolean {
    return typeof value === "string" && this.pattern.test(value);
  }
  toString(): string {
    return "StringMatching";
  }
}

/** Structural deep equality with asymmetric matcher support. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (isAsymmetricMatcher(b)) return b.asymmetricMatch(a);
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;

  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return (
      a instanceof RegExp &&
      b instanceof RegExp &&
      a.source === b.source &&
      a.flags === b.flags
    );
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size)
      return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size)
      return false;
    const remaining = [...b];
    return [...a].every((actual) => {
      const index = remaining.findIndex((expected) =>
        deepEqual(actual, expected),
      );
      if (index === -1) return false;
      remaining.splice(index, 1);
      return true;
    });
  }

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;

  const aKeys = Reflect.ownKeys(a);
  const bKeys = Reflect.ownKeys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.propertyIsEnumerable.call(a, key) ===
        Object.prototype.propertyIsEnumerable.call(b, key) &&
      Object.prototype.hasOwnProperty.call(b, key) &&
      deepEqual(
        (a as Record<PropertyKey, unknown>)[key],
        (b as Record<PropertyKey, unknown>)[key],
      ),
  );
}

function subsetEqual(actual: unknown, expected: unknown): boolean {
  if (isAsymmetricMatcher(expected)) return expected.asymmetricMatch(actual);
  if (typeof expected !== "object" || expected === null)
    return deepEqual(actual, expected);
  if (typeof actual !== "object" || actual === null) return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((item, index) => subsetEqual(actual[index], item))
    );
  }
  return Reflect.ownKeys(expected).every(
    (key) =>
      Object.prototype.hasOwnProperty.call(actual, key) &&
      subsetEqual(
        (actual as Record<PropertyKey, unknown>)[key],
        (expected as Record<PropertyKey, unknown>)[key],
      ),
  );
}

function getPathValue(
  value: unknown,
  propertyPath: string | readonly (string | number)[],
): { found: boolean; value: unknown } {
  const parts =
    typeof propertyPath === "string"
      ? propertyPath.split(".").filter(Boolean)
      : [...propertyPath];
  let cursor = value as Record<PropertyKey, unknown> | null | undefined;
  for (const part of parts) {
    if (cursor == null || !(part in Object(cursor)))
      return { found: false, value: undefined };
    cursor = Object(cursor)[part] as Record<PropertyKey, unknown>;
  }
  return { found: true, value: cursor };
}

function makeError(
  message: string,
  diff?: { actual: unknown; expected: unknown },
): LightningAssertionError {
  return new LightningAssertionError(message, diff);
}

function failOrSoft(
  message: string,
  soft: boolean,
  diff?: { actual: unknown; expected: unknown },
): void {
  const error = makeError(message, diff);
  if (soft) assertionState.softErrors.push(error);
  else throw error;
}

function check(
  pass: boolean,
  negated: boolean,
  soft: boolean,
  positiveMsg: () => string,
  negativeMsg: () => string,
  diff?: { actual: unknown; expected: unknown },
): void {
  recordAssertion();
  if (negated ? pass : !pass) {
    failOrSoft(
      negated ? negativeMsg() : positiveMsg(),
      soft,
      negated ? undefined : diff,
    );
  }
}

const baseMatcherNames = [
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toBeTruthy",
  "toBeFalsy",
  "toBeDefined",
  "toBeUndefined",
  "toBeNull",
  "toBeNaN",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeCloseTo",
  "toContain",
  "toContainEqual",
  "toHaveLength",
  "toHaveProperty",
  "toMatch",
  "toThrow",
  "toThrowError",
  "toBeInstanceOf",
  "toBeTypeOf",
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveReturned",
  "toHaveReturnedTimes",
  "toHaveReturnedWith",
  "toHaveLastReturnedWith",
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
] as const;

type MatcherName = (typeof baseMatcherNames)[number];

export type Matchers = Record<
  MatcherName,
  (...args: any[]) => void | Promise<void>
> & {
  readonly not: Matchers;
  readonly resolves: Matchers;
  readonly rejects: Matchers;
  [customMatcher: string]: unknown;
};

function ensureMock(actual: unknown): asserts actual is {
  mock: {
    calls: unknown[][];
    results: Array<{ type: string; value: unknown }>;
  };
} {
  if (!isMockFunction(actual))
    throw makeError(`expected ${stringify(actual)} to be a mock function`);
}

function thrownError(actual: unknown): { threw: boolean; value?: unknown } {
  if (typeof actual !== "function")
    throw makeError(
      `expected a function to call, received ${stringify(actual)}`,
    );
  try {
    (actual as () => unknown)();
    return { threw: false };
  } catch (error) {
    return { threw: true, value: error };
  }
}

function matchesThrown(
  value: unknown,
  expected?: string | RegExp | ErrorConstructor | Error,
): boolean {
  if (expected === undefined) return true;
  const message = value instanceof Error ? value.message : String(value);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (expected instanceof Error)
    return value instanceof Error && value.message === expected.message;
  if (typeof expected === "function") return value instanceof expected;
  return false;
}

function buildSyncMatchers(
  actual: unknown,
  negated: boolean,
  soft: boolean,
): Matchers {
  const matchers: Partial<Matchers> = {
    get not() {
      return buildMatchers(actual, !negated, soft);
    },
    get resolves() {
      return buildPromiseMatchers(
        Promise.resolve(actual),
        "resolves",
        negated,
        soft,
      );
    },
    get rejects() {
      return buildPromiseMatchers(
        Promise.resolve(actual),
        "rejects",
        negated,
        soft,
      );
    },

    toBe(expected: unknown) {
      check(
        Object.is(actual, expected),
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to be ${stringify(expected)} (Object.is)`,
        () => `expected ${stringify(actual)} not to be ${stringify(expected)}`,
        { actual, expected },
      );
    },

    toEqual(expected: unknown) {
      check(
        deepEqual(actual, expected),
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to deeply equal ${stringify(expected)}`,
        () => `expected value not to deeply equal ${stringify(expected)}`,
        { actual, expected },
      );
    },

    toStrictEqual(expected: unknown) {
      (
        buildSyncMatchers(actual, negated, soft).toEqual as (
          expected: unknown,
        ) => void
      )(expected);
    },

    toMatchObject(expected: unknown) {
      check(
        subsetEqual(actual, expected),
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to match object ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to match object ${stringify(expected)}`,
        { actual, expected },
      );
    },

    toBeTruthy() {
      check(
        Boolean(actual),
        negated,
        soft,
        () => `expected ${stringify(actual)} to be truthy`,
        () => `expected ${stringify(actual)} not to be truthy`,
      );
    },

    toBeFalsy() {
      check(
        !actual,
        negated,
        soft,
        () => `expected ${stringify(actual)} to be falsy`,
        () => `expected ${stringify(actual)} not to be falsy`,
      );
    },

    toBeDefined() {
      check(
        actual !== undefined,
        negated,
        soft,
        () => "expected value to be defined",
        () => "expected value not to be defined",
      );
    },

    toBeUndefined() {
      check(
        actual === undefined,
        negated,
        soft,
        () => `expected ${stringify(actual)} to be undefined`,
        () => "expected value not to be undefined",
      );
    },

    toBeNull() {
      check(
        actual === null,
        negated,
        soft,
        () => `expected ${stringify(actual)} to be null`,
        () => "expected value not to be null",
      );
    },

    toBeNaN() {
      check(
        Number.isNaN(actual),
        negated,
        soft,
        () => `expected ${stringify(actual)} to be NaN`,
        () => "expected value not to be NaN",
      );
    },

    toBeGreaterThan(expected: number | bigint) {
      check(
        (actual as number | bigint) > expected,
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to be greater than ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to be greater than ${stringify(expected)}`,
      );
    },

    toBeGreaterThanOrEqual(expected: number | bigint) {
      check(
        (actual as number | bigint) >= expected,
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to be greater than or equal to ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to be greater than or equal to ${stringify(expected)}`,
      );
    },

    toBeLessThan(expected: number | bigint) {
      check(
        (actual as number | bigint) < expected,
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to be less than ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to be less than ${stringify(expected)}`,
      );
    },

    toBeLessThanOrEqual(expected: number | bigint) {
      check(
        (actual as number | bigint) <= expected,
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to be less than or equal to ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to be less than or equal to ${stringify(expected)}`,
      );
    },

    toBeCloseTo(expected: number, precision = 2) {
      const tolerance = 10 ** -precision / 2;
      check(
        typeof actual === "number" && Math.abs(actual - expected) < tolerance,
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to be close to ${expected} with ${precision} digits`,
        () => `expected ${stringify(actual)} not to be close to ${expected}`,
      );
    },

    toContain(expected: unknown) {
      const pass =
        typeof actual === "string"
          ? actual.includes(String(expected))
          : Array.isArray(actual)
            ? actual.some((item) => Object.is(item, expected))
            : actual instanceof Set
              ? actual.has(expected)
              : false;
      check(
        pass,
        negated,
        soft,
        () => `expected ${stringify(actual)} to contain ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to contain ${stringify(expected)}`,
      );
    },

    toContainEqual(expected: unknown) {
      const values = Array.isArray(actual)
        ? actual
        : actual instanceof Set
          ? [...actual]
          : [];
      check(
        values.some((item) => deepEqual(item, expected)),
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to contain equal ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to contain equal ${stringify(expected)}`,
      );
    },

    toHaveLength(expected: number) {
      const length = (actual as { length?: unknown })?.length;
      check(
        length === expected,
        negated,
        soft,
        () => `expected ${stringify(actual)} to have length ${expected}`,
        () => `expected ${stringify(actual)} not to have length ${expected}`,
        { actual: length, expected },
      );
    },

    toHaveProperty(
      propertyPath: string | readonly (string | number)[],
      expected?: unknown,
    ) {
      const result = getPathValue(actual, propertyPath);
      const pass =
        arguments.length >= 2
          ? result.found && deepEqual(result.value, expected)
          : result.found;
      check(
        pass,
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to have property ${stringify(propertyPath)}`,
        () =>
          `expected ${stringify(actual)} not to have property ${stringify(propertyPath)}`,
        { actual: result.value, expected },
      );
    },

    toMatch(expected: string | RegExp) {
      const received = String(actual);
      const pass =
        typeof expected === "string"
          ? received.includes(expected)
          : expected.test(received);
      check(
        pass,
        negated,
        soft,
        () => `expected ${stringify(actual)} to match ${stringify(expected)}`,
        () =>
          `expected ${stringify(actual)} not to match ${stringify(expected)}`,
      );
    },

    toThrow(expected?: string | RegExp | ErrorConstructor | Error) {
      const thrown = thrownError(actual);
      const pass = thrown.threw && matchesThrown(thrown.value, expected);
      check(
        pass,
        negated,
        soft,
        () =>
          `expected function to throw ${expected === undefined ? "" : stringify(expected)}`.trim(),
        () =>
          `expected function not to throw ${expected === undefined ? "" : stringify(expected)}`.trim(),
      );
    },

    toThrowError(expected?: string | RegExp | ErrorConstructor | Error) {
      (
        buildSyncMatchers(actual, negated, soft).toThrow as (
          expected?: string | RegExp | ErrorConstructor | Error,
        ) => void
      )(expected);
    },

    toBeInstanceOf(expected: new (...args: any[]) => object) {
      check(
        actual instanceof expected,
        negated,
        soft,
        () =>
          `expected ${stringify(actual)} to be instance of ${expected.name}`,
        () =>
          `expected ${stringify(actual)} not to be instance of ${expected.name}`,
      );
    },

    toBeTypeOf(expected: string) {
      check(
        typeof actual === expected,
        negated,
        soft,
        () => `expected ${stringify(actual)} to be typeof ${expected}`,
        () => `expected ${stringify(actual)} not to be typeof ${expected}`,
      );
    },

    toHaveBeenCalled() {
      ensureMock(actual);
      check(
        actual.mock.calls.length > 0,
        negated,
        soft,
        () => "expected mock to have been called",
        () => "expected mock not to have been called",
      );
    },

    toHaveBeenCalledTimes(expected: number) {
      ensureMock(actual);
      check(
        actual.mock.calls.length === expected,
        negated,
        soft,
        () =>
          `expected mock to be called ${expected} times, received ${actual.mock.calls.length}`,
        () => `expected mock not to be called ${expected} times`,
        { actual: actual.mock.calls.length, expected },
      );
    },

    toHaveBeenCalledWith(...expected: unknown[]) {
      ensureMock(actual);
      check(
        actual.mock.calls.some((call) => deepEqual(call, expected)),
        negated,
        soft,
        () => `expected mock to have been called with ${stringify(expected)}`,
        () =>
          `expected mock not to have been called with ${stringify(expected)}`,
      );
    },

    toHaveBeenLastCalledWith(...expected: unknown[]) {
      ensureMock(actual);
      const last = actual.mock.calls.at(-1);
      check(
        deepEqual(last, expected),
        negated,
        soft,
        () => `expected last mock call to equal ${stringify(expected)}`,
        () => `expected last mock call not to equal ${stringify(expected)}`,
        { actual: last, expected },
      );
    },

    toHaveBeenNthCalledWith(nth: number, ...expected: unknown[]) {
      ensureMock(actual);
      const call = actual.mock.calls[nth - 1];
      check(
        deepEqual(call, expected),
        negated,
        soft,
        () => `expected mock call ${nth} to equal ${stringify(expected)}`,
        () => `expected mock call ${nth} not to equal ${stringify(expected)}`,
        { actual: call, expected },
      );
    },

    toHaveReturned() {
      ensureMock(actual);
      check(
        actual.mock.results.some((result) => result.type === "return"),
        negated,
        soft,
        () => "expected mock to have returned",
        () => "expected mock not to have returned",
      );
    },

    toHaveReturnedTimes(expected: number) {
      ensureMock(actual);
      const actualReturns = actual.mock.results.filter(
        (result) => result.type === "return",
      ).length;
      check(
        actualReturns === expected,
        negated,
        soft,
        () =>
          `expected mock to return ${expected} times, received ${actualReturns}`,
        () => `expected mock not to return ${expected} times`,
        { actual: actualReturns, expected },
      );
    },

    toHaveReturnedWith(expected: unknown) {
      ensureMock(actual);
      check(
        actual.mock.results.some(
          (result) =>
            result.type === "return" && deepEqual(result.value, expected),
        ),
        negated,
        soft,
        () => `expected mock to have returned with ${stringify(expected)}`,
        () => `expected mock not to have returned with ${stringify(expected)}`,
      );
    },

    toHaveLastReturnedWith(expected: unknown) {
      ensureMock(actual);
      const last = [...actual.mock.results]
        .reverse()
        .find((result) => result.type === "return");
      check(
        deepEqual(last?.value, expected),
        negated,
        soft,
        () => `expected last mock return to equal ${stringify(expected)}`,
        () => `expected last mock return not to equal ${stringify(expected)}`,
        { actual: last?.value, expected },
      );
    },

    toMatchSnapshot(hint?: string) {
      recordAssertion();
      const result = matchSnapshot(actual, hint);
      if (negated ? result.pass : !result.pass) {
        failOrSoft(
          negated
            ? `expected snapshot ${result.key} not to match`
            : `snapshot ${result.key} mismatched`,
          soft,
          { actual: result.actual, expected: result.expected },
        );
      }
    },

    toMatchInlineSnapshot(inline?: string) {
      if (inline === undefined) {
        (
          buildSyncMatchers(actual, negated, soft).toMatchSnapshot as (
            hint?: string,
          ) => void
        )("inline");
        return;
      }
      const received = serializeSnapshot(actual).trim();
      const expected = inline.trim();
      check(
        received === expected,
        negated,
        soft,
        () => "inline snapshot mismatched",
        () => "expected inline snapshot not to match",
        { actual: received, expected },
      );
    },
  };

  for (const [name, matcher] of customMatchers) {
    (matchers as Record<string, unknown>)[name] = (...args: unknown[]) => {
      recordAssertion();
      const context: MatcherContext = {
        isNot: negated,
        equals: deepEqual,
        utils: { stringify },
      };
      const handle = (result: MatcherResult): void => {
        if (negated ? result.pass : !result.pass) {
          failOrSoft(
            result.message(),
            soft,
            negated
              ? undefined
              : { actual: result.actual, expected: result.expected },
          );
        }
      };
      const result = matcher.call(context, actual, ...args);
      if (
        result &&
        typeof (result as Promise<MatcherResult>).then === "function"
      ) {
        return (result as Promise<MatcherResult>).then(handle);
      }
      handle(result as MatcherResult);
    };
  }

  return matchers as Matchers;
}

function buildPromiseMatchers(
  promise: Promise<unknown>,
  mode: "resolves" | "rejects",
  negated: boolean,
  soft: boolean,
): Matchers {
  const getActual = async () => {
    try {
      const value = await promise;
      if (mode === "rejects")
        throw makeError(
          `expected promise to reject, but resolved with ${stringify(value)}`,
        );
      return value;
    } catch (error) {
      if (mode === "rejects" && !(error instanceof LightningAssertionError))
        return error;
      if (mode === "resolves")
        throw makeError(
          `expected promise to resolve, but rejected with ${stringify(error)}`,
        );
      throw error;
    }
  };
  return buildAsyncMatchers(getActual, negated, soft, mode);
}

function buildAsyncMatchers(
  getActual: () => Promise<unknown>,
  negated: boolean,
  soft: boolean,
  promiseMode?: "resolves" | "rejects",
): Matchers {
  const asyncMatchers: Partial<Matchers> = {
    get not() {
      return buildAsyncMatchers(getActual, !negated, soft, promiseMode);
    },
    get resolves() {
      return buildPromiseMatchers(getActual(), "resolves", negated, soft);
    },
    get rejects() {
      return buildPromiseMatchers(getActual(), "rejects", negated, soft);
    },
  };
  for (const name of [...baseMatcherNames, ...customMatchers.keys()]) {
    (asyncMatchers as Record<string, unknown>)[name] = async (
      ...args: unknown[]
    ) => {
      const value = await getActual();
      if (
        promiseMode === "rejects" &&
        (name === "toThrow" || name === "toThrowError")
      ) {
        const expected = args[0] as
          | string
          | RegExp
          | ErrorConstructor
          | Error
          | undefined;
        check(
          matchesThrown(value, expected),
          negated,
          soft,
          () =>
            `expected promise rejection to throw ${expected === undefined ? "" : stringify(expected)}`.trim(),
          () =>
            `expected promise rejection not to throw ${expected === undefined ? "" : stringify(expected)}`.trim(),
        );
        return;
      }
      const matcher = (
        buildSyncMatchers(value, negated, soft) as Record<
          string,
          ((...a: unknown[]) => unknown) | undefined
        >
      )[name];
      if (!matcher) throw new Error(`Unknown matcher: ${String(name)}`);
      return matcher(...args);
    };
  }
  return asyncMatchers as Matchers;
}

function buildPollMatchers(
  factory: () => unknown | Promise<unknown>,
  options: { timeout?: number; interval?: number },
  negated: boolean,
  soft: boolean,
): Matchers {
  const timeout = options.timeout ?? 1000;
  const interval = options.interval ?? 50;
  const pollMatchers: Partial<Matchers> = {
    get not() {
      return buildPollMatchers(factory, options, !negated, soft);
    },
    get resolves() {
      return buildAsyncMatchers(async () => factory(), negated, soft).resolves;
    },
    get rejects() {
      return buildAsyncMatchers(async () => factory(), negated, soft).rejects;
    },
  };
  for (const name of [...baseMatcherNames, ...customMatchers.keys()]) {
    (pollMatchers as Record<string, unknown>)[name] = async (
      ...args: unknown[]
    ) => {
      const deadline = Date.now() + timeout;
      let lastError: unknown;
      while (Date.now() <= deadline) {
        try {
          const value = await factory();
          const matcher = (
            buildSyncMatchers(value, negated, false) as Record<
              string,
              ((...a: unknown[]) => unknown) | undefined
            >
          )[name];
          if (!matcher) throw new Error(`Unknown matcher: ${String(name)}`);
          await matcher(...args);
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, interval));
        }
      }
      if (lastError instanceof LightningAssertionError) {
        if (soft) assertionState.softErrors.push(lastError);
        else throw lastError;
      }
      throw lastError;
    };
  }
  return pollMatchers as Matchers;
}

function buildMatchers(
  actual: unknown,
  negated: boolean,
  soft: boolean,
): Matchers {
  return buildSyncMatchers(actual, negated, soft);
}

export interface ExpectStatic {
  (actual: unknown): Matchers;
  soft(actual: unknown): Matchers;
  poll(
    factory: () => unknown | Promise<unknown>,
    options?: { timeout?: number; interval?: number },
  ): Matchers;
  extend(matchers: Record<string, CustomMatcher>): void;
  assertions(count: number): void;
  hasAssertions(): void;
  anything(): AsymmetricMatcherInterface;
  any(expected: unknown): AsymmetricMatcherInterface;
  objectContaining(sample: Record<string, unknown>): AsymmetricMatcherInterface;
  arrayContaining(sample: readonly unknown[]): AsymmetricMatcherInterface;
  stringContaining(sample: string): AsymmetricMatcherInterface;
  stringMatching(sample: string | RegExp): AsymmetricMatcherInterface;
  addSnapshotSerializer(serializer: SnapshotSerializer): void;
  getState(): AssertionState;
  setState(state: Partial<AssertionState>): void;
  unreachable(message?: string): never;
}

export const expect = Object.assign(
  (actual: unknown) => buildMatchers(actual, false, false),
  {
    soft: (actual: unknown) => buildMatchers(actual, false, true),
    poll: (
      factory: () => unknown | Promise<unknown>,
      options: { timeout?: number; interval?: number } = {},
    ) => buildPollMatchers(factory, options, false, false),
    extend(matchers: Record<string, CustomMatcher>) {
      for (const [name, matcher] of Object.entries(matchers))
        customMatchers.set(name, matcher);
    },
    assertions(count: number) {
      assertionState.expected = count;
    },
    hasAssertions() {
      assertionState.requireAssertions = true;
    },
    anything: () => new AnythingMatcher(),
    any: (expected: unknown) => new AnyMatcher(expected),
    objectContaining: (sample: Record<string, unknown>) =>
      new ObjectContainingMatcher(sample),
    arrayContaining: (sample: readonly unknown[]) =>
      new ArrayContainingMatcher(sample),
    stringContaining: (sample: string) => new StringContainingMatcher(sample),
    stringMatching: (sample: string | RegExp) =>
      new StringMatchingMatcher(sample),
    addSnapshotSerializer,
    getState,
    setState,
    unreachable(message = "expected code path to be unreachable"): never {
      throw new LightningAssertionError(message);
    },
  },
) as ExpectStatic;
