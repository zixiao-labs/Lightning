import type { AssertionState, ExpectStatic } from "../expect/index.ts";
import type { Test } from "../types.ts";

export type TestCleanup = (context: TestContext) => void | Promise<void>;

export interface TestContext {
  bench: import("../bench/context.ts").BenchmarkContext;
  task: Test;
  expect: ExpectStatic;
  onTestFinished: (fn: TestCleanup) => void;
  onTestFailed: (fn: TestCleanup) => void;
}

export interface ExecutionScope {
  snapshotName?: string;
  snapshotCounts?: Map<string, number>;
  context?: TestContext;
  assertionState?: AssertionState;
  finished: TestCleanup[];
  failed: TestCleanup[];
}

// No static Node import: this module is also bundled for browsers.
const builtin = typeof process !== "undefined"
  ? process.getBuiltinModule?.("node:async_hooks")
  : undefined;
const storage = builtin ? new builtin.AsyncLocalStorage<ExecutionScope>() : undefined;
let fallback: ExecutionScope | undefined;

/** Browsers lack async-local storage, so their test attempts run serially. */
export const supportsConcurrentScopes = storage !== undefined;

export function getExecutionScope(): ExecutionScope | undefined {
  return storage?.getStore() ?? fallback;
}

export function withExecutionScope<T>(scope: ExecutionScope, fn: () => T): T {
  if (storage) return storage.run(scope, fn);
  const previous = fallback;
  fallback = scope;
  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return Promise.resolve(result).finally(() => { fallback = previous; }) as T;
    }
    fallback = previous;
    return result;
  } catch (error) {
    fallback = previous;
    throw error;
  }
}

export function onTestFinished(fn: TestCleanup): void {
  const scope = getExecutionScope();
  if (!scope) throw new Error("onTestFinished must be called within a test");
  scope.finished.push(fn);
}

export function onTestFailed(fn: TestCleanup): void {
  const scope = getExecutionScope();
  if (!scope) throw new Error("onTestFailed must be called within a test");
  scope.failed.push(fn);
}
