/**
 * Runner: walks a collected suite tree depth-first and produces results.
 *
 * Hook semantics mirror Jest/Vitest:
 *  - `beforeAll`/`afterAll` run once per suite (before/after its tasks),
 *  - `beforeEach` run outer→inner before every test, `afterEach` inner→outer after.
 *
 * `.only` convergence: when any `.only` exists in the file, a test runs only if it
 * is `.only` itself or lives under an `.only` suite.
 */
import type { Suite, Test, TestError, TestResult } from "../types.ts";

export interface RunOptions {
  hasOnly: boolean;
  defaultTimeout: number;
  /** Only run tests whose full dotted name matches. */
  namePattern?: RegExp;
}

function toError(value: unknown): TestError {
  if (value instanceof Error) {
    const err: TestError = { message: value.message, stack: value.stack ?? "" };
    const diff = (value as { diff?: TestError["diff"] }).diff;
    if (diff) err.diff = diff;
    return err;
  }
  return { message: typeof value === "string" ? value : String(value) };
}

function withTimeout(fn: () => void | Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out in ${ms}ms`));
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
  });
}

function suitePath(suite: Suite): string[] {
  const parts: string[] = [];
  let s: Suite | null = suite;
  while (s && s.name) {
    parts.unshift(s.name);
    s = s.parent;
  }
  return parts;
}

function fullName(test: Test): string {
  return [...suitePath(test.suite), test.name].join(" > ");
}

/** Does this subtree contain at least one test that is active under the given flags? */
function hasActiveTest(suite: Suite, inOnly: boolean, opts: RunOptions): boolean {
  for (const task of suite.tasks) {
    if (task.type === "test") {
      if (isTestActive(task, inOnly, opts)) return true;
    } else {
      const childInOnly = inOnly || task.mode === "only";
      if (task.mode !== "skip" && task.mode !== "todo" && hasActiveTest(task, childInOnly, opts)) {
        return true;
      }
    }
  }
  return false;
}

function isTestActive(test: Test, inOnly: boolean, opts: RunOptions): boolean {
  if (opts.hasOnly && !(inOnly || test.mode === "only")) return false;
  if (opts.namePattern && !opts.namePattern.test(fullName(test))) return false;
  return true;
}

export async function runSuiteTree(root: Suite, opts: RunOptions): Promise<TestResult[]> {
  const results: TestResult[] = [];
  await runSuite(root, opts, [], [], false, results);
  return results;
}

async function runSuite(
  suite: Suite,
  opts: RunOptions,
  beforeEachChain: Array<() => void | Promise<void>>,
  afterEachChain: Array<() => void | Promise<void>>,
  inOnly: boolean,
  results: TestResult[],
): Promise<void> {
  const active = hasActiveTest(suite, inOnly, opts);

  // Accumulate each-hooks for descendants regardless; only fire all-hooks if active.
  const beforeEach = [
    ...beforeEachChain,
    ...suite.hooks.filter((h) => h.type === "beforeEach").map((h) => h.fn),
  ];
  const afterEach = [
    ...suite.hooks.filter((h) => h.type === "afterEach").map((h) => h.fn),
    ...afterEachChain,
  ];

  if (active) {
    for (const h of suite.hooks.filter((h) => h.type === "beforeAll")) await h.fn();
  }

  for (const task of suite.tasks) {
    if (task.type === "suite") {
      const childInOnly = inOnly || task.mode === "only";
      if (task.mode === "skip" || task.mode === "todo") {
        markSkipped(task, task.mode === "todo" ? "todo" : "skip", results);
        continue;
      }
      await runSuite(task, opts, beforeEach, afterEach, childInOnly, results);
    } else {
      await runTest(task, opts, beforeEach, afterEach, inOnly, results);
    }
  }

  if (active) {
    for (const h of suite.hooks.filter((h) => h.type === "afterAll")) await h.fn();
  }
}

function markSkipped(suite: Suite, state: "skip" | "todo", results: TestResult[]): void {
  for (const task of suite.tasks) {
    if (task.type === "test") {
      results.push({ fullName: fullName(task), state, durationMs: 0 });
    } else {
      markSkipped(task, state, results);
    }
  }
}

async function runTest(
  test: Test,
  opts: RunOptions,
  beforeEach: Array<() => void | Promise<void>>,
  afterEach: Array<() => void | Promise<void>>,
  inOnly: boolean,
  results: TestResult[],
): Promise<void> {
  const name = fullName(test);

  if (test.mode === "todo") {
    results.push({ fullName: name, state: "todo", durationMs: 0 });
    return;
  }
  if (test.mode === "skip" || !isTestActive(test, inOnly, opts)) {
    results.push({ fullName: name, state: "skip", durationMs: 0 });
    return;
  }

  const timeout = test.timeout ?? opts.defaultTimeout;
  const start = performance.now();
  try {
    for (const fn of beforeEach) await withTimeout(fn, timeout, "BeforeEach");
    await withTimeout(test.fn, timeout, "Test");
    // afterEach runs even on success; failures here fail the test.
    for (const fn of afterEach) await withTimeout(fn, timeout, "AfterEach");
    results.push({ fullName: name, state: "pass", durationMs: performance.now() - start });
  } catch (err) {
    // Best-effort afterEach cleanup on failure (ignore secondary errors).
    for (const fn of afterEach) {
      try {
        await withTimeout(fn, timeout, "AfterEach");
      } catch {
        /* swallow cleanup error after a primary failure */
      }
    }
    results.push({
      fullName: name,
      state: "fail",
      durationMs: performance.now() - start,
      error: toError(err),
    });
  }
}
