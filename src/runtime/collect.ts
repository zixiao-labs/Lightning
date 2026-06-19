/**
 * Collector: builds the suite/test tree as a spec file is evaluated.
 *
 * State is a module-level singleton (one collection at a time — Phase 0 runs files
 * serially in-process). The orchestrator calls {@link startCollection} before
 * `ssrLoadModule(file)` and {@link finishCollection} after, so the file's top-level
 * `test()`/`describe()` calls register into a fresh root suite.
 */
import type { Hook, Suite, TaskMode, Test } from "../types.ts";

function createSuite(name: string, mode: TaskMode, parent: Suite | null): Suite {
  return { type: "suite", name, mode, parent, tasks: [], hooks: [] };
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

function addTest(name: string, fn: Test["fn"], mode: TaskMode, timeout?: number): void {
  if (mode === "only") hasOnly = true;
  const test: Test = { type: "test", name, mode, fn, suite: currentSuite };
  if (timeout !== undefined) test.timeout = timeout;
  currentSuite.tasks.push(test);
}

function addSuite(name: string, factory: (() => void) | undefined, mode: TaskMode): void {
  if (mode === "only") hasOnly = true;
  const suite = createSuite(name, mode, currentSuite);
  currentSuite.tasks.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  try {
    // describe callbacks collect synchronously (Vitest semantics).
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

export interface TestAPI {
  (name: string, fn: TestFn, timeout?: number): void;
  skip: (name: string, fn?: TestFn) => void;
  only: (name: string, fn: TestFn, timeout?: number) => void;
  todo: (name: string, fn?: TestFn) => void;
  each: <T>(cases: readonly T[]) => (name: string, fn: (value: T) => void | Promise<void>) => void;
}

function formatEachName(name: string, value: unknown, index: number): string {
  // Support both printf-style `%s`/`%i` and `$0` positional interpolation.
  if (/%[sdif]/.test(name)) {
    return name.replace(/%[sdif]/, () =>
      typeof value === "object" ? JSON.stringify(value) : String(value),
    );
  }
  return name.replace(/\$(\w+|\d+)/g, (_m, key: string) => {
    if (key === "0" || key === "index") return String(index);
    if (value !== null && typeof value === "object" && key in (value as object)) {
      return String((value as Record<string, unknown>)[key]);
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

function makeEach(getMode: () => TaskMode) {
  return <T>(cases: readonly T[]) =>
    (name: string, fn: (value: T) => void | Promise<void>): void => {
      cases.forEach((value, index) => {
        addTest(formatEachName(name, value, index), () => fn(value), getMode());
      });
    };
}

export const test: TestAPI = Object.assign(
  (name: string, fn: TestFn, timeout?: number) => addTest(name, fn, "run", timeout),
  {
    skip: (name: string, fn?: TestFn) => addTest(name, fn ?? (() => {}), "skip"),
    only: (name: string, fn: TestFn, timeout?: number) => addTest(name, fn, "only", timeout),
    todo: (name: string, fn?: TestFn) => addTest(name, fn ?? (() => {}), "todo"),
    each: makeEach(() => "run"),
  },
);

export const it: TestAPI = test;

// ---- public `describe` -----------------------------------------------------

export interface DescribeAPI {
  (name: string, factory: () => void): void;
  skip: (name: string, factory: () => void) => void;
  only: (name: string, factory: () => void) => void;
  todo: (name: string, factory?: () => void) => void;
  each: <T>(cases: readonly T[]) => (name: string, factory: (value: T) => void) => void;
}

export const describe: DescribeAPI = Object.assign(
  (name: string, factory: () => void) => addSuite(name, factory, "run"),
  {
    skip: (name: string, factory: () => void) => addSuite(name, factory, "skip"),
    only: (name: string, factory: () => void) => addSuite(name, factory, "only"),
    todo: (name: string, factory?: () => void) => addSuite(name, factory, "todo"),
    each:
      <T>(cases: readonly T[]) =>
      (name: string, factory: (value: T) => void): void => {
        cases.forEach((value, index) => {
          addSuite(formatEachName(name, value, index), () => factory(value), "run");
        });
      },
  },
);

// ---- hooks -----------------------------------------------------------------

export const beforeAll = (fn: Hook["fn"]) => addHook("beforeAll", fn);
export const afterAll = (fn: Hook["fn"]) => addHook("afterAll", fn);
export const beforeEach = (fn: Hook["fn"]) => addHook("beforeEach", fn);
export const afterEach = (fn: Hook["fn"]) => addHook("afterEach", fn);
