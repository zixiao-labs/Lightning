/**
 * Collector: builds the suite/test tree as a spec file is evaluated.
 *
 * The orchestrator/worker calls {@link startCollection} before evaluating a spec
 * and {@link finishCollection} after it, so top-level `test()`/`describe()` calls
 * register into a fresh root suite.
 */
import type { Hook, RunnableOptions, Suite, TaskMode, Test } from "../types.ts";

function createSuite(
  name: string,
  mode: TaskMode,
  parent: Suite | null,
  options: RunnableOptions = {},
): Suite {
  return {
    type: "suite",
    name,
    mode,
    parent,
    tasks: [],
    hooks: [],
    ...options,
  };
}

let rootSuite: Suite = createSuite("", "run", null);
let currentSuite: Suite = rootSuite;
/** Set true if any `.only` was seen during this file's collection. */
let hasOnly = false;

/** Reset collector state and return the fresh file-root suite. */
export function startCollection(): Suite {
  rootSuite = createSuite("", "run", null);
  currentSuite = rootSuite;
  hasOnly = false;
  return rootSuite;
}

export interface CollectionResult {
  root: Suite;
  hasOnly: boolean;
}

export function finishCollection(): CollectionResult {
  return { root: rootSuite, hasOnly };
}

function addTest(
  name: string,
  fn: Test["fn"],
  mode: TaskMode,
  options: RunnableOptions = {},
): void {
  if (mode === "only") hasOnly = true;
  const test: Test = {
    type: "test",
    name,
    mode,
    fn,
    suite: currentSuite,
    ...options,
  };
  currentSuite.tasks.push(test);
}

function addSuite(
  name: string,
  factory: (() => void) | undefined,
  mode: TaskMode,
  options: RunnableOptions = {},
): void {
  if (mode === "only") hasOnly = true;
  const suite = createSuite(name, mode, currentSuite, options);
  currentSuite.tasks.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  try {
    // describe callbacks collect synchronously (Vitest/Jest semantics).
    factory?.();
  } finally {
    currentSuite = prev;
  }
}

function addHook(type: Hook["type"], fn: Hook["fn"]): void {
  currentSuite.hooks.push({ type, fn });
}

// ---- public `test` / `it` --------------------------------------------------

type TestFn = () => void | Promise<void>;

type TestCase<T> = T extends readonly unknown[] ? T : [T];

type TestFactory<T> = (...args: TestCase<T>) => void | Promise<void>;

export interface TestAPI {
  (name: string, fn: TestFn, timeout?: number): void;
  skip: TestAPI;
  only: TestAPI;
  todo: (name: string, fn?: TestFn) => void;
  concurrent: TestAPI;
  sequential: TestAPI;
  each: <T>(cases: readonly T[]) => (name: string, fn: TestFactory<T>) => void;
  retry: (times: number) => TestAPI;
  repeats: (times: number) => TestAPI;
}

function formatPrimitive(value: unknown): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function formatEachName(
  name: string,
  values: readonly unknown[],
  index: number,
): string {
  let positional = 0;
  if (/%[sdif]/.test(name)) {
    return name.replace(/%[sdif]/g, () =>
      formatPrimitive(values[positional++]),
    );
  }
  return name.replace(/\$(\w+|\d+)/g, (_m, key: string) => {
    if (key === "index") return String(index);
    if (/^\d+$/.test(key)) return formatPrimitive(values[Number(key)]);
    const first = values[0];
    if (
      first !== null &&
      typeof first === "object" &&
      key in (first as object)
    ) {
      return String((first as Record<string, unknown>)[key]);
    }
    return formatPrimitive(first);
  });
}

function normalizeCase<T>(value: T): TestCase<T> {
  return (Array.isArray(value) ? value : [value]) as TestCase<T>;
}

function makeEach(mode: TaskMode, options: RunnableOptions) {
  return <T>(cases: readonly T[]) =>
    (name: string, fn: TestFactory<T>): void => {
      cases.forEach((value, index) => {
        const args = normalizeCase(value);
        addTest(
          formatEachName(name, args, index),
          () => fn(...args),
          mode,
          options,
        );
      });
    };
}

function createTestApi(
  mode: TaskMode = "run",
  options: RunnableOptions = {},
): TestAPI {
  const api = ((name: string, fn: TestFn, timeout?: number) => {
    const nextOptions =
      timeout === undefined ? options : { ...options, timeout };
    addTest(name, fn, mode, nextOptions);
  }) as TestAPI;

  Object.defineProperties(api, {
    skip: { get: () => createTestApi("skip", options) },
    only: { get: () => createTestApi("only", options) },
    concurrent: {
      get: () =>
        createTestApi(mode, {
          ...options,
          concurrent: true,
          sequential: false,
        }),
    },
    sequential: {
      get: () =>
        createTestApi(mode, {
          ...options,
          sequential: true,
          concurrent: false,
        }),
    },
  });
  api.todo = (name: string, fn?: TestFn) =>
    addTest(name, fn ?? (() => {}), "todo", options);
  api.each = makeEach(mode, options);
  api.retry = (times: number) =>
    createTestApi(mode, { ...options, retry: Math.max(0, times) });
  api.repeats = (times: number) =>
    createTestApi(mode, { ...options, repeats: Math.max(1, times) });
  return api;
}

export const test: TestAPI = createTestApi();
export const it: TestAPI = test;

// ---- public `describe` -----------------------------------------------------

export interface DescribeAPI {
  (name: string, factory: () => void): void;
  skip: DescribeAPI;
  only: DescribeAPI;
  todo: (name: string, factory?: () => void) => void;
  concurrent: DescribeAPI;
  sequential: DescribeAPI;
  each: <T>(
    cases: readonly T[],
  ) => (name: string, factory: (...args: TestCase<T>) => void) => void;
}

function makeDescribeEach(mode: TaskMode, options: RunnableOptions) {
  return <T>(cases: readonly T[]) =>
    (name: string, factory: (...args: TestCase<T>) => void): void => {
      cases.forEach((value, index) => {
        const args = normalizeCase(value);
        addSuite(
          formatEachName(name, args, index),
          () => factory(...args),
          mode,
          options,
        );
      });
    };
}

function createDescribeApi(
  mode: TaskMode = "run",
  options: RunnableOptions = {},
): DescribeAPI {
  const api = ((name: string, factory: () => void) =>
    addSuite(name, factory, mode, options)) as DescribeAPI;
  Object.defineProperties(api, {
    skip: { get: () => createDescribeApi("skip", options) },
    only: { get: () => createDescribeApi("only", options) },
    concurrent: {
      get: () =>
        createDescribeApi(mode, {
          ...options,
          concurrent: true,
          sequential: false,
        }),
    },
    sequential: {
      get: () =>
        createDescribeApi(mode, {
          ...options,
          sequential: true,
          concurrent: false,
        }),
    },
  });
  api.todo = (name: string, factory?: () => void) =>
    addSuite(name, factory, "todo", options);
  api.each = makeDescribeEach(mode, options);
  return api;
}

export const describe: DescribeAPI = createDescribeApi();

// ---- hooks -----------------------------------------------------------------

export const beforeAll = (fn: Hook["fn"]) => addHook("beforeAll", fn);
export const afterAll = (fn: Hook["fn"]) => addHook("afterAll", fn);
export const beforeEach = (fn: Hook["fn"]) => addHook("beforeEach", fn);
export const afterEach = (fn: Hook["fn"]) => addHook("afterEach", fn);
