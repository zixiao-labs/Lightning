/**
 * Runner: walks a collected suite tree and produces results.
 *
 * Hook semantics mirror Jest/Vitest:
 *  - `beforeAll`/`afterAll` run once per suite (before/after its tasks),
 *  - `beforeEach` run outer→inner before every test, `afterEach` inner→outer after.
 */
import type { Hook, Suite, Test, TestError, TestResult } from "../types.ts";
import { createScopedExpect, finishTestAssertions, startTestAssertions } from "../expect/index.ts";
import { withExecutionScope, supportsConcurrentScopes, type ExecutionScope } from "./context.ts";

// Runner deadlines must not be replaced by a test's fake clock.
const deadlineSetTimeout = globalThis.setTimeout;
const deadlineClearTimeout = globalThis.clearTimeout;

export interface RunOptions {
  createBenchmarkContext?: () => import("../bench/context.ts").BenchmarkContext;
  hasOnly: boolean;
  defaultTimeout: number;
  /** Only run tests whose full dotted name matches. */
  namePattern?: RegExp;
  retry: number;
  repeats: number;
  onTestStart?: (name: string) => void;
  onTestEnd?: (name: string) => void | Promise<void>;
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

function withTimeout<T>(
  fn: () => T | Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (ms === 0) return Promise.resolve().then(fn);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = deadlineSetTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out in ${ms}ms`));
    }, ms);
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          deadlineClearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          deadlineClearTimeout(timer);
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

function suiteName(suite: Suite): string {
  return suitePath(suite).join(" > ") || "<root>";
}

function hasActiveTest(
  suite: Suite,
  inOnly: boolean,
  opts: RunOptions,
): boolean {
  for (const task of suite.tasks) {
    if (task.type === "test") {
      if (isTestActive(task, inOnly, opts)) return true;
    } else {
      const childInOnly = inOnly || task.mode === "only";
      if (
        task.mode !== "skip" &&
        task.mode !== "todo" &&
        hasActiveTest(task, childInOnly, opts)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isTestActive(test: Test, inOnly: boolean, opts: RunOptions): boolean {
  if (test.mode === "skip" || test.mode === "todo") return false;
  if (opts.hasOnly && !(inOnly || test.mode === "only")) return false;
  if (opts.namePattern) {
    opts.namePattern.lastIndex = 0;
    if (!opts.namePattern.test(fullName(test))) return false;
  }
  return true;
}

export async function runSuiteTree(
  root: Suite,
  opts: RunOptions,
): Promise<TestResult[]> {
  return runSuite(root, opts, [], [], false, false);
}

async function runSuite(
  suite: Suite,
  opts: RunOptions,
  beforeEachChain: Array<Hook["fn"]>,
  afterEachChain: Array<Hook["fn"]>,
  inOnly: boolean,
  inheritedConcurrent: boolean,
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const active = hasActiveTest(suite, inOnly, opts);
  const suiteConcurrent = suite.sequential
    ? false
    : (suite.concurrent ?? inheritedConcurrent);

  const beforeEach = [
    ...beforeEachChain,
    ...suite.hooks.filter((h) => h.type === "beforeEach").map((h) => h.fn),
  ];
  const afterEach = [
    ...suite.hooks.filter((h) => h.type === "afterEach").map((h) => h.fn),
    ...afterEachChain,
  ];

  let setupFailed = false;
  const suiteCleanups: Array<() => void | Promise<void>> = [];
  if (active) {
    try {
      for (const h of suite.hooks.filter(
        (h): h is Extract<Hook, { type: "beforeAll" | "afterAll" }> => h.type === "beforeAll",
      )) {
        const cleanup = await h.fn();
        if (typeof cleanup === "function") suiteCleanups.push(cleanup);
      }
    } catch (error) {
      results.push(...markFailedActive(suite, opts, inOnly, toError(error)));
      setupFailed = true;
    }
  }

  const concurrentQueue: Array<Promise<TestResult[]>> = [];
  const flushConcurrent = async () => {
    if (concurrentQueue.length === 0) return;
    const chunks = await Promise.all(concurrentQueue.splice(0));
    for (const chunk of chunks) results.push(...chunk);
  };

  for (const task of suite.tasks) {
    if (task.type === "suite") {
      if (setupFailed) break;
      await flushConcurrent();
      const childInOnly = inOnly || task.mode === "only";
      if (task.mode === "skip" || task.mode === "todo") {
        results.push(
          ...markSkipped(task, task.mode === "todo" ? "todo" : "skip"),
        );
        continue;
      }
      results.push(
        ...(await runSuite(
          task,
          opts,
          beforeEach,
          afterEach,
          childInOnly,
          suiteConcurrent,
        )),
      );
    } else {
      if (setupFailed) break;
      const testConcurrent = task.sequential
        ? false
        : (task.concurrent ?? suiteConcurrent);
      const run = () => runTest(task, opts, beforeEach, afterEach, inOnly);
      if (testConcurrent && supportsConcurrentScopes) concurrentQueue.push(run());
      else {
        await flushConcurrent();
        results.push(...(await run()));
      }
    }
  }

  await flushConcurrent();

  if (active) {
    const cleanupFns = [
      ...suite.hooks.filter(
        (h): h is Extract<Hook, { type: "beforeAll" | "afterAll" }> => h.type === "afterAll",
      ).map(h => h.fn),
      ...suiteCleanups.reverse(),
    ];
    for (const fn of cleanupFns) {
      try {
        await fn();
      } catch (error) {
        results.push({
          fullName: `${suiteName(suite)} > afterAll`,
          state: "fail",
          durationMs: 0,
          error: toError(error),
        });
      }
    }
  }

  return results;
}

function markSkipped(suite: Suite, state: "skip" | "todo"): TestResult[] {
  const results: TestResult[] = [];
  for (const task of suite.tasks) {
    if (task.type === "test")
      results.push({ fullName: fullName(task), state, durationMs: 0 });
    else results.push(...markSkipped(task, state));
  }
  return results;
}

function markFailedActive(
  suite: Suite,
  opts: RunOptions,
  inOnly: boolean,
  error: TestError,
): TestResult[] {
  const results: TestResult[] = [];
  for (const task of suite.tasks) {
    if (task.type === "test") {
      if (isTestActive(task, inOnly, opts)) {
        results.push({
          fullName: fullName(task),
          state: "fail",
          durationMs: 0,
          error,
        });
      } else {
        results.push({
          fullName: fullName(task),
          state: task.mode === "todo" ? "todo" : "skip",
          durationMs: 0,
        });
      }
    } else {
      const childInOnly = inOnly || task.mode === "only";
      results.push(...(task.mode === "skip" || task.mode === "todo"
        ? markSkipped(task, task.mode === "todo" ? "todo" : "skip")
        : markFailedActive(task, opts, childInOnly, error)));
    }
  }
  return results;
}

async function runTest(
  test: Test,
  opts: RunOptions,
  beforeEach: Array<Hook["fn"]>,
  afterEach: Array<Hook["fn"]>,
  inOnly: boolean,
): Promise<TestResult[]> {
  const name = fullName(test);

  if (test.mode === "todo")
    return [{ fullName: name, state: "todo", durationMs: 0 }];
  if (test.mode === "skip" || !isTestActive(test, inOnly, opts)) {
    return [{ fullName: name, state: "skip", durationMs: 0 }];
  }

  const repeats = Math.max(1, test.repeats ?? opts.repeats);
  const output: TestResult[] = [];
  for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
    const displayName =
      repeats === 1 ? name : `${name} [repeat ${repeatIndex}/${repeats}]`;
    output.push(
      await runWithRetry(
        test,
        displayName,
        opts,
        beforeEach,
        afterEach,
        repeatIndex,
      ),
    );
  }
  return output;
}

async function runWithRetry(
  test: Test,
  displayName: string,
  opts: RunOptions,
  beforeEach: Array<Hook["fn"]>,
  afterEach: Array<Hook["fn"]>,
  repeatIndex: number,
): Promise<TestResult> {
  const retry = Math.max(0, test.retry ?? opts.retry);
  let last: TestResult | undefined;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const result = await runAttempt(
      test,
      displayName,
      opts,
      beforeEach,
      afterEach,
      repeatIndex,
      attempt,
    );
    if (result.state === "pass") return result;
    last = result;
  }
  return (
    last ?? {
      fullName: displayName,
      state: "fail",
      durationMs: 0,
      retryCount: retry,
    }
  );
}

async function runAttempt(
  test: Test,
  displayName: string,
  opts: RunOptions,
  beforeEach: Array<Hook["fn"]>,
  afterEach: Array<Hook["fn"]>,
  repeatIndex: number,
  attempt: number,
): Promise<TestResult> {
  const scope: ExecutionScope = { finished: [], failed: [], snapshotName: displayName, snapshotCounts: new Map() };
  scope.context = {
    get bench() {
      if (!opts.createBenchmarkContext) throw new Error("Benchmark context is unavailable in this runner");
      const bench = opts.createBenchmarkContext();
      Object.defineProperty(scope.context!, "bench", { value: bench });
      return bench;
    },
    task: test,
    expect: createScopedExpect(scope),
    onTestFinished: fn => { scope.finished.push(fn); },
    onTestFailed: fn => { scope.failed.push(fn); },
  };
  return withExecutionScope(scope, async () => {
    const timeout = test.timeout ?? opts.defaultTimeout;
    const start = performance.now();
    let error: unknown;
    let failed = false;
    const capture = (err: unknown) => { if (!failed) error = err; failed = true; };
    const invoke = (fn: Hook["fn"], label: string) =>
      withExecutionScope(scope, () => withTimeout(() => fn(scope.context!), timeout, label));
    const invokeHook = async (fn: Hook["fn"], label: string) => {
      const softCount = scope.assertionState?.softErrors.length ?? 0;
      try { return await invoke(fn, label); }
      finally {
        for (const err of scope.assertionState?.softErrors.slice(softCount) ?? []) capture(err);
      }
    };
    let setupSucceeded = false;
    let bodyFailed = false;
    withExecutionScope(scope, startTestAssertions);
    try {
      withExecutionScope(scope, () => opts.onTestStart?.(displayName));
      for (const fn of beforeEach) {
        const cleanup = await invokeHook(fn, "BeforeEach");
        if (typeof cleanup === "function") scope.finished.push(cleanup);
      }
      setupSucceeded = true;
      try {
        await invoke(() => test.fn(scope.context!), "Test");
      } catch (err) {
        bodyFailed = true;
        if (!test.fails) capture(err);
      }
    } catch (err) { capture(err); }
    for (const fn of afterEach) {
      try { await invokeHook(fn, "AfterEach"); } catch (err) { capture(err); }
    }
    if (setupSucceeded) {
      try { withExecutionScope(scope, finishTestAssertions); }
      catch (err) {
        bodyFailed = true;
        if (!test.fails) capture(err);
      }
      if (test.fails && !bodyFailed) capture(new Error("Test was expected to fail, but passed"));
    }
    if (failed) {
      for (const fn of scope.failed.reverse()) {
        try { await invoke(fn, "onTestFailed"); } catch (err) { capture(err); }
      }
    }
    for (const fn of scope.finished.reverse()) {
      try { await invoke(fn, "onTestFinished"); } catch (err) { capture(err); }
    }
    try { await withExecutionScope(scope, () => opts.onTestEnd?.(displayName)); }
    catch (err) { capture(err); }
    return {
      fullName: displayName,
      state: failed ? "fail" : "pass",
      durationMs: performance.now() - start,
      ...(failed ? { error: toError(error) } : {}),
      ...(attempt > 0 ? { retryCount: attempt } : {}),
      ...(repeatIndex > 1 ? { repeatIndex } : {}),
    };
  });
}
